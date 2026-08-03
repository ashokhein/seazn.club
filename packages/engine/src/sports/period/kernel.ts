// Period scoring kernel — v6/00 §3 + v6/01 §2/§3. Generalizes football's
// phase machine: n timed periods (3 for IIHF, 4 quarters for FIH), an
// overtime policy (sudden-death OT or fixed extra periods), the shared
// shootout primitive and the timed-suspension track (power-play strength,
// PIM, cards — the team plays short on every FIH card). Goals carry scorer,
// assists and a kind (PP/SH/PS · FG/PC/stroke) for the stats ledger.
//
// The engine has NO clock (v6/00 §6.1): periods advance and suspensions end
// by scorer events only; elapsed displays are UI sugar from recorded_at.
// Penalty LAW is not adjudicated (v6/00 §6.4): the module records what the
// scorer decides (coincidentals, delayed penalties → core.note for context).
import { z } from "zod";
import { EngineError } from "../../core/errors.ts";
import { resolveVoids, type CoreEv, type EventEnvelope } from "../../core/events.ts";
import type { Rng } from "../../core/rng.ts";
import {
  AttemptOutcome,
  EntrantId,
  type DisciplineCard,
  type DisciplineModel,
  type LineupPair,
  type MatchOutcome,
  type MetricSpec,
  type ScoreSummary,
  type StageCtx,
  type StageKind,
  type StandingsDelta,
} from "../../core/types.ts";
import type { PositionCatalog } from "../../sport/catalog.ts";
import type {
  FidelityTier,
  ModuleEvent,
  SportModule,
  TiebreakerKey,
} from "../../sport/module.ts";
import type { PlayerStatsModel } from "../../stats/stats.ts";
import type { EntrantModel } from "../../sport/entrant-model.ts";
import {
  escalationHints,
  pimOf,
  strengthChip,
  strengthOf,
  type ActiveSuspension,
  type CardRecordEntry,
  type SuspensionClass,
  type SuspensionCfg,
} from "./suspensions.ts";
import {
  expectedKicker,
  shootoutDecision,
  shootoutTally,
  type ShootoutKick,
} from "./shootout.ts";

// ---------------------------------------------------------------------------
// Cfg — v6/00 §3
// ---------------------------------------------------------------------------

export interface PeriodParams {
  periods: { count: number; minutes: number };
  overtime:
    | null
    | { kind: "sudden_death"; minutes: number; skaters?: number }
    | { kind: "periods"; count: number; minutes: number };
  shootout: null | { attempts: number; suddenDeath: boolean; clockSeconds?: number };
  points: {
    win: number;
    draw: number;
    loss: number;
    otWin?: number;
    otLoss?: number;
    shootoutWin?: number;
    shootoutLoss?: number;
  };
  suspensions: SuspensionCfg | null;
  strength: { base: number; min: number };
  goalKinds: string[]; // allowed goal kinds beyond plain fg ('og' credits opponent)
  assists: boolean; // ice: up to 2 assists per goal feed player stats
  awardScore: { goals: number };
  abandonPolicy: "replay" | "award";
}

// W4 (#407) — resolved-config knobs that are deliberately NOT PeriodParams
// fields. `goalkeeper` is lineup data with no preset default. `setPieceKinds`
// DOES have a preset default (W4 review item 4): the preset seeds the list, a
// competition may replace it, and emptying it turns the event off.
export type PeriodCfg = PeriodParams & {
  goalkeeper?: "required" | "optional";
  setPieceKinds: string[];
};

const SuspensionClassSchema: z.ZodType<SuspensionClass> = z.object({
  minutes: z.number().int().positive().nullable(),
  teamShort: z.boolean(),
  pim: z.number().int().nonnegative().optional(),
  permanent: z.boolean().optional(),
});

export function makePeriodConfigSchema(
  defaults: PeriodParams,
  setPieceKinds: readonly string[] = [],
) {
  return z.object({
    // W4 review item 4 — which restarts this competition records as AWARDED
    // (FIH penalty corner / stroke, IIHF penalty shot). These used to be read
    // off a compile-time preset field because a new cfg key was believed to
    // break replay for every recorded stream; the golden has compared `cfg` as
    // a SUBSET since W4, so a defaulted knob is additive and reds nothing.
    // Seeded from the preset; an empty list means this sport records no set
    // pieces and the fold refuses the event outright.
    setPieceKinds: z.array(z.string().min(1)).default([...setPieceKinds]),
    // W4 (#407) — FIH Rule 4 lets a team play with a goalkeeper, with a field
    // player holding goalkeeping privileges, or with none at all; IIHF Rule 6
    // lets a team pull its goaltender. The catalog forced GK min 1 max 1, so a
    // side playing out with an empty net — the very situation the `emptyNet`
    // goal kind records — could not be written down as a lineup. Lineup data
    // only: it drives `positionsFor` and never the fold. Optional with no
    // default so `state.cfg` serialises exactly as it did before W4.
    goalkeeper: z.enum(["required", "optional"]).optional(),
    periods: z
      .object({
        count: z.number().int().min(1).max(4),
        minutes: z.number().int().positive(),
      })
      .default(defaults.periods),
    overtime: z
      .union([
        z.null(),
        z.strictObject({
          kind: z.literal("sudden_death"),
          minutes: z.number().int().positive(),
          skaters: z.number().int().positive().optional(),
        }),
        z.strictObject({
          kind: z.literal("periods"),
          count: z.number().int().positive(),
          minutes: z.number().int().positive(),
        }),
      ])
      .default(defaults.overtime),
    shootout: z
      .union([
        z.null(),
        z.strictObject({
          attempts: z.number().int().positive(),
          suddenDeath: z.boolean(),
          clockSeconds: z.number().int().positive().optional(),
        }),
      ])
      .default(defaults.shootout),
    points: z
      .object({
        win: z.number().int().nonnegative(),
        draw: z.number().int().nonnegative(),
        loss: z.number().int().nonnegative(),
        otWin: z.number().int().nonnegative().optional(),
        otLoss: z.number().int().nonnegative().optional(),
        shootoutWin: z.number().int().nonnegative().optional(),
        shootoutLoss: z.number().int().nonnegative().optional(),
      })
      .default(defaults.points),
    suspensions: z
      .union([z.null(), z.object({ classes: z.record(z.string().min(1), SuspensionClassSchema) })])
      .default(defaults.suspensions),
    strength: z
      .object({ base: z.number().int().positive(), min: z.number().int().positive() })
      .default(defaults.strength),
    goalKinds: z.array(z.string().min(1)).default(defaults.goalKinds),
    assists: z.boolean().default(defaults.assists),
    awardScore: z.object({ goals: z.number().int().positive() }).default(defaults.awardScore),
    abandonPolicy: z.enum(["replay", "award"]).default(defaults.abandonPolicy),
  });
}

// ---------------------------------------------------------------------------
// Events — v6/00 §3
// ---------------------------------------------------------------------------

const PersonId = z.string().min(1);

export const PeriodGoal = z.strictObject({
  by: EntrantId, // for kind 'og': the side whose player struck it (credits opponent)
  person: PersonId.optional(),
  assists: z.array(PersonId).max(2).optional(),
  kind: z.string().min(1).optional(), // validated against cfg.goalKinds
  period: z.string().min(1).optional(), // the scorer's own period label for the log
  // W4 (#407) — empty-net goal. Orthogonal to `kind`: IIHF situation codes
  // stack (an SH-EN goal is both), and FIH sides also pull the keeper for an
  // extra outfielder, so this rides beside the kind rather than inside it.
  emptyNet: z.boolean().optional(),
  clockRef: z.string().min(1).optional(), // scorer's clock note ("12:41"), display only
});
export const PeriodAdvance = z.strictObject({
  to: z.string().min(1), // must match the kernel's expected next phase
});
export const PeriodSuspensionStart = z.strictObject({
  by: EntrantId,
  person: PersonId.optional(),
  class: z.string().min(1),
  clockRef: z.string().min(1).optional(), // scorer's clock note, display only
  // W4 (#407) — the rest of an IIHF penalty row / FIH card row. See
  // SuspensionDetail in ./suspensions.ts for what each one is.
  reason: z.string().min(1).optional(),
  servedBy: PersonId.optional(),
  minutes: z.number().int().positive().optional(),
});
export const PeriodSuspensionEnd = z.strictObject({
  by: EntrantId,
  person: PersonId.optional(),
  class: z.string().min(1).optional(),
});
export const PeriodShootoutAttempt = z.strictObject({
  by: EntrantId,
  person: PersonId.optional(),
  scored: z.boolean(),
  // W4 (#407) — the keeper facing the attempt; both sheets name him.
  goalkeeper: PersonId.optional(),
  meta: z
    .strictObject({
      clockSeconds: z.number().int().positive().optional(), // FIH 8 s attempt
      ineligible: z.boolean().optional(), // GWS penalty-box flag, recorded only
    })
    .optional(),
});

// W4 (#407) — a set piece AWARDED, converted or not: the FIH match record's
// penalty-corner and penalty-stroke counts, and the IIHF penalty shot that the
// goal kinds can only ever show once it beat the keeper. `kind` is validated
// against `cfg.setPieceKinds` (seeded from the preset), so a competition that
// declares none rejects the event outright.
export const PeriodSetPiece = z.strictObject({
  by: EntrantId, // the side awarded it
  kind: z.string().min(1), // 'pc' | 'stroke' (FIH) · 'ps' (IIHF)
  person: PersonId.optional(), // the taker
  goalkeeper: PersonId.optional(), // the keeper defending it
  // W4 review item 2 — the SHARED attempt vocabulary (core/types.ts), the same
  // key football's open-play penalty carries. `scored` is what the pre-review
  // `converted: true` meant; the goal itself still arrives as a goal event, so
  // the two never double-count the score. ABSENT ⇒ the scorer recorded no
  // result, which the tally reads exactly as it read `converted: false`.
  outcome: AttemptOutcome.optional(),
  clockRef: z.string().min(1).optional(),
});

// NOTE (union order): branches are told apart structurally and the first match
// wins, so every new branch goes LAST — a set-piece payload is a structural
// subset of a goal and must never be able to displace one. `apply` dispatches
// on the ENVELOPE type, so the union only has to stay a superset of every
// legal payload; period-audit.test.ts pins both halves of that.
export const PeriodEv = z.union([
  PeriodGoal,
  PeriodAdvance,
  PeriodSuspensionStart,
  PeriodSuspensionEnd,
  PeriodShootoutAttempt,
  PeriodSetPiece,
]);
export type PeriodEv = z.infer<typeof PeriodEv>;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

type Side = "home" | "away";

export interface PeriodScore {
  phase: string;
  home: number;
  away: number;
}

// W4 (#407) — one attributed goal as the scoresheet writes it. Appended only
// when the goal names a person or carries scoresheet detail; a coarse goal
// (side + kind only) adds nothing the counters do not already hold, and leaving
// it out is what keeps `goalLog` ABSENT — and the frozen golden states
// byte-identical — for streams recorded before this wave.
export interface GoalLogEntry {
  phase: string; // the scorer's `period`, else the phase the fold was in
  by: Side; // the side whose player struck it
  credited: Side; // differs from `by` for an own goal
  person?: string;
  assists?: string[]; // ordered: A1 then A2 (IIHF)
  kind?: string;
  emptyNet?: boolean;
  clockRef?: string;
}

export interface SetPieceTally {
  awarded: number;
  /** Attempts whose `outcome` was `scored` — the counter the FIH match record
   *  prints beside the awarded count. Named for the token that feeds it. */
  scored: number;
}

export interface PeriodState {
  cfg: PeriodCfg;
  entrants: { home: string; away: string };
  phase: string; // 'pre' | play label (P1/Q3/OT/OT2) | 'SHOOTOUT' | 'done' | 'final' | 'abandoned'
  goals: { home: number; away: number }; // regulation + OT (shootout excluded)
  periods: PeriodScore[]; // per-phase breakdown in play order
  suspensions: ActiveSuspension[]; // currently running
  cardLog: CardRecordEntry[]; // every suspension.start, immutable
  kindCounts: { home: Record<string, number>; away: Record<string, number> };
  shootout: { kicks: ShootoutKick[] } | null;
  outcome: MatchOutcome | null;
  replayFlagged: boolean;
  /** W4 — attributed goals, in order. Absent until one goal carries detail. */
  goalLog?: GoalLogEntry[];
  /** W4 — set pieces awarded/converted per side per kind. Absent until one is
   *  recorded. */
  setPieces?: { home: Record<string, SetPieceTally>; away: Record<string, SetPieceTally> };
}

function opponent(side: Side): Side {
  return side === "home" ? "away" : "home";
}

/** Generator helper: one rng draw → one shared attempt token, weighted so most
 *  set pieces do not convert (FIH corners convert well under half the time). */
function attemptOutcome(draw: number): AttemptOutcome {
  return draw < 0.3 ? "scored" : draw < 0.6 ? "saved" : draw < 0.8 ? "missed" : "post";
}

function invalid(message: string, data?: unknown): never {
  throw new EngineError("INVALID_EVENT", message, data);
}

function wrongPhase(message: string, data?: unknown): never {
  throw new EngineError("WRONG_PHASE", message, data);
}

function sideOf(state: PeriodState, entrantId: string): Side {
  if (entrantId === state.entrants.home) return "home";
  if (entrantId === state.entrants.away) return "away";
  invalid(`unknown entrant "${entrantId}"`, { entrantId });
}

function parsePayload<T>(schema: z.ZodType<T>, payload: unknown, type: string): T {
  const parsed = schema.safeParse(payload);
  if (!parsed.success) invalid(`invalid ${type} payload`, { issues: parsed.error.issues });
  return parsed.data;
}

// ---------------------------------------------------------------------------
// Phase machine — P1..Pn (Q1..Q4 for quarters, H1/H2 for halves), then OT
// (sudden death) or OT1..OTk (fixed extra periods), then SHOOTOUT.
// ---------------------------------------------------------------------------

export function periodLabels(cfg: PeriodCfg): string[] {
  const n = cfg.periods.count;
  if (n === 4) return ["Q1", "Q2", "Q3", "Q4"];
  if (n === 2) return ["H1", "H2"];
  return Array.from({ length: n }, (_, i) => `P${i + 1}`);
}

function otLabels(cfg: PeriodCfg): string[] {
  if (cfg.overtime === null) return [];
  if (cfg.overtime.kind === "sudden_death") return ["OT"];
  return Array.from({ length: cfg.overtime.count }, (_, i) =>
    cfg.overtime !== null && "count" in cfg.overtime && cfg.overtime.count === 1
      ? "OT"
      : `OT${i + 1}`,
  );
}

// The phases in which PLAY is running, so goals count and the clock is on.
// Deliberately NOT the same list as `playPhases` below — "pre" and "SHOOTOUT"
// are phases of the match without being phases of play, and conflating the two
// is what made a stamped shootout card unorderable.
function scoringPhases(cfg: PeriodCfg): string[] {
  return [...periodLabels(cfg), ...otLabels(cfg)];
}

function isPlayPhase(state: PeriodState): boolean {
  return scoringPhases(state.cfg).includes(state.phase);
}

/**
 * THE phase order for this cfg — W4a (#425) §7. Every phase in which a STAMPED
 * event may legally occur, in the order they occur, and nothing else.
 *
 * One function, two consumers, by contract: the fold kernel's monotonic guard
 * reads it via `SportModule.playPhases`, and every `compareGameTime` call the
 * module makes inside `apply()` passes this same function's result. Two lists
 * that merely agree today is the defect this exists to prevent — an event the
 * guard accepts is then backwards one layer down, and lazy expiry (§3.1) sweeps
 * against an order nothing agrees on. `phases.test.ts` asserts the module holds
 * this exact function reference, so a sport that builds its own copy fails.
 *
 * WIDER than `scoringPhases`, and that is the point:
 *  - "pre" — a card before the opening whistle is legal (`suspensionAllowed`),
 *    and so is a stoppage: a floodlight failure during the warm-up.
 *  - "SHOOTOUT" — cards are legal there too, and it sorts LAST, after any
 *    overtime, because that is when it happens. Listed only when this cfg can
 *    reach it (`resolveEnd` enters it only when `cfg.shootout !== null`).
 *  - "done" is excluded: nothing stamped is accepted once the match is decided.
 *
 * Exhaustive by obligation, not by construction — the fold treats a period
 * outside this list as a bad payload field, so anything omitted here is an
 * event the scorer cannot record.
 */
export function playPhases(cfg: PeriodCfg): string[] {
  return [
    "pre",
    ...scoringPhases(cfg),
    ...(cfg.shootout === null ? [] : ["SHOOTOUT"]),
  ];
}

function inOvertime(state: PeriodState): boolean {
  return otLabels(state.cfg).includes(state.phase);
}

// The one `to` value the next period.advance may carry from this phase; "FT"
// closes the final regulation/OT period and resolves the result.
export function expectedAdvance(state: PeriodState): string | null {
  const regs = periodLabels(state.cfg);
  const ots = otLabels(state.cfg);
  const regIndex = regs.indexOf(state.phase);
  if (regIndex >= 0) return regIndex < regs.length - 1 ? (regs[regIndex + 1] as string) : "FT";
  const otIndex = ots.indexOf(state.phase);
  if (otIndex >= 0) return otIndex < ots.length - 1 ? (ots[otIndex + 1] as string) : "FT";
  return null;
}

function pushPeriod(state: PeriodState, phase: string): PeriodState {
  return { ...state, phase, periods: [...state.periods, { phase, home: 0, away: 0 }] };
}

function decideWin(state: PeriodState, winnerSide: Side, method: string): PeriodState {
  return {
    ...state,
    phase: "done",
    outcome: {
      kind: "win",
      winner: state.entrants[winnerSide],
      loser: state.entrants[opponent(winnerSide)],
      method,
    },
  };
}

// Level-score resolution when the last regulation (or OT) period closes:
// leader wins; a level score runs the overtime policy, then the shootout,
// and only then is a draw (league semantics; supportsDraws gates finalize).
function resolveEnd(state: PeriodState, after: "regulation" | "overtime"): PeriodState {
  const { home, away } = state.goals;
  if (home !== away) {
    return decideWin(state, home > away ? "home" : "away", after === "regulation" ? "regulation" : "extra_time");
  }
  if (after === "regulation" && state.cfg.overtime !== null) {
    return pushPeriod(state, otLabels(state.cfg)[0] as string);
  }
  if (state.cfg.shootout !== null) {
    return { ...state, phase: "SHOOTOUT", shootout: { kicks: [] } };
  }
  return { ...state, phase: "done", outcome: { kind: "draw" } };
}

// ---------------------------------------------------------------------------
// Event application
// ---------------------------------------------------------------------------

function creditGoal(state: PeriodState, credited: Side): PeriodState {
  const periods = state.periods.map((period, i) =>
    i === state.periods.length - 1 ? { ...period, [credited]: period[credited] + 1 } : period,
  );
  return {
    ...state,
    goals: { ...state.goals, [credited]: state.goals[credited] + 1 },
    periods,
  };
}

function applyGoal(state: PeriodState, payload: z.infer<typeof PeriodGoal>): PeriodState {
  if (!isPlayPhase(state)) {
    wrongPhase(`goal not allowed in phase "${state.phase}"`, { phase: state.phase });
  }
  const by = sideOf(state, payload.by);
  const kind = payload.kind;
  if (kind !== undefined && kind !== "fg" && kind !== "og" && !state.cfg.goalKinds.includes(kind)) {
    invalid(`goal kind "${kind}" is not valid for this sport`, { kind });
  }
  if (payload.assists !== undefined && payload.assists.length > 0) {
    if (!state.cfg.assists) invalid("this sport does not record assists");
    if (kind === "og") invalid("an own goal cannot carry assists");
  }
  const credited = kind === "og" ? opponent(by) : by;
  let next = creditGoal(state, credited);
  if (kind !== undefined && kind !== "og" && kind !== "fg") {
    const counts = { ...next.kindCounts[credited], [kind]: (next.kindCounts[credited][kind] ?? 0) + 1 };
    next = { ...next, kindCounts: { ...next.kindCounts, [credited]: counts } };
  }
  // W4 — attributed goals join the log. The trigger is scoresheet DETAIL, not
  // the mere presence of a goal: a side-only goal is fully described by the
  // counters above, and gating on detail is what keeps pre-W4 folds identical.
  // W4 review item 7 — `assists` is attribution too. Leaving it out of the
  // trigger meant a goal recorded as "assisted by A1, scorer not named" logged
  // nothing, so the state-side scoresheet lost the assists entirely; they only
  // survived in the player metrics, which read the ledger.
  if (
    payload.person !== undefined ||
    payload.clockRef !== undefined ||
    payload.emptyNet !== undefined ||
    (payload.assists !== undefined && payload.assists.length > 0)
  ) {
    const entry: GoalLogEntry = {
      phase: payload.period ?? next.phase,
      by,
      credited,
      ...(payload.person === undefined ? {} : { person: payload.person }),
      ...(payload.assists === undefined || payload.assists.length === 0
        ? {}
        : { assists: payload.assists }),
      ...(kind === undefined ? {} : { kind }),
      ...(payload.emptyNet === undefined ? {} : { emptyNet: payload.emptyNet }),
      ...(payload.clockRef === undefined ? {} : { clockRef: payload.clockRef }),
    };
    next = { ...next, goalLog: [...(next.goalLog ?? []), entry] };
  }
  // Sudden-death overtime: the first goal ends it (IIHF Rule 84.1).
  if (inOvertime(next) && next.cfg.overtime?.kind === "sudden_death") {
    return decideWin(next, credited, "extra_time");
  }
  return next;
}

function applyAdvance(state: PeriodState, payload: z.infer<typeof PeriodAdvance>): PeriodState {
  const expected = expectedAdvance(state);
  if (expected === null) {
    wrongPhase(`period advance not allowed in phase "${state.phase}"`);
  }
  if (payload.to !== expected) {
    invalid(`expected advance to "${expected}", got "${payload.to}"`, { expected, to: payload.to });
  }
  if (expected !== "FT") return pushPeriod(state, expected);
  return resolveEnd(state, inOvertime(state) ? "overtime" : "regulation");
}

function suspensionAllowed(state: PeriodState): boolean {
  // Cards happen pre-kickoff, in play and during a shootout — never once the
  // match is decided (mirrors football's card window).
  return state.phase === "pre" || isPlayPhase(state) || state.phase === "SHOOTOUT";
}

function applySuspensionStart(
  state: PeriodState,
  payload: z.infer<typeof PeriodSuspensionStart>,
): PeriodState {
  if (state.cfg.suspensions === null) invalid("this sport does not track suspensions");
  if (!suspensionAllowed(state)) {
    wrongPhase(`suspension not allowed in phase "${state.phase}"`);
  }
  const side = sideOf(state, payload.by);
  const cls = state.cfg.suspensions.classes[payload.class];
  if (cls === undefined) {
    invalid(`unknown suspension class "${payload.class}"`, { class: payload.class });
  }
  // W4 — the scoresheet detail rides along, and only when recorded: an
  // undetailed card must still fold to exactly its pre-W4 shape.
  const detail = {
    ...(payload.reason === undefined ? {} : { reason: payload.reason }),
    ...(payload.servedBy === undefined ? {} : { servedBy: payload.servedBy }),
    ...(payload.minutes === undefined ? {} : { minutes: payload.minutes }),
  };
  const active: ActiveSuspension = {
    side,
    ...(payload.person === undefined ? {} : { person: payload.person }),
    classKey: payload.class,
    teamShort: cls.teamShort,
    permanent: cls.permanent === true,
    ...detail,
  };
  const record: CardRecordEntry = {
    side,
    ...(payload.person === undefined ? {} : { person: payload.person }),
    classKey: payload.class,
    ...detail,
  };
  return {
    ...state,
    suspensions: [...state.suspensions, active],
    cardLog: [...state.cardLog, record],
  };
}

function applySuspensionEnd(
  state: PeriodState,
  payload: z.infer<typeof PeriodSuspensionEnd>,
): PeriodState {
  if (state.cfg.suspensions === null) invalid("this sport does not track suspensions");
  if (!suspensionAllowed(state)) {
    wrongPhase(`suspension release not allowed in phase "${state.phase}"`);
  }
  const side = sideOf(state, payload.by);
  const index = state.suspensions.findIndex(
    (s) =>
      s.side === side &&
      !s.permanent &&
      (payload.person === undefined || s.person === payload.person) &&
      (payload.class === undefined || s.classKey === payload.class),
  );
  if (index < 0) {
    invalid("no matching running suspension to release", {
      by: payload.by,
      person: payload.person,
      class: payload.class,
    });
  }
  return { ...state, suspensions: state.suspensions.filter((_, i) => i !== index) };
}

function applyShootoutAttempt(
  state: PeriodState,
  payload: z.infer<typeof PeriodShootoutAttempt>,
): PeriodState {
  if (state.phase !== "SHOOTOUT" || state.shootout === null || state.cfg.shootout === null) {
    wrongPhase(`shootout attempt in phase "${state.phase}"`);
  }
  const side = sideOf(state, payload.by);
  const expected = expectedKicker(state.shootout.kicks);
  if (expected !== null && side !== expected) {
    invalid(`attempts must alternate: expected "${state.entrants[expected]}"`, {
      expected: state.entrants[expected],
    });
  }
  // W4 — taker + defending keeper join the kick when recorded (absent keys keep
  // the pre-W4 kick shape byte-identical).
  const kick: ShootoutKick = {
    side,
    scored: payload.scored,
    ...(payload.person === undefined ? {} : { person: payload.person }),
    ...(payload.goalkeeper === undefined ? {} : { goalkeeper: payload.goalkeeper }),
  };
  const kicks = [...state.shootout.kicks, kick];
  const winnerSide = shootoutDecision(kicks, state.cfg.shootout.attempts);
  if (winnerSide === null) return { ...state, shootout: { kicks } };
  return { ...decideWin(state, winnerSide, "shootout"), shootout: { kicks } };
}

// W4 (#407) — a set piece awarded. `outcome` is the scorer's own answer to
// "how did it finish"; the goal itself still arrives as a goal event, so the
// two never double-count the score.
//
// The allowed kinds come from `cfg.setPieceKinds`, seeded from the preset
// (W4 review item 4). They used to be a compile-time preset constant, on the
// belief that "a new cfg key would break replay for every recorded stream" —
// which stopped being true when the golden started comparing `cfg` as a SUBSET
// (see testkit/golden.ts). An empty list means this sport records no set
// pieces at all.
function applySetPiece(
  state: PeriodState,
  payload: z.infer<typeof PeriodSetPiece>,
): PeriodState {
  const allowedKinds = state.cfg.setPieceKinds;
  if (allowedKinds.length === 0) {
    invalid("this sport does not record set pieces");
  }
  if (!isPlayPhase(state)) {
    wrongPhase(`set piece not allowed in phase "${state.phase}"`, { phase: state.phase });
  }
  const side = sideOf(state, payload.by);
  if (!allowedKinds.includes(payload.kind)) {
    invalid(`set piece kind "${payload.kind}" is not valid for this sport`, { kind: payload.kind });
  }
  const base = state.setPieces ?? { home: {}, away: {} };
  const previous = base[side][payload.kind] ?? { awarded: 0, scored: 0 };
  const tally: SetPieceTally = {
    awarded: previous.awarded + 1,
    scored: previous.scored + (payload.outcome === "scored" ? 1 : 0),
  };
  return {
    ...state,
    setPieces: { ...base, [side]: { ...base[side], [payload.kind]: tally } },
  };
}

function applyForfeit(state: PeriodState, by: string): PeriodState {
  if (state.phase === "done" || state.phase === "final" || state.phase === "abandoned") {
    wrongPhase("match already over");
  }
  const winnerSide = opponent(sideOf(state, by));
  const goals =
    winnerSide === "home"
      ? { home: state.cfg.awardScore.goals, away: 0 }
      : { home: 0, away: state.cfg.awardScore.goals };
  return {
    ...state,
    phase: "done",
    goals,
    outcome: { kind: "award", winner: state.entrants[winnerSide], score: goals },
  };
}

function applyAbandon(state: PeriodState): PeriodState {
  if (state.phase === "done" || state.phase === "final" || state.phase === "abandoned") {
    wrongPhase("match already over");
  }
  if (state.cfg.abandonPolicy === "replay") {
    return { ...state, phase: "abandoned", replayFlagged: true };
  }
  const { home, away } = state.goals;
  if (home === away) return { ...state, phase: "done", outcome: { kind: "no_result" } };
  const winnerSide: Side = home > away ? "home" : "away";
  return {
    ...state,
    phase: "done",
    outcome: { kind: "award", winner: state.entrants[winnerSide], score: { home, away } },
  };
}

// ---------------------------------------------------------------------------
// Standings — OT-aware points (v6/01 §2 Event Code §219: 3-2-1-0).
// ---------------------------------------------------------------------------

function winPoints(cfg: PeriodCfg, method: string | undefined): [number, number] {
  if (method === "shootout") {
    return [
      cfg.points.shootoutWin ?? cfg.points.otWin ?? cfg.points.win,
      cfg.points.shootoutLoss ?? cfg.points.otLoss ?? cfg.points.loss,
    ];
  }
  if (method === "extra_time") {
    return [cfg.points.otWin ?? cfg.points.win, cfg.points.otLoss ?? cfg.points.loss];
  }
  return [cfg.points.win, cfg.points.loss];
}

// ---------------------------------------------------------------------------
// Preset wiring
// ---------------------------------------------------------------------------

export interface PeriodPreset {
  key: string; // 'icehockey' | 'hockey' (football migrates later)
  version: string;
  defaults: PeriodParams;
  variants: Record<string, Partial<PeriodParams>>;
  positions: PositionCatalog;
  // W4 (#407) — which `positions.groups` key is the goalkeeper, so the kernel
  // can relax its minimum when a competition sets `goalkeeper: "optional"`.
  // The vocabulary is the sport's, not the kernel's: FIH says GK, IIHF says G.
  // Omitted ⇒ the sport has no keeper and the config knob does nothing.
  keeperGroup?: string;
  metrics: MetricSpec[];
  defaultTiebreakers: TiebreakerKey[];
  officialLabel: { scorer: string };
  shootoutLabel: string; // 'GWS' (ice) | 'SO' (FIH)
  timelineEntitlement: string; // FeatureKey for tier-2/3 attributed scoring
  playerStats?: PlayerStatsModel;
  entrantModel?: EntrantModel;
  // SPEC-1 — the card/penalty classes the discipline rules editor may offer
  // (a superset/relabel of the suspension classes). Omitted → derived from the
  // suspension class keys; absent suspensions → no discipline descriptor.
  disciplineColors?: { key: string; label: string }[];
  // W4 (#407) — the DEFAULT set pieces this sport records as AWARDED, not just
  // scored (FIH penalty corner / stroke, IIHF penalty shot). Seeds
  // `cfg.setPieceKinds`, which a competition may replace. Omitted → the sport
  // has no `<key>.set_piece` event: it is absent from every fidelity tier, and
  // the default empty list makes the fold reject it.
  setPieceKinds?: string[];
}

export function makePeriodModule(
  preset: PeriodPreset,
): SportModule<PeriodCfg, PeriodEv, PeriodState> {
  const configSchema = makePeriodConfigSchema(preset.defaults, preset.setPieceKinds ?? []);
  const goalType = `${preset.key}.goal`;
  const advanceType = `${preset.key}.period.advance`;
  const suspStartType = `${preset.key}.suspension.start`;
  const suspEndType = `${preset.key}.suspension.end`;
  const attemptType = `${preset.key}.shootout.attempt`;
  const setPieceType = `${preset.key}.set_piece`;
  const setPieceKinds = preset.setPieceKinds;

  // Set pieces are attributed-scoring detail (who took it, did it convert), so
  // they join tiers 2/3 only — a tier-0 scorer taps goals, not awards.
  const attributed = [goalType, advanceType, attemptType, suspStartType, suspEndType];
  const attributedTypes = setPieceKinds === undefined ? attributed : [...attributed, setPieceType];
  const fidelityTiers: FidelityTier[] = [
    { tier: 0, eventTypes: [goalType, advanceType, attemptType] },
    { tier: 1, eventTypes: [goalType, advanceType, attemptType] },
    { tier: 2, eventTypes: attributedTypes, entitlement: preset.timelineEntitlement },
    { tier: 3, eventTypes: attributedTypes, entitlement: preset.timelineEntitlement },
  ];

  // SPEC-1 — read-only card projection over the suspension.start events (voids
  // un-count). Colours come from disciplineColors, else the suspension class
  // keys humanised. Sports without a suspension track get no descriptor.
  const discipline: DisciplineModel | undefined =
    preset.defaults.suspensions === null
      ? undefined
      : {
          colors:
            preset.disciplineColors ??
            Object.keys(preset.defaults.suspensions.classes).map((key) => ({
              key,
              label: key.replace(/_/g, " ").replace(/^./, (ch) => ch.toUpperCase()),
            })),
          extractCards(ledger): DisciplineCard[] {
            const cards: DisciplineCard[] = [];
            for (const ev of resolveVoids(ledger)) {
              if (ev.type !== suspStartType) continue;
              const parsed = PeriodSuspensionStart.safeParse(ev.payload);
              if (!parsed.success) continue;
              const card = parsed.data;
              cards.push({
                ...(card.person === undefined ? {} : { personId: card.person }),
                entrantSide: card.by,
                color: card.class,
                eventId: ev.id,
                // W4 — the scoresheet detail the fold already keeps in
                // `cardLog` (SuspensionDetail) now reaches the projection too,
                // so a suspension tariff can key on the infraction and a bench
                // minor accumulates against the player who actually sits.
                ...(card.reason === undefined ? {} : { reason: card.reason }),
                ...(card.servedBy === undefined ? {} : { servedBy: card.servedBy }),
              });
            }
            return cards;
          },
        };

  const sideMetrics = (state: PeriodState, side: Side, zero: boolean): Record<string, number> => {
    const opp = opponent(side);
    const gf = zero ? 0 : state.goals[side];
    const ga = zero ? 0 : state.goals[opp];
    const out: Record<string, number> = { gf, ga, gd: gf - ga };
    if (state.cfg.suspensions !== null) {
      const classes = state.cfg.suspensions.classes;
      let pim = 0;
      const cardCounts: Record<string, number> = {};
      for (const entry of state.cardLog) {
        if (entry.side !== side) continue;
        const cls = classes[entry.classKey];
        if (cls === undefined) continue;
        pim += pimOf(cls);
        cardCounts[entry.classKey] = (cardCounts[entry.classKey] ?? 0) + 1;
      }
      out.pim = pim;
      for (const key of Object.keys(classes)) {
        out[`cards_${key}`] = cardCounts[key] ?? 0;
      }
    }
    for (const kind of state.cfg.goalKinds) {
      if (kind === "fg" || kind === "og") continue;
      out[`goals_${kind}`] = zero ? 0 : (state.kindCounts[side][kind] ?? 0);
    }
    return out;
  };

  return {
    key: preset.key,
    version: preset.version,
    configSchema,
    eventSchema: PeriodEv,
    positions: preset.positions,
    // W4a (#425) §7 — the fold's monotonic time guard orders stamps by this
    // list. Handed over as the function itself, not as a wrapper computing its
    // own: the module's `apply()` calls the same export, so the guard and the
    // fold can never order against two different lists.
    playPhases,
    // W4 (#407) — one implementation serves every period sport: when the
    // competition makes the keeper optional, the GK group's minimum drops to
    // zero while its maximum stays 1 (nobody fields two keepers). Absent ⇒ the
    // preset's own catalog, byte-for-byte.
    positionsFor(cfg) {
      const keeper = preset.keeperGroup;
      if (cfg.goalkeeper !== "optional" || keeper === undefined) return preset.positions;
      return {
        ...preset.positions,
        groups: preset.positions.groups.map((group) =>
          group.key === keeper ? { ...group, min: 0 } : group,
        ),
      };
    },
    variants: preset.variants,

    init(cfg, lineups: LineupPair): PeriodState {
      return {
        cfg,
        entrants: { home: lineups.home.entrantId, away: lineups.away.entrantId },
        phase: "pre",
        goals: { home: 0, away: 0 },
        periods: [],
        suspensions: [],
        cardLog: [],
        kindCounts: { home: {}, away: {} },
        shootout: null,
        outcome: null,
        replayFlagged: false,
      };
    },

    apply(state, ev: EventEnvelope<PeriodEv | CoreEv>): PeriodState {
      switch (ev.type) {
        case "core.start":
          if (state.phase !== "pre") wrongPhase("already started");
          return pushPeriod(state, periodLabels(state.cfg)[0] as string);
        case goalType:
          return applyGoal(state, parsePayload(PeriodGoal, ev.payload, ev.type));
        case advanceType:
          return applyAdvance(state, parsePayload(PeriodAdvance, ev.payload, ev.type));
        case suspStartType:
          return applySuspensionStart(
            state,
            parsePayload(PeriodSuspensionStart, ev.payload, ev.type),
          );
        case suspEndType:
          return applySuspensionEnd(state, parsePayload(PeriodSuspensionEnd, ev.payload, ev.type));
        case attemptType:
          return applyShootoutAttempt(
            state,
            parsePayload(PeriodShootoutAttempt, ev.payload, ev.type),
          );
        case setPieceType:
          return applySetPiece(state, parsePayload(PeriodSetPiece, ev.payload, ev.type));
        case "core.forfeit":
          return applyForfeit(state, (ev.payload as { by: string }).by);
        case "core.abandon":
          return applyAbandon(state);
        case "core.finalize":
          if (state.outcome === null) wrongPhase("cannot finalize an undecided fixture");
          return { ...state, phase: "final" };
        case "core.note":
        case "core.award":
          return state;
        default:
          invalid(`unknown event type "${ev.type}"`);
      }
    },

    outcome: (state) => state.outcome,

    // §9.5 — defined at every prefix. Headline grammar per v6/00 §5:
    // `2 — 1 · P3`, `3 — 2 (OT)`, `2 — 1 (GWS 2–1)`, `1 — 1 · Q4`.
    summary(state): ScoreSummary {
      const { home, away } = state.goals;
      const tally = state.shootout === null ? null : shootoutTally(state.shootout.kicks);
      const soSuffix =
        tally === null ? "" : ` (${preset.shootoutLabel} ${tally.home}–${tally.away})`;
      const otSuffix =
        soSuffix === "" && state.outcome?.kind === "win" && state.outcome.method === "extra_time"
          ? " (OT)"
          : "";
      const phaseSuffix = isPlayPhase(state) ? ` · ${state.phase}` : "";
      const chip = strengthChip(state.suspensions, state.cfg.strength.base, state.cfg.strength.min);
      return {
        headline: `${home} — ${away}${soSuffix}${otSuffix}${phaseSuffix}`,
        perSide: [
          {
            entrantId: state.entrants.home,
            line: `${home}${tally ? ` (${tally.home})` : ""}`,
          },
          {
            entrantId: state.entrants.away,
            line: `${away}${tally ? ` (${tally.away})` : ""}`,
          },
        ],
        detail: {
          periods: state.periods,
          phase: state.phase,
          // Pads drive the phase machine from here — no duplicated kernel
          // logic client-side.
          nextAdvance: expectedAdvance(state),
          shootoutNext:
            state.phase === "SHOOTOUT" && state.shootout !== null
              ? expectedKicker(state.shootout.kicks)
              : null,
          strength: chip,
          suspensions: state.suspensions,
          discipline: state.cardLog,
          // W4 — attributed detail appears only once it exists, so a coarse
          // match's summary is byte-identical to its pre-W4 shape.
          ...(state.goalLog === undefined ? {} : { goalLog: state.goalLog }),
          ...(state.setPieces === undefined ? {} : { setPieces: state.setPieces }),
          ...(preset.key === "hockey" ? { escalate: escalationHints(state.cardLog) } : {}),
          ...(tally === null ? {} : { shootout: tally }),
          ...(state.replayFlagged ? { abandoned: true } : {}),
        },
      };
    },

    standingsDelta(outcome, cfg, _ctx: StageCtx, state): [StandingsDelta, StandingsDelta] {
      const build = (
        side: Side,
        w: number,
        d: number,
        l: number,
        pts: number,
        zeroGoals = false,
      ): StandingsDelta => ({
        entrantId: state.entrants[side],
        played: 1,
        won: w,
        drawn: d,
        lost: l,
        points: pts,
        metrics: sideMetrics(state, side, zeroGoals),
      });

      switch (outcome.kind) {
        case "win":
        case "award": {
          const winnerSide = sideOf(state, outcome.winner);
          const [wp, lp] = winPoints(cfg, outcome.kind === "win" ? outcome.method : undefined);
          const winner = build(winnerSide, 1, 0, 0, wp);
          const loser = build(opponent(winnerSide), 0, 0, 1, lp);
          return winnerSide === "home" ? [winner, loser] : [loser, winner];
        }
        case "draw":
        case "tie":
          return [
            build("home", 0, 1, 0, cfg.points.draw),
            build("away", 0, 1, 0, cfg.points.draw),
          ];
        case "no_result":
          return [
            build("home", 0, 0, 0, cfg.points.draw, true),
            build("away", 0, 0, 0, cfg.points.draw, true),
          ];
      }
    },

    metrics: preset.metrics,
    defaultTiebreakers: preset.defaultTiebreakers,

    // v6/00 §3 — draws are a league result only where no decider is
    // configured (FIH outdoor, rec ice); OT or a shootout means every match
    // produces a winner.
    supportsDraws(cfg, stage: StageKind) {
      const leagueish = stage === "league" || stage === "group" || stage === "swiss";
      return leagueish && cfg.overtime === null && cfg.shootout === null;
    },

    declaredPointsSets(cfg) {
      const totals = [cfg.points.win + cfg.points.loss, cfg.points.draw * 2];
      if (cfg.points.otWin !== undefined || cfg.points.otLoss !== undefined) {
        totals.push(
          (cfg.points.otWin ?? cfg.points.win) + (cfg.points.otLoss ?? cfg.points.loss),
        );
      }
      if (cfg.points.shootoutWin !== undefined || cfg.points.shootoutLoss !== undefined) {
        totals.push(
          (cfg.points.shootoutWin ?? cfg.points.otWin ?? cfg.points.win) +
            (cfg.points.shootoutLoss ?? cfg.points.otLoss ?? cfg.points.loss),
        );
      }
      return [...new Set(totals)];
    },

    fidelityTiers,
    officialLabel: preset.officialLabel,
    ...(preset.playerStats === undefined ? {} : { playerStats: preset.playerStats }),
    ...(preset.entrantModel === undefined ? {} : { entrantModel: preset.entrantModel }),
    ...(discipline === undefined ? {} : { discipline }),

    // spec 03 §6 — deterministic valid-event generator.
    arbitraryEvent(state, rng: Rng): ModuleEvent<PeriodEv> | null {
      const sideId = (side: Side) => state.entrants[side];
      const randomSide = (): Side => (rng() < 0.5 ? "home" : "away");

      if (state.phase === "pre") return { type: "core.start", payload: {} };

      if (state.phase === "SHOOTOUT" && state.shootout) {
        const expected = expectedKicker(state.shootout.kicks) ?? randomSide();
        const named = rng() < 0.5;
        return {
          type: attemptType,
          payload: {
            by: sideId(expected),
            scored: rng() < 0.7,
            ...(named
              ? {
                  person: `${sideId(expected)}-p3`,
                  goalkeeper: `${sideId(opponent(expected))}-g1`,
                }
              : {}),
          },
        };
      }

      if (!isPlayPhase(state)) return null; // done / final / abandoned

      const roll = rng();
      if (roll < 0.02) {
        return { type: "core.forfeit", payload: { by: sideId(randomSide()), reason: "walkover" } };
      }
      if (roll < 0.03) return { type: "core.abandon", payload: { reason: "conditions" } };
      if (roll < 0.13 && state.cfg.suspensions !== null) {
        const classes = Object.keys(state.cfg.suspensions.classes);
        const classKey = classes[Math.floor(rng() * classes.length)] as string;
        const side = randomSide();
        const person = rng() < 0.5 ? `${sideId(side)}-p1` : undefined;
        const detailed = rng() < 0.4;
        return {
          type: suspStartType,
          payload: {
            by: sideId(side),
            class: classKey,
            ...(person === undefined ? {} : { person }),
            ...(detailed
              ? { reason: "obstruction", servedBy: `${sideId(side)}-p9`, minutes: 2 }
              : {}),
          },
        };
      }
      // The CONFIG's list, not the preset's — a competition may have replaced
      // it, and a generator that emits an event its own fold rejects is worse
      // than one that emits none (spec 03 §6).
      const cfgKinds = state.cfg.setPieceKinds;
      if (roll < 0.22 && cfgKinds.length > 0) {
        const side = randomSide();
        const kind = cfgKinds[Math.floor(rng() * cfgKinds.length)] as string;
        return {
          type: setPieceType,
          payload: {
            by: sideId(side),
            kind,
            ...(rng() < 0.6 ? { person: `${sideId(side)}-p4` } : {}),
            // One draw, four tokens — the shared attempt vocabulary. Keeping it
            // to a single rng() call leaves every other generated stream on the
            // walk it was recorded on.
            outcome: attemptOutcome(rng()),
          },
        };
      }
      if (roll < 0.19 && state.suspensions.some((s) => !s.permanent)) {
        const releasable = state.suspensions.filter((s) => !s.permanent);
        const pick = releasable[Math.floor(rng() * releasable.length)] as ActiveSuspension;
        return {
          type: suspEndType,
          payload: {
            by: sideId(pick.side),
            class: pick.classKey,
            ...(pick.person === undefined ? {} : { person: pick.person }),
          },
        };
      }
      if (roll < 0.62) {
        const side = randomSide();
        const kinds = state.cfg.goalKinds.filter((k) => k !== "fg" && k !== "og");
        const kind =
          rng() < 0.25 && kinds.length > 0
            ? (kinds[Math.floor(rng() * kinds.length)] as string)
            : rng() < 0.05
              ? "og"
              : undefined;
        const withAssists = state.cfg.assists && kind !== "og" && rng() < 0.4;
        const attributed = rng() < 0.5;
        return {
          type: goalType,
          payload: {
            by: sideId(side),
            ...(kind === undefined ? {} : { kind }),
            ...(withAssists ? { assists: [`${sideId(side)}-p2`] } : {}),
            ...(attributed
              ? { person: `${sideId(side)}-p1`, clockRef: "10:00", emptyNet: rng() < 0.1 }
              : {}),
          },
        };
      }
      const to = expectedAdvance(state);
      if (to === null) return null;
      return { type: advanceType, payload: { to } };
    },
  };
}
