// Set-based scoring kernel — spec 04 §3–5 + engine/sports/{volleyball,badminton,
// table-tennis}.md (PROMPT-06). ONE parametric engine parameterised by
// {bestOf, setTo, finalSetTo, winBy, cap, pointsMap}; volleyball, badminton and
// table tennis are three thin presets — this file owns every line of set logic,
// the presets add only catalog/metrics/labels. Dual fidelity (spec 04 §9.6):
// fine `rally {wonBy}` and coarse `*.summary` fold to identical set totals and
// outcomes, and all result math reads only the folded set ledger.
import { z } from "zod";
import { EngineError } from "../../core/errors.ts";
import { isStrictFold, resolveVoids, type CoreEv, type EventEnvelope } from "../../core/events.ts";
import type { Rng } from "../../core/rng.ts";
import {
  EntrantId,
  type DisciplineCard,
  type DisciplineModel,
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
  // W4a (#425) §5.3 — the ITTF expedite system (Law 2.15.2). READ THE UNIT:
  // this is the count of the RECEIVER'S good returns, NOT the rally's stroke
  // count and NOT the number of shots the server played. The receiver takes
  // the point on their thirteenth, so the two readings differ by exactly the
  // amount that decides a rally. Only meaningful once expedite is in force;
  // recorded (and inert) before that.
  returns: z.number().int().nonnegative().optional(),
  // The SIDE that served this rally — an `EntrantId`, like `wonBy`.
  //
  // THIS IS NOT `server`. `server` directly above is a `PersonId`: the player
  // who served. They are adjacent, similarly named, differently typed, and in
  // doubles they routinely disagree (a person on the receiving pair can be
  // named in `server` by a pad recording the previous rally's server, and the
  // side that served is still the other one). `DisciplineCard.entrantSide`
  // shipped that exact confusion once already, so expedite enforcement reads
  // `serving` and never `server`. `expedite.test.ts` pins it with a rally whose
  // `server` is a string that is ALSO a legal `EntrantId` and names the OTHER
  // side — in both the accept and the reject direction. That is the only shape
  // that kills the bug: with a person-shaped `server` a wrong-field kernel dies
  // inside `sideOf` on an unknown entrant, which is a type-domain refusal and
  // not the wrong-side verdict the pin exists to catch.
  //
  // WHY IT IS ON THE PAYLOAD AT ALL: the set-based kernel holds no serving
  // state — `server` feeds a `serves` tally and nothing else — so the engine
  // cannot name the receiver from what it stores. Deriving the ITTF rotation
  // would break on doubles order and lineup changes (spec §5.3). The pad
  // already knows who is serving, because it is drawing the service
  // indicator, so it sends it. Optional: where it is absent the 13-return
  // rule is UNENFORCEABLE and the rally stands (see `applyRally`).
  serving: EntrantId.optional(),
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
  // W4 review — the offence as the official called it. The whole rationale for
  // `DisciplineCard.reason` (core/types.ts) is an accumulation rule keyed on
  // the offence rather than the ladder step — "three for dissent" — and this
  // branch could not express one, though the FIVB/BWF/ITTF sheets all leave a
  // free-text sanction note. Optional: coarse scoring records a step and
  // nothing else, and the fold never reads it (discipline does).
  reason: z.string().min(1).optional(),
});
export type SetBasedSanction = z.infer<typeof SetBasedSanction>;

// W4 review item 5 — `off`/`on`, the names `football.sub` has carried since
// before this wave. The incumbent wins; `in`/`out` also read badly across the
// engine, where cricket's `out` already names a DISMISSAL.
export const SetBasedSub = z.strictObject({
  by: EntrantId,
  off: PersonId.optional(),
  on: PersonId.optional(),
});
export type SetBasedSub = z.infer<typeof SetBasedSub>;

// W4a (#425) §5.3 — expedite is introduced, per ITTF Law 2.15.1, when a game
// reaches ten minutes unfinished (or earlier if both players agree), unless
// both have already scored nine. The TEN-MINUTE TRIGGER IS THE PAD'S: the
// engine owns no clock, and this event is the record that the umpire called it.
//
// EMPTY BY DESIGN, and the emptiness is the rule. Law 2.15.4 runs expedite to
// the end of the MATCH, not the end of the game, so there is no game number to
// carry — and because there is none, a second `expedite.start` is simply an
// invalid event rather than a re-scoping (`applyExpedite`). Scoping this per
// game would have been the wrong model, quietly.
export const SetBasedExpediteStart = z.strictObject({});
export type SetBasedExpediteStart = z.infer<typeof SetBasedExpediteStart>;

// Branch order matters: z.union takes the FIRST branch that parses, so the new
// branches are APPENDED and every pre-existing payload still lands on the
// branch it always did (rally needs `wonBy`, the summaries need home/away or
// forBy+forOpp — none of which the new strict branches accept).
// A bare `{by}` is accepted by both the timeout and the substitution branch;
// that overlap is inert because `apply` dispatches on the ENVELOPE type and
// parses with the one branch that type names.
// `SetBasedExpediteStart` is LAST and matches only `{}` — every other branch
// requires at least one key, so it can steal nothing from a sibling; placed
// first it would still steal nothing, but the rule is the rule (§8).
export const SetBasedEv = z.union([
  SetBasedRally,
  SetBasedSummary,
  SetBasedTimeout,
  SetBasedSanction,
  SetBasedSub,
  SetBasedExpediteStart,
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
  off?: string;
  on?: string;
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
  // ---- W4a (#425) §5.3 — expedite. MATCH-scoped (ITTF 2.15.4): `bankSet`
  // deliberately does NOT clear this, unlike `subs.thisSet`.
  expedite?: boolean;
  /** Rallies the 13-return rule could not be checked against, because they
   *  carried `returns` but no `serving` (spec §5.3). Recorded rather than
   *  hidden: a count of zero and a count of forty mean very different things
   *  about how much of an expedited match the engine actually validated.
   *  Deliberately NOT surfaced in `summary` — coarsening discards `returns`
   *  entirely, so a coarse fold could never reproduce it and §9.6 would break
   *  (the same reason `persons` stays out of the summary). `arbitraryEvent`
   *  generates the unenforceable rally precisely so that exclusion is a claim
   *  §9.6 ENFORCES: put this key in `summary().detail` and the conformance run
   *  goes red.
   *
   *  NOT write-only, and `summary().detail` is not the only surface. The whole
   *  folded state is persisted verbatim (`match_states.state`) and served raw
   *  by `GET /api/v1/fixtures/:id/state`, which is what the scoring pad page
   *  already reads — so a pad can read this counter today without any new
   *  export. Staying out of `summary` costs it nothing. */
  expediteUnchecked?: number;
}

/** ITTF Law 2.15.2 — the receiver wins the point on their thirteenth good
 *  return. Not configurable: it is the law, not a competition setting. */
const EXPEDITE_RETURNS = 13;

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

// W4a (#425) §5.3 — ITTF Law 2.15.2 under expedite: thirteen good returns by
// the RECEIVER and the point is theirs, so a 13-return rally credited to the
// SERVING side contradicts the rule and is refused.
//
// Enforcement is CONDITIONAL on the rally naming `serving`, and that is a
// stated limitation, not an oversight. The kernel holds no serving state, so
// with `serving` absent there is no receiver to compare `wonBy` against.
// Rejecting those rallies would make coarse-tier expedited scoring — a pad
// that records `returns` off the umpire's sheet but not the service indicator
// — impossible to record at all. So the rally stands and the fold COUNTS it
// (`expediteUnchecked`) rather than pretending it was validated.
function checkExpedite(
  state: SetBasedState,
  payload: SetBasedRally,
  winner: Side,
): number | undefined {
  if (state.expedite !== true) return state.expediteUnchecked;
  if (payload.returns === undefined || payload.returns < EXPEDITE_RETURNS) {
    return state.expediteUnchecked;
  }
  if (payload.serving === undefined) return (state.expediteUnchecked ?? 0) + 1;
  // `serving`, never `server`: one is the side, the other is a person, and in
  // doubles they disagree.
  if (sideOf(state, payload.serving) === winner) {
    throw new EngineError(
      "EXPEDITE_WRONG_WINNER",
      `under expedite the receiver wins the point on their ${EXPEDITE_RETURNS}th good return — ` +
        `this rally records ${payload.returns} returns but credits the serving side`,
      { wonBy: payload.wonBy, serving: payload.serving, returns: payload.returns },
    );
  }
  return state.expediteUnchecked;
}

function applyRally(
  state: SetBasedState,
  payload: SetBasedRally,
  preset: { key: string; recordsExpedite: boolean },
): SetBasedState {
  if (state.phase !== "live") wrongPhase(`rally not allowed in phase "${state.phase}"`);
  // W4a review — `returns` rides on the SHARED rally payload, so without this
  // gate volleyball and badminton accept an ITTF-only field their laws have no
  // concept of and then discard it. `records` exists to refuse exactly that
  // (see `SetBasedPreset.records`), and the expedite EVENT is already gated;
  // the field has to be too or the preset principle only half holds.
  // `serving` is deliberately NOT gated: which side served is a fact every
  // set-based scoresheet carries — only the return count is table tennis's.
  if (payload.returns !== undefined && !preset.recordsExpedite) {
    invalid(`"${preset.key}" has no expedite system, so a rally cannot carry \`returns\``);
  }
  const side = sideOf(state, payload.wonBy);
  // Validate the serving side even where the rule does not bite, so a typo'd
  // entrant id is caught on the rally that carries it rather than on whichever
  // later rally happens to reach thirteen returns.
  if (payload.serving !== undefined) sideOf(state, payload.serving);
  const expediteUnchecked = checkExpedite(state, payload, side);

  const persons = creditPersons(state.persons, [
    [payload.scorer, "points"],
    [payload.server, "serves"],
  ]);
  let next =
    persons === state.persons && expediteUnchecked === state.expediteUnchecked
      ? state
      : {
          ...state,
          ...(persons === undefined ? {} : { persons }),
          ...(expediteUnchecked === undefined ? {} : { expediteUnchecked }),
        };
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

function applySummary(
  state: SetBasedState,
  payload: SetBasedSummary,
  strict: boolean,
): SetBasedState {
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
  // STRICT ONLY (§3.3 seam). "Is a set in flight?" is a PROJECTION of cfg: lower
  // `setTo` and rallies that used to close a set no longer do, so a set the
  // ledger scored rally-by-rally and then summarised reads as still open on
  // replay and every summary in the division is refused. The dual-fidelity rule
  // it enforces — do not mix point-by-point and summary scoring for one set —
  // is about what a scorer may ENTER, and stays exactly as strict there.
  if (strict && open !== null && (open.set.home > 0 || open.set.away > 0)) {
    invalid("this set is being scored rally-by-rally — a set summary is not allowed for it");
  }
  const index = open === null ? state.sets.length : open.index;
  const target = setTarget(params, index);
  const winner = setWinner(home, away, target, params.winBy, params.cap);
  // STRICT ONLY (§3.3 seam). The set predicate is built from `setTo`,
  // `finalSetTo`, `winBy` and `cap` — all cfg — so lowering any of them makes
  // every set summary already in the ledger "unreachable" and every fixture in
  // the division unreadable, with no event to void. 21–19 was a real set when
  // it was played; it is not the ledger's fault the competition later moved to
  // 15. On replay the summary is banked as recorded: `winner` is null only when
  // neither side meets the target, and the higher score then takes the set,
  // which is the reading a scoresheet has always had.
  if (strict && (winner === null || !reachableSetScore(home, away, target, params.winBy, params.cap))) {
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
  // `winner` is non-null on every strict path (the guard above proves it) and
  // may be null only on replay, where the higher score takes the set.
  return bankSet(withSet, index, winner ?? (home >= away ? "home" : "away"));
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
    ...(payload.off === undefined ? {} : { off: payload.off }),
    ...(payload.on === undefined ? {} : { on: payload.on }),
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

// W4a (#425) §5.3 — the umpire introduced expedite (ITTF 2.15.1). It touches
// no score; it changes how every subsequent rally is judged, for the rest of
// the MATCH (2.15.4). `bankSet` closing a game leaves `expedite` alone, which
// is the whole point of holding it here rather than on the open set.
function applyExpedite(state: SetBasedState): SetBasedState {
  if (state.phase !== "live") wrongPhase(`expedite not allowed in phase "${state.phase}"`);
  if (state.expedite === true) {
    invalid(
      "expedite is already in force — ITTF 2.15.4 runs it to the end of the match, so there is " +
        "nothing a second introduction could scope",
    );
  }
  return { ...state, expedite: true };
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
  // W4a (#425) §5.3 — `expedite` is table tennis's alone (ITTF Law 2.15);
  // volleyball and badminton have no such rule, so the kernel refuses
  // `<key>.expedite.start` for them exactly as it refuses `badminton.timeout`
  // — and, because `returns` rides on the SHARED rally payload rather than a
  // sport-specific one, `applyRally` refuses that field for them too.
  records?: {
    timeouts?: boolean;
    sanctions?: boolean;
    substitutions?: boolean;
    expedite?: boolean;
  };
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
  // Dotted like the period kernel's `<key>.suspension.start` — the `.start`
  // suffix is load-bearing shorthand for "there is no `.end`": expedite runs to
  // the end of the match (ITTF 2.15.4) and nothing ever stops it.
  const expediteType = `${preset.key}.expedite.start`;
  const records = preset.records ?? {};
  const coarsenParams = preset.defaults; // spec 04 §9.6 conformance runs at default cfg

  // W4 — the interruption types this sport actually records. `coarsen` treats
  // them as transparent, so they never split a rally set.
  const extensionTypes = [
    ...(records.timeouts === true ? [timeoutType] : []),
    ...(records.sanctions === true ? [sanctionType] : []),
    ...(records.substitutions === true ? [subType] : []),
    ...(records.expedite === true ? [expediteType] : []),
  ];
  const isExtensionType = (type: string): boolean => extensionTypes.includes(type);

  // W4 review item 7 — the sanction row reaches the shared discipline
  // projection. Volleyball, badminton and table tennis each folded a LOCAL
  // sanction record in this wave and none of the three shipped a
  // `discipline` descriptor, so a card that suspends a player in football was
  // invisible to the same usecase here.
  //
  // The LADDER stays the sport's own — FIVB's four steps are not the ITF's and
  // not football's colours; the dossiers record how each code's cards map onto
  // it. What has to be uniform is the PROJECTION, so W5 renders one control.
  const discipline: DisciplineModel | undefined =
    records.sanctions === true
      ? {
          colors: SetBasedSanctionLevel.options.map((key) => ({
            key,
            label: key.replace(/_/g, " ").replace(/^./, (ch) => ch.toUpperCase()),
          })),
          extractCards(ledger): DisciplineCard[] {
            const cards: DisciplineCard[] = [];
            for (const ev of resolveVoids(ledger)) {
              if (ev.type !== sanctionType) continue;
              const parsed = SetBasedSanction.safeParse(ev.payload);
              if (!parsed.success) continue;
              const sanction = parsed.data;
              cards.push({
                ...(sanction.person === undefined ? {} : { personId: sanction.person }),
                entrantSide: sanction.by,
                // The ladder step IS the colour axis, exactly as the period
                // kernel projects its suspension CLASS keys.
                color: sanction.level,
                eventId: ev.id,
                // W4 review — the offence, when the official recorded one, the
                // way football and the period kernel already pass it. Absent
                // stays absent: an accumulation rule must be able to tell "no
                // offence recorded" from an offence named.
                ...(sanction.reason === undefined ? {} : { reason: sanction.reason }),
              });
            }
            return cards;
          },
        }
      : undefined;

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
    ...(discipline === undefined ? {} : { discipline }),

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

    apply(state, ev: EventEnvelope<SetBasedEv | CoreEv>, ctx): SetBasedState {
      const strict = isStrictFold(ctx);
      switch (ev.type) {
        case "core.start":
          if (state.phase !== "pre") wrongPhase("already started");
          return { ...state, phase: "live" };
        case rallyType:
          return applyRally(state, parsePayload(SetBasedRally, ev.payload, ev.type), {
            key: preset.key,
            recordsExpedite: records.expedite === true,
          });
        case summaryType:
          return applySummary(state, parsePayload(SetBasedSummary, ev.payload, ev.type), strict);
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
        case expediteType:
          if (records.expedite !== true) {
            invalid(`"${preset.key}" has no expedite system`);
          }
          // Parsed for its own sake: the payload is empty and the strict schema
          // is what refuses a `game` key, i.e. the per-game scoping mistake.
          parsePayload(SetBasedExpediteStart, ev.payload, ev.type);
          return applyExpedite(state);
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
          // W4a §5.3 — expedite survives coarsening (it is an extension type,
          // passed straight through), so it can appear here without breaking
          // §9.6. `expediteUnchecked` cannot and deliberately does not.
          ...(state.expedite === undefined ? {} : { expedite: state.expedite }),
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
        // Expedite is introduced ONCE per match (ITTF 2.15.4), so drop it from
        // the pool the moment it is in force — a second one is a rejected
        // event and the generator must only emit legal streams.
        const choices =
          state.expedite === true
            ? extensionTypes.filter((type) => type !== expediteType)
            : extensionTypes;
        const type = choices[Math.floor(rng() * choices.length)];
        if (type === expediteType) return { type, payload: {} };
        if (type === timeoutType) return { type, payload: { by, technical: rng() < 0.3 } };
        if (type === sanctionType) {
          const levels = SetBasedSanctionLevel.options;
          const level = levels[Math.floor(rng() * levels.length)] as (typeof levels)[number];
          return { type, payload: { by, level, person: randomPerson(by) } };
        }
        if (type === subType) {
          return { type, payload: { by, off: randomPerson(by), on: randomPerson(by) } };
        }
        // `choices` was emptied (expedite was this sport's only extension) —
        // fall through and rally instead.
      }
      // Half of all rallies carry attribution — the other half keep the coarse
      // (entrant-only) shape legal and exercised.
      const rallyPayload = (): SetBasedRally => {
        const wonBy = randomEntrant();
        const base: SetBasedRally =
          rng() < 0.5
            ? { wonBy }
            : { wonBy, server: randomPerson(randomEntrant()), scorer: randomPerson(wonBy) };
        // Under expedite, exercise the 13-return path — and only ever LEGALLY:
        // the receiver takes the point on the thirteenth, so the serving side
        // is by construction the side that did not win it (Law 2.15.2).
        if (state.expedite !== true || rng() < 0.5) return base;
        // W4a review — half of those omit `serving`, which is the UNENFORCEABLE
        // path (§5.3): the rally stands and the fold counts it in
        // `state.expediteUnchecked`. Generating it is what makes the summary
        // exclusion of that counter an ENFORCED claim rather than an asserted
        // one — coarsening discards `returns`, so the coarse fold cannot
        // reproduce the count, and §9.6 (which deep-compares `summary()`) goes
        // red the moment `expediteUnchecked` is exposed there. Without these
        // streams the counter is always `undefined` on both sides and the
        // exclusion reds nothing.
        if (rng() < 0.5) return { ...base, returns: EXPEDITE_RETURNS };
        const serving =
          wonBy === state.entrants.home ? state.entrants.away : state.entrants.home;
        return { ...base, serving, returns: EXPEDITE_RETURNS };
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
