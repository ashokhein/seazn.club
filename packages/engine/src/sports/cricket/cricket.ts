// Cricket SportModule — spec 04 §2 (normative) + engine/sports/cricket.md
// (PROMPT-05). Dual fidelity is the load-bearing design (spec §2.2): fine
// `cricket.ball` events and coarse `cricket.innings.summary` events both fold
// into the same InningsTotals shape, and all result/NRR/DLS math reads only
// those totals — result logic never peeks at ball events.
import { z } from "zod";
import { EngineError } from "../../core/errors.ts";
import type { CoreEv, EventEnvelope } from "../../core/events.ts";
import type { Rng } from "../../core/rng.ts";
import {
  EntrantId,
  type LineupPair,
  type MatchOutcome,
  type ScoreSummary,
  type StageCtx,
  type StageKind,
  type StandingsDelta,
} from "../../core/types.ts";
import type { PositionCatalog } from "../../sport/catalog.ts";
import type { ModuleEvent, SportModule } from "../../sport/module.ts";
import { dlsPar, dlsTarget, resources } from "./dls.ts";

// ---------------------------------------------------------------------------
// Cfg — spec 04 §2.1
// ---------------------------------------------------------------------------

const CricketCfgBase = z.object({
  inningsPerSide: z.union([z.literal(1), z.literal(2)]).default(1),
  // T20 120, ODI 300, Hundred 100; null = unlimited (test).
  ballsPerInnings: z.number().int().positive().nullable().default(120),
  ballsPerOver: z.number().int().positive().default(6), // Hundred uses 5-ball sets
  playersPerSide: z.number().int().min(2).default(11),
  maxOversPerBowler: z.number().int().positive().optional(), // T20 4, ODI 10
  points: z
    .object({
      win: z.number().int().nonnegative().default(2),
      tie: z.number().int().nonnegative().default(1),
      noResult: z.number().int().nonnegative().default(1),
      loss: z.number().int().nonnegative().default(0),
      draw: z.number().int().nonnegative().optional(), // 2-innings only
    })
    .default({ win: 2, tie: 1, noResult: 1, loss: 0 }),
  superOver: z.boolean().default(false), // knockout tie resolution
  // spec 04 §2.3 — still-tied policy. ICC current conditions repeat the super
  // over until decided; boundary_count is the (2019) legacy rule kept for
  // community leagues; shared records the tie.
  superOverStillTied: z.enum(["repeat", "boundary_count", "shared"]).default("repeat"),
  dls: z
    .object({ enabled: z.boolean(), edition: z.literal("standard") })
    .default({ enabled: false, edition: "standard" }),
  followOn: z
    .object({ enabled: z.boolean(), lead: z.number().int().positive() })
    .optional(), // 2-innings only
  minOversForResult: z.number().int().nonnegative().default(5), // T20 5, ODI 20
});

export const CricketCfg = CricketCfgBase.refine(
  (cfg) =>
    cfg.maxOversPerBowler === undefined ||
    cfg.ballsPerInnings === null ||
    cfg.maxOversPerBowler <= Math.ceil(cfg.ballsPerInnings / cfg.ballsPerOver),
  { message: "maxOversPerBowler exceeds the innings length" },
)
  .refine((cfg) => !(cfg.followOn?.enabled === true) || cfg.inningsPerSide === 2, {
    message: "followOn requires inningsPerSide = 2",
  })
  .refine((cfg) => !cfg.superOver || cfg.inningsPerSide === 1, {
    message: "superOver requires inningsPerSide = 1",
  })
  .refine((cfg) => !cfg.dls.enabled || cfg.ballsPerInnings !== null, {
    message: "DLS requires a limited-overs config",
  })
  .refine(
    (cfg) =>
      cfg.ballsPerInnings === null ||
      cfg.minOversForResult * cfg.ballsPerOver <= cfg.ballsPerInnings,
    { message: "minOversForResult exceeds the innings length" },
  );
export type CricketCfg = z.infer<typeof CricketCfg>;

// ---------------------------------------------------------------------------
// Ev — spec 04 §2.2 (+ doc 14 §1 Tier-2 player lines)
// ---------------------------------------------------------------------------

const PersonId = z.string().min(1);

export const CricketExtras = z.strictObject({
  kind: z.enum(["wide", "noball", "bye", "legbye", "penalty"]),
  runs: z.number().int().positive(),
});

export const CricketWicket = z.strictObject({
  kind: z.enum([
    "bowled",
    "caught",
    "lbw",
    "runout",
    "stumped",
    "hitwicket",
    "retired",
    "obstructed",
    "timedout",
  ]),
  out: PersonId,
  fielder: PersonId.optional(),
  bowlerCredited: z.boolean(),
});

export const CricketBall = z.strictObject({
  over: z.number().int().nonnegative(),
  ballInOver: z.number().int().positive(),
  striker: PersonId,
  nonStriker: PersonId,
  bowler: PersonId,
  runs: z.strictObject({
    bat: z.number().int().nonnegative(),
    extras: CricketExtras.optional(),
  }),
  wicket: CricketWicket.optional(),
  boundary: z.union([z.literal(4), z.literal(6)]).optional(),
  freeHit: z.boolean().optional(),
});
export type CricketBallEv = z.infer<typeof CricketBall>;

// Coarse fidelity (spec §2.2). `partial: true` = in-progress snapshot: totals
// update an open innings and the fold's auto-close rules (all out / balls
// exhausted / target passed) decide closure — exactly the rules a fine
// innings closes under, which is what makes cfg-free coarsening possible.
// `boundaries` feeds the boundary-count tiebreak at coarse fidelity.
export const CricketInningsSummary = z.strictObject({
  runs: z.number().int().nonnegative(),
  wickets: z.number().int().nonnegative(),
  legalBalls: z.number().int().nonnegative(),
  declared: z.boolean().optional(),
  boundaries: z.number().int().nonnegative().optional(),
  partial: z.boolean().optional(),
});

export const CricketToss = z.strictObject({
  wonBy: EntrantId,
  elected: z.enum(["bat", "bowl"]),
});
export const CricketDeclare = z.strictObject({});
export const CricketClose = z.strictObject({});
export const CricketMatchClose = z.strictObject({}); // 2-innings time expiry ⇒ draw
export const CricketInterruption = z.strictObject({
  kind: z.enum(["rain", "light", "other"]),
  oversLostEstimate: z.number().int().nonnegative().optional(),
});
export const CricketRevise = z
  .strictObject({
    oversPerSide: z.number().int().positive().optional(),
    target: z.number().int().positive().optional(),
  })
  .refine((r) => r.oversPerSide !== undefined || r.target !== undefined, {
    message: "revise needs oversPerSide and/or target",
  });
export const CricketFollowOn = z.strictObject({});

// doc 14 §1 Tier 2 — post-match scorecard line, validated for sum-consistency
// against the innings totals.
export const CricketPlayerLine = z
  .strictObject({
    innings: z.number().int().positive(), // 1-based innings number
    person: PersonId,
    batting: z
      .strictObject({
        runs: z.number().int().nonnegative(),
        balls: z.number().int().nonnegative(),
        out: z.boolean().optional(),
      })
      .optional(),
    bowling: z
      .strictObject({
        legalBalls: z.number().int().nonnegative(),
        runs: z.number().int().nonnegative(),
        wickets: z.number().int().nonnegative(),
      })
      .optional(),
  })
  .refine((line) => line.batting !== undefined || line.bowling !== undefined, {
    message: "player line needs a batting and/or bowling aspect",
  });

export const CricketEv = z.union([
  CricketBall,
  CricketInningsSummary,
  CricketToss,
  CricketDeclare,
  CricketClose,
  CricketMatchClose,
  CricketInterruption,
  CricketRevise,
  CricketFollowOn,
  CricketPlayerLine,
]);
export type CricketEv = z.infer<typeof CricketEv>;

// ---------------------------------------------------------------------------
// State — spec §2.2 layered design: InningsState.{runs,wickets,legalBalls}
// is the InningsTotals every downstream computation reads.
// ---------------------------------------------------------------------------

type Side = "home" | "away";

interface FineInnings {
  striker: string | null; // null = awaiting replacement (super over only)
  nonStriker: string | null;
  nextBatterIndex: number; // cursor into the batting order (main innings)
  dismissed: string[];
  currentBowler: string | null; // null = new over pending
  prevOverBowler: string | null;
  freeHitPending: boolean;
  batterRuns: Record<string, number>;
  batterBalls: Record<string, number>;
  bowlerBalls: Record<string, number>;
  bowlerRuns: Record<string, number>;
  bowlerWickets: Record<string, number>;
  extras: number;
}

export interface InningsState {
  battingSide: Side;
  runs: number;
  wickets: number;
  legalBalls: number;
  boundaries: number;
  declared: boolean;
  closed: boolean;
  ballsLimit: number | null; // quota at this point (revise updates it)
  fine: FineInnings | null; // null = coarse innings
}

interface PlayerLineRec {
  innings: number;
  person: string;
  batting?: { runs: number; balls: number; out?: boolean };
  bowling?: { legalBalls: number; runs: number; wickets: number };
}

export interface CricketState {
  cfg: CricketCfg;
  entrants: { home: string; away: string };
  orders: { home: string[]; away: string[] }; // batting order = LineupSlot.order_no
  phase: "pre" | "live" | "super_over" | "done" | "final";
  battingFirst: Side;
  tossTaken: boolean;
  innings: InningsState[];
  followOnEnforced: boolean;
  quota: number | null; // current balls-per-innings (post-revise)
  revisedTarget: number | null;
  targetSource: "dls" | "manual" | null;
  r1: number | null; // DLS resources available, first innings (spec §2.5)
  r2: number | null; // …and the chase
  interruptions: number;
  superOver: {
    innings: InningsState[];
    dismissed: { home: string[]; away: string[] };
  } | null;
  outcome: MatchOutcome | null;
  margin: string | null;
  playerLines: PlayerLineRec[];
}

function opponent(side: Side): Side {
  return side === "home" ? "away" : "home";
}

function invalid(message: string, data?: unknown): never {
  throw new EngineError("INVALID_EVENT", message, data);
}

function wrongPhase(message: string, data?: unknown): never {
  throw new EngineError("WRONG_PHASE", message, data);
}

function sideOf(state: CricketState, entrantId: string): Side {
  if (entrantId === state.entrants.home) return "home";
  if (entrantId === state.entrants.away) return "away";
  invalid(`unknown entrant "${entrantId}"`, { entrantId });
}

function parsePayload<T>(schema: z.ZodType<T>, payload: unknown, type: string): T {
  const parsed = schema.safeParse(payload);
  if (!parsed.success) invalid(`invalid ${type} payload`, { issues: parsed.error.issues });
  return parsed.data;
}

// All-out threshold — spec §2.3: playersPerSide − 1 partnerships; bounded by
// the actual lineup so short lineups stay consistent across both fidelities.
function allOutWickets(state: CricketState, side: Side): number {
  const order = state.orders[side];
  const players = Math.min(state.cfg.playersPerSide, order.length || state.cfg.playersPerSide);
  return Math.max(1, players - 1);
}

// spec §2.4 — decimalised overs with ballsPerOver generality (display only;
// the ledger stays integer balls).
function oversText(balls: number, ballsPerOver: number): string {
  const whole = Math.floor(balls / ballsPerOver);
  const rem = balls % ballsPerOver;
  return rem === 0 ? `${whole}` : `${whole}.${rem}`;
}

// ---------------------------------------------------------------------------
// Innings sequencing — spec §2.3 / cricket.md §3
// ---------------------------------------------------------------------------

function maxInningsCount(cfg: CricketCfg): number {
  return cfg.inningsPerSide * 2;
}

function battingSideAt(state: CricketState, index: number): Side {
  const first = state.battingFirst;
  if (state.cfg.inningsPerSide === 1) return index === 0 ? first : opponent(first);
  if (state.followOnEnforced) {
    // F, S, S, F
    return index === 0 || index === 3 ? first : opponent(first);
  }
  return index % 2 === 0 ? first : opponent(first);
}

function aggregate(state: CricketState, side: Side): number {
  return state.innings.reduce(
    (sum, innings) => (innings.battingSide === side ? sum + innings.runs : sum),
    0,
  );
}

function isChaseIndex(state: CricketState, index: number): boolean {
  return index === maxInningsCount(state.cfg) - 1;
}

// Runs the batting side of the final innings needs to win (spec §2.3).
function chaseTarget(state: CricketState): number {
  if (state.cfg.inningsPerSide === 1) {
    if (state.revisedTarget !== null) return state.revisedTarget;
    const first = state.innings[0];
    return (first?.runs ?? 0) + 1;
  }
  const chaseSide = battingSideAt(state, 3);
  const own = state.innings
    .slice(0, 3)
    .reduce((sum, innings) => (innings.battingSide === chaseSide ? sum + innings.runs : sum), 0);
  return aggregate(state, opponent(chaseSide)) - own + 1;
}

function openInnings(state: CricketState): { innings: InningsState; index: number } | null {
  const index = state.innings.length - 1;
  const innings = state.innings[index];
  if (innings === undefined || innings.closed) return null;
  return { innings, index };
}

function freshFine(): FineInnings {
  return {
    striker: null,
    nonStriker: null,
    nextBatterIndex: 0,
    dismissed: [],
    currentBowler: null,
    prevOverBowler: null,
    freeHitPending: false,
    batterRuns: {},
    batterBalls: {},
    bowlerBalls: {},
    bowlerRuns: {},
    bowlerWickets: {},
    extras: 0,
  };
}

// Creates the next innings (on the first scoring event for it).
function createInnings(state: CricketState, fidelity: "fine" | "coarse"): CricketState {
  const index = state.innings.length;
  if (index >= maxInningsCount(state.cfg)) invalid("all innings already recorded");
  const battingSide = battingSideAt(state, index);
  let fine: FineInnings | null = null;
  if (fidelity === "fine") {
    const order = state.orders[battingSide];
    if (order.length < 2) {
      invalid(`batting order for "${state.entrants[battingSide]}" needs at least 2 players`);
    }
    fine = {
      ...freshFine(),
      // spec §2.3 — openers from lineup order.
      striker: order[0] as string,
      nonStriker: order[1] as string,
      nextBatterIndex: 2,
    };
  }
  const innings: InningsState = {
    battingSide,
    runs: 0,
    wickets: 0,
    legalBalls: 0,
    boundaries: 0,
    declared: false,
    closed: false,
    ballsLimit: state.quota,
    fine,
  };
  let next: CricketState = { ...state, innings: [...state.innings, innings] };
  // DLS bookkeeping (spec §2.5) — resources available at innings start.
  if (state.quota !== null) {
    const res = resources(state.quota / state.cfg.ballsPerOver, 0);
    if (index === 0 && next.r1 === null) next = { ...next, r1: res };
    if (state.cfg.inningsPerSide === 1 && index === 1 && next.r2 === null) {
      next = { ...next, r2: res };
      next = maybeComputeDlsTarget(next);
    }
  }
  return next;
}

function replaceInnings(state: CricketState, index: number, innings: InningsState): CricketState {
  const list = state.innings.map((entry, i) => (i === index ? innings : entry));
  return { ...state, innings: list };
}

// ---------------------------------------------------------------------------
// Result determination — spec §2.3
// ---------------------------------------------------------------------------

function decideWin(
  state: CricketState,
  winnerSide: Side,
  method: string,
  margin: string,
): CricketState {
  return {
    ...state,
    phase: "done",
    outcome: {
      kind: "win",
      winner: state.entrants[winnerSide],
      loser: state.entrants[opponent(winnerSide)],
      method,
    },
    margin,
  };
}

function decideTie(state: CricketState): CricketState {
  // spec §2.3 — tie → super over when configured (fold superover.* events
  // recursively); otherwise the tie stands (league: 1 pt each).
  if (state.cfg.superOver) {
    return {
      ...state,
      phase: "super_over",
      superOver: state.superOver ?? { innings: [], dismissed: { home: [], away: [] } },
    };
  }
  return { ...state, phase: "done", outcome: { kind: "tie" }, margin: null };
}

// Runs after every innings close; owns the whole §2.3 result table.
function decideAfterClose(state: CricketState): CricketState {
  const cfg = state.cfg;
  const count = state.innings.length;
  const methodSuffix = state.targetSource !== null ? "dls" : "regulation";

  if (cfg.inningsPerSide === 1) {
    if (count < 2) return state; // innings break
    const chase = state.innings[1] as InningsState;
    const target = chaseTarget(state);
    if (chase.runs >= target) {
      const wicketsLeft = allOutWickets(state, chase.battingSide) - chase.wickets;
      return decideWin(
        state,
        chase.battingSide,
        methodSuffix,
        `by ${wicketsLeft} wicket${wicketsLeft === 1 ? "" : "s"}`,
      );
    }
    if (chase.runs === target - 1) return decideTie(state);
    const runs = target - 1 - chase.runs;
    return decideWin(
      state,
      opponent(chase.battingSide),
      methodSuffix,
      `by ${runs} run${runs === 1 ? "" : "s"}`,
    );
  }

  // Two innings per side — spec §2.3 test rules.
  const done: Record<Side, number> = { home: 0, away: 0 };
  for (const innings of state.innings) done[innings.battingSide]++;
  const aggHome = aggregate(state, "home");
  const aggAway = aggregate(state, "away");

  if (count === 4) {
    const chase = state.innings[3] as InningsState;
    const chaseSide = chase.battingSide;
    const chaseAgg = chaseSide === "home" ? aggHome : aggAway;
    const otherAgg = chaseSide === "home" ? aggAway : aggHome;
    if (chaseAgg > otherAgg) {
      const wicketsLeft = allOutWickets(state, chaseSide) - chase.wickets;
      return decideWin(state, chaseSide, "regulation", `by ${wicketsLeft} wicket${wicketsLeft === 1 ? "" : "s"}`);
    }
    if (chaseAgg === otherAgg) return decideTie(state);
    const runs = otherAgg - chaseAgg;
    return decideWin(state, opponent(chaseSide), "regulation", `by ${runs} run${runs === 1 ? "" : "s"}`);
  }

  // Innings victory: a side finished both innings still behind an opponent
  // that batted once (spec §2.3 "innings victory").
  for (const side of ["home", "away"] as const) {
    const other = opponent(side);
    const sideAgg = side === "home" ? aggHome : aggAway;
    const otherAgg = side === "home" ? aggAway : aggHome;
    if (done[side] === 2 && done[other] === 1 && sideAgg < otherAgg) {
      const runs = otherAgg - sideAgg;
      return decideWin(state, other, "innings", `by an innings and ${runs} run${runs === 1 ? "" : "s"}`);
    }
  }
  return state;
}

// Close the open innings (auto or manual) and run the result table. `bpo`
// balls-exhausted, all-out and target-passed closes flow through here from
// both fidelities.
function closeOpenInnings(state: CricketState, declared: boolean): CricketState {
  const open = openInnings(state);
  if (open === null) invalid("no innings in progress");
  const closed: InningsState = { ...open.innings, declared, closed: true };
  return decideAfterClose(replaceInnings(state, open.index, closed));
}

// Auto-close rules — the single source of truth for when an innings ends
// without an explicit event (spec §2.3): target passed, all out, balls
// exhausted. Shared by ball- and summary-fidelity application.
function autoClose(state: CricketState): CricketState {
  const open = openInnings(state);
  if (open === null) return state;
  const { innings, index } = open;
  const chasing = isChaseIndex(state, index);
  if (chasing && state.innings.length >= 2 && innings.runs >= chaseTarget(state)) {
    return closeOpenInnings(state, false);
  }
  if (innings.wickets >= allOutWickets(state, innings.battingSide)) {
    return closeOpenInnings(state, false);
  }
  if (innings.ballsLimit !== null && innings.legalBalls >= innings.ballsLimit) {
    return closeOpenInnings(state, false);
  }
  return state;
}

// ---------------------------------------------------------------------------
// DLS folding — spec §2.5 (revise events carry the umpire-confirmed numbers;
// our Standard-Edition computation fills the target when cfg.dls is on and no
// manual target was given; a manual target always wins).
// ---------------------------------------------------------------------------

function maybeComputeDlsTarget(state: CricketState): CricketState {
  if (
    !state.cfg.dls.enabled ||
    state.targetSource === "manual" ||
    state.cfg.inningsPerSide !== 1 ||
    state.innings.length < 1 ||
    !(state.innings[0] as InningsState).closed ||
    state.r1 === null ||
    state.r2 === null
  ) {
    return state;
  }
  const s1 = (state.innings[0] as InningsState).runs;
  if (Math.abs(state.r2 - state.r1) < 1e-9) {
    // Equal resources ⇒ no revision needed.
    return state.targetSource === "dls" ? { ...state, revisedTarget: s1 + 1 } : state;
  }
  return {
    ...state,
    revisedTarget: dlsTarget(s1, state.r1, state.r2),
    targetSource: "dls",
  };
}

function applyRevise(state: CricketState, payload: z.infer<typeof CricketRevise>): CricketState {
  if (state.phase !== "pre" && state.phase !== "live") {
    wrongPhase(`revise not allowed in phase "${state.phase}"`);
  }
  if (state.quota === null) invalid("revise applies to limited-overs matches only");
  if (state.cfg.inningsPerSide !== 1) invalid("revise applies to single-innings matches only");
  const bpo = state.cfg.ballsPerOver;
  let next = state;

  if (payload.oversPerSide !== undefined) {
    const newLimit = payload.oversPerSide * bpo;
    const open = openInnings(next);
    if (open !== null) {
      const { innings, index } = open;
      if (newLimit < innings.legalBalls) {
        invalid("revised overs are below the balls already bowled", {
          legalBalls: innings.legalBalls,
          newLimit,
        });
      }
      if (innings.ballsLimit !== null) {
        // Resources lost = remaining before − remaining after, at the current
        // wickets (Standard Edition interruption accounting).
        const before = resources((innings.ballsLimit - innings.legalBalls) / bpo, innings.wickets);
        const after = resources((newLimit - innings.legalBalls) / bpo, innings.wickets);
        const lost = before - after;
        if (index === 0 && next.r1 !== null) next = { ...next, r1: next.r1 - lost };
        if (index === 1 && next.r2 !== null) next = { ...next, r2: next.r2 - lost };
      }
      next = replaceInnings(next, index, { ...innings, ballsLimit: newLimit });
    } else if (next.innings.length === 1 && next.quota !== null) {
      // Between innings: the chase quota (and its resources) shrink.
      next = { ...next, r2: resources(newLimit / bpo, 0) };
    }
    next = { ...next, quota: newLimit };
  }

  if (payload.target !== undefined) {
    next = { ...next, revisedTarget: payload.target, targetSource: "manual" };
  } else {
    next = maybeComputeDlsTarget(next);
  }

  // A shrunk quota or lowered target can resolve the match immediately.
  return autoClose(next);
}

// core.abandon — spec §2.3: no_result below the minimum, DLS par decision
// beyond it (method 'dls'); 2-innings matches are drawn.
function applyAbandon(state: CricketState): CricketState {
  if (state.phase === "done" || state.phase === "final") wrongPhase("match already over");
  if (state.cfg.inningsPerSide === 2) {
    return { ...state, phase: "done", outcome: { kind: "draw" }, margin: null };
  }
  if (state.phase === "super_over") {
    // Main match already tied; the abandoned decider leaves the tie standing.
    return { ...state, phase: "done", outcome: { kind: "tie" }, margin: null };
  }
  const open = openInnings(state);
  const chase = open !== null && isChaseIndex(state, open.index) ? open.innings : null;
  const minBalls = state.cfg.minOversForResult * state.cfg.ballsPerOver;
  if (
    chase !== null &&
    state.cfg.dls.enabled &&
    state.quota !== null &&
    chase.legalBalls >= minBalls &&
    state.r1 !== null &&
    state.r2 !== null &&
    chase.ballsLimit !== null
  ) {
    const s1 = (state.innings[0] as InningsState).runs;
    const remaining = resources(
      (chase.ballsLimit - chase.legalBalls) / state.cfg.ballsPerOver,
      chase.wickets,
    );
    const par = dlsPar(s1, state.r1, state.r2, state.r2 - remaining);
    if (chase.runs > par) {
      const runs = chase.runs - par;
      return decideWin(state, chase.battingSide, "dls", `by ${runs} run${runs === 1 ? "" : "s"}`);
    }
    if (chase.runs === par) {
      return { ...state, phase: "done", outcome: { kind: "tie" }, margin: null };
    }
    const runs = par - chase.runs;
    return decideWin(state, opponent(chase.battingSide), "dls", `by ${runs} run${runs === 1 ? "" : "s"}`);
  }
  return { ...state, phase: "done", outcome: { kind: "no_result" }, margin: null };
}

// ---------------------------------------------------------------------------
// Ball application — spec §2.2 grammar + legality rules
// ---------------------------------------------------------------------------

const BOWLER_CREDITED_KINDS = new Set(["bowled", "caught", "lbw", "stumped", "hitwicket"]);

interface DeliveryCtx {
  battingOrder: readonly string[];
  bowlingOrder: readonly string[];
  whiteBall: boolean;
  ballsPerOver: number;
  maxOversPerBowler: number | undefined;
  allOut: number;
  // Main innings: strict next-batter-by-order. Super over: any eligible
  // batter not previously dismissed in the super over(s).
  strictOrder: boolean;
  soIneligible: readonly string[];
}

function applyDelivery(
  innings: InningsState,
  payload: CricketBallEv,
  ctx: DeliveryCtx,
): InningsState {
  const fine = innings.fine;
  if (fine === null) {
    invalid("this innings is recorded at summary fidelity — ball events are not allowed");
  }
  const bpo = ctx.ballsPerOver;

  // Over/ball counters must match the fold's expectation (wides/no-balls do
  // not advance the count — spec §2.2 ball legality).
  const expectedOver = Math.floor(innings.legalBalls / bpo);
  const expectedBall = (innings.legalBalls % bpo) + 1;
  if (payload.over !== expectedOver || payload.ballInOver !== expectedBall) {
    invalid("over/ballInOver do not match the ledger", {
      expected: { over: expectedOver, ballInOver: expectedBall },
      got: { over: payload.over, ballInOver: payload.ballInOver },
    });
  }

  // Bowler legality — no consecutive overs, per-bowler quota (spec §2.2).
  let currentBowler = fine.currentBowler;
  if (currentBowler === null) {
    if (payload.bowler === fine.prevOverBowler) {
      invalid(`bowler "${payload.bowler}" cannot bowl consecutive overs`);
    }
    if (!ctx.bowlingOrder.includes(payload.bowler)) {
      invalid(`bowler "${payload.bowler}" is not in the fielding lineup`);
    }
    if (ctx.maxOversPerBowler !== undefined) {
      const bowled = Math.floor((fine.bowlerBalls[payload.bowler] ?? 0) / bpo);
      if (bowled >= ctx.maxOversPerBowler) {
        invalid(`bowler "${payload.bowler}" has exhausted the ${ctx.maxOversPerBowler}-over quota`);
      }
    }
    currentBowler = payload.bowler;
  } else if (payload.bowler !== currentBowler) {
    invalid(`over in progress belongs to "${currentBowler}"`);
  }

  // Batters at the crease.
  let striker = fine.striker;
  let nonStriker = fine.nonStriker;
  if (ctx.strictOrder) {
    if (payload.striker !== striker || payload.nonStriker !== nonStriker) {
      invalid("striker/non-striker do not match the ledger", {
        expected: { striker, nonStriker },
        got: { striker: payload.striker, nonStriker: payload.nonStriker },
      });
    }
  } else {
    // Super over: resolve open ends against eligibility.
    const named = [payload.striker, payload.nonStriker];
    if (payload.striker === payload.nonStriker) invalid("striker and non-striker must differ");
    for (const person of named) {
      if (!ctx.battingOrder.includes(person)) {
        invalid(`batter "${person}" is not in the lineup`);
      }
      if (fine.dismissed.includes(person) || ctx.soIneligible.includes(person)) {
        invalid(`batter "${person}" is not eligible (already dismissed)`);
      }
    }
    const survivors = [striker, nonStriker].filter((p): p is string => p !== null);
    for (const survivor of survivors) {
      if (!named.includes(survivor)) {
        invalid(`batter "${survivor}" is at the crease and must stay`, { survivor });
      }
    }
    striker = payload.striker;
    nonStriker = payload.nonStriker;
  }

  // Free hit — armed by a white-ball no-ball, consumed by the next legal
  // delivery; only the run-out family can dismiss on it (spec §2.2).
  if (payload.freeHit === true && !fine.freeHitPending) {
    invalid("freeHit flagged but no free hit is pending");
  }
  const extras = payload.runs.extras;
  const legal = extras === undefined || (extras.kind !== "wide" && extras.kind !== "noball");
  if (extras?.kind === "wide" && payload.runs.bat > 0) {
    invalid("bat runs are impossible off a wide");
  }
  if (payload.wicket !== undefined) {
    const wicket = payload.wicket;
    if (fine.freeHitPending && wicket.kind !== "runout" && wicket.kind !== "obstructed") {
      invalid(`"${wicket.kind}" cannot dismiss on a free hit`);
    }
    if (wicket.out !== striker && wicket.out !== nonStriker) {
      invalid(`"${wicket.out}" is not at the crease`);
    }
    const shouldCredit = BOWLER_CREDITED_KINDS.has(wicket.kind);
    if (wicket.bowlerCredited !== shouldCredit) {
      invalid(`bowlerCredited must be ${shouldCredit} for "${wicket.kind}"`);
    }
  }

  // Accounting.
  const batRuns = payload.runs.bat;
  const extraRuns = extras?.runs ?? 0;
  const facing = striker as string;
  const batterRuns =
    extras?.kind === "wide"
      ? fine.batterRuns
      : { ...fine.batterRuns, [facing]: (fine.batterRuns[facing] ?? 0) + batRuns };
  const batterBalls =
    extras?.kind === "wide"
      ? fine.batterBalls
      : { ...fine.batterBalls, [facing]: (fine.batterBalls[facing] ?? 0) + 1 };
  const bowlerCharged =
    batRuns + (extras !== undefined && (extras.kind === "wide" || extras.kind === "noball") ? extras.runs : 0);
  const bowlerRuns = {
    ...fine.bowlerRuns,
    [currentBowler]: (fine.bowlerRuns[currentBowler] ?? 0) + bowlerCharged,
  };
  const bowlerBalls = legal
    ? { ...fine.bowlerBalls, [currentBowler]: (fine.bowlerBalls[currentBowler] ?? 0) + 1 }
    : fine.bowlerBalls;

  let wickets = innings.wickets;
  let dismissed = fine.dismissed;
  let bowlerWickets = fine.bowlerWickets;
  if (payload.wicket !== undefined) {
    wickets += 1;
    dismissed = [...dismissed, payload.wicket.out];
    if (payload.wicket.bowlerCredited) {
      bowlerWickets = {
        ...bowlerWickets,
        [currentBowler]: (bowlerWickets[currentBowler] ?? 0) + 1,
      };
    }
  }

  // Striker rotation — spec §2.2: swap on odd runs actually run (bat runs
  // unless a boundary, plus run extras net of the wide/no-ball penalty);
  // dismissal resolves positions instead (documented simplification).
  let crossings = 0;
  if (payload.boundary === undefined) crossings += batRuns;
  if (extras !== undefined) {
    if (extras.kind === "wide" || extras.kind === "noball") crossings += extras.runs - 1;
    else if (extras.kind !== "penalty") crossings += extras.runs;
  }
  if (payload.wicket === undefined && crossings % 2 === 1) {
    [striker, nonStriker] = [nonStriker, striker];
  }

  if (payload.wicket !== undefined && wickets < ctx.allOut) {
    const outPerson = payload.wicket.out;
    let replacement: string | null = null;
    let nextBatterIndex = fine.nextBatterIndex;
    if (ctx.strictOrder) {
      // spec §2.3 — dismissal → next batter by order.
      replacement = ctx.battingOrder[nextBatterIndex] ?? null;
      if (replacement === null) invalid("batting order exhausted");
      nextBatterIndex += 1;
    }
    if (striker === outPerson) striker = replacement;
    else if (nonStriker === outPerson) nonStriker = replacement;
    return finishDelivery(innings, payload, {
      ...fine,
      striker,
      nonStriker,
      nextBatterIndex,
      dismissed,
      batterRuns,
      batterBalls,
      bowlerRuns,
      bowlerBalls,
      bowlerWickets,
      currentBowler,
    }, { legal, batRuns, extraRuns, wickets, whiteBall: ctx.whiteBall, bpo });
  }

  return finishDelivery(innings, payload, {
    ...fine,
    striker,
    nonStriker,
    dismissed,
    batterRuns,
    batterBalls,
    bowlerRuns,
    bowlerBalls,
    bowlerWickets,
    currentBowler,
  }, { legal, batRuns, extraRuns, wickets, whiteBall: ctx.whiteBall, bpo });
}

function finishDelivery(
  innings: InningsState,
  payload: CricketBallEv,
  fine: FineInnings,
  info: { legal: boolean; batRuns: number; extraRuns: number; wickets: number; whiteBall: boolean; bpo: number },
): InningsState {
  const legalBalls = innings.legalBalls + (info.legal ? 1 : 0);
  let next: FineInnings = {
    ...fine,
    extras: fine.extras + info.extraRuns,
    freeHitPending:
      payload.runs.extras?.kind === "noball" && info.whiteBall
        ? true
        : info.legal
          ? false
          : fine.freeHitPending,
  };
  // Over end: swap ends, hand the ball to a new bowler.
  if (info.legal && legalBalls % info.bpo === 0) {
    next = {
      ...next,
      striker: next.nonStriker,
      nonStriker: next.striker,
      prevOverBowler: next.currentBowler,
      currentBowler: null,
    };
  }
  return {
    ...innings,
    runs: innings.runs + info.batRuns + info.extraRuns,
    wickets: info.wickets,
    legalBalls,
    boundaries: innings.boundaries + (payload.boundary !== undefined ? 1 : 0),
    fine: next,
  };
}

// ---------------------------------------------------------------------------
// Coarse application — spec §2.2 dual fidelity
// ---------------------------------------------------------------------------

function applySummary(
  state: CricketState,
  payload: z.infer<typeof CricketInningsSummary>,
): CricketState {
  if (state.phase !== "live") wrongPhase(`innings summary in phase "${state.phase}"`);
  let next = state;
  let open = openInnings(next);
  if (open !== null && open.innings.fine !== null) {
    invalid("this innings is recorded ball-by-ball — summaries are not allowed for it");
  }
  if (open === null) {
    next = createInnings(next, "coarse");
    open = openInnings(next) as { innings: InningsState; index: number };
  }
  const { innings, index } = open;
  // Monotone update: totals may only grow (progressive coarse scoring).
  if (
    payload.runs < innings.runs ||
    payload.wickets < innings.wickets ||
    payload.legalBalls < innings.legalBalls
  ) {
    invalid("summary totals may not decrease", {
      previous: { runs: innings.runs, wickets: innings.wickets, legalBalls: innings.legalBalls },
      got: { runs: payload.runs, wickets: payload.wickets, legalBalls: payload.legalBalls },
    });
  }
  const allOut = allOutWickets(next, innings.battingSide);
  if (payload.wickets > allOut) {
    invalid(`wickets exceed all-out (${allOut})`, { wickets: payload.wickets });
  }
  if (innings.ballsLimit !== null && payload.legalBalls > innings.ballsLimit) {
    invalid("legalBalls exceed the innings quota", {
      legalBalls: payload.legalBalls,
      quota: innings.ballsLimit,
    });
  }
  if (payload.declared === true && next.cfg.inningsPerSide !== 2) {
    invalid("declarations apply to two-innings matches only");
  }
  const updated: InningsState = {
    ...innings,
    runs: payload.runs,
    wickets: payload.wickets,
    legalBalls: payload.legalBalls,
    boundaries: Math.max(innings.boundaries, payload.boundaries ?? 0),
  };
  next = replaceInnings(next, index, updated);
  if (payload.partial === true) return autoClose(next);
  return closeOpenInnings(next, payload.declared === true);
}

// ---------------------------------------------------------------------------
// Super over — spec §2.3: a recursive 1-over innings pair, 2-wicket all out;
// still-tied policy from cfg (repeat | boundary_count | shared).
// ---------------------------------------------------------------------------

function boundaryCount(state: CricketState, side: Side): number {
  const main = state.innings.reduce(
    (sum, innings) => (innings.battingSide === side ? sum + innings.boundaries : sum),
    0,
  );
  const so = (state.superOver?.innings ?? []).reduce(
    (sum, innings) => (innings.battingSide === side ? sum + innings.boundaries : sum),
    0,
  );
  return main + so;
}

function soBattingSideAt(state: CricketState, index: number): Side {
  // ICC: the side batting second in the match bats first in the super over;
  // the side batting second in a super over bats first in the next one.
  const pair = Math.floor(index / 2);
  const pairFirst = pair % 2 === 0 ? opponent(state.battingFirst) : state.battingFirst;
  return index % 2 === 0 ? pairFirst : opponent(pairFirst);
}

function applySuperOverBall(state: CricketState, payload: CricketBallEv): CricketState {
  if (state.phase !== "super_over" || state.superOver === null) {
    wrongPhase(`super-over ball in phase "${state.phase}"`);
  }
  const so = state.superOver;
  const bpo = state.cfg.ballsPerOver;
  let inningsList = so.innings;
  let index = inningsList.length - 1;
  let innings = inningsList[index];
  if (innings === undefined || innings.closed) {
    index += 1;
    const battingSide = soBattingSideAt(state, index);
    innings = {
      battingSide,
      runs: 0,
      wickets: 0,
      legalBalls: 0,
      boundaries: 0,
      declared: false,
      closed: false,
      ballsLimit: bpo, // one over
      fine: freshFine(),
    };
    inningsList = [...inningsList, innings];
  }
  const battingSide = innings.battingSide;
  const updated = applyDelivery(innings, payload, {
    battingOrder: state.orders[battingSide],
    bowlingOrder: state.orders[opponent(battingSide)],
    whiteBall: true,
    ballsPerOver: bpo,
    maxOversPerBowler: undefined,
    allOut: 2, // spec cricket.md §3 — 2-wicket all out
    strictOrder: false,
    soIneligible: so.dismissed[battingSide],
  });

  const dismissedNow = payload.wicket !== undefined ? [payload.wicket.out] : [];
  const dismissed = {
    ...so.dismissed,
    [battingSide]: [...so.dismissed[battingSide], ...dismissedNow],
  };

  // Close conditions for a super-over innings.
  const second = index % 2 === 1;
  const target = second ? (inningsList[index - 1] as InningsState).runs + 1 : null;
  const shouldClose =
    updated.wickets >= 2 ||
    updated.legalBalls >= bpo ||
    (target !== null && updated.runs >= target);
  const closed: InningsState = shouldClose ? { ...updated, closed: true } : updated;
  const nextList = inningsList.map((entry, i) => (i === index ? closed : entry));
  let next: CricketState = { ...state, superOver: { innings: nextList, dismissed } };

  if (!shouldClose || !second) return next;

  // Pair complete — decide or recurse (spec §2.3).
  const first = nextList[index - 1] as InningsState;
  if (closed.runs > first.runs) {
    return decideWin(next, closed.battingSide, "super_over", "Super Over");
  }
  if (closed.runs < first.runs) {
    return decideWin(next, first.battingSide, "super_over", "Super Over");
  }
  switch (next.cfg.superOverStillTied) {
    case "repeat":
      return next; // next pair opens on the next ball (ICC current rule)
    case "boundary_count": {
      const home = boundaryCount(next, "home");
      const away = boundaryCount(next, "away");
      if (home === away) {
        return { ...next, phase: "done", outcome: { kind: "tie" }, margin: null };
      }
      return decideWin(next, home > away ? "home" : "away", "boundary_count", "on boundary count");
    }
    case "shared":
      return { ...next, phase: "done", outcome: { kind: "tie" }, margin: null };
  }
}

// ---------------------------------------------------------------------------
// Tier-2 player lines — doc 14 §1: sum-consistency vs InningsTotals; fine
// innings cross-check exactly against the derived cards.
// ---------------------------------------------------------------------------

function applyPlayerLine(
  state: CricketState,
  payload: z.infer<typeof CricketPlayerLine>,
): CricketState {
  const innings = state.innings[payload.innings - 1];
  if (innings === undefined || !innings.closed) {
    invalid(`innings ${payload.innings} is not a closed innings`);
  }
  const battingOrder = state.orders[innings.battingSide];
  const bowlingOrder = state.orders[opponent(innings.battingSide)];
  const existing = state.playerLines.filter((line) => line.innings === payload.innings);
  const dupe = existing.find(
    (line) =>
      line.person === payload.person &&
      ((line.batting !== undefined && payload.batting !== undefined) ||
        (line.bowling !== undefined && payload.bowling !== undefined)),
  );
  if (dupe !== undefined) {
    invalid(`a line for "${payload.person}" in innings ${payload.innings} already exists`);
  }

  const reject = (field: string, expected: number | string, got: number): never =>
    invalid("player line disagrees with the innings totals", {
      innings: payload.innings,
      person: payload.person,
      field,
      expected,
      got,
    });

  if (payload.batting !== undefined) {
    if (!battingOrder.includes(payload.person)) {
      invalid(`"${payload.person}" is not in the batting lineup for innings ${payload.innings}`);
    }
    if (innings.fine !== null) {
      const runs = innings.fine.batterRuns[payload.person] ?? 0;
      const balls = innings.fine.batterBalls[payload.person] ?? 0;
      if (payload.batting.runs !== runs) reject("batting.runs", runs, payload.batting.runs);
      if (payload.batting.balls !== balls) reject("batting.balls", balls, payload.batting.balls);
    } else {
      const soFar = existing.reduce((sum, line) => sum + (line.batting?.runs ?? 0), 0);
      if (soFar + payload.batting.runs > innings.runs) {
        reject("batting.runs", `≤ ${innings.runs - soFar}`, payload.batting.runs);
      }
    }
  }
  if (payload.bowling !== undefined) {
    if (!bowlingOrder.includes(payload.person)) {
      invalid(`"${payload.person}" is not in the bowling lineup for innings ${payload.innings}`);
    }
    if (innings.fine !== null) {
      const balls = innings.fine.bowlerBalls[payload.person] ?? 0;
      const runs = innings.fine.bowlerRuns[payload.person] ?? 0;
      const wickets = innings.fine.bowlerWickets[payload.person] ?? 0;
      if (payload.bowling.legalBalls !== balls) reject("bowling.legalBalls", balls, payload.bowling.legalBalls);
      if (payload.bowling.runs !== runs) reject("bowling.runs", runs, payload.bowling.runs);
      if (payload.bowling.wickets !== wickets) reject("bowling.wickets", wickets, payload.bowling.wickets);
    } else {
      const wicketsSoFar = existing.reduce((sum, line) => sum + (line.bowling?.wickets ?? 0), 0);
      const ballsSoFar = existing.reduce((sum, line) => sum + (line.bowling?.legalBalls ?? 0), 0);
      const runsSoFar = existing.reduce((sum, line) => sum + (line.bowling?.runs ?? 0), 0);
      if (wicketsSoFar + payload.bowling.wickets > innings.wickets) {
        reject("bowling.wickets", `≤ ${innings.wickets - wicketsSoFar}`, payload.bowling.wickets);
      }
      if (ballsSoFar + payload.bowling.legalBalls > innings.legalBalls) {
        reject("bowling.legalBalls", `≤ ${innings.legalBalls - ballsSoFar}`, payload.bowling.legalBalls);
      }
      if (runsSoFar + payload.bowling.runs > innings.runs) {
        reject("bowling.runs", `≤ ${innings.runs - runsSoFar}`, payload.bowling.runs);
      }
    }
  }

  const record: PlayerLineRec = {
    innings: payload.innings,
    person: payload.person,
    ...(payload.batting === undefined ? {} : { batting: payload.batting }),
    ...(payload.bowling === undefined ? {} : { bowling: payload.bowling }),
  };
  return { ...state, playerLines: [...state.playerLines, record] };
}

// ---------------------------------------------------------------------------
// Generator internals — spec 03 §6 (rng-injected, no fast-check dependency).
// ---------------------------------------------------------------------------

function eligibleBowlers(
  order: readonly string[],
  fine: FineInnings,
  maxOversPerBowler: number | undefined,
  ballsPerOver: number,
): string[] {
  return order.filter((person) => {
    if (person === fine.prevOverBowler) return false;
    if (maxOversPerBowler === undefined) return true;
    return Math.floor((fine.bowlerBalls[person] ?? 0) / ballsPerOver) < maxOversPerBowler;
  });
}

function pickFrom(items: readonly string[], rng: Rng): string {
  if (items.length === 0) invalid("generator ran out of eligible players");
  return items[Math.floor(rng() * items.length)] as string;
}

function randomDelivery(
  base: {
    over: number;
    ballInOver: number;
    striker: string;
    nonStriker: string;
    bowler: string;
  },
  freeHitPending: boolean,
  whiteBall: boolean,
  rng: Rng,
): CricketBallEv {
  const freeHit = freeHitPending ? { freeHit: true as const } : {};
  const roll = rng();
  if (roll < 0.04) {
    // Wide (occasionally with runs run). No bat runs, no free-hit consumption.
    return { ...base, runs: { bat: 0, extras: { kind: "wide", runs: rng() < 0.15 ? 2 : 1 } } };
  }
  if (whiteBall && roll < 0.06) {
    return {
      ...base,
      runs: { bat: Math.floor(rng() * 3), extras: { kind: "noball", runs: 1 } },
      ...freeHit,
    };
  }
  if (roll < 0.13) {
    const kind = rng() < 0.5 ? ("bye" as const) : ("legbye" as const);
    return { ...base, runs: { bat: 0, extras: { kind, runs: 1 + Math.floor(rng() * 2) } }, ...freeHit };
  }
  if (roll < 0.2) {
    const kind = freeHitPending
      ? ("runout" as const)
      : ((["bowled", "caught", "lbw", "runout", "stumped"] as const)[Math.floor(rng() * 5)] ??
        ("bowled" as const));
    const out = kind === "runout" && rng() < 0.4 ? base.nonStriker : base.striker;
    return {
      ...base,
      runs: { bat: kind === "runout" && rng() < 0.5 ? 1 : 0 },
      wicket: { kind, out, bowlerCredited: BOWLER_CREDITED_KINDS.has(kind) },
      ...freeHit,
    };
  }
  if (roll < 0.32) {
    const six = rng() < 0.3;
    return { ...base, runs: { bat: six ? 6 : 4 }, boundary: six ? 6 : 4, ...freeHit };
  }
  const bat = ([0, 0, 0, 1, 1, 1, 1, 2, 2, 3] as const)[Math.floor(rng() * 10)] ?? 0;
  return { ...base, runs: { bat }, ...freeHit };
}

function generateBall(state: CricketState, rng: Rng): CricketBallEv {
  const open = openInnings(state);
  const index = open === null ? state.innings.length : state.innings.length - 1;
  const battingSide = open?.innings.battingSide ?? battingSideAt(state, index);
  const order = state.orders[battingSide];
  const bowlingOrder = state.orders[opponent(battingSide)];
  const fine: FineInnings = open?.innings.fine ?? {
    ...freshFine(),
    striker: order[0] as string,
    nonStriker: order[1] as string,
    nextBatterIndex: 2,
  };
  const legalBalls = open?.innings.legalBalls ?? 0;
  const bpo = state.cfg.ballsPerOver;
  const bowler =
    fine.currentBowler ??
    pickFrom(eligibleBowlers(bowlingOrder, fine, state.cfg.maxOversPerBowler, bpo), rng);
  return randomDelivery(
    {
      over: Math.floor(legalBalls / bpo),
      ballInOver: (legalBalls % bpo) + 1,
      striker: fine.striker as string,
      nonStriker: fine.nonStriker as string,
      bowler,
    },
    fine.freeHitPending,
    state.cfg.ballsPerInnings !== null,
    rng,
  );
}

function generateSoBall(state: CricketState, rng: Rng): CricketBallEv {
  const so = state.superOver as NonNullable<CricketState["superOver"]>;
  let index = so.innings.length - 1;
  // Explicit `| undefined` so this compiles under consumers that don't enable
  // noUncheckedIndexedAccess (apps/web); a no-op under the engine's own config.
  let innings: InningsState | undefined = so.innings[index];
  if (innings === undefined || innings.closed) {
    index += 1;
    innings = undefined;
  }
  const battingSide = innings?.battingSide ?? soBattingSideAt(state, index);
  const order = state.orders[battingSide];
  const fine = innings?.fine ?? freshFine();
  const ineligible = new Set([...so.dismissed[battingSide], ...fine.dismissed]);
  const survivors = [fine.striker, fine.nonStriker].filter((p): p is string => p !== null);
  const fresh = order.filter(
    (person) => !ineligible.has(person) && !survivors.includes(person),
  );
  const striker = survivors[0] ?? fresh[0];
  const nonStriker = survivors[1] ?? (striker === fresh[0] ? fresh[1] : fresh[0]);
  if (striker === undefined || nonStriker === undefined) {
    invalid("generator ran out of eligible super-over batters");
  }
  // One bowler bowls the whole super over — reuse the over's bowler mid-over
  // (the fold rejects a change of bowler within an over).
  const bowler =
    fine.currentBowler ?? pickFrom(state.orders[opponent(battingSide)], rng);
  return randomDelivery(
    {
      over: 0,
      ballInOver: ((innings?.legalBalls ?? 0) % state.cfg.ballsPerOver) + 1,
      striker,
      nonStriker,
      bowler,
    },
    fine.freeHitPending,
    true,
    rng,
  );
}

// ---------------------------------------------------------------------------
// Positions — spec §2.7
// ---------------------------------------------------------------------------

const positions: PositionCatalog = {
  groups: [
    { key: "BAT", name: "Batter" },
    { key: "BOWL", name: "Bowler" },
    { key: "AR", name: "All-rounder" },
    { key: "WK", name: "Wicketkeeper" },
  ],
  roles: [
    { key: "captain", name: "Captain", unique: true },
    { key: "wicketkeeper", name: "Wicketkeeper", unique: true, required: true },
  ],
  lineup: { size: 11, benchMax: 4 }, // substitutes: fielding only (spec §2.7)
};

// ---------------------------------------------------------------------------
// Module
// ---------------------------------------------------------------------------

function orderFromLineup(lineup: LineupPair["home"]): string[] {
  return lineup.slots
    .filter((slot) => slot.slot === "starting")
    .sort((a, b) => a.orderNo - b.orderNo)
    .map((slot) => slot.personId);
}

function sideLine(state: CricketState, side: Side): string {
  const list = state.innings.filter((innings) => innings.battingSide === side);
  if (list.length === 0) return "—";
  return list
    .map((innings) => {
      const allOut = innings.wickets >= allOutWickets(state, side);
      const wickets = allOut ? "" : `/${innings.wickets}`;
      const declared = innings.declared ? "d" : "";
      const overs =
        state.cfg.inningsPerSide === 1
          ? ` (${oversText(innings.legalBalls, state.cfg.ballsPerOver)})`
          : "";
      return `${innings.runs}${wickets}${declared}${overs}`;
    })
    .join(" & ");
}

export const cricket: SportModule<CricketCfg, CricketEv, CricketState> = {
  key: "cricket",
  version: "1.0.0",
  configSchema: CricketCfg,
  eventSchema: CricketEv,
  positions,
  variants: {
    // spec 04 §2.1
    t20: { ballsPerInnings: 120, maxOversPerBowler: 4 },
    odi: { ballsPerInnings: 300, maxOversPerBowler: 10, minOversForResult: 20 },
    hundred: { ballsPerInnings: 100, ballsPerOver: 5, maxOversPerBowler: 4 },
    test: {
      inningsPerSide: 2,
      ballsPerInnings: null,
      points: { win: 2, tie: 1, noResult: 1, loss: 0, draw: 1 },
      superOver: false, // multi-day cricket draws; it never goes to a super over
      followOn: { enabled: true, lead: 200 },
      minOversForResult: 0,
    },
    "pairs-6-a-side": { playersPerSide: 6, ballsPerInnings: 60, maxOversPerBowler: 2 },
  },

  // spec 03 §2 guarantee 4 — post-match scorecards append after the decision.
  postDecisionTypes: ["cricket.player.line"],

  init(cfg, lineups: LineupPair): CricketState {
    return {
      cfg,
      entrants: { home: lineups.home.entrantId, away: lineups.away.entrantId },
      orders: { home: orderFromLineup(lineups.home), away: orderFromLineup(lineups.away) },
      phase: "pre",
      battingFirst: "home", // toss overrides
      tossTaken: false,
      innings: [],
      followOnEnforced: false,
      quota: cfg.ballsPerInnings,
      revisedTarget: null,
      targetSource: null,
      r1: null,
      r2: null,
      interruptions: 0,
      superOver: null,
      outcome: null,
      margin: null,
      playerLines: [],
    };
  },

  apply(state, ev: EventEnvelope<CricketEv | CoreEv>): CricketState {
    switch (ev.type) {
      case "core.start":
        if (state.phase !== "pre") wrongPhase("already started");
        return { ...state, phase: "live" };
      case "cricket.toss": {
        if (state.phase !== "pre") wrongPhase("toss must precede core.start");
        if (state.tossTaken) invalid("toss already recorded");
        const payload = parsePayload(CricketToss, ev.payload, ev.type);
        const winner = sideOf(state, payload.wonBy);
        return {
          ...state,
          tossTaken: true,
          battingFirst: payload.elected === "bat" ? winner : opponent(winner),
        };
      }
      case "cricket.ball": {
        if (state.phase !== "live") wrongPhase(`ball in phase "${state.phase}"`);
        const payload = parsePayload(CricketBall, ev.payload, ev.type);
        let next = state;
        let open = openInnings(next);
        if (open !== null && open.innings.fine === null) {
          invalid("this innings is recorded at summary fidelity — ball events are not allowed");
        }
        if (open === null) {
          next = createInnings(next, "fine");
          open = openInnings(next) as { innings: InningsState; index: number };
        }
        const battingSide = open.innings.battingSide;
        const updated = applyDelivery(open.innings, payload, {
          battingOrder: next.orders[battingSide],
          bowlingOrder: next.orders[opponent(battingSide)],
          whiteBall: next.cfg.ballsPerInnings !== null,
          ballsPerOver: next.cfg.ballsPerOver,
          maxOversPerBowler: next.cfg.maxOversPerBowler,
          allOut: allOutWickets(next, battingSide),
          strictOrder: true,
          soIneligible: [],
        });
        return autoClose(replaceInnings(next, open.index, updated));
      }
      case "cricket.superover.ball":
        return applySuperOverBall(state, parsePayload(CricketBall, ev.payload, ev.type));
      case "cricket.innings.summary":
        return applySummary(state, parsePayload(CricketInningsSummary, ev.payload, ev.type));
      case "cricket.innings.declare": {
        if (state.phase !== "live") wrongPhase(`declare in phase "${state.phase}"`);
        parsePayload(CricketDeclare, ev.payload, ev.type);
        if (state.cfg.inningsPerSide !== 2) {
          invalid("declarations apply to two-innings matches only");
        }
        return closeOpenInnings(state, true);
      }
      case "cricket.innings.close": {
        if (state.phase !== "live") wrongPhase(`innings close in phase "${state.phase}"`);
        parsePayload(CricketClose, ev.payload, ev.type);
        return closeOpenInnings(state, false);
      }
      case "cricket.match.close": {
        if (state.phase !== "live") wrongPhase(`match close in phase "${state.phase}"`);
        parsePayload(CricketMatchClose, ev.payload, ev.type);
        if (state.cfg.inningsPerSide !== 2) {
          invalid("match close (time expiry draw) applies to two-innings matches only");
        }
        // spec §2.3 — draw on time expiry.
        return { ...state, phase: "done", outcome: { kind: "draw" }, margin: null };
      }
      case "cricket.interruption": {
        if (state.phase !== "pre" && state.phase !== "live") {
          wrongPhase(`interruption in phase "${state.phase}"`);
        }
        parsePayload(CricketInterruption, ev.payload, ev.type);
        // Metadata only — the revise event carries the numbers (spec §2.5).
        return { ...state, interruptions: state.interruptions + 1 };
      }
      case "cricket.revise":
        return applyRevise(state, parsePayload(CricketRevise, ev.payload, ev.type));
      case "cricket.followon": {
        if (state.phase !== "live") wrongPhase(`follow-on in phase "${state.phase}"`);
        parsePayload(CricketFollowOn, ev.payload, ev.type);
        const followOn = state.cfg.followOn;
        if (state.cfg.inningsPerSide !== 2 || followOn === undefined || !followOn.enabled) {
          invalid("follow-on is not enabled for this match");
        }
        if (state.innings.length !== 2 || openInnings(state) !== null) {
          invalid("follow-on is decided between the 2nd and 3rd innings");
        }
        const lead =
          (state.innings[0] as InningsState).runs - (state.innings[1] as InningsState).runs;
        if (lead < followOn.lead) {
          invalid(`follow-on requires a lead of ${followOn.lead} (actual ${lead})`);
        }
        return { ...state, followOnEnforced: true };
      }
      case "cricket.player.line":
        return applyPlayerLine(state, parsePayload(CricketPlayerLine, ev.payload, ev.type));
      case "core.forfeit": {
        if (state.phase === "done" || state.phase === "final") wrongPhase("match already over");
        const by = (ev.payload as { by: string }).by;
        const winner = opponent(sideOf(state, by));
        return {
          ...state,
          phase: "done",
          outcome: { kind: "award", winner: state.entrants[winner] },
          margin: null,
        };
      }
      case "core.abandon":
        return applyAbandon(state);
      case "core.finalize":
        if (state.outcome === null) wrongPhase("cannot finalize an undecided fixture");
        return { ...state, phase: "final" };
      case "core.note":
        return state;
      default:
        invalid(`unknown event type "${ev.type}"`);
    }
  },

  outcome: (state) => state.outcome,

  // §9.5 — reads only InningsTotals (never fine state), so coarse and fine
  // folds of the same match render identically (§9.6).
  summary(state): ScoreSummary {
    const home = sideLine(state, "home");
    const away = sideLine(state, "away");
    const so = state.superOver;
    const soTally =
      so === null
        ? null
        : so.innings.reduce(
            (tally, innings) => {
              tally[innings.battingSide] += innings.runs;
              return tally;
            },
            { home: 0, away: 0 },
          );
    const headline = `${home} — ${away}${soTally ? ` · SO ${soTally.home}–${soTally.away}` : ""}`;
    return {
      headline,
      perSide: [
        { entrantId: state.entrants.home, line: home },
        { entrantId: state.entrants.away, line: away },
      ],
      detail: {
        innings: state.innings.map((innings) => ({
          entrantId: state.entrants[innings.battingSide],
          runs: innings.runs,
          wickets: innings.wickets,
          legalBalls: innings.legalBalls,
          declared: innings.declared,
          closed: innings.closed,
        })),
        ...(state.revisedTarget === null
          ? {}
          : { target: state.revisedTarget, targetSource: state.targetSource }),
        ...(state.margin === null ? {} : { margin: state.margin }),
        ...(soTally === null ? {} : { superOver: soTally }),
      },
    };
  },

  // spec §2.4/§2.6 — integer NRR ledger; NRR itself is computed at rank time
  // from these integers (never stored as a float).
  standingsDelta(outcome, cfg, _ctx: StageCtx, state): [StandingsDelta, StandingsDelta] {
    const allOutFor = (side: Side) => allOutWickets(state, side);
    // spec §2.4 — a bowled-out side is charged its full quota; DLS-revised
    // matches use the revised quota (the innings' ballsLimit at close).
    const effectiveBalls = (innings: InningsState): number => {
      if (innings.ballsLimit !== null && innings.wickets >= allOutFor(innings.battingSide)) {
        return innings.ballsLimit;
      }
      return innings.legalBalls;
    };
    const ledger = (side: Side): Record<string, number> => {
      let runsFor = 0;
      let ballsFaced = 0;
      let runsAgainst = 0;
      let ballsBowled = 0;
      for (const innings of state.innings) {
        if (innings.battingSide === side) {
          runsFor += innings.runs;
          ballsFaced += effectiveBalls(innings);
        } else {
          runsAgainst += innings.runs;
          ballsBowled += effectiveBalls(innings);
        }
      }
      return {
        runs_for: runsFor,
        balls_faced_eff: ballsFaced,
        runs_against: runsAgainst,
        balls_bowled_eff: ballsBowled,
        ties: 0,
        no_results: 0,
      };
    };
    const zeroLedger = (): Record<string, number> => ({
      runs_for: 0,
      balls_faced_eff: 0,
      runs_against: 0,
      balls_bowled_eff: 0,
      ties: 0,
      no_results: 0,
    });
    const build = (
      side: Side,
      w: number,
      d: number,
      l: number,
      pts: number,
      metrics: Record<string, number>,
    ): StandingsDelta => ({
      entrantId: state.entrants[side],
      played: 1,
      won: w,
      drawn: d,
      lost: l,
      points: pts,
      metrics,
    });

    switch (outcome.kind) {
      case "win": {
        const winnerSide = sideOf(state, outcome.winner);
        const winner = build(winnerSide, 1, 0, 0, cfg.points.win, ledger(winnerSide));
        const loser = build(opponent(winnerSide), 0, 0, 1, cfg.points.loss, ledger(opponent(winnerSide)));
        return winnerSide === "home" ? [winner, loser] : [loser, winner];
      }
      case "award": {
        // Forfeit: full points, no NRR contribution (ICC convention).
        const winnerSide = sideOf(state, outcome.winner);
        const winner = build(winnerSide, 1, 0, 0, cfg.points.win, zeroLedger());
        const loser = build(opponent(winnerSide), 0, 0, 1, cfg.points.loss, zeroLedger());
        return winnerSide === "home" ? [winner, loser] : [loser, winner];
      }
      case "tie": {
        const metrics = (side: Side) => ({ ...ledger(side), ties: 1 });
        return [
          build("home", 0, 0, 0, cfg.points.tie, metrics("home")),
          build("away", 0, 0, 0, cfg.points.tie, metrics("away")),
        ];
      }
      case "draw": {
        const pts = cfg.points.draw ?? cfg.points.tie;
        return [
          build("home", 0, 1, 0, pts, zeroLedger()),
          build("away", 0, 1, 0, pts, zeroLedger()),
        ];
      }
      case "no_result": {
        const metrics = () => ({ ...zeroLedger(), no_results: 1 });
        return [
          build("home", 0, 0, 0, cfg.points.noResult, metrics()),
          build("away", 0, 0, 0, cfg.points.noResult, metrics()),
        ];
      }
    }
  },

  metrics: [
    { key: "runs_for", label: "Runs for", direction: "desc" },
    { key: "balls_faced_eff", label: "Balls faced (eff.)", direction: "asc" },
    { key: "runs_against", label: "Runs against", direction: "asc" },
    { key: "balls_bowled_eff", label: "Balls bowled (eff.)", direction: "desc" },
    { key: "ties", label: "Ties", direction: "desc" },
    { key: "no_results", label: "No results", direction: "desc" },
  ],
  // spec §2.6 — ICC-style cascade; `nrr` is resolved from the integer ledger
  // by the competition engine at rank time (cross-multiplication).
  defaultTiebreakers: ["points", "wins", "nrr", "h2h_points", "seed"],

  // Draw exists only in 2-innings cricket and only survives league/group play.
  supportsDraws(cfg, stage: StageKind) {
    return cfg.inningsPerSide === 2 && (stage === "league" || stage === "group" || stage === "swiss");
  },

  // §9.3 — {win+loss, 2·tie, 2·noResult, 2·draw}.
  declaredPointsSets(cfg) {
    return [
      ...new Set([
        cfg.points.win + cfg.points.loss,
        cfg.points.tie * 2,
        cfg.points.noResult * 2,
        (cfg.points.draw ?? cfg.points.tie) * 2,
      ]),
    ];
  },

  // doc 14 §2 — the four-tier ladder; cricket is the sport with a real Tier 2.
  fidelityTiers: [
    { tier: 0, eventTypes: ["cricket.innings.summary"] },
    {
      tier: 1,
      eventTypes: [
        "cricket.innings.summary",
        "cricket.toss",
        "cricket.innings.declare",
        "cricket.innings.close",
        "cricket.match.close",
        "cricket.interruption",
        "cricket.revise",
        "cricket.followon",
        "cricket.superover.ball",
      ],
    },
    { tier: 2, eventTypes: ["cricket.player.line"], entitlement: "stats.player" },
    {
      tier: 3,
      eventTypes: ["cricket.ball", "cricket.superover.ball"],
      entitlement: "scoring.ball_by_ball",
    },
  ],
  officialLabel: { scorer: "Umpire" }, // doc 13 §1

  // spec 03 §6 / PROMPT-05 §9 — generates only legal deliveries.
  arbitraryEvent(state, rng: Rng): ModuleEvent<CricketEv> | null {
    const pick = <T>(items: readonly T[]): T => items[Math.floor(rng() * items.length)] as T;

    if (state.phase === "pre") {
      if (!state.tossTaken && rng() < 0.4) {
        return {
          type: "cricket.toss",
          payload: {
            wonBy: rng() < 0.5 ? state.entrants.home : state.entrants.away,
            elected: rng() < 0.5 ? "bat" : "bowl",
          },
        };
      }
      return { type: "core.start", payload: {} };
    }
    if (state.phase === "done" || state.phase === "final") return null;

    if (state.phase === "super_over") {
      return { type: "cricket.superover.ball", payload: generateSoBall(state, rng) };
    }

    const open = openInnings(state);
    if (open === null) {
      // Between innings.
      const cfg = state.cfg;
      if (cfg.inningsPerSide === 2 && state.innings.length >= 2 && rng() < 0.05) {
        return { type: "cricket.match.close", payload: {} };
      }
      if (
        cfg.inningsPerSide === 2 &&
        cfg.followOn?.enabled === true &&
        state.innings.length === 2 &&
        !state.followOnEnforced &&
        (state.innings[0] as InningsState).runs - (state.innings[1] as InningsState).runs >=
          cfg.followOn.lead &&
        rng() < 0.5
      ) {
        return { type: "cricket.followon", payload: {} };
      }
      if (rng() < 0.6) {
        // Coarse innings in one event.
        const limit = state.quota;
        const nextIndex = state.innings.length;
        const battingSide = battingSideAt(state, nextIndex);
        const allOut = allOutWickets(state, battingSide);
        const bowledOut = rng() < 0.3;
        const wickets = bowledOut ? allOut : Math.floor(rng() * allOut);
        const legalBalls =
          limit === null
            ? 60 + Math.floor(rng() * 400)
            : bowledOut
              ? 1 + Math.floor(rng() * limit)
              : limit;
        const runs = Math.floor(rng() * 220);
        return {
          type: "cricket.innings.summary",
          payload: {
            runs,
            wickets,
            legalBalls,
            boundaries: Math.floor(runs / 8),
            ...(state.cfg.inningsPerSide === 2 && rng() < 0.15 ? { declared: true } : {}),
          },
        };
      }
      return { type: "cricket.ball", payload: generateBall(state, rng) };
    }

    if (open.innings.fine === null) {
      // Open coarse innings never comes from this generator, but stay total.
      return { type: "cricket.innings.close", payload: {} };
    }
    const roll = rng();
    if (roll < 0.004) return { type: "core.abandon", payload: { reason: "rain" } };
    if (roll < 0.006) {
      return {
        type: "core.forfeit",
        payload: { by: rng() < 0.5 ? state.entrants.home : state.entrants.away, reason: "walkover" },
      };
    }
    if (roll < 0.012 && state.quota !== null && state.cfg.inningsPerSide === 1) {
      const bpo = state.cfg.ballsPerOver;
      const currentOvers = Math.floor(state.quota / bpo);
      const floorOvers = Math.max(1, Math.ceil(open.innings.legalBalls / bpo));
      if (currentOvers - 1 >= floorOvers) {
        const newOvers = Math.max(floorOvers, currentOvers - 1 - Math.floor(rng() * 3));
        return { type: "cricket.revise", payload: { oversPerSide: newOvers } };
      }
    }
    if (
      roll < 0.03 &&
      state.cfg.inningsPerSide === 2 &&
      open.innings.runs > 50 &&
      state.innings.length < 4
    ) {
      return { type: "cricket.innings.declare", payload: {} };
    }
    return { type: "cricket.ball", payload: generateBall(state, rng) };
  },

  // §9.6 / spec §2.2 — coarsen: collapse ball runs into innings summaries.
  // cfg-free by design: it emits `partial` snapshots at every boundary and
  // lets the fold's auto-close rules (identical for both fidelities) decide
  // closure, so coarse folds close and decide exactly where fine folds did.
  coarsen(events): ModuleEvent<CricketEv>[] {
    interface Tracker {
      runs: number;
      wickets: number;
      legalBalls: number;
      boundaries: number;
      seen: Set<string>;
    }
    const out: ModuleEvent<CricketEv>[] = [];
    let cur: Tracker | null = null;
    let dirty = false; // unflushed deliveries since the last snapshot
    // Emit a cumulative partial snapshot at most once per set of new balls, so
    // a snapshot taken for a mid-innings pass-through (revise) isn't re-emitted
    // by the trailing flush as a post-decision duplicate.
    const flush = () => {
      if (cur === null || !dirty) return;
      out.push({
        type: "cricket.innings.summary",
        payload: {
          runs: cur.runs,
          wickets: cur.wickets,
          legalBalls: cur.legalBalls,
          boundaries: cur.boundaries,
          partial: true,
        },
      });
      dirty = false;
    };
    for (const event of events) {
      switch (event.type) {
        case "cricket.ball": {
          const ball = event.payload as CricketBallEv;
          // New innings when both crease batters are unseen (sides alternate;
          // the follow-on boundary always carries an explicit event).
          if (cur !== null && !cur.seen.has(ball.striker) && !cur.seen.has(ball.nonStriker)) {
            flush();
            cur = null;
          }
          cur ??= { runs: 0, wickets: 0, legalBalls: 0, boundaries: 0, seen: new Set() };
          const extras = ball.runs.extras;
          const legal =
            extras === undefined || (extras.kind !== "wide" && extras.kind !== "noball");
          cur.runs += ball.runs.bat + (extras?.runs ?? 0);
          cur.wickets += ball.wicket === undefined ? 0 : 1;
          cur.legalBalls += legal ? 1 : 0;
          cur.boundaries += ball.boundary === undefined ? 0 : 1;
          cur.seen.add(ball.striker);
          cur.seen.add(ball.nonStriker);
          dirty = true;
          break;
        }
        case "cricket.innings.summary":
        case "cricket.innings.close":
        case "cricket.innings.declare":
        case "cricket.followon":
          // Innings boundary: snapshot totals, then the explicit event closes
          // (or hands over) the innings in the fold.
          flush();
          cur = null;
          out.push({ type: event.type, payload: event.payload });
          break;
        case "cricket.player.line":
          break; // Tier-2 attribution — dropped at coarse fidelity
        default:
          // revise / interruption / toss / match.close / superover.ball /
          // core.* — snapshot so the fold decides on the same totals, then
          // pass through. The innings may continue afterwards (revise).
          flush();
          out.push({ type: event.type, payload: event.payload });
      }
    }
    flush();
    return out;
  },
};

