// EventEnvelope, fold kernel, void semantics — spec 03 §2.
// foldMatch is the ONLY state-derivation function in the system.
import { z } from "zod";
import { EngineError } from "./errors.ts";
import { compareGameTime, gameTimeOf, type GameTime } from "./time.ts";
import { EntrantId, type LineupPair, type MatchOutcome } from "./types.ts";

// spec 03 §2 — ids and time are injected (uuid in prod, `e-${n}` in tests);
// seq is gapless per fixture, assigned by persistence.
export interface EventEnvelope<T = unknown> {
  id: string;
  fixtureId: string;
  seq: number;
  type: string; // sport-namespaced: 'cricket.ball', 'football.goal', 'core.void'
  payload: T;
  recordedAt: string; // ISO, injected
  recordedBy: string | null;
  voids?: string; // id of the event this void cancels (type === 'core.void')
}

export const EventEnvelopeSchema = z.object({
  id: z.string().min(1),
  fixtureId: z.string().min(1),
  seq: z.number().int().nonnegative(),
  type: z.string().min(1),
  payload: z.unknown(),
  recordedAt: z.string().min(1),
  recordedBy: z.string().min(1).nullable(),
  voids: z.string().min(1).optional(),
});

// ---------------------------------------------------------------------------
// Core event payloads — spec 03 §2 table (sport-independent).
// ---------------------------------------------------------------------------

export const CoreStart = z.strictObject({}); // scheduled → in_play
export const CoreVoid = z.strictObject({}); // target id travels in envelope.voids
export const CoreForfeit = z.strictObject({ by: EntrantId, reason: z.string().min(1) });
export const CoreAbandon = z.strictObject({ reason: z.string().min(1) });
export const CoreFinalize = z.strictObject({}); // locks ledger
export const CoreNote = z.strictObject({ text: z.string().min(1) }); // no state effect
// Jul3/07 §4 — MOTM/MVP and friends: append-only, undoable via core.void,
// no state effect on the match itself (a stats-layer fact).
export const CoreAward = z.strictObject({ person: z.string().min(1), key: z.string().min(1) });
// W4 (#407) — play stopped, and may restart. `core.abandon` is terminal and was
// the only way to record that play had stopped, so a floodlight failure, a
// thunderstorm, a serious injury or a crowd incident — every one of which is
// routinely followed by a restart — was unrecordable in every sport. The reason
// is what the official wrote in the match record; it is never adjudicated.
export const CoreSuspend = z.strictObject({ reason: z.string().min(1).optional() });
export const CoreResume = z.strictObject({}); // play restarts; the stoppage ends

export const CORE_EVENT_SCHEMAS = {
  "core.start": CoreStart,
  "core.void": CoreVoid,
  "core.forfeit": CoreForfeit,
  "core.abandon": CoreAbandon,
  "core.finalize": CoreFinalize,
  "core.note": CoreNote,
  "core.award": CoreAward,
  "core.suspend": CoreSuspend,
  "core.resume": CoreResume,
} as const;

export type CoreEventType = keyof typeof CORE_EVENT_SCHEMAS;

// Payload union modules see in apply(): EventEnvelope<Ev | CoreEv> (spec 03 §3).
// core.void, core.suspend and core.resume are absent on purpose — the kernel
// resolves all three before a module sees anything.
export type CoreEv =
  | z.infer<typeof CoreStart>
  | z.infer<typeof CoreForfeit>
  | z.infer<typeof CoreAbandon>
  | z.infer<typeof CoreFinalize>
  | z.infer<typeof CoreNote>
  | z.infer<typeof CoreAward>;

export function isCoreEventType(type: string): type is CoreEventType {
  return Object.hasOwn(CORE_EVENT_SCHEMAS, type);
}

// Core events are owned by the kernel, so the kernel — not the sport module —
// validates their payloads (spec 03 §2). Unknown `core.*` types are invalid.
export function validateCoreEvent(event: EventEnvelope): void {
  if (!event.type.startsWith("core.")) return;
  if (!isCoreEventType(event.type)) {
    throw new EngineError("INVALID_EVENT", `unknown core event type "${event.type}"`, {
      eventId: event.id,
    });
  }
  const parsed = CORE_EVENT_SCHEMAS[event.type].safeParse(event.payload);
  if (!parsed.success) {
    throw new EngineError("INVALID_EVENT", `invalid ${event.type} payload`, {
      eventId: event.id,
      issues: parsed.error.issues,
    });
  }
}

// ---------------------------------------------------------------------------
// Void resolution — spec 03 §2 guarantee 3 (undo = void).
// ---------------------------------------------------------------------------

// Drops voided events and the void events themselves, preserving order.
// Modules never see core.void. Voids are NOT themselves voidable (PROMPT-02
// decision): a core.void targeting another core.void is rejected with
// INVALID_EVENT, so "re-enable by voiding the void" cannot exist — undoing an
// undo means re-recording the event.
export function resolveVoids(events: readonly EventEnvelope[]): EventEnvelope[] {
  const indexOf = new Map<string, number>();
  events.forEach((event, i) => indexOf.set(event.id, i));

  const voided = new Set<string>();
  events.forEach((event, i) => {
    if (event.type !== "core.void") return;
    if (!event.voids) {
      throw new EngineError("INVALID_EVENT", "core.void requires a `voids` target id", {
        eventId: event.id,
      });
    }
    const targetIndex = indexOf.get(event.voids);
    // "cancels a prior event" (spec 03 §2): the target must exist earlier in
    // the ledger — unknown, later, or self targets are all invalid.
    if (targetIndex === undefined || targetIndex >= i) {
      throw new EngineError(
        "INVALID_EVENT",
        `core.void targets unknown or non-prior event "${event.voids}"`,
        { eventId: event.id },
      );
    }
    // targetIndex came from indexOf, so the lookup cannot miss.
    if ((events[targetIndex] as EventEnvelope).type === "core.void") {
      throw new EngineError("INVALID_EVENT", "voids are not themselves voidable", {
        eventId: event.id,
        targetId: event.voids,
      });
    }
    voided.add(event.voids);
  });

  return events.filter((event) => event.type !== "core.void" && !voided.has(event.id));
}

// ---------------------------------------------------------------------------
// Fold kernel — spec 03 §2.
// ---------------------------------------------------------------------------

// Structural subset of the SportModule contract (spec 03 §3) the kernel needs;
// the full interface lands with PROMPT-03 and is assignable to this.
export interface FoldableModule<Cfg = unknown, State = unknown> {
  init(cfg: Cfg, lineups: LineupPair): State;
  apply(state: State, event: EventEnvelope): State; // pure; throws EngineError
  outcome(state: State): MatchOutcome | null; // null = still live
  // Sport-declared types still accepted after the outcome is decided
  // (spec 03 §2 guarantee 4).
  postDecisionTypes?: readonly string[];
}

// Core types always accepted post-decision: annotations and the finalize lock.
// core.suspend is deliberately absent — a decided match cannot be suspended.
const POST_DECISION_CORE: readonly string[] = ["core.note", "core.finalize", "core.award"];

// W4 (#407) — the kernel owns core.suspend / core.resume exactly as it owns
// core.void: it validates them, folds them, and NEVER forwards them to
// module.apply. One implementation therefore serves all eleven sports (and
// every future one), no module state moves, and no frozen golden shifts.

/** An open stoppage: play has been suspended and not yet resumed. */
export interface MatchStoppage {
  /** As the official recorded it ("floodlight failure"); never adjudicated. */
  reason?: string;
  /** The `core.suspend` event that opened it — the read side's undo handle. */
  eventId: string;
}

// The only types the ledger accepts while play is suspended: the annotations
// (which have no play effect) and the events that end the stoppage one way or
// the other. Everything else — every sport event, and core.start — is refused
// with WRONG_PHASE, because it claims play happened while play was stopped.
const DURING_STOPPAGE: readonly string[] = [
  "core.resume",
  "core.note",
  "core.award",
  "core.abandon",
  "core.forfeit",
  "core.finalize",
];

// The only state-derivation function in the system (spec 03 §2). Guarantees:
//  1. determinism — referentially transparent, same inputs → deep-equal state;
//  2. validation before append — persistence folds before inserting, so a
//     throwing event never enters the ledger;
//  3. undo = void — resolveVoids strips voided events + voids before modules
//     see anything;
//  4. monotonic decision — once outcome(state) is non-null, further events are
//     rejected (ALREADY_DECIDED) except core.note / core.finalize / the
//     module's declared postDecisionTypes;
//  5. suspended play records nothing (W4) — between a core.suspend and its
//     core.resume the ledger accepts only annotations and the events that end
//     the stoppage; anything else is WRONG_PHASE. Both types are kernel-owned
//     and never reach the module, so no sport had to change to gain them.
//  6. monotonic game time (W4a #425 §3.3) — an event carrying a `GameTime` at
//     `payload.at` may not be stamped earlier than the newest accepted stamp
//     (NON_MONOTONIC_TIME). Equal stamps are legal; unstamped events are
//     unconstrained, so every stream recorded before this wave is unaffected.
export function foldMatch<Cfg, State>(
  module: FoldableModule<Cfg, State>,
  cfg: Cfg,
  lineups: LineupPair,
  events: readonly EventEnvelope[],
): State {
  return foldMatchWithStoppage(module, cfg, lineups, events).state;
}

/** foldMatch plus guarantee 5: the open stoppage, if play is suspended right
 *  now. Same fold, same errors — the state is byte-for-byte what foldMatch
 *  returns, because core.suspend / core.resume never reach the module. */
export function foldMatchWithStoppage<Cfg, State>(
  module: FoldableModule<Cfg, State>,
  cfg: Cfg,
  lineups: LineupPair,
  events: readonly EventEnvelope[],
): { state: State; stoppage: MatchStoppage | null } {
  const active = resolveVoids(events);
  const postDecision = new Set([...POST_DECISION_CORE, ...(module.postDecisionTypes ?? [])]);
  const duringStoppage = new Set(DURING_STOPPAGE);

  let state = module.init(cfg, lineups);
  let decided = false;
  let stoppage: MatchStoppage | null = null;

  // W4a (#425) §3.3 — monotonic time guard. A timer only moves forward, but a
  // manually typed time (§4) can go anywhere, and an out-of-order stamp makes
  // lazy expiry silently wrong: a suspension started at seq 4 / 05:00 would
  // "expire" after one started at seq 3 / 08:00. Guarding here means all eleven
  // modules inherit it from one place and none of them changes.
  //
  // PHASE ORDER, the one non-obvious decision. compareGameTime needs a phase
  // list, and the kernel knows no sport's phases — `playPhases` lives on the
  // period module, not on FoldableModule, and widening that contract for this
  // would touch every sport. So the order is derived generically, as the order
  // of FIRST APPEARANCE of `period` across the stamped events in this stream:
  // a period never seen before is appended, and is therefore later than every
  // period seen so far. That is exactly the semantics wanted — play moves into
  // a new period, never back into an old one — it is sport-agnostic, it needs
  // no module API change, and because a period is registered before it is
  // compared, UNKNOWN_PHASE can never escape this fold.
  const phaseOrder: string[] = [];
  let highWater: GameTime | null = null;

  for (const event of active) {
    validateCoreEvent(event);
    if (decided && !postDecision.has(event.type)) {
      throw new EngineError(
        "ALREADY_DECIDED",
        `event "${event.type}" rejected: match outcome already decided`,
        { eventId: event.id },
      );
    }
    if (stoppage !== null && !duringStoppage.has(event.type)) {
      throw new EngineError(
        "WRONG_PHASE",
        `event "${event.type}" rejected: play is suspended — resume or abandon first`,
        { eventId: event.id, stoppage },
      );
    }
    if (event.type === "core.suspend") {
      // Guarded by the branch above, so this can only be the first suspend.
      const reason = (event.payload as z.infer<typeof CoreSuspend>).reason;
      stoppage = { ...(reason === undefined ? {} : { reason }), eventId: event.id };
      continue; // kernel-owned: the module never sees it
    }
    if (event.type === "core.resume") {
      // A resume with no open stoppage is a NO-OP, not an error. Undo is void
      // (guarantee 3): voiding a mis-entered core.suspend leaves the resume
      // that followed it pointing at nothing, which is meaningless but not
      // contradictory — refusing it made the whole match unfoldable until the
      // scorer also voided the resume, which is not an undo anyone would find.
      stoppage = null;
      continue; // kernel-owned: the module never sees it
    }
    // Two carve-outs, both load-bearing (§3.3):
    //  - An UNSTAMPED event is unconstrained. gameTimeOf returns null for every
    //    payload written before this wave, so no recorded stream changes
    //    meaning — this null is what makes the wave additive. It is neither
    //    checked against the high-water mark nor allowed to advance it.
    //  - An EQUAL stamp is legal. core.suspend and its core.resume share one
    //    (§1.2), and so do two penalties awarded at a single whistle. Only a
    //    strictly earlier stamp throws.
    const at = gameTimeOf(event.payload);
    if (at !== null) {
      if (!phaseOrder.includes(at.period)) phaseOrder.push(at.period);
      if (highWater !== null && compareGameTime(at, highWater, phaseOrder) < 0) {
        throw new EngineError(
          "NON_MONOTONIC_TIME",
          `event "${event.type}" is stamped ${at.period} ${at.elapsed}s, before the newest accepted stamp ${highWater.period} ${highWater.elapsed}s`,
          { eventId: event.id, seq: event.seq, at, previous: highWater },
        );
      }
      highWater = at;
    }
    state = module.apply(state, event);
    if (!decided) {
      decided = module.outcome(state) !== null;
      // A decided match is not awaiting resumption. core.abandon and
      // core.forfeit are both legal mid-stoppage and both decide, and
      // core.resume is not a post-decision type — so a stoppage left open here
      // could never be cleared, and the read side would show an abandoned
      // match as "play suspended, awaiting restart" forever.
      if (decided) stoppage = null;
    }
  }
  return { state, stoppage };
}
