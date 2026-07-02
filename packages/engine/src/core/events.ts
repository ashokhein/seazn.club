// EventEnvelope, fold kernel, void semantics — spec 03 §2.
// foldMatch is the ONLY state-derivation function in the system.
import { z } from "zod";
import { EngineError } from "./errors.ts";
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

export const CORE_EVENT_SCHEMAS = {
  "core.start": CoreStart,
  "core.void": CoreVoid,
  "core.forfeit": CoreForfeit,
  "core.abandon": CoreAbandon,
  "core.finalize": CoreFinalize,
  "core.note": CoreNote,
} as const;

export type CoreEventType = keyof typeof CORE_EVENT_SCHEMAS;

// Payload union modules see in apply(): EventEnvelope<Ev | CoreEv> (spec 03 §3).
export type CoreEv =
  | z.infer<typeof CoreStart>
  | z.infer<typeof CoreForfeit>
  | z.infer<typeof CoreAbandon>
  | z.infer<typeof CoreFinalize>
  | z.infer<typeof CoreNote>;

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
const POST_DECISION_CORE: readonly string[] = ["core.note", "core.finalize"];

// The only state-derivation function in the system (spec 03 §2). Guarantees:
//  1. determinism — referentially transparent, same inputs → deep-equal state;
//  2. validation before append — persistence folds before inserting, so a
//     throwing event never enters the ledger;
//  3. undo = void — resolveVoids strips voided events + voids before modules
//     see anything;
//  4. monotonic decision — once outcome(state) is non-null, further events are
//     rejected (ALREADY_DECIDED) except core.note / core.finalize / the
//     module's declared postDecisionTypes.
export function foldMatch<Cfg, State>(
  module: FoldableModule<Cfg, State>,
  cfg: Cfg,
  lineups: LineupPair,
  events: readonly EventEnvelope[],
): State {
  const active = resolveVoids(events);
  const postDecision = new Set([...POST_DECISION_CORE, ...(module.postDecisionTypes ?? [])]);

  let state = module.init(cfg, lineups);
  let decided = false;
  for (const event of active) {
    validateCoreEvent(event);
    if (decided && !postDecision.has(event.type)) {
      throw new EngineError(
        "ALREADY_DECIDED",
        `event "${event.type}" rejected: match outcome already decided`,
        { eventId: event.id },
      );
    }
    state = module.apply(state, event);
    if (!decided) decided = module.outcome(state) !== null;
  }
  return state;
}
