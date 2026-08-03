// Set-based scoring kernel — spec 04 §3–5 + engine/sports/{volleyball,badminton,
// table-tennis}.md (PROMPT-06). ONE parametric engine parameterised by
// {bestOf, setTo, finalSetTo, winBy, cap, pointsMap}; volleyball, badminton and
// table tennis are three thin presets — this file owns every line of set logic,
// the presets add only catalog/metrics/labels. Dual fidelity (spec 04 §9.6):
// fine `rally {wonBy}` and coarse `*.summary` fold to identical set totals and
// outcomes, and all result math reads only the folded set ledger.
import { z } from "zod";
import { EngineError } from "../../core/errors.ts";
import type { CoreEv, EventEnvelope } from "../../core/events.ts";
import type { Rng } from "../../core/rng.ts";
import {
  EntrantId,
  type LineupPair,
  type MatchOutcome,
  type MetricSpec,
  type ScoreSummary,
  type StageKind,
  type StandingsDelta,
} from "../../core/types.ts";
import type { PositionCatalog } from "../../sport/catalog.ts";
import type { EntrantModel } from "../../sport/entrant-model.ts";
import type { PlayerStatsModel } from "../../stats/stats.ts";
import type {
  FidelityTier,
  ModuleEvent,
  SportModule,
  TiebreakerKey,
} from "../../sport/module.ts";

// ---------------------------------------------------------------------------
// Kernel parameters & config — spec 04 §3.1 / §4 / §5
// ---------------------------------------------------------------------------

// A completed-set score maps to [winnerPoints, loserPoints] keyed by the
// winner's set tally "W-L" (FIVB 3-2 → [2,1]); "*" is the fall-through for
// every other (clean-win) score. Integers only — spec 04 §9.3.
export const PointsPair = z.tuple([
  z.number().int().nonnegative(),
  z.number().int().nonnegative(),
]);
export type PointsPair = z.infer<typeof PointsPair>;

export interface SetBasedParams {
  bestOf: number;
  setTo: number;
  finalSetTo: number;
  winBy: number;
  cap: number | null;
  pointsMap: Record<string, PointsPair>;
}

// Builds a preset's config schema (defaults = its shipped/first variant).
// Refinements are the kernel's hard invariants: odd bestOf (so ⌈bestOf/2⌉ has a
// unique decider) and cap ≥ target.
function makeConfigSchema(defaults: SetBasedParams) {
  return z
    .object({
      bestOf: z.number().int().positive().default(defaults.bestOf),
      setTo: z.number().int().positive().default(defaults.setTo),
      finalSetTo: z.number().int().positive().default(defaults.finalSetTo),
      winBy: z.number().int().positive().default(defaults.winBy),
      cap: z.number().int().positive().nullable().default(defaults.cap),
      pointsMap: z.record(z.string().min(1), PointsPair).default(defaults.pointsMap),
    })
    .refine((cfg) => cfg.bestOf % 2 === 1, { message: "bestOf must be odd (a decider must exist)" })
    .refine((cfg) => cfg.cap === null || cfg.cap >= Math.max(cfg.setTo, cfg.finalSetTo), {
      message: "cap must be ≥ the set target",
    })
    .refine((cfg) => Object.keys(cfg.pointsMap).length > 0, {
      message: "pointsMap needs at least one entry",
    });
}

export type SetBasedCfg = SetBasedParams;

// ---------------------------------------------------------------------------
// Events — spec 04 §3.2 / §4 / §5
// ---------------------------------------------------------------------------

// W4 (#407) — person attribution. `PersonId` mirrors the football convention
// (a plain non-empty id); EVERY person field is optional so a coarse scorer who
// records nothing but `wonBy` stays legal and folds exactly as before.
export const PersonId = z.string().min(1);

// The FIVB scoresheet's point-by-point grid records the SERVING player's
// number, and the BWF / ITTF umpire sheets track the server through the service
// rotation — so `server` is a genuine scorebook field, not broadcast trivia.
// `scorer` is the player credited with the terminating action (kill/block/ace/
// winner); only pads that ask for it will send it.
export const SetBasedRally = z.strictObject({
  wonBy: EntrantId,
  server: PersonId.optional(),
  scorer: PersonId.optional(),
});
export type SetBasedRally = z.infer<typeof SetBasedRally>;

// Coarse fidelity. Two accepted shapes fold identically:
//  • positional `{home, away}` — the scorer form (spec 04 §3.2 `set.summary`);
//  • entrant-keyed `{by, forBy, forOpp}` — the fidelity bridge coarsen emits,
//    position-independent so coarsen needs no lineup context (`by` scored
//    `forBy`, the opponent `forOpp`).
// `partial: true` = an in-progress (non-terminal) snapshot — the coarse analogue
// of an unfinished rally set, so a stream stopped mid-set renders the same live
// score after coarsening (spec 04 §9.6).
export const SetSummaryPositional = z.strictObject({
  home: z.number().int().nonnegative(),
  away: z.number().int().nonnegative(),
  partial: z.boolean().optional(),
});
export const SetSummaryByEntrant = z.strictObject({
  by: EntrantId,
  forBy: z.number().int().nonnegative(),
  forOpp: z.number().int().nonnegative(),
  partial: z.boolean().optional(),
});
export const SetBasedSummary = z.union([SetSummaryPositional, SetSummaryByEntrant]);
export type SetBasedSummary = z.infer<typeof SetBasedSummary>;

// W4 (#407) — the interruptions a set-based scoresheet actually carries.
// Which of the three a sport records is declared per preset (`records`): FIVB
// keeps timeouts, sanctions and substitutions; the ITTF sheet keeps timeouts
// and cards; BWF has no timeouts and no substitutions at all.
//
// NONE of these touches the score. A volleyball penalty concedes a rally and an
// ITTF penalty card awards a point, but the scoresheet writes that point into
// the point-by-point grid — so the point arrives as a rally and this row is the
// record of the misconduct, exactly as on paper.

/** FIVB's four-step sanction ladder. The BWF card ladder (yellow warning / red
 *  fault / black disqualification) and the ITTF yellow/red cards map onto it —
 *  each sport's dossier records the mapping. */
export const SetBasedSanctionLevel = z.enum([
  "warning",
  "penalty",
  "expulsion",
  "disqualification",
]);
export type SetBasedSanctionLevel = z.infer<typeof SetBasedSanctionLevel>;

export const SetBasedTimeout = z.strictObject({
  by: EntrantId,
  /** FIVB technical timeout (automatic at 8/16 in a non-deciding set). */
  technical: z.boolean().optional(),
});
export type SetBasedTimeout = z.infer<typeof SetBasedTimeout>;

export const SetBasedSanction = z.strictObject({
  by: EntrantId,
  level: SetBasedSanctionLevel,
  person: PersonId.optional(), // absent = a team sanction
});
export type SetBasedSanction = z.infer<typeof SetBasedSanction>;

export const SetBasedSub = z.strictObject({
  by: EntrantId,
  in: PersonId.optional(),
  out: PersonId.optional(),
});
export type SetBasedSub = z.infer<typeof SetBasedSub>;

// Branch order matters: z.union takes the FIRST branch that parses, so the new
// branches are APPENDED and every pre-existing payload still lands on the
// branch it always did (rally needs `wonBy`, the summaries need home/away or
// forBy+forOpp — none of which the new strict branches accept).
// A bare `{by}` is accepted by both the timeout and the substitution branch;
// that overlap is inert because `apply` dispatches on the ENVELOPE type and
// parses with the one branch that type names.
export const SetBasedEv = z.union([
  SetBasedRally,
  SetBasedSummary,
  SetBasedTimeout,
  SetBasedSanction,
  SetBasedSub,
]);
export type SetBasedEv = z.infer<typeof SetBasedEv>;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export type Side = "home" | "away";

export interface SetState {
  home: number;
  away: number;
  closed: boolean;
}

/** Per-person tallies folded out of attributed rallies (W4). */
export interface SetBasedPersonTally {
  points: number; // rallies won by this player's terminating action
  serves: number; // rallies this player served
}

export interface SetBasedSanctionRec {
  by: Side;
  level: SetBasedSanctionLevel;
  person?: string;
}

export interface SetBasedSubRec {
  by: Side;
  in?: string;
  out?: string;
}

export interface SetBasedSubState {
  home: number; // match totals
  away: number;
  thisSet: { home: number; away: number }; // reset when a set closes
  log: SetBasedSubRec[];
}

export interface SetBasedState {
  cfg: SetBasedCfg;
  entrants: { home: string; away: string };
  phase: "pre" | "live" | "done" | "final" | "abandoned";
  sets: SetState[]; // closed sets in order + at most one trailing open set
  setsWon: { home: number; away: number };
  outcome: MatchOutcome | null;
  replayFlagged: boolean;
  // ---- W4 (#407) additive extensions. Every one of these is ABSENT until the
  // event that fills it arrives, so a stream recorded before W4 folds to a
  // byte-identical state (the golden corpus compares JSON.stringify(state)).
  // Never initialise them in `init`.
  persons?: Record<string, SetBasedPersonTally>;
  timeouts?: { home: number; away: number };
  sanctions?: SetBasedSanctionRec[];
  subs?: SetBasedSubState;
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

function sideOf(state: SetBasedState, entrantId: string): Side {
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
// Set-win predicate & reachability — spec 04 §3.3 (single source of truth for
// both fidelities and coarsen)
// ---------------------------------------------------------------------------

const majority = (bestOf: number): number => Math.ceil(bestOf / 2);

// The deciding set is the last possible one (index bestOf−1, reached only at
// ⌈bestOf/2⌉−1 sets each) and uses finalSetTo (spec 04 §3.3).
function setTarget(params: SetBasedParams, setIndex: number): number {
  return setIndex === params.bestOf - 1 ? params.finalSetTo : params.setTo;
}

// Winner of a set at score (h,a), or null while it is still live. `cap` is the
// hard golden-point ceiling (badminton 30-29); cap=null = uncapped win-by-two
// endgame (volleyball 32-30). spec 04 §3.3.
function setWinner(
  h: number,
  a: number,
  target: number,
  winBy: number,
  cap: number | null,
): Side | null {
  const winner: Side | null = h > a ? "home" : a > h ? "away" : null;
  if (winner === null) return null;
  const hi = Math.max(h, a);
  const lo = Math.min(h, a);
  if (cap !== null && hi >= cap) return winner;
  if (hi >= target && hi - lo >= winBy) return winner;
  return null;
}

// A summary score is *reachable* iff it is terminal and the score one point
// earlier (winner one lower) was still live — rejecting 25-24 (winBy 2, no cap)
// and 22-19 / 31-30 (already decided earlier), accepting 26-24, 30-29 (cap),
// 32-30 (spec 04 §3.3; badminton/TT §3 corners).
function reachableSetScore(
  h: number,
  a: number,
  target: number,
  winBy: number,
  cap: number | null,
): boolean {
  // The set ends *at* the cap, so no score can exceed it (rejects 31-30).
  if (cap !== null && Math.max(h, a) > cap) return false;
  const winner = setWinner(h, a, target, winBy, cap);
  if (winner === null) return false;
  const prevH = winner === "home" ? h - 1 : h;
  const prevA = winner === "away" ? a - 1 : a;
  if (prevH < 0 || prevA < 0) return false;
  return setWinner(prevH, prevA, target, winBy, cap) === null;
}

// ---------------------------------------------------------------------------
// Fold helpers
// ---------------------------------------------------------------------------

function openSet(state: SetBasedState): { set: SetState; index: number } | null {
  const index = state.sets.length - 1;
  const set = state.sets[index];
  if (set === undefined || set.closed) return null;
  return { set, index };
}

function replaceSet(state: SetBasedState, index: number, set: SetState): SetBasedState {
  return { ...state, sets: state.sets.map((entry, i) => (i === index ? set : entry)) };
}

function totalPoints(state: SetBasedState, side: Side): number {
  return state.sets.reduce((sum, set) => sum + set[side], 0);
}

// W4 — credit optional person fields onto the tally map. Returns the SAME
// reference when nothing is credited, so an unattributed stream never
// materialises the `persons` key (golden byte-identity) and `apply` stays pure.
function creditPersons(
  persons: Record<string, SetBasedPersonTally> | undefined,
  credits: ReadonlyArray<readonly [string | undefined, keyof SetBasedPersonTally]>,
): Record<string, SetBasedPersonTally> | undefined {
  const named = credits.filter((entry): entry is readonly [string, keyof SetBasedPersonTally] =>
    entry[0] !== undefined,
  );
  if (named.length === 0) return persons;
  const next: Record<string, SetBasedPersonTally> = { ...(persons ?? {}) };
  for (const [personId, key] of named) {
    const prev = next[personId] ?? { points: 0, serves: 0 };
    next[personId] = { ...prev, [key]: prev[key] + 1 };
  }
  return next;
}

// Closes the set at `index` for `winnerSide`, banks the set win and decides the
// match when a side reaches ⌈bestOf/2⌉ sets (spec 04 §3.3). No draws, ever.
function bankSet(state: SetBasedState, index: number, winnerSide: Side): SetBasedState {
  const closed: SetState = { ...(state.sets[index] as SetState), closed: true };
  const setsWon = { ...state.setsWon, [winnerSide]: state.setsWon[winnerSide] + 1 };
  let next: SetBasedState = { ...replaceSet(state, index, closed), setsWon };
  // A new set means a fresh substitution allowance (indoor volleyball counts
  // six a SET, not a match) — the match totals keep running.
  if (next.subs !== undefined) {
    next = { ...next, subs: { ...next.subs, thisSet: { home: 0, away: 0 } } };
  }
  if (setsWon[winnerSide] >= majority(state.cfg.bestOf)) {
    next = {
      ...next,
      phase: "done",
      outcome: {
        kind: "win",
        winner: next.entrants[winnerSide],
        loser: next.entrants[opponent(winnerSide)],
        method: "regulation",
      },
    };
  }
  return next;
}

// ---------------------------------------------------------------------------
// Event application
// ---------------------------------------------------------------------------

function applyRally(state: SetBasedState, payload: SetBasedRally): SetBasedState {
  if (state.phase !== "live") wrongPhase(`rally not allowed in phase "${state.phase}"`);
  const side = sideOf(state, payload.wonBy);

  const persons = creditPersons(state.persons, [
    [payload.scorer, "points"],
    [payload.server, "serves"],
  ]);
  let next = persons === state.persons ? state : { ...state, persons };
  let open = openSet(next);
  if (open === null) {
    next = { ...next, sets: [...next.sets, { home: 0, away: 0, closed: false }] };
    open = openSet(next) as { set: SetState; index: number };
  }
  const scored: SetState = { ...open.set, [side]: open.set[side] + 1 };
  const target = setTarget(next.cfg, open.index);
  const winner = setWinner(scored.home, scored.away, target, next.cfg.winBy, next.cfg.cap);
  next = replaceSet(next, open.index, scored);
  return winner === null ? next : bankSet(next, open.index, winner);
}

// Resolves either summary shape to positional home/away.
function normalizeSummary(
  state: SetBasedState,
  payload: SetBasedSummary,
): { home: number; away: number; partial: boolean } {
  if ("by" in payload) {
    const side = sideOf(state, payload.by);
    const home = side === "home" ? payload.forBy : payload.forOpp;
    const away = side === "home" ? payload.forOpp : payload.forBy;
    return { home, away, partial: payload.partial === true };
  }
  return { home: payload.home, away: payload.away, partial: payload.partial === true };
}

function applySummary(state: SetBasedState, payload: SetBasedSummary): SetBasedState {
  if (state.phase !== "live") wrongPhase(`set summary not allowed in phase "${state.phase}"`);
  const params = state.cfg;
  const { home, away, partial } = normalizeSummary(state, payload);

  if (partial) {
    // In-progress snapshot: create/refresh an open set; must not already be
    // terminal (a finished set arrives as a non-partial summary).
    const open = openSet(state);
    const index = open?.index ?? state.sets.length;
    const target = setTarget(params, index);
    if (setWinner(home, away, target, params.winBy, params.cap) !== null) {
      invalid("a partial set summary must not be a completed set score", { home, away });
    }
    if (open === null) {
      return { ...state, sets: [...state.sets, { home, away, closed: false }] };
    }
    if (home < open.set.home || away < open.set.away) {
      invalid("a partial set summary may not decrease the score");
    }
    return replaceSet(state, index, { ...open.set, home, away });
  }

  // Completed-set summary: no rally set may be mid-flight (dual fidelity is
  // per-set, not per-point).
  const open = openSet(state);
  if (open !== null && (open.set.home > 0 || open.set.away > 0)) {
    invalid("this set is being scored rally-by-rally — a set summary is not allowed for it");
  }
  const index = open === null ? state.sets.length : open.index;
  const target = setTarget(params, index);
  const winner = setWinner(home, away, target, params.winBy, params.cap);
  if (winner === null || !reachableSetScore(home, away, target, params.winBy, params.cap)) {
    invalid("set summary is not a reachable final score under the set predicate", {
      home,
      away,
      target,
      winBy: params.winBy,
      cap: params.cap,
    });
  }
  const set: SetState = { home, away, closed: false };
  const withSet =
    open === null ? { ...state, sets: [...state.sets, set] } : replaceSet(state, index, set);
  return bankSet(withSet, index, winner);
}

// ---------------------------------------------------------------------------
// W4 (#407) — scoresheet interruptions. None of them touches the set ledger,
// so they are legal at any live moment and leave the score exactly as it was.
// ---------------------------------------------------------------------------

function applyTimeout(state: SetBasedState, payload: SetBasedTimeout): SetBasedState {
  if (state.phase !== "live") wrongPhase(`timeout not allowed in phase "${state.phase}"`);
  const side = sideOf(state, payload.by);
  const timeouts = state.timeouts ?? { home: 0, away: 0 };
  return { ...state, timeouts: { ...timeouts, [side]: timeouts[side] + 1 } };
}

function applySanction(state: SetBasedState, payload: SetBasedSanction): SetBasedState {
  if (state.phase !== "live") wrongPhase(`sanction not allowed in phase "${state.phase}"`);
  const record: SetBasedSanctionRec = {
    by: sideOf(state, payload.by),
    level: payload.level,
    ...(payload.person === undefined ? {} : { person: payload.person }),
  };
  return { ...state, sanctions: [...(state.sanctions ?? []), record] };
}

function applySub(state: SetBasedState, payload: SetBasedSub): SetBasedState {
  if (state.phase !== "live") wrongPhase(`substitution not allowed in phase "${state.phase}"`);
  const side = sideOf(state, payload.by);
  const subs = state.subs ?? { home: 0, away: 0, thisSet: { home: 0, away: 0 }, log: [] };
  const record: SetBasedSubRec = {
    by: side,
    ...(payload.in === undefined ? {} : { in: payload.in }),
    ...(payload.out === undefined ? {} : { out: payload.out }),
  };
  return {
    ...state,
    subs: {
      ...subs,
      [side]: subs[side] + 1,
      thisSet: { ...subs.thisSet, [side]: subs.thisSet[side] + 1 },
      log: [...subs.log, record],
    },
  };
}

// Forfeit — spec 04 §3 / volleyball.md §7: award the match to the opponent;
// completed sets already stand in the ledger.
function applyForfeit(state: SetBasedState, by: string): SetBasedState {
  if (state.phase === "done" || state.phase === "final" || state.phase === "abandoned") {
    wrongPhase("match already over");
  }
  const winnerSide = opponent(sideOf(state, by));
  return {
    ...state,
    phase: "done",
    outcome: { kind: "award", winner: state.entrants[winnerSide] },
  };
}

// Abandon — leave the fixture undecided and flagged for regeneration (mirrors
// football's replay policy; a gym closure is re-scheduled, not awarded).
function applyAbandon(state: SetBasedState): SetBasedState {
  if (state.phase === "done" || state.phase === "final" || state.phase === "abandoned") {
    wrongPhase("match already over");
  }
  return { ...state, phase: "abandoned", replayFlagged: true };
}

// ---------------------------------------------------------------------------
// Generator helper — a reachable completed-set score for the given target.
// ---------------------------------------------------------------------------

function generateSetScore(
  target: number,
  winBy: number,
  cap: number | null,
  rng: Rng,
): [hi: number, lo: number] {
  // ~25% deuce/cap endings, else a clean win to the target.
  if (rng() < 0.25) {
    const ceiling = cap ?? target + winBy + 4;
    // Winner lands on hi with the loser winBy behind, or exactly at the cap.
    let hi = target + 1 + Math.floor(rng() * Math.max(1, ceiling - target - 1));
    if (cap !== null && rng() < 0.4) hi = cap;
    hi = Math.min(hi, cap ?? hi);
    const lo = cap !== null && hi === cap ? hi - 1 : hi - winBy;
    if (reachableSetScore(hi, lo, target, winBy, cap)) return [hi, Math.max(0, lo)];
  }
  const lo = Math.floor(rng() * Math.max(1, target - winBy + 1));
  return [target, lo];
}

// ---------------------------------------------------------------------------
// Preset wiring — the parts that differ between the three sports
// ---------------------------------------------------------------------------

export interface SetBasedPreset {
  key: string; // 'volleyball' | 'badminton' | 'tabletennis'
  version: string;
  defaults: SetBasedParams; // shipped variant (also what coarsen segments under)
  variants: Record<string, Partial<SetBasedParams>>;
  positions: PositionCatalog;
  // Metric labels differ (Sets vs Games); keys stay set_ratio/point_ratio so the
  // shared comparator registry (PROMPT-08) resolves them uniformly.
  unitLabel: { one: string; many: string };
  defaultTiebreakers: TiebreakerKey[];
  officialLabel: { scorer: string };
  coarseEventType: "set.summary" | "game.summary";
  rallyEntitlement: string; // doc 10 FeatureKey for Tier-2/3 rally scoring
  entrantModel?: EntrantModel;
  // W4 (#407) — which interruptions THIS sport's scoresheet carries. A sport
  // that does not declare one refuses the event outright rather than silently
  // recording a fact its laws have no concept of (badminton has no timeouts
  // and no substitutions; only indoor volleyball substitutes).
  records?: { timeouts?: boolean; sanctions?: boolean; substitutions?: boolean };
  playerStats?: PlayerStatsModel; // Jul3/07 §3 — unlocked by person attribution
}

function makeMetrics(unit: { one: string; many: string }): MetricSpec[] {
  // doc 09 §2: the public table shows sets won/lost plus the cascade-derived
  // set/point ratios (engine competition/display.ts); raw point tallies are
  // ledger-only ratio operands.
  return [
    { key: "sets_won", label: `${unit.many} won`, direction: "desc" },
    { key: "sets_lost", label: `${unit.many} lost`, direction: "asc" },
    { key: "points_won", label: "Points won", direction: "desc", display: false },
    { key: "points_lost", label: "Points lost", direction: "asc", display: false },
  ];
}

// ---------------------------------------------------------------------------
// Module factory
// ---------------------------------------------------------------------------

export function makeSetBasedModule(
  preset: SetBasedPreset,
): SportModule<SetBasedCfg, SetBasedEv, SetBasedState> {
  const configSchema = makeConfigSchema(preset.defaults);
  const rallyType = `${preset.key}.rally`;
  const summaryType = `${preset.key}.${preset.coarseEventType}`;
  const timeoutType = `${preset.key}.timeout`;
  const sanctionType = `${preset.key}.sanction`;
  const subType = `${preset.key}.sub`;
  const records = preset.records ?? {};
  const coarsenParams = preset.defaults; // spec 04 §9.6 conformance runs at default cfg

  // W4 — the interruption types this sport actually records. `coarsen` treats
  // them as transparent, so they never split a rally set.
  const extensionTypes = [
    ...(records.timeouts === true ? [timeoutType] : []),
    ...(records.sanctions === true ? [sanctionType] : []),
    ...(records.substitutions === true ? [subType] : []),
  ];
  const isExtensionType = (type: string): boolean => extensionTypes.includes(type);

  // Tiers 0/1 stay a bare final score; the attributed timeline (who served, who
  // scored, cards, timeouts, subs) rides with rally scoring at tiers 2/3.
  const fidelityTiers: FidelityTier[] = [
    { tier: 0, eventTypes: [summaryType] },
    { tier: 1, eventTypes: [summaryType] },
    { tier: 2, eventTypes: [rallyType, ...extensionTypes], entitlement: preset.rallyEntitlement },
    { tier: 3, eventTypes: [rallyType, ...extensionTypes], entitlement: preset.rallyEntitlement },
  ];

  // Award/forfeit points = a clean-sweep win pair: "*" (or the first entry).
  const cleanSweepPair = (cfg: SetBasedCfg): PointsPair =>
    cfg.pointsMap["*"] ?? (Object.values(cfg.pointsMap)[0] as PointsPair | undefined) ?? [1, 0];

  // pointsMap lookup for a decided match: exact "W-L", else "*".
  const matchPoints = (cfg: SetBasedCfg, winnerSets: number, loserSets: number): PointsPair => {
    const exact = cfg.pointsMap[`${winnerSets}-${loserSets}`];
    if (exact !== undefined) return exact;
    const wildcard = cfg.pointsMap["*"];
    if (wildcard !== undefined) return wildcard;
    invalid(`no pointsMap entry for set score ${winnerSets}-${loserSets}`);
  };

  const sideMetrics = (state: SetBasedState, side: Side): Record<string, number> => ({
    sets_won: state.setsWon[side],
    sets_lost: state.setsWon[opponent(side)],
    points_won: totalPoints(state, side),
    points_lost: totalPoints(state, opponent(side)),
  });

  return {
    key: preset.key,
    version: preset.version,
    configSchema,
    eventSchema: SetBasedEv,
    positions: preset.positions,
    variants: preset.variants,
    ...(preset.entrantModel === undefined ? {} : { entrantModel: preset.entrantModel }),
    ...(preset.playerStats === undefined ? {} : { playerStats: preset.playerStats }),

    init(cfg, lineups: LineupPair): SetBasedState {
      return {
        cfg,
        entrants: { home: lineups.home.entrantId, away: lineups.away.entrantId },
        phase: "pre",
        sets: [],
        setsWon: { home: 0, away: 0 },
        outcome: null,
        replayFlagged: false,
      };
    },

    apply(state, ev: EventEnvelope<SetBasedEv | CoreEv>): SetBasedState {
      switch (ev.type) {
        case "core.start":
          if (state.phase !== "pre") wrongPhase("already started");
          return { ...state, phase: "live" };
        case rallyType:
          return applyRally(state, parsePayload(SetBasedRally, ev.payload, ev.type));
        case summaryType:
          return applySummary(state, parsePayload(SetBasedSummary, ev.payload, ev.type));
        case timeoutType:
          if (records.timeouts !== true) {
            invalid(`"${preset.key}" does not record timeouts`);
          }
          return applyTimeout(state, parsePayload(SetBasedTimeout, ev.payload, ev.type));
        case sanctionType:
          if (records.sanctions !== true) {
            invalid(`"${preset.key}" does not record sanctions`);
          }
          return applySanction(state, parsePayload(SetBasedSanction, ev.payload, ev.type));
        case subType:
          if (records.substitutions !== true) {
            invalid(`"${preset.key}" does not record substitutions`);
          }
          return applySub(state, parsePayload(SetBasedSub, ev.payload, ev.type));
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

    // §9.5 — defined at every prefix; reads only the folded set ledger so
    // coarse and fine folds render identically (§9.6). The headline carries the
    // per-set points, racquet-scoreline style ("2 — 0 · 21–15, 21–18"): a
    // just-entered set summary must be visible in the top score (v3/09 §1a —
    // "chosen score not reflected in top score").
    summary(state): ScoreSummary {
      const points = { home: totalPoints(state, "home"), away: totalPoints(state, "away") };
      const closedSets = state.sets.filter((set) => set.closed);
      const setLine =
        closedSets.length === 0
          ? ""
          : ` · ${closedSets.map((set) => `${set.home}–${set.away}`).join(", ")}`;
      // While a set is mid-flight, surface its live points next to the set
      // tally ("1 — 0 · 21–15 (14–11)") so rally scoring is visible too.
      const open = openSet(state);
      const inSet = open === null ? "" : ` (${open.set.home}–${open.set.away})`;
      return {
        headline: `${state.setsWon.home} — ${state.setsWon.away}${setLine}${inSet}`,
        perSide: [
          { entrantId: state.entrants.home, line: `${state.setsWon.home}` },
          { entrantId: state.entrants.away, line: `${state.setsWon.away}` },
        ],
        detail: {
          sets: state.sets.map((set) => ({ home: set.home, away: set.away, closed: set.closed })),
          points,
          ...(state.replayFlagged ? { abandoned: true } : {}),
          // W4 — interruption counters survive coarsening (they pass straight
          // through it), so exposing them here keeps §9.6 coarse ≡ fine. Per-
          // PERSON tallies deliberately do NOT appear: coarsening collapses
          // rallies into set summaries and discards attribution, so a summary
          // that carried `persons` could never satisfy §9.6. They live in
          // state (and in the playerStats fold over the ledger) instead.
          ...(state.timeouts === undefined ? {} : { timeouts: state.timeouts }),
          ...(state.sanctions === undefined ? {} : { sanctions: state.sanctions }),
          ...(state.subs === undefined
            ? {}
            : { subs: { home: state.subs.home, away: state.subs.away, thisSet: state.subs.thisSet } }),
        },
      };
    },

    standingsDelta(outcome, cfg, _ctx, state): [StandingsDelta, StandingsDelta] {
      const build = (side: Side, w: number, l: number, pts: number): StandingsDelta => ({
        entrantId: state.entrants[side],
        played: 1,
        won: w,
        drawn: 0,
        lost: l,
        points: pts,
        metrics: sideMetrics(state, side),
      });

      switch (outcome.kind) {
        case "win": {
          const winnerSide = sideOf(state, outcome.winner);
          const [wp, lp] = matchPoints(
            cfg,
            state.setsWon[winnerSide],
            state.setsWon[opponent(winnerSide)],
          );
          const winner = build(winnerSide, 1, 0, wp);
          const loser = build(opponent(winnerSide), 0, 1, lp);
          return winnerSide === "home" ? [winner, loser] : [loser, winner];
        }
        case "award": {
          // Forfeit: clean-sweep pair to keep the total inside declaredPointsSets.
          const winnerSide = sideOf(state, outcome.winner);
          const [wp, lp] = cleanSweepPair(cfg);
          const winner = build(winnerSide, 1, 0, wp);
          const loser = build(opponent(winnerSide), 0, 1, lp);
          return winnerSide === "home" ? [winner, loser] : [loser, winner];
        }
        // Set-based sports always produce a winner (§3.3 supportsDraws = false);
        // abandon leaves the outcome null, so no draw/tie/no_result reaches here.
        default:
          invalid(`set-based module cannot rank outcome "${outcome.kind}"`);
      }
    },

    metrics: makeMetrics(preset.unitLabel),
    defaultTiebreakers: preset.defaultTiebreakers,

    supportsDraws(_cfg, _stage: StageKind) {
      return false;
    },

    // §9.3 — every decided fixture pays a pointsMap value-sum (award reuses the
    // clean-sweep pair, whose sum is already present).
    declaredPointsSets(cfg) {
      return [...new Set(Object.values(cfg.pointsMap).map(([w, l]) => w + l))];
    },

    fidelityTiers,
    officialLabel: preset.officialLabel,

    // spec 03 §6 — deterministic generator. Summary-dominant so best-of-N
    // matches decide within the conformance event budget; rally bursts exercise
    // the point-by-point path and coarsen (§9.6).
    arbitraryEvent(state, rng: Rng): ModuleEvent<SetBasedEv> | null {
      if (state.phase === "pre") return { type: "core.start", payload: {} };
      if (state.phase !== "live") return null;

      const randomEntrant = () => (rng() < 0.5 ? state.entrants.home : state.entrants.away);
      // W4 — the testkit's lineups are `${entrantId}-p{n}` (helpers.ts), so the
      // generator can name people the way a real pad would.
      const randomPerson = (entrantId: string) => `${entrantId}-p${1 + Math.floor(rng() * 3)}`;
      // Occasional interruptions, so conformance actually walks the new
      // branches (and §9.6 proves coarsen stays transparent to them).
      if (extensionTypes.length > 0 && rng() < 0.05) {
        const by = randomEntrant();
        const type = extensionTypes[Math.floor(rng() * extensionTypes.length)] as string;
        if (type === timeoutType) return { type, payload: { by, technical: rng() < 0.3 } };
        if (type === sanctionType) {
          const levels = SetBasedSanctionLevel.options;
          const level = levels[Math.floor(rng() * levels.length)] as (typeof levels)[number];
          return { type, payload: { by, level, person: randomPerson(by) } };
        }
        return { type, payload: { by, in: randomPerson(by), out: randomPerson(by) } };
      }
      // Half of all rallies carry attribution — the other half keep the coarse
      // (entrant-only) shape legal and exercised.
      const rallyPayload = (): SetBasedRally => {
        const wonBy = randomEntrant();
        if (rng() < 0.5) return { wonBy };
        return { wonBy, server: randomPerson(randomEntrant()), scorer: randomPerson(wonBy) };
      };
      const open = openSet(state);
      if (open !== null) {
        // A rally set is mid-flight — keep rallying it to a finish.
        return { type: rallyType, payload: rallyPayload() };
      }
      const roll = rng();
      if (roll < 0.02) {
        return { type: "core.forfeit", payload: { by: randomEntrant(), reason: "walkover" } };
      }
      if (roll < 0.04) return { type: "core.abandon", payload: { reason: "venue closed" } };
      if (roll < 0.14) return { type: rallyType, payload: rallyPayload() };
      const target = setTarget(state.cfg, state.sets.length);
      const [hi, lo] = generateSetScore(target, state.cfg.winBy, state.cfg.cap, rng);
      const homeWins = rng() < 0.5;
      return {
        type: summaryType,
        payload: { home: homeWins ? hi : lo, away: homeWins ? lo : hi },
      };
    },

    // §9.6 — collapse a rally stream into per-set summaries. Completed sets emit
    // a non-partial entrant-keyed summary; a trailing open set emits a `partial`
    // snapshot. Segmentation is position-independent: it tracks the two entrant
    // ids in local slots and asks setWinner which slot won, so no lineup context
    // is needed. core/positional-summary events flush the open set, then pass
    // through. Uses the preset default params (coarsenParams; §9.6 runs at the
    // default cfg — the shipped variant).
    coarsen(events): ModuleEvent<SetBasedEv>[] {
      const out: ModuleEvent<SetBasedEv>[] = [];
      let setsPlayed = 0;
      // Local slot A = first id seen this set, B = the other.
      let idA: string | null = null;
      let idB: string | null = null;
      let a = 0;
      let b = 0;

      const resetSet = () => {
        idA = null;
        idB = null;
        a = 0;
        b = 0;
      };
      const flushPartial = () => {
        if (a === 0 && b === 0) return;
        // Slot A always fills first, so idA is set whenever any point exists.
        out.push({
          type: summaryType,
          payload: { by: idA as string, forBy: a, forOpp: b, partial: true },
        });
        resetSet();
      };

      for (const event of events) {
        if (event.type === rallyType) {
          const { wonBy } = event.payload as SetBasedRally;
          if (idA === null || wonBy === idA) {
            idA = wonBy;
            a += 1;
          } else {
            idB = wonBy;
            b += 1;
          }
          const target = setTarget(coarsenParams, setsPlayed);
          const winner = setWinner(a, b, target, coarsenParams.winBy, coarsenParams.cap);
          if (winner !== null) {
            const winnerId = (winner === "home" ? idA : idB) as string;
            out.push({
              type: summaryType,
              payload: {
                by: winnerId,
                forBy: winner === "home" ? a : b,
                forOpp: winner === "home" ? b : a,
              },
            });
            setsPlayed += 1;
            resetSet();
          }
          continue;
        }
        // W4 — an interruption (timeout / sanction / substitution) is
        // TRANSPARENT: it neither scores nor ends a set, so flushing the open
        // set here would split one rally set into two coarse summaries and
        // break §9.6. Pass it through and keep counting the set.
        if (isExtensionType(event.type)) {
          out.push({ type: event.type, payload: event.payload });
          continue;
        }
        // Non-rally: flush the open set, then pass through. A completed
        // (non-partial) summary already occupies a set slot, so advance the set
        // index — otherwise a later rally set (e.g. the decider) would segment
        // under the wrong target (spec 04 §3.3).
        flushPartial();
        out.push({ type: event.type, payload: event.payload });
        if (event.type === summaryType && (event.payload as { partial?: boolean }).partial !== true) {
          setsPlayed += 1;
        }
      }
      flushPartial();
      return out;
    },
  };
}
