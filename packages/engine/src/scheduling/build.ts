// The build solver's control loop.
//
// Greedy seeds the incumbent, so the answer is never worse than today's — that
// property is what lets this ship with NO escape hatch back to greedy (design
// D6). Tiers then improve the incumbent in a fixed lexicographic order, each by
// a bound walk under push/pop: assert the objective is strictly better than the
// incumbent, solve, and on SAT take the new board. The last satisfiable bound
// IS the optimum, by construction rather than by an objective function nobody
// can audit — the same reason `repair.ts` walks k upward instead of minimising
// a weighted sum.
//
// The budget is z3's `rlimit`, a DETERMINISTIC resource counter, not the wall
// clock (design D9). An anytime search cut off by wall clock returns a
// different board on a faster machine, which is both a support ticket and a
// permanently flaky test. The wall clock survives only as an outer cap that
// should never fire.
//
// --- the seed is LEGALISED before it is measured ---------------------------
//
// `slotFixtures` does not read `config.window`: its only bound is
// `horizonMinutes`, a 365-day default (`calendar.ts:390`). `repairUniverse`,
// which bounds the lattice this solver searches, DOES read it. So on any
// competition that overruns its own window greedy places every card — outside
// the window, reporting nothing — while z3 can only place the ones that fit
// inside it. D3 ranks `placed` first, so that illegal board outranks every
// legal one and would stay the incumbent forever, making the whole feature
// inert on exactly the boards it exists to fix.
//
// The fix is to make `placed` mean LEGALLY placed: every seed row carrying a
// BLOCKING conflict is dropped before the seed is measured. Those cards were
// already conflicts — counting them as placed was the bug — and the drop is
// provably sound, because every blocking reason is either per-row (`window`)
// or names both sides of a pair (`court`, `person_overlap`) or names the
// dependent (`order`), so removing every named row cannot leave one behind and
// cannot create a new one. The floor therefore becomes a board free of the
// blocking conflicts it can be held RESPONSIBLE for, and "never worse than
// greedy" becomes a stronger claim rather than a weaker one.
//
// Two honest limits on that claim, both harmless and both worth stating rather
// than leaving for the next reader to rediscover:
//
//   * it is not "provably legal". `validateAssignments` builds its index over
//     `[...existing, ...assignments]` (`calendar.ts:1268`), so a direct `order`
//     dependency between two IMMOVABLE rows emits a blocking conflict whose
//     `fixtureId` is not in the seed at all — the `seedIds` guard below skips
//     it, and it survives into the answer. Nothing the solver can do would
//     change it, which is exactly why the gate is a delta and is scoped to
//     `ours`; both neutralise it independently.
//   * the drop is CONSERVATIVE. `court` and `person_overlap` name both sides of
//     a pair, so a clashing pair loses both rows where keeping either one alone
//     would have been legal. Sound, never optimistic, and the solver is free to
//     re-place both — it just starts from a lower floor than it strictly had
//     to.
//
// --- the lattice is the CONFIGURED courts (R3) ------------------------------
//
// `repairCourts` folds in every court an `existing` row uses, which is right
// for a REPAIR — a card already sitting on court 5 may stay there — and wrong
// for a BUILD, which would then place brand-new fixtures on a court the
// organiser never listed. The verifier does not test court membership, so this
// was never a parity defect; it was a product question, and the ruling is that
// a BUILD places only on `config.courts`.
//
// Immovable rows on other courts remain OBSTACLES in full: their court time is
// still removed from the lattice by `buildGrid` and their participants still
// constrain through `encodeBuild` §7. Only new PLACEMENT is restricted. The one
// exemption is a PINNED slot: a card the caller locked onto an unlisted court
// must still be representable, or a board that merely looks odd becomes an
// infeasible one.
//
// --- three verdicts, and why the third is the point -------------------------
//
// A `check()` here has THREE outcomes and they are not two:
//
//   sat      a board exists at this bound, and it is in hand;
//   unsat    a PROOF that no board reaches this bound;
//   unknown  no proof either way inside the budget.
//
// `unknown` is T0's EXPECTED terminal state near the optimum — finding a good
// board is fast, proving a tight ceiling is not — and it is not an error and
// not an infeasibility. Collapsing it onto `infeasible` would report an
// impossibility nobody established, which is precisely the defect this tier
// exists to remove: greedy's `no_slot` is a GUESS, and replacing one guess with
// a differently-dressed guess buys nothing. When the answer is `unknown` the
// incumbent simply stands and `budgetExpired` says why. Both sites that can
// see an `unknown` — the feasibility probe and the T0 walk — are pinned by
// their own test.
import type { Arith, Bool, Solver } from "z3-solver";
import { boardMetrics, isStrictlyBetter, type BoardMetrics } from "./build-objectives.ts";
import { improveByWindows, type LnsWindow } from "./build-lns.ts";
import { buildGrid, type BuildGrid, type BuildSlot } from "./build-grid.ts";
import { encodeBuild, type BuildConfig, type EncodedModel } from "./build-encode.ts";
import {
  deltaConflicts,
  isBlockingConflict,
  slotFixtures,
  validateAssignments,
  RULE_BY_REASON,
  type Assignment,
  type Conflict,
  type OrderDependency,
  type SchedulableFixture,
  type SlotConfig,
  type VerifyConfig,
} from "./calendar.ts";
import { repairUniverse } from "./repair-domain.ts";
import { loadZ3, withZ3LockAndReset, type Z3Context } from "./z3-load.ts";

const MS_PER_MIN = 60_000;

/**
 * A RUN total, not a per-check allowance; see `RunBudget`.
 *
 * MEASURED by `scripts/bench-build.ts` (Task 13), replacing the placeholder.
 * The rule is the one `DEFAULT_REPAIR_BUDGET_MS` used: twice the worst `rlimit`
 * any board consumed that completed ALL FOUR TIERS, across both measured
 * densities, rounded up. The worst such board spent **14_562_487** (10 fixtures,
 * 2 matches per entrant, 8.1 s), so 2x is 29_124_974 and this is 30_000_000.
 * Every four-tier completion measured, for the record: 52_497 / 72_269 /
 * 765_734 / 850_484 / 864_501 / 1_822_166 / 7_693_966 / 8_281_447 / 14_562_487.
 *
 * --- READ THIS BEFORE TUNING IT -------------------------------------------
 *
 * **AT THE PRODUCTION WALL THIS CONSTANT GOVERNS NOTHING, and the change from
 * 40M to 30M is behaviourally inert.** The bench measured this box at roughly
 * 0.9-1.9M rlimit units per second of solving, so `AUTO_SOLVER_WALL_MS` (8_000)
 * can buy at most ~15M units — half of this budget and a third of the old one.
 * Every run in the 14-row sweep stopped on the WALL, never on the budget, at
 * every size from 10 fixtures to 200. D9 says the budget is the rlimit and not
 * the clock; in practice it is the clock, which is why the same board can come
 * back differently on a different machine.
 *
 * The mechanism, from Q9 of the same bench: at 200 fixtures an ABORTED check
 * spends **1** rlimit unit while costing 322 ms of wall, because z3 tests the
 * resource limit during preprocessing and bails before its counter moves. An
 * rlimit budget therefore cannot bound elapsed time on a large model at all —
 * D9's premise holds for small models and breaks for big ones.
 *
 * Making D9 true again means setting this BELOW what the wall can buy on the
 * slowest supported machine — around **6_000_000** on the measurements here —
 * so the deterministic cap fires first and the answer stops depending on
 * machine speed. That trades search for reproducibility and is an owner ruling,
 * not a tuning decision, so it is written up in the Task 13 report rather than
 * applied here.
 */
export const DEFAULT_BUILD_RLIMIT = 30_000_000;
/**
 * How much of a run's budget the monolithic solve may draw before the window
 * fallback gets a look (ruling R11).
 *
 * Without a reserve the two are not really sharing a budget: the tiers exhaust
 * it exactly when they fail to converge, which is precisely the state LNS
 * exists to rescue, so the fallback would be dead on arrival on every board it
 * is for. The FRACTION is a placeholder for Task 13's bench, like
 * `DEFAULT_BUILD_RLIMIT`; that some reserve must exist is not.
 *
 * THE RESERVE IS ONLY MEANINGFUL WHEN THE BUDGET IS LARGE relative to a single
 * check's overshoot (see `RunBudget` — ~28_500 units on the four-fixture model
 * in `build-budget.test.ts`). Below that a single check can blow through both
 * the share and the run total at once and no window ever opens, which is the
 * honest answer: a budget that cannot pay for one check cannot pay for two
 * solvers' worth of them either. At `DEFAULT_BUILD_RLIMIT` the reserve is
 * ~10_000_000 against an overshoot of tens of thousands, so it binds as
 * intended.
 */
export const BUILD_MAIN_RLIMIT_SHARE = 0.75;
/** The outer safety cap. Not the stopping rule; see the header. */
export const DEFAULT_BUILD_WALL_MS = 30_000;
/** T0 plus the three lexicographic tiers. `tiersCompleted` reaching this is
 *  what "the board is lexicographically optimal" means.
 *
 *  EXPORTED for the web layer (ruling R17), which was carrying its own
 *  `TIERS_TOTAL = 4`. Two copies of a number that means "the solver proved
 *  every tier" drift the moment a tier is added, and the copy that drifts is
 *  the one deciding what an organiser is told. */
export const TIER_COUNT = 4;

/**
 * The R18 size gate, in fixture-slots (`fixtures.length x grid.slots.length`).
 *
 * MEASURED by `scripts/bench-build.ts` (Task 13), the R18 knee sweep:
 *
 *   node --experimental-strip-types packages/engine/scripts/bench-build.ts \
 *     --sizes=10,20,40,60,80,120,200 --per-entrant=2,4 --wall=8000 --not-after=2
 *   node --experimental-strip-types packages/engine/scripts/bench-build.ts \
 *     --sizes=140,160,180 --per-entrant=2 --wall=8000 --not-after=2
 *
 * At the 8_000 ms production wall the solver improved the board at every size
 * up to 140 fixtures on a 144-slot lattice (20_160 fixture-slots) and improved
 * NOTHING at 160 on a 216-slot lattice (34_560) or above — `tiersCompleted: 0`,
 * `engine: "greedy"`, and 11-15 s spent to hand back the board it started with.
 * 20_000 is the improving side of that boundary, rounded.
 *
 * --- WHY FIXTURE-SLOTS AND NOT A FIXTURE COUNT ----------------------------
 *
 * The knee is not a property of the fixture count. It is where boot + greedy +
 * `encodeBuild` + the first `solver.push()` crosses the wall, and all of those
 * scale with the ENCODING — `fixtures x slots` place literals — not with
 * fixtures alone. The bench's own lattice happens to jump 144 -> 216 slots
 * between n=144 and n=145, which is what makes a fixture-count reading look
 * sharp at 140/160; a board with 200 fixtures on a 144-slot lattice would very
 * likely still improve, and one with 120 fixtures on a 400-slot lattice would
 * not. A gate spelled `n <= 140` misfires on both.
 *
 * --- WHAT TO RE-MEASURE BEFORE CHANGING THIS ------------------------------
 *
 * This number is a ratio between the wall and this machine's speed, so it is
 * NOT portable across a change to either. Re-run the two commands above and
 * move it if: `AUTO_SOLVER_WALL_MS` changes; the pre-search cost changes
 * (anything touching `encodeBuild`, `buildGrid` or the first `push()`); or the
 * deployment target's CPU changes. The figure to read off the sweep is the
 * largest `n x slots` whose row still reports `engine: "z3"`.
 */
export const MAX_SOLVE_ENCODING = 20_000;

/**
 * Whether the build solver is worth calling on this board at this wall — the
 * R18 gate, as a predicate, so no caller has to restate the threshold.
 *
 * THE POINT IS THAT `MAX_SOLVE_ENCODING` LIVES IN ONE PLACE. The web layer has
 * to decide whether to call `buildSchedule` at all, and a copy of the number
 * there is a placer/verifier fork wearing a different hat — the defect shape
 * this subsystem has hit three times, and the copy that drifts is always the
 * one deciding what the organiser gets.
 *
 * `false` does NOT mean "no better board exists". Task 13 measured a
 * 200-fixture board improving (placed 198 -> 199) when given 180 s instead of
 * 8 s: above the gate the solver is not failing to find anything, it is never
 * being asked, because the wall expires during the encode. So the honest
 * reading is "not inside this wall", and a caller that gets `false` should fall
 * through to the greedy board rather than tell anyone the board is optimal.
 *
 * It builds the real lattice rather than estimating it. `buildGrid` is cheap
 * (it never reads the fixture list) and it is the only thing that knows how
 * sessions, blackouts, the horizon and the configured courts turn into slots;
 * an estimate here would be a second implementation of exactly that, which is
 * the fork this export exists to prevent. `buildSchedule` builds the same
 * lattice again a moment later — that duplication is deliberate and cheap, and
 * far safer than threading a grid through the call.
 *
 * An over-cap or empty lattice answers `false`: `buildSchedule` returns the
 * greedy board on both without solving, so calling it would be pure cost.
 *
 * @param wallMs the wall the caller will actually pass. Defaults to the
 * engine's own, which is NOT what the web layer uses — pass
 * `AUTO_SOLVER_WALL_MS` explicitly or the gate answers for a 30 s budget the
 * request will not get.
 */
export function canSolveWithin(
  fixtures: readonly SchedulableFixture[],
  config: SlotConfig & { courts: string[] },
  wallMs: number = DEFAULT_BUILD_WALL_MS,
  existing: readonly Assignment[] = [],
): boolean {
  if (fixtures.length === 0) return false;
  const grid = restrictToConfiguredCourts(buildGrid({ config, existing }), config.courts, []);
  if (grid.overCap || grid.slots.length === 0) return false;
  // Scaled by the wall the caller will really use. The 20_000 figure was
  // measured against 8_000 ms, so a caller with twice the budget can afford
  // twice the encoding — the gate is a cost-vs-budget ratio, not a fixed size.
  const budget = MAX_SOLVE_ENCODING * (wallMs / AUTO_SOLVER_WALL_MS_AT_MEASUREMENT);
  return fixtures.length * grid.slots.length <= budget;
}

/** The wall `MAX_SOLVE_ENCODING` was measured against — the web layer's
 *  `AUTO_SOLVER_WALL_MS` at the time of the Task 13 bench. It exists so
 *  `canSolveWithin` can scale the gate to whatever wall a caller passes;
 *  changing it without re-running the sweep silently rescales every gate
 *  decision. */
const AUTO_SOLVER_WALL_MS_AT_MEASUREMENT = 8_000;

/**
 * One run's z3 resource budget, shared by every solve the run performs
 * (ruling R11).
 *
 * --- WHY THIS IS NOT `solver.set("rlimit", n)` ONCE ------------------------
 *
 * MEASURED, against z3-solver 5.0.0:
 *
 *   * `rlimit` is RE-ARMED ON EVERY `check()`. Three checks at `rlimit: 50_000`
 *     on ONE solver each returned `sat`, spending ~40_000 apiece — 120_000
 *     against a limit that reads like 50_000.
 *   * it is a PER-CHECK DELTA, not an absolute threshold. With the context's
 *     counter already at 86_090, a check at `rlimit: 50_000` still returned
 *     `sat` and spent 40_672. An absolute reading would have aborted at once.
 *
 * So a limit set once before the first check bounds a CHECK, never a run: the
 * old code could spend `checks x rlimit`, and with LNS re-entering the solver
 * per window it became `(windows + 1) x checks x rlimit`. That inverts D9 —
 * the deterministic budget stops binding and the wall-clock backstop becomes
 * the real stopping rule, on a machine-dependent boundary that R10 says must
 * never fire at all.
 *
 * --- HOW IT IS ACCOUNTED ---------------------------------------------------
 *
 * z3's own counter, read from `solver.statistics()` under the key
 * `rlimit count`. It is CONTEXT-GLOBAL and monotonic — a fresh `Solver` keeps
 * counting from where the last one stopped, which is exactly what makes it
 * usable as a run total across the sub-solves LNS opens. Every reading here is
 * a DELTA against `base`, so what other runs did before this one is irrelevant,
 * and `withZ3Lock` guarantees no other solve is interleaving with ours.
 *
 * Deterministic by construction: `rlimit` is a resource counter, not a clock,
 * which is the whole reason D9 chose it. Nothing here reads elapsed time.
 */
interface RunBudget {
  /** The whole run's allowance, in z3 resource units. */
  readonly total: number;
  /** `rlimit count` when the run started. Readings are deltas against it. */
  readonly base: number;
  /** Consumed so far by every solve in this run. MEASURED, never assumed. */
  spent: number;
  /**
   * What the run has DRAWN, as opposed to what it spent: each phase is charged
   * the smaller of what it used and what it was allotted.
   *
   * The two differ because a check OVERSHOOTS (see `rlimitSpent`), and the
   * overshoot is z3's, not the next phase's to pay for. Charging it whole makes
   * the reserve imaginary: MEASURED, the main phase's last check overran its
   * 75% share by more than the remaining 25% in EVERY configuration tried —
   * 500_000 spent 1_045_248, 100_000 spent 103_661, 260_000 spent 288_533 — so
   * `spent < total` was false the moment the tiers fell short, and the fallback
   * never ran on a single board it exists for. Allotments are drawn against
   * this; `spent` stays the honest total and is what `rlimitSpent` reports.
   */
  drawn: number;
}

/**
 * z3's own resource counter. Present before the first `check()` (measured: 1 on
 * a brand-new context), but guarded anyway — a missing key must read as
 * "nothing spent yet", not as a `NaN` that would silently disable the cap.
 *
 * `release()` IS NOT OPTIONAL HERE, whatever the API docs' "can help release
 * memory sooner" suggests. `statistics()` allocates a `Z3_stats` in the WASM
 * heap and JS finalisers are not prompt enough to keep up with one reading per
 * `check()`: leaving them to the collector aborted a 14-run probe with
 * `RuntimeError: memory access out of bounds` inside
 * `smt::relevancy_propagator_imp::pop` — a corrupted heap, surfacing at the
 * next `solver.pop()` rather than anywhere near the leak.
 */
function rlimitCount(solver: Solver<"repair">): number {
  const stats = solver.statistics();
  try {
    return stats.keys().includes("rlimit count") ? stats.get("rlimit count") : 0;
  } finally {
    stats.release();
  }
}

export type BuildStatus =
  /** A board was produced and the gate accepted it. */
  | "ok"
  /** Every tier that ran completed, and none of them could improve on the
   *  greedy seed. A PROOF, not an opinion — the distinction from `ok` is
   *  exactly the distinction between "we stopped looking" and "there is
   *  nothing to find". */
  | "already_optimal"
  /** z3 PROVED no better board exists, and the proof is one of two:
   *
   *    * the bare feasibility probe came back unsat, which can only happen
   *      through a pin (see `solveBuild` §5);
   *    * the T0 walk proved `AtLeast(placed, 1)` unsat, i.e. not one card can
   *      be placed legally.
   *
   *  Never inferred from an `unknown`, and never from an unsat at a bound
   *  above 1 — that is `already_optimal`. The greedy board is still returned. */
  | "infeasible"
  /** The encoder and `validateAssignments` disagreed and the solver's board
   *  INTRODUCED a blocking conflict. The greedy seed is returned and the
   *  disagreement is logged. */
  | "verifier_rejected"
  /** The WASM would not boot. A fallback, never an exception. */
  | "z3_unavailable"
  /**
   * THE SOLVER NEVER SEARCHED THIS BOARD, so nothing is claimed about it.
   *
   * The greedy board is returned and it is a perfectly good board; what is
   * missing is any statement about whether a better one exists. Two causes, and
   * both are "the lattice cannot hold the board already in hand":
   *
   *   * the lattice would exceed `MAX_SLOTS` and comes back EMPTY, so there is
   *     nothing to search over at all;
   *   * the greedy seed sits BETWEEN slots. `gridStepMinutes` folds every
   *     interval that can displace a start, but it is floored at
   *     `REPAIR_GRID_MINUTES` and no gcd over durations can reach an ABSOLUTE
   *     anchor — a `startWindows.notBefore` at 09:07, a blackout edge, an
   *     existing booking's `endAt + gap`. On such a board the first tier bound
   *     is the incumbent's own metric, which the lattice cannot achieve, so the
   *     model goes unsat and every later walk is unsat on its first ask: all
   *     four tiers "complete" having looked at nothing.
   *
   * IT EXISTS TO STOP THAT READING AS `already_optimal`, which is the damaging
   * outcome — an organiser told their schedule is optimal when it was never
   * searched has no reason to look again and no way to find out. `ok` is barely
   * better: it reads as a board the solver produced and accepted.
   */
  | "not_searched"
  /** This build declined to QUEUE behind `withZ3Lock` rather than wait it out:
   *  `MAX_SOLVER_QUEUE` builds were already in flight, so the greedy board came
   *  back at once and the solver was never consulted. Ordinary rather than an
   *  error — the board is valid, and a retry can do better. */
  | "solver_busy";

export interface BuildInput {
  fixtures: readonly SchedulableFixture[];
  /**
   * `hard` and `restByDivision` are picked in explicitly because `SlotConfig`
   * has neither and `VerifyConfig` has both. Without them a caller writing
   * `{ ...packConfig, hard: compiled }` gets TS2353, deletes the field to make
   * it compile, and every compiled instruction rule silently stops binding —
   * `restByDivision` has no other channel at all, and a cross-division pair
   * then rests at whichever division's number happened to be asked.
   */
  config: SlotConfig & { courts: string[] } & Pick<VerifyConfig, "hard" | "restByDivision">;
  existing?: readonly Assignment[];
  dependencies?: readonly OrderDependency[];
  /** POLISH only: fixture ids that may not move. Anchored to `locked` when the
   *  caller supplied one, and to greedy's placement otherwise — see
   *  `publishedSlotOf`. */
  frozen?: readonly string[];
  /**
   * Where the caller's MOVABLE cards sit right now, before this run.
   *
   * Read for exactly two things, and it is NOT part of the immovable board —
   * that is `existing`, and conflating the two would put the organiser's own
   * cards in their own way:
   *
   *   * it is the baseline `moved` is measured against, so the strip's
   *     "moved N" counts from where the organiser was rather than from a greedy
   *     seed they never saw;
   *   * POLISH anchors a freeze to it (R20), so a frozen card without a
   *     `locked` slot is held where it was PUBLISHED instead of wherever greedy
   *     happened to re-place it this run.
   *
   * It still does not constrain the solve: an unfrozen card is free to move off
   * its `current` slot, which is the whole point of asking.
   *
   * AN EMPTY ARRAY MEANS "no board", not "an empty board" — a first-ever build
   * would otherwise report every card it placed as moved.
   *
   * Rows for fixtures this run does not place are still consulted: one that
   * vanishes from the answer is reported through `lost`. So pass the board for
   * the cards this run may touch, not the whole competition, and do not filter
   * it down to the cards you expect back — that is precisely the signal.
   *
   * Optional and additive. Omitting it leaves `moved` measured against the
   * greedy seed and `lost` at 0, which is what every caller got before this
   * field existed.
   */
  current?: readonly Assignment[];
  rlimit?: number;
  wallMs?: number;
}

export interface BuildResult {
  assignments: readonly Assignment[];
  /** Everything wrong with `assignments`, INCLUDING a row per fixture that is
   *  not on the board. `validateAssignments` cannot report an absence — it
   *  iterates the rows it is given — so without this a solver that placed
   *  nothing would hand back an empty conflict list and read as a clean board.
   *  Each absent fixture carries what ACTUALLY happened to it, never a
   *  fabricated one: greedy's own diagnosis if greedy could not place it, the
   *  blocking conflict that disqualified it if the seed was legalised, and only
   *  otherwise a `no_slot` whose detail says whether a proof backs it. */
  conflicts: readonly Conflict[];
  metrics: BoardMetrics;
  /** Where the returned board came from, not which solver was consulted: `z3`
   *  means the board on this result is one z3 produced. */
  engine: "greedy" | "z3" | "z3+lns";
  status: BuildStatus;
  tiersCompleted: number;
  budgetExpired: boolean;
  elapsedMs: number;
  /**
   * Rows on this board that changed slot relative to the baseline — the
   * caller's `current` when there is one, and the greedy seed otherwise.
   *
   * RELOCATIONS ONLY. It never exceeds `assignments.length`, which is what makes
   * "moved N" printable beside a board of that size. A card the run could not
   * place is `lost`, not this (R21): folding the two made a single substitution
   * read as 2 and let the number outgrow the board it described.
   */
  moved: number;
  /**
   * Baseline rows that are NOT on this board — matches the caller had scheduled
   * and this run could not place.
   *
   * ALWAYS 0 without `current`, and that is a definition rather than a gap
   * (R21). The greedy seed is this run's own first guess and not a board anybody
   * was shown, so the solver dropping a seed row to fit two better ones is
   * ordinary progress; only the caller's real board can lose a match.
   *
   * Separate from `moved` because the two are different events and only one is
   * alarming — cards moving is what the organiser asked for, a card falling off
   * the board is not, and a single conflated number cannot say which happened.
   */
  lost: number;
  /**
   * What the RUN cost, in z3 resource units, measured off z3's own counter
   * (R11). The whole run — every tier check and every window the fallback
   * opened — because they share one allowance.
   *
   * Deterministic, which is the point: `rlimit` is a resource counter and not a
   * clock (D9), so this number is a property of the search and reproduces on
   * any machine. It exists so the budget is AUDITABLE rather than asserted —
   * "the run stayed inside its allowance" is otherwise unobservable from
   * outside, and it was silently false before R11.
   *
   * MAY EXCEED `rlimit`, and by much more than a rounding error: z3 tests the
   * resource limit at intervals rather than stopping on it, so a check carries
   * a floor cost it pays whatever the limit says. Measured on the four-fixture
   * model in `build-budget.test.ts`: `rlimit: 10` and `rlimit: 100` both spend
   * ~28_600, and `rlimit: 200_000` spends 228_533. Treat this as "the run drew
   * its allowance and one check's overshoot", never as a hard ceiling.
   */
  rlimitSpent: number;
  /**
   * What each LNS window was ALLOTTED, in order, in z3 resource units. Empty
   * when the fallback did not run.
   *
   * Telemetry, and the only place the apportionment is visible from outside:
   * every other symptom of a mis-apportioned budget is downstream of a solve
   * and washes out into "the solver found nothing", which is also what a
   * correctly-budgeted run looks like. Task 13's bench needs it to answer
   * whether one run budget is enough at 200 fixtures and how it should be
   * split.
   */
  lnsWindowRlimits: readonly number[];
  /**
   * The pinned fixtures an `infeasible` verdict is ABOUT (R4).
   *
   * `status: "infeasible"` has two sources and they mean opposite things to an
   * organiser. The T0 source is a statement about the board — not one card can
   * be placed legally. The PROBE source is a statement about the PINS: 38 of 40
   * cards can be scheduled perfectly well, and the only thing z3 proved is that
   * two `locked`/`frozen` placements cannot both be kept. Rendering the second
   * as "no schedule is possible" is false and unactionable, so the result
   * carries the identity of the cards the proof is about and the caller can say
   * which ones. `metrics.placed` / `metrics.total` still carry the rest of the
   * sentence.
   *
   * PRESENT ONLY on the probe path, and its absence on an `infeasible` result
   * is itself meaningful: it says the proof was about the board.
   *
   * It is the pinned SET, sorted, not a minimal unsat core. The claim it
   * supports is "these cannot ALL be kept", never "this one is at fault":
   * `encodeBuild` asserts a `locked` placement as a unit clause of its own, so
   * z3 is never asked the question a core would answer. Naming a subset would
   * need those pins passed as check-time assumptions, which is a change to
   * `build-encode.ts`.
   *
   * Optional and additive on purpose — every existing reader ignores it, and a
   * UI that has not been taught about it degrades to the count.
   */
  contradictoryPins?: readonly string[];
}

/**
 * The verifier gate's decision, as a pure function.
 *
 * A DELTA, not an absolute test, and that is a behavioural ruling rather than a
 * convenience. Blocking conflicts predate this solver: `person_overlap` and
 * `window` became blocking in #399 over boards that were published while they
 * were warnings, and an absolute gate would refuse the solver's answer on every
 * one of those boards forever — the feature would be dead on exactly the dirty
 * boards `deltaConflicts` exists to keep editable. "Never worse than greedy" is
 * enforced by `isStrictlyBetter` on the metrics, not here.
 *
 * `before` is the RAW greedy board — what the organiser gets today — so a
 * breach that is already theirs is not laid at the solver's door.
 *
 * Blocking-filtered BEFORE the delta, deliberately: `conflictKey` is
 * `fixtureId|reason|detail` and does not include `direct`, so a warn-only
 * `order` row and a blocking one can share a key and would cancel.
 *
 * Scoped to `ours` because `validateAssignments` attributes an `order` conflict
 * between two `existing` rows to a fixture this solver never placed. Refusing
 * our own answer over one would be a lock-out with no fix, since nothing the
 * solver can do changes it. Under the delta rule this is belt-and-braces — an
 * unchanged sibling conflict is already matched away — which is why it is
 * exercised here rather than through `buildSchedule`.
 */
export function rejectedBlockingConflicts(
  before: readonly Conflict[],
  after: readonly Conflict[],
  ours: ReadonlySet<string>,
): Conflict[] {
  return deltaConflicts(before.filter(isBlockingConflict), after.filter(isBlockingConflict)).filter(
    (c) => ours.has(c.fixtureId),
  );
}

/**
 * A board's conflicts, in full — the rows' own, PLUS a row per fixture that is
 * not on the board at all.
 *
 * `validateAssignments` answers for the rows it is handed; the fixtures that are
 * NOT on the board are the other half of the truth and it cannot see them.
 * Without this a solver that placed nothing hands back an empty conflict list
 * and reads as a clean board.
 *
 * Three sources, in order of how well established they are, because a fabricated
 * reason is fed straight to the repair prompt:
 *
 *   1. greedy's own diagnosis, which names the binding constraint;
 *   2. the blocking conflict that disqualified the row from the seed;
 *   3. only then a `no_slot` — and `proved` decides whether its detail claims a
 *      ceiling (T0 came back unsat) or admits the budget ran out.
 *
 * EXPORTED for the web layer (ruling R17). It was module-private, so the API
 * layer grew a second copy of the same three-source rule; two copies of "what
 * actually happened to this card" will drift, and the drift is invisible until
 * an organiser is told the wrong reason. Behaviour is unchanged from the closure
 * it replaces — the captured values are now parameters and nothing else moved.
 */
export function conflictsFor(input: {
  board: readonly Assignment[];
  fixtures: readonly SchedulableFixture[];
  config: BuildConfig;
  existing: readonly Assignment[];
  dependencies: readonly OrderDependency[];
  /** `slotFixtures`' OWN conflicts for the raw greedy seed. */
  greedyConflicts: readonly Conflict[];
  /** Seed rows dropped by the legalisation pass, and what disqualified them. */
  disqualified: ReadonlyMap<string, readonly Conflict[]>;
  /** Whether a proof backs an absence, or the budget merely ran out. */
  proved: boolean;
}): Conflict[] {
  const { board, fixtures, config, existing, dependencies, proved } = input;
  const onBoard = new Set(board.map((a) => a.fixtureId));
  const out: Conflict[] = validateAssignments(board, config, existing, dependencies);
  for (const f of fixtures) {
    if (onBoard.has(f.id)) continue;
    const greedySaid = input.greedyConflicts.filter((c) => c.fixtureId === f.id);
    if (greedySaid.length > 0) {
      out.push(...greedySaid);
      continue;
    }
    const dropped = input.disqualified.get(f.id);
    if (dropped !== undefined) {
      out.push(...dropped);
      continue;
    }
    out.push({
      fixtureId: f.id,
      reason: "no_slot",
      detail: proved
        ? "no legal slot in the lattice"
        : "left unplaced when the solver's budget expired",
      rule: RULE_BY_REASON.no_slot,
    });
  }
  return out;
}

/**
 * Everything the GREEDY board is made of, and everything a `BuildResult`
 * describing it needs — all of it derived from the input alone, with no solver
 * and no lock involved.
 *
 * ONE DEFINITION, deliberately. `solveBuild` hands this board back from six
 * early exits, and `buildSchedule` hands it back without entering the lock at
 * all when the queue is full (`MAX_SOLVER_QUEUE`). A second construction of it
 * is the placer/verifier fork this subsystem has already hit three times, and
 * the copy that drifts is always the one deciding what the organiser gets: the
 * first field added to the solver's greedy exit and not to the queue-cap exit
 * would be invisible to every test that only ever looks at one of them.
 *
 * The defaults live here too (`existing`, `dependencies`, `verifyConfig`) so
 * that they are derived exactly once — the "ONE immovable board" rule below is
 * a real invariant, not a style note.
 */
interface GreedySeed {
  /**
   * ONE immovable board, read by three consumers that must not disagree.
   *
   * `encodeBuild` seeds its typed-rule day tallies from this array and
   * `validateAssignments` tallies from the array IT is handed; a filtered or
   * omitted copy on either side puts the encoder and the verifier on different
   * counts and reopens the placer/verifier fork. Every call passes THIS
   * binding — never a filtered view, never `input.existing` re-defaulted.
   */
  existing: readonly Assignment[];
  dependencies: readonly OrderDependency[];
  verifyConfig: BuildConfig;
  /** Greedy's board before legalisation, and its own conflict list. */
  rawSeed: ReturnType<typeof slotFixtures>;
  /** What `validateAssignments` says about the RAW seed. */
  rawSeedConflicts: readonly Conflict[];
  /** Seed rows disqualified by a blocking conflict, mapped to the conflicts
   *  that disqualified them — so the result can report what ACTUALLY happened
   *  to the card instead of inventing a reason for it. */
  disqualified: ReadonlyMap<string, readonly Conflict[]>;
  /** The LEGALISED greedy board: the floor the solver is held to, and the board
   *  every greedy exit returns. */
  assignments: readonly Assignment[];
  metrics: BoardMetrics;
  /**
   * The caller's own board, or `undefined` when they gave us none.
   *
   * AN EMPTY ARRAY IS "NONE", not "a board on which nothing was scheduled".
   * `[]` is the natural shape of a first-ever build on a division nobody has
   * touched, and reading it as a baseline makes every card the run places differ
   * from it — so the strip announces "12 matches moved" about a board that never
   * existed. The distinction is drawn HERE rather than at the call seam, because
   * it has to hold for every caller and not only for the one that remembered.
   *
   * ONE binding, read by both consumers. `publishedSlotOf` anchors a freeze to
   * it (R20) and `movedFrom` measures against it, and those two must never
   * disagree about whether there is a caller board at all: a freeze anchored to
   * the organiser's slot while `moved` counted from greedy's would report a card
   * as moved precisely when it had been held still.
   */
  currentBoard: readonly Assignment[] | undefined;
  /** This run's bindings for the exported `conflictsFor`, which carries the
   *  three-source rule and the reasoning behind it. */
  conflictsForBoard: (board: readonly Assignment[], proved: boolean) => Conflict[];
  /**
   * How many of `board`'s rows sit somewhere other than where the CALLER had
   * them — the number the UI renders verbatim as "moved N" / "nothing moved".
   *
   * MEASURED AGAINST `input.current` WHEN THERE IS ONE, and only otherwise
   * against the greedy seed. The seed is the wrong baseline whenever the two
   * differ, and they differ in exactly the shape POLISH exists for: a fixture
   * the caller froze but did not `lock` has no anchor of its own, so greedy
   * RE-PLACES it and the seed records greedy's slot rather than the organiser's.
   * The run then holds the card at greedy's slot, the diff against the seed is
   * zero, and the strip says "nothing moved" about a board whose published times
   * changed. Falling back to the seed keeps every caller that supplies nothing
   * exactly where it was — a self-comparison, so zero.
   *
   * ONE rule for both exits. The early-return greedy paths hand back the seed
   * itself, and hard-coding `moved: 0` there tells the same lie whenever
   * `current` disagrees with it, so they route through here too.
   *
   * A row missing from the baseline counts as moved, which is right in both
   * directions: under `current` it is a card the organiser had not scheduled at
   * all, and under the seed it is one greedy could not place.
   *
   * ROWS ONLY — a card this run could not place is `lostFrom`'s business, not
   * this one's (R21). Folding the two together made a single substitution read
   * as 2 (the card swapped in counted as moved, the card dropped counted again)
   * and let `moved` exceed the size of the board it describes. A strip printing
   * "moved N" cannot honestly print an N larger than the board.
   */
  movedFrom: (board: readonly Assignment[]) => number;
  /**
   * Baseline rows this run could not place — matches that were on the caller's
   * board and are not on the answer.
   *
   * SCOPED TO `currentBoard`, and zero without one (R21). Against the greedy
   * seed the question is not meaningful: the seed is this run's own first guess,
   * not a board anybody was shown, and the solver dropping a greedy card to fit
   * two better ones is ordinary progress rather than a loss. Measured on the
   * shape that proves it — one slot per court, `a=(E1,E2) b=(E1,E3) c=(E2,E4)`:
   * greedy places only `a`, z3 places `b` and `c`, and counting the seed's `a`
   * as lost took `moved` to 3 on a two-row board.
   *
   * That case is also why the previous justification here was wrong. It claimed
   * a seed baseline could never lose a row because T0 maximises `placed` — but
   * `isStrictlyBetter` only requires `placed >=`, so the solver may drop one
   * card while adding two, and the set can change even when the count does not.
   *
   * Its own field rather than folded into `moved`, because the two are different
   * events and only one of them is alarming: cards moving is what the organiser
   * asked for, a card falling off the board is not.
   */
  lostFrom: (board: readonly Assignment[]) => number;
}

/**
 * The seed, and the legalisation pass that turns it into a floor worth having.
 *
 * See the file header: `placed` has to mean LEGALLY placed or the solver can
 * never beat greedy on a window-overrunning board.
 */
function greedySeed(input: BuildInput): GreedySeed {
  const { fixtures, config } = input;
  const existing = input.existing ?? [];
  const dependencies = input.dependencies ?? [];
  const verifyConfig: BuildConfig = { ...config };

  const rawSeed = slotFixtures({ fixtures, config, existing });
  const rawSeedConflicts = validateAssignments(
    rawSeed.assignments,
    verifyConfig,
    existing,
    dependencies,
  );
  const disqualified = new Map<string, Conflict[]>();
  const seedIds = new Set(rawSeed.assignments.map((a) => a.fixtureId));
  for (const c of rawSeedConflicts) {
    if (!isBlockingConflict(c) || !seedIds.has(c.fixtureId)) continue;
    const rows = disqualified.get(c.fixtureId);
    if (rows === undefined) disqualified.set(c.fixtureId, [c]);
    else rows.push(c);
  }
  const assignments = rawSeed.assignments.filter((a) => !disqualified.has(a.fixtureId));
  const metrics = boardMetrics(assignments, config.courts, fixtures.length);

  const currentBoard =
    input.current !== undefined && input.current.length > 0 ? input.current : undefined;

  return {
    existing,
    dependencies,
    verifyConfig,
    rawSeed,
    rawSeedConflicts,
    disqualified,
    assignments,
    metrics,
    currentBoard,
    conflictsForBoard: (board, proved) =>
      conflictsFor({
        board,
        fixtures,
        config: verifyConfig,
        existing,
        dependencies,
        greedyConflicts: rawSeed.conflicts,
        disqualified,
        proved,
      }),
    movedFrom: (board) => {
      const was = new Map((currentBoard ?? assignments).map((a) => [a.fixtureId, a]));
      return board.filter((a) => {
        const before = was.get(a.fixtureId);
        return before === undefined || before.court !== a.court || before.startAt !== a.startAt;
      }).length;
    },
    lostFrom: (board) => {
      if (currentBoard === undefined) return 0;
      const onBoard = new Set(board.map((a) => a.fixtureId));
      return currentBoard.filter((a) => !onBoard.has(a.fixtureId)).length;
    },
  };
}

/**
 * The greedy board as a finished `BuildResult` — the ONE place that shape is
 * written down.
 *
 * `spent` is the caller's because only a run that reached the solver has
 * anything but zero to report, and `lnsWindowRlimits` is passed by reference on
 * purpose: `solveBuild` fills it after this closure is built.
 */
function greedyResult(
  seed: GreedySeed,
  status: BuildStatus,
  spent: {
    budgetExpired: boolean;
    elapsedMs: number;
    rlimitSpent: number;
    lnsWindowRlimits: readonly number[];
  },
): BuildResult {
  return {
    assignments: seed.assignments,
    conflicts: seed.conflictsForBoard(seed.assignments, false),
    metrics: seed.metrics,
    engine: "greedy",
    status,
    tiersCompleted: 0,
    budgetExpired: spent.budgetExpired,
    elapsedMs: spent.elapsedMs,
    // NOT a hard 0. This board IS the seed, so it is zero whenever the caller
    // supplied no `current` — but when they did, a card greedy re-placed has
    // genuinely moved from where the organiser had it, and saying otherwise is
    // the same false "nothing moved" the solver paths were fixed for.
    moved: seed.movedFrom(seed.assignments),
    lost: seed.lostFrom(seed.assignments),
    rlimitSpent: spent.rlimitSpent,
    lnsWindowRlimits: spent.lnsWindowRlimits,
  };
}

/**
 * The greedy board and nothing else — for a caller that never reaches the
 * solver at all, so nothing has been spent and the result says so honestly.
 */
function greedyOnly(input: BuildInput, status: BuildStatus): BuildResult {
  const t0 = performance.now();
  const seed = greedySeed(input);
  return greedyResult(seed, status, {
    budgetExpired: false,
    elapsedMs: performance.now() - t0,
    rlimitSpent: 0,
    lnsWindowRlimits: [],
  });
}

/**
 * How many builds may be waiting on the WASM before a caller is told to take the
 * greedy board instead (Gap 4).
 *
 * `withZ3Lock` serialises the whole PROCESS — it is a correctness device, not a
 * throttle: `resetZ3` kills pthreads process-wide, so it cannot be reentrant.
 * Without this cap the third organiser to click auto-schedule waits out two full
 * `wallMs` budgets before their own run even starts, and their request simply
 * appears hung. Declining to queue converts that into an immediate greedy board
 * carrying `status: "solver_busy"`, which the result strip already renders as an
 * ordinary outcome rather than an error.
 *
 * **`queued` IS PER-PROCESS, so on a multi-instance deployment the real ceiling
 * is `instances x MAX_SOLVER_QUEUE` concurrent solves.** This is memory
 * protection for ONE process's WASM heap — z3's heap only ever grows, and behind
 * a process-wide lock a deeper queue buys no throughput at all, only waiting. It
 * is NOT global admission control and must not be read as one: nothing here
 * coordinates between instances, so a fleet-wide concurrency limit sized off
 * this number would be sized off a single box's.
 */
export const MAX_SOLVER_QUEUE = 2;

/** Builds that have entered `buildSchedule` and not yet finished — running or
 *  waiting on the lock, which from a caller's point of view is the same thing.
 *  Incremented SYNCHRONOUSLY, before anything is awaited, so two calls made in
 *  one tick cannot both read a stale depth. */
let queued = 0;

export function buildSchedule(input: BuildInput): Promise<BuildResult> {
  // The queue cap comes FIRST, ahead of every other reason to fall back to
  // greedy (Gap 4). The R22 size gate (`canSolveWithin`) and `solveBuild`'s own
  // lattice checks also end in a greedy board, but each of them has to build the
  // seed and the lattice to decide — behind the lock, where this caller would be
  // waiting out two full budgets first. This test is a single integer read: it
  // is the only one that can be answered before joining the queue, which is the
  // whole point of it. Order therefore costs nothing either way in the answer
  // and everything in the latency.
  if (queued >= MAX_SOLVER_QUEUE) return Promise.resolve(greedyOnly(input, "solver_busy"));
  queued++;
  // `withZ3Lock` is NOT reentrant. It is taken exactly here, and nothing below
  // may take it again — `loadZ3` deliberately does not, neither does anything
  // in `build-encode.ts`, and the LNS pass re-enters `solveBuild` rather than
  // `buildSchedule` for exactly this reason. (The plan proposed driving LNS
  // through `repairSchedule`, which DOES take the lock itself, and therefore
  // proposed moving this call inward; nothing here takes it twice, so the lock
  // stays on the outside where it can serialise the whole run.)
  //
  // AND THE TEARDOWN IS OURS, not the caller's (R17). z3's WASM heap only ever
  // grows and nothing frees a finished `Solver`, so a process that runs a
  // handful of solves aborts with an OOM and takes node with it — measured at
  // six consecutive solves. That fix first landed as a `finally` at the web
  // seam, where the NEXT entry point re-introduces the crash simply by not
  // knowing about it; `repairDecomposed` already owns its own resets, and this
  // now matches. `withZ3LockAndReset` rather than a `finally` around this call
  // because the reset has to happen while the lock is still HELD — see its
  // comment for what the obvious spelling does instead.
  //
  // `finally` on the promise, not a `try`/`finally` around the call: the
  // decrement has to happen when the SOLVE settles, and it must run on the throw
  // path too — `solveBuild` swallows a boot failure but not an encoder-drift
  // throw, and a counter that leaked one of those would refuse every subsequent
  // build in this process for as long as it lived.
  return withZ3LockAndReset(() => solveBuild(input)).finally(() => {
    queued--;
  });
}

/**
 * @param allowLns false on the LNS pass's own sub-solves. Each window is solved
 * by re-entering this function with the rest of the board pinned, so without a
 * guard a sub-solve that also fell short of `TIER_COUNT` would open windows of
 * its own, without bound.
 */
async function solveBuild(
  input: BuildInput,
  allowLns = true,
  inherited?: RunBudget,
): Promise<BuildResult> {
  // `performance.now()`, never `Date.now()` — `scripts/engine-boundary.ts` bans
  // ambient wall-clock reads in engine source, and a monotonic clock is the
  // right one for a duration anyway.
  const t0 = performance.now();
  const elapsed = (): number => performance.now() - t0;
  const { fixtures, config } = input;
  const wallMs = input.wallMs ?? DEFAULT_BUILD_WALL_MS;
  const rlimit = input.rlimit ?? DEFAULT_BUILD_RLIMIT;
  /**
   * The wall, tested where the EXPENSIVE work is, not only between checks
   * (ruling R23).
   *
   * Before this existed the only tests were at the top of each search loop, and
   * everything costly happens outside them: Task 13's bench measured a
   * 200-fixture run returning at **15_368 ms against an 8_000 ms wall** — 92 %
   * over — because `encodeBuild` (3_706 ms) and the first `solver.push()` over
   * the encoded model (9_837 ms) both run to completion before any loop is
   * entered, and nothing in either reads the clock. That is a latency bug, not
   * a measurement artefact: every caller sizing a request timeout on
   * `AUTO_SOLVER_WALL_MS` was wrong by about a factor of two, and wrong by most
   * on exactly the biggest boards.
   *
   * The bail is not a new outcome. It returns the greedy incumbent with
   * `budgetExpired: true`, which is byte-identical to what an exhausted rlimit
   * already produces, so D6 ("never worse than greedy") survives it by
   * construction — `greedy()` returns `seedAssignments`/`seedMetrics` and there
   * is no path here that can hand back anything else. It never throws.
   *
   * It cannot make the wall exact. `encodeBuild` and `push()` are single
   * uninterruptible calls, so the guard catches the run at their BOUNDARIES —
   * the overrun is bounded by one such step, not eliminated. At 200 fixtures
   * the first tier `push()` alone is ~9_800 ms, so an 8 s wall CANNOT be held
   * once that push has started. The fix for that case is the R22 size gate,
   * which declines the call outright; R23 only stops a doomed run buying more.
   *
   * --- WHAT IS ACTUALLY COVERED, AND WHAT IS NOT ----------------------------
   *
   * Only the FIRST use below — the guard before `encodeBuild` — is
   * mutation-provable, by `build-wall.test.ts`: delete it and a 200-fixture run
   * pays a full encode it will never be allowed to search, and the test's
   * elapsed bound reds.
   *
   * The other four (after `encodeBuild`, after each `solver.push()`, and before
   * `buildTiers`) are BELT AND BRACES, and each was confirmed to survive
   * mutation across all 131 build-suite tests. That is not an oversight waiting
   * for a cleverer test: removing any of them changes ONLY elapsed time. Every
   * observable field — `engine`, `status`, `tiersCompleted`, `budgetExpired`,
   * `rlimitSpent`, the board itself — is identical either way, because each is
   * followed by another guard that reaches the same exit a few hundred
   * milliseconds later. They are kept because each sits in front of a real
   * uninterruptible cost that nothing else guards at that exact point.
   * **Do not read their presence as coverage.**
   */
  const outOfTime = (): boolean => elapsed() >= wallMs;

  // 1. The seed, the legalisation pass that turns it into a floor worth having,
  //    and every derived binding the run needs — all of it in `greedySeed`, so
  //    the queue-cap exit in `buildSchedule` returns the SAME board this
  //    function's early exits do rather than a second construction of it.
  const seed = greedySeed(input);
  const { existing, dependencies, verifyConfig, rawSeed, rawSeedConflicts } = seed;
  const { currentBoard, conflictsForBoard, movedFrom, lostFrom } = seed;
  const seedAssignments = seed.assignments;
  const seedMetrics = seed.metrics;

  /** Filled once the solver exists — `greedy(...)` is defined before that and
   *  can return from an early exit, where nothing has been spent and the result
   *  should say so honestly. A ref rather than a `let` so the binding itself
   *  stays `const`. */
  const runBudget: { current: RunBudget | undefined } = { current: undefined };

  /** Filled by the LNS pass below; empty on every path that never reaches it. */
  const lnsWindowRlimits: number[] = [];

  const greedy = (status: BuildStatus, budgetExpired = false): BuildResult =>
    greedyResult(seed, status, {
      budgetExpired,
      elapsedMs: elapsed(),
      rlimitSpent: runBudget.current?.spent ?? 0,
      lnsWindowRlimits,
    });

  // 2. The lattice.
  //
  //    A universe that ends before the fixtures begin is not a small lattice,
  //    it is the WRONG one: `repairUniverse` falls back to the first day of the
  //    unix epoch when there is no competition window, no session window and no
  //    existing board, and solving over that would "improve" the board onto
  //    slots in 1970. Refused for the same reason `buildGrid` refuses a
  //    truncated lattice over `MAX_SLOTS`: a lattice the encoder cannot tell
  //    apart from a legal one is worse than none at all.
  const universe = repairUniverse({ proposal: [], existing, config });
  if (config.startAt >= universe.to) return greedy("ok");

  /**
   * Where a card the caller says may not move actually IS.
   *
   * THREE SOURCES, in descending order of how much the ORGANISER would
   * recognise the answer (R20):
   *
   *   1. `locked` — the caller naming a slot outright;
   *   2. `current` — where the card sits on the caller's own board, which for
   *      POLISH is the time an entrant has already been told;
   *   3. greedy's re-placement, and only as a last resort.
   *
   * The third is a slot greedy INVENTED during this very run, so anchoring to it
   * freezes the card to a time nobody has ever seen — POLISH silently moving a
   * published card, which is the exact opposite of the mode's purpose. It stayed
   * that way only because `BuildInput` had no published-board field; `current`
   * is that field, so `locked` is no longer the only way to express a true
   * freeze. The fallback survives for the caller that supplies neither, where a
   * pin at greedy's slot is still better than no freeze at all.
   *
   * `currentBoard`, not `input.current`, so an empty array is "no board" here
   * exactly as it is for `moved` — the two must agree or a freeze anchored to
   * one baseline gets counted against the other.
   *
   * The RAW seed, not the legalised one: a card the legalisation pass dropped
   * still has a placement the organiser is looking at.
   */
  const publishedSlotOf = (id: string): BuildSlot | undefined => {
    const f = fixtures.find((x) => x.id === id);
    if (f?.locked !== undefined) return f.locked;
    const now = currentBoard?.find((a) => a.fixtureId === id);
    if (now !== undefined) return { court: now.court, startAt: now.startAt };
    const at = rawSeed.assignments.find((a) => a.fixtureId === id);
    return at === undefined ? undefined : { court: at.court, startAt: at.startAt };
  };

  const frozenIds = input.frozen ?? [];
  // Every anchor is PINNED into the lattice, exactly as a `locked` placement
  // is. This is the deliberate answer to an off-grid freeze — a card the
  // organiser dragged to 09:07, or one greedy parked against the edge of an
  // existing booking. Dropping it (what a bare `findIndex === -1` did) lets the
  // card move under POLISH while the result still says `ok`, which is the one
  // outcome that silently breaks the caller's contract; refusing the whole run
  // would contradict "auto-schedule always hands back a board". Pinning honours
  // the freeze, and any illegality the pin causes surfaces through the ordinary
  // conflict and gate path where somebody can see it.
  //
  // Carried WITH the fixture id, not as a bare slot list, because an
  // `infeasible` proved off these pins has to be able to name them (R4).
  //
  // A FROZEN ID THAT NAMES NO FIXTURE IN THIS RUN IS NOT A PIN. `publishedSlotOf`
  // falls back to `current`, so a stale id — a filtered `schedulable` list,
  // another division's card, a board read before a deletion — resolves to a slot
  // this run has no card for, and a pin is admitted into the lattice
  // UNCONDITIONALLY, court filter included. The result is a free slot on a court
  // the organiser never configured: measured, `courts: ["C1"]` plus a ghost pin
  // on `C9` placed a real fixture on C9 and reported `status: "ok"`.
  //
  // The same guard the force loop below already applies (`i < 0 -> continue`),
  // and it belongs on BOTH: skipping the card there while still buying it a
  // lattice slot here is what let the slot go to somebody else. It also keeps
  // `contradictoryPins` — which is `pinnedIds` — naming only cards the caller
  // can act on.
  const ownFixture = (id: string): boolean => fixtures.some((f) => f.id === id);
  const pins: { id: string; at: BuildSlot }[] = [
    ...fixtures.flatMap((f) => (f.locked !== undefined ? [{ id: f.id, at: f.locked }] : [])),
    ...frozenIds.flatMap((id) => {
      if (!ownFixture(id)) return [];
      const at = publishedSlotOf(id);
      return at === undefined ? [] : [{ id, at }];
    }),
  ];
  const pinned = pins.map((p) => p.at);
  /** Sorted and de-duplicated: a `locked` card named in `frozen` too is one
   *  pin, and the order is part of what makes two runs comparable. */
  const pinnedIds = [...new Set(pins.map((p) => p.id))].sort();
  const grid = restrictToConfiguredCourts(buildGrid({ config, existing, pinned }), config.courts, pinned);
  // NO LNS PASS HERE, AND THAT IS DELIBERATE — do not "fix" this by wiring one
  // up. `buildGrid` never reads the fixture list at all: `overCap` is a
  // function of the config, the immovable board and the pins alone. So every
  // window the fallback opened would rebuild the IDENTICAL over-cap lattice,
  // get the same empty `slots` back, and return its own greedy board — the
  // pass is inert here by construction, not merely unhelpful. Rescuing an
  // over-cap board means shrinking the LATTICE, i.e. slicing the horizon per
  // window, which is a design change and out of scope (controller ruling,
  // Task 6). Task 13's bench establishes whether this path is even reachable
  // at the 200-fixture target; if it is, it reopens as a real gap.
  //
  // `not_searched`, NOT `ok`. There is no lattice, so nothing was looked at,
  // and a strip reading "the quick pass produced this board" is the most it can
  // honestly say — never that the board was produced and accepted by a solver.
  if (grid.overCap || grid.slots.length === 0) return greedy("not_searched");

  /**
   * Is the board we already have in hand REPRESENTABLE on the lattice we are
   * about to search?
   *
   * `gridStepMinutes` folds every interval that can displace a start, so a
   * modern config lands on the grid by construction. Two residues survive it and
   * neither is fixable by choosing a better step:
   *
   *   * the `REPAIR_GRID_MINUTES` floor, which clamps an honest gcd of 1 or 2
   *     minutes up to 5;
   *   * an ABSOLUTE anchor — `startWindows.notBefore` at 09:07, a blackout `to`,
   *     an existing booking's `endAt + gap` — which no gcd over DURATIONS can
   *     divide, because the lattice is anchored at the day and the anchor is
   *     not.
   *
   * When the seed is off the lattice the tier ladder degenerates: the first
   * bound it is handed is the incumbent's own metric, the lattice cannot achieve
   * it, the model goes unsat, and every subsequent walk is unsat on its first
   * ask. All four tiers then "complete" having searched nothing, which is
   * indistinguishable — from the outside — from a genuine optimality proof. This
   * is the one bit that tells them apart.
   *
   * Measured on the whole seed and not just its first row: a board can be half
   * on the grid, and half a proof is not a proof.
   *
   * The run continues either way. z3 may still find a board that is strictly
   * better than the seed, and that board IS real (the verifier gate proves it) —
   * what it may not do is claim the SEED could not be beaten.
   */
  const latticeKeys = new Set(grid.slots.map((s) => `${s.court}|${s.startAt}`));
  const seedOffLattice = seedAssignments.some(
    (a) => !latticeKeys.has(`${a.court}|${a.startAt}`),
  );

  // 3. z3. A boot failure is a fallback, never an exception: auto-schedule must
  //    always hand back a board.
  let Z3;
  try {
    ({ Z3 } = await loadZ3());
  } catch {
    return greedy("z3_unavailable");
  }

  const solver = new Z3.Solver();

  // The run budget (R11). A sub-solve INHERITS its caller's — one run, one
  // allowance — and is capped at the slice its caller allotted it; a top-level
  // run opens a fresh one and keeps `1 - BUILD_MAIN_RLIMIT_SHARE` of it back
  // for the fallback.
  runBudget.current = inherited ?? {
    total: rlimit,
    base: rlimitCount(solver),
    spent: 0,
    drawn: 0,
  };
  const budget = runBudget.current;
  const phaseCap =
    inherited === undefined
      // `Math.max(1, ...)` because the floor is 0 for `rlimit <= 1`, and a main
      // phase allotted nothing declines every check while the FALLBACK still
      // gets one — the reserve inverted, and on the exact configuration a
      // budget that small is used to produce.
      ? Math.max(1, Math.floor(rlimit * BUILD_MAIN_RLIMIT_SHARE))
      : rlimit;
  /** This solve's ceiling, expressed in the RUN's units so both caps are one
   *  comparison: it may not push `runBudget.spent` past here, nor past the run
   *  total however generous its own slice was. */
  const phaseLimit = Math.min(budget.spent + phaseCap, budget.total);

  /** The outer cap, refreshed before every check the way `repair.ts` does it —
   *  one `timeout` set once would give the last check the whole budget again. */
  const armTimeout = (): void => {
    solver.set("timeout", Math.max(1, Math.ceil(wallMs - elapsed())));
  };
  /**
   * Arm BOTH caps for exactly one `check()`, and say whether there is a check
   * left to arm. False means the run budget is gone — a normal outcome that
   * leaves the incumbent standing, never an error.
   *
   * The `rlimit` is re-set every time BECAUSE z3 re-arms it every time (see
   * `RunBudget`); handing it the REMAINDER is what turns a per-check allowance
   * into a run total. Never 0 — `rlimit: 0` means UNLIMITED in z3, so an
   * exhausted budget must decline the check rather than describe itself as
   * zero.
   */
  const arm = (): boolean => {
    const room = phaseLimit - budget.spent;
    if (room <= 0) return false;
    solver.set("rlimit", room);
    armTimeout();
    return true;
  };
  /** Charge the run for what the check just cost. MEASURED off z3's counter,
   *  not assumed from the limit: a check that finishes early spends less, and
   *  charging it the whole slice would starve the fallback for nothing. */
  const settle = (): void => {
    // Clamped: a negative delta would make `room` enormous and silently
    // disable the cap altogether. Unreachable today — `withZ3Lock` keeps a
    // context reset out of the middle of a run, and the counter is monotonic
    // — but a budget that fails OPEN is not a failure mode worth leaving to
    // an invariant held somewhere else.
    budget.spent = Math.max(0, rlimitCount(solver) - budget.base);
  };
  armTimeout();

  // R23. The greedy seed, the lattice and the WASM boot are already behind us
  // and they are not free at scale; encoding on top of a wall that has already
  // gone buys a board nobody will be allowed to search.
  if (outOfTime()) return greedy("ok", true);

  const model = encodeBuild({
    Z3,
    solver,
    fixtures,
    grid,
    config: verifyConfig,
    // The same binding `validateAssignments` is handed below. See its comment.
    existing,
    dependencies,
  });

  // R23. THE SINGLE MOST IMPORTANT ONE. `encodeBuild` is the largest
  // uninterruptible step in the run — 3_706 ms at 200 fixtures / 216 slots —
  // and at the sizes where it matters it alone can outlast the whole wall.
  if (outOfTime()) return greedy("ok", true);

  /** `AtLeast` takes a NON-EMPTY tuple, not varargs. `Z3.AtLeast(...lits, k)`
   *  compiles and then fails at runtime with a spread TypeError out of z3's own
   *  internals; `repair.ts:862` spells the same shape correctly. */
  const atLeastPlaced = (k: number): void => {
    const [head, ...rest] = model.placed;
    if (head === undefined) return;
    solver.add(Z3.AtLeast([head, ...rest], k));
  };

  // 4. POLISH freezes the cards an entrant has already been told about. Every
  //    anchor is in `pinned` above, so the lattice is guaranteed to contain it
  //    and `findIndex` cannot come back -1 for a card that has an anchor at all.
  for (const id of frozenIds) {
    const i = fixtures.findIndex((f) => f.id === id);
    const at = publishedSlotOf(id);
    // No anchor at all: greedy could not place it and the caller pinned
    // nothing, so there is no placement to hold it to. Left free rather than
    // pretended-frozen.
    if (i < 0 || at === undefined) continue;
    const s = grid.slots.findIndex((sl) => sl.court === at.court && sl.startAt === at.startAt);
    if (s >= 0) solver.add(model.place[i]![s]!);
  }

  let budgetExpired = false;

  // 5. The infeasibility probe — asked ONLY when something is pinned, and only
  //    while there is budget left to ask in.
  //
  //    Without a pin the model is satisfiable by inspection (the empty board):
  //    every clause `encodeBuild` writes is an at-most, a negation or an
  //    equivalence, and `placed[i]` is free to be false. So the probe could only
  //    ever answer "sat" and would cost a full check for it; at 200 fixtures a
  //    bare `check()` is ~10 s of a 30 s budget. With a pin it is the only way
  //    to tell "two cards pinned onto one slot" from "n cards will not fit",
  //    and those want opposite answers.
  if (pinned.length > 0) {
    if (elapsed() >= wallMs || !arm()) {
      // Never asked, so nothing is established. Reporting `infeasible` from a
      // question we did not get to ask is the same error as reading it off an
      // `unknown` — and that holds whether it was the wall backstop or the run
      // budget that stopped us asking.
      budgetExpired = true;
    } else {
      const probe = await solver.check();
      settle();
      // The pins are the ONLY thing that can make this model unsat (see above),
      // so the proof is about them and the result says so by name.
      if (probe === "unsat") return { ...greedy("infeasible"), contradictoryPins: pinnedIds };
      // `unknown` is exhaustion, not a verdict — the ABSENCE of a proof. Fall
      // through and let the walk below report `budgetExpired` on the greedy
      // incumbent.
      if (probe === "unknown") budgetExpired = true;
    }
  }

  let incumbent: readonly Assignment[] = seedAssignments;
  let incumbentMetrics = seedMetrics;
  let tiersCompleted = 0;
  let checks = 0;
  let improved = false;

  // 6. T0 — maximise the number placed. This is what turns greedy's `no_slot`
  //    GUESS into a proof: UNSAT at `placed >= n` is the proof that n is out of
  //    reach, and SAT is a board that reaches it. Descending from the full
  //    count means the FIRST satisfiable bound is the optimum, by construction.
  for (let target = fixtures.length; target > incumbentMetrics.placed; target--) {
    if (budgetExpired || outOfTime()) {
      budgetExpired = true;
      break;
    }
    solver.push();
    // R23. `push()` is not the bookkeeping no-op it reads as: over the fully
    // encoded model it costs 205 / 2_923 / 9_837 ms at 20 / 90 / 200 fixtures
    // (Task 13 bench, `--probe=encode`). It is a ONE-TIME cost — every push
    // after the first is sub-millisecond — but the first one alone outlasts the
    // production wall at target scale, so the loop-top test above is stale by
    // the time we get here and has to be retaken.
    if (outOfTime()) {
      solver.pop();
      budgetExpired = true;
      break;
    }
    atLeastPlaced(target);
    if (!arm()) {
      solver.pop();
      budgetExpired = true;
      break;
    }
    checks++;
    const verdict = await solver.check();
    settle();
    if (verdict === "sat") {
      const board = model.assignmentsFrom(model.slotOf(solver.model()));
      const metrics = boardMetrics(board, config.courts, fixtures.length);
      solver.pop();
      if (isStrictlyBetter(metrics, incumbentMetrics)) {
        incumbent = board;
        incumbentMetrics = metrics;
        improved = true;
      }
      break;
    }
    solver.pop();
    if (verdict === "unknown") {
      budgetExpired = true;
      break;
    }
  }
  // Freeze the achieved count as a hard bound for every later tier: a tier that
  // shortens the makespan must not buy it by dropping a card.
  //
  // OUTSIDE the loop, not in the `sat` arm. The walk has a second exit — UNSAT
  // at every bound down to the incumbent's own count — and on that path the arm
  // never runs, so a freeze written there leaves `placed` unbounded for exactly
  // the boards greedy already got right.
  atLeastPlaced(incumbentMetrics.placed);

  // T0 completed iff it ran to a verdict rather than to the budget: a SAT at
  // some bound, or UNSAT all the way down to the incumbent's own count.
  //
  // ...or if there was nothing to ask. `target` starts at `fixtures.length`, so
  // a greedy board that already placed every card enters no iteration at all:
  // the maximum is ACHIEVED and proving it costs zero checks. Reading that as
  // "the tier did not finish" is what made a fully-placed board indistinguish-
  // able from one whose budget died before the first check, and it is why
  // `already_optimal` could never fire on the boards it most obviously
  // describes.
  const proved = !budgetExpired && (checks > 0 || incumbentMetrics.placed >= fixtures.length);
  if (proved) tiersCompleted = 1;

  // 6b. Tiers 1-3 — makespan, then worst idle gap, then court imbalance, in
  //     D3's fixed order.
  //
  //     Each is the same descending-bound walk T0 is, in the opposite
  //     direction: T0 descends from `fixtures.length` and so proves its UNSAT
  //     bounds FIRST, one per step, before the single SAT that ends it; these
  //     assert "strictly better than the incumbent", take the board z3 hands
  //     back, and repeat — so the SATs come first and the walk ends on ONE
  //     UNSAT, the expensive proof. The cheap direction is deliberate: every
  //     intermediate board is a real improvement in hand, so a budget that
  //     expires mid-walk still returns something better, which is not true of
  //     an ascending walk.
  //
  //     A tier that completes FREEZES its achieved value as a hard bound, and
  //     that freeze is the whole of what makes the ordering lexicographic
  //     rather than a negotiation: with it, a later tier can only choose among
  //     boards an earlier tier already called optimal.
  //
  //     WHAT THIS LOOKS LIKE TO AN ORGANISER, MEASURED (Task 13 bench, R18
  //     sweep). At the production wall only T0 completes from 20 fixtures up,
  //     so the ONLY metric that improves is `placed`, by +1 — and because
  //     `placed` dominates, the solver will buy that one extra match with
  //     everything below it. Every sweep row from n=20 to n=140 got worse on
  //     the other three: at n=140, makespan 2_120 -> 2_160, worst idle gap
  //     1_400 -> 2_040, court imbalance 40 -> 120.
  //
  //     THIS IS D3 WORKING, NOT A DEFECT. "One more match fits and the day is
  //     longer" is the trade the owner chose when they ranked
  //     placed > makespan > idle > balance, and it was re-affirmed against this
  //     measurement rather than in ignorance of it. Do not "fix" it by
  //     weighting the tiers or by refusing a board that regressed a lower one —
  //     either change silently drops matches an organiser asked to fit, which
  //     is the failure D3 exists to prevent. If the trade is ever revisited it
  //     is a product decision about the ORDERING, made here, not a tweak in a
  //     tier's walk.
  //
  //     NO PER-TIER BUDGET SLICE, deliberately. Splitting the WALL clock (half
  //     the remainder each, say) would make which tier ran a property of the
  //     machine, which is the exact defect D9 exists to prevent — the same run
  //     on a faster box would return a differently-optimised board. Splitting
  //     the `rlimit` is unavailable until Task 13 establishes whether it is a
  //     per-`check()` cap or a run total (it is set once, before the first
  //     check, and nothing here re-reads it). Neither is needed for termination:
  //     each walk is strictly decreasing over a finite set of achievable metric
  //     values, and every individual `check()` is capped by the rlimit, so a
  //     tier cannot spin. The wall clock stays what the header says it is — an
  //     outer cap that should never fire.
  // R23. `buildTiers` is called in the `for...of` HEADER, so its cost — 43_240
  // assertions and 730 ms at 200 fixtures — is paid before the loop-top test
  // below can run even once. A run whose wall has already gone must not pay it.
  if (proved && outOfTime()) budgetExpired = true;
  if (proved && !budgetExpired) {
    for (const tier of buildTiers({ Z3, solver, model, grid, fixtures, config })) {
      if (budgetExpired || outOfTime()) {
        budgetExpired = true;
        break;
      }
      let best = tier.of(incumbentMetrics);
      let settled = false;
      for (;;) {
        // THE METRIC'S FLOOR. All three are non-negative quantities that
        // `boardMetrics` reports as 0 on an empty board, so a bound of -1 ms is
        // not "one better" — it is a question with no answer, and asking it is
        // not free: the makespan and imbalance terms say NOTHING when nothing
        // is placed, so z3 answers SAT off a pair of unconstrained variables,
        // hands back the same board, and the walk would loop on it. At zero the
        // tier is already optimal and there is nothing to prove.
        if (best <= 0) {
          settled = true;
          break;
        }
        if (outOfTime()) {
          budgetExpired = true;
          break;
        }
        solver.push();
        // R23, same reason as T0's: `push()` is where the wall gets overrun.
        // `tier.atMost` is charged here too — the idle-gap family restates
        // 14_400 clauses per bound at 200 fixtures (358 ms), which the makespan
        // and imbalance tiers, at one assertion each, do not.
        if (outOfTime()) {
          solver.pop();
          budgetExpired = true;
          break;
        }
        tier.atMost(best - 1);
        if (!arm()) {
          solver.pop();
          budgetExpired = true;
          break;
        }
        checks++;
        const verdict = await solver.check();
        settle();
        if (verdict !== "sat") {
          solver.pop();
          // UNSAT is the proof that `best` IS the optimum — the walk asked for
          // strictly better and no board exists. `unknown` is the absence of
          // that proof and must never be read as one (see the header).
          if (verdict === "unknown") budgetExpired = true;
          else settled = true;
          break;
        }
        const board = model.assignmentsFrom(model.slotOf(solver.model()));
        const metrics = boardMetrics(board, config.courts, fixtures.length);
        solver.pop();
        const next = tier.of(metrics);
        // Belt and braces. Every earlier tier is frozen and this bound is
        // strict, so a SAT board is lexicographically better by construction;
        // if it ever is not, the term and the metric have drifted apart and the
        // right move is to keep the incumbent and stop counting tiers, not to
        // accept a board D3 ranks below the one in hand.
        if (next >= best || !isStrictlyBetter(metrics, incumbentMetrics)) break;
        incumbent = board;
        incumbentMetrics = metrics;
        improved = true;
        best = next;
      }
      if (!settled) break;
      tier.atMost(tier.of(incumbentMetrics));
      tiersCompleted++;
    }
  }

  // 6c. LNS — the fallback for a run that did not finish (design D7's "C"
  //     half). See `build-lns.ts` for what a window is and why it is neither
  //     `repairSchedule` nor an `existing`-shaped sub-board.
  //
  //     THE TRIGGER IS `tiersCompleted < TIER_COUNT`, not `budgetExpired`.
  //     Those are different questions: a tier can exit without ever setting
  //     `budgetExpired` (a term and its metric drifting apart breaks the walk
  //     on the spot), and `tiersCompleted === TIER_COUNT` is the ONLY thing
  //     that means "every tier ran to a verdict" — the same predicate
  //     `already_optimal` keys on below. A board that is not lexicographically
  //     proven is a board windows may still improve.
  //
  //     THE WINDOWS SPEND THE SAME RUN BUDGET THE TIERS DID (R11). Each one is
  //     allotted an equal share of WHAT IS LEFT, divided by the windows still
  //     to come — so a window that finishes cheaply leaves the surplus to its
  //     successors, and the last one may have the whole remainder. Derived from
  //     the budget and the window plan only, never from elapsed time, so two
  //     runs on identical input still open identical windows at identical
  //     allowances on any machine.
  //
  //     Running out is a NORMAL outcome: the pass stops launching windows and
  //     the incumbent stands. The result is taken only if the WHOLE board
  //     improved, so this can never make the answer worse — the same guarantee
  //     the greedy seed gives, and the reason it needs no escape hatch either.
  let usedLns = false;
  // Close the MAIN phase's account. It is charged its SHARE, never its
  // overshoot — see `RunBudget.drawn`. Without that the fallback is unreachable
  // by construction: the tiers only fall short when their last check overran,
  // and that overrun is reliably bigger than the whole reserve.
  //
  // ONLY AT THE TOP LEVEL. `drawn` is a RUN-WIDE running total and `phaseCap`
  // in an inherited solve is that one window's allotment, so an unguarded
  // assignment lets every window reset the run's account down to its own small
  // slice: `left` and `allot` inflate from window 1 onward and `hasBudget()`
  // can never fire, which is exactly the equal-share re-levelling the window
  // loop below claims to do. Measured at rlimit 200_000: window 1 allotted
  // 83_334 against a correct share of 16_667.
  if (inherited === undefined) budget.drawn = Math.min(budget.spent, phaseCap);
  if (allowLns && tiersCompleted < TIER_COUNT && elapsed() < wallMs && budget.drawn < budget.total) {
    const solveWindow = async (w: LnsWindow): Promise<readonly Assignment[]> => {
      const left = budget.total - budget.drawn;
      const drawnBefore = budget.spent;
      const allot = Math.max(1, Math.floor(left / (w.of - w.index)));
      lnsWindowRlimits.push(allot);
      const sub = await solveBuild(
        {
          fixtures: w.fixtures,
          config,
          // The caller's immovables only. Everything else is a pinned FIXTURE
          // in `w.fixtures`, which is what keeps the sub-solve's metrics the
          // whole board's metrics.
          existing: w.existing,
          dependencies,
          // This window's slice. `w.of - w.index` is how many windows are still
          // to come, this one included, so the division re-levels after every
          // over- or under-spend rather than committing the whole plan up front
          // to a split the first window has already invalidated.
          rlimit: allot,
          wallMs: Math.max(1, wallMs - elapsed()),
        },
        false,
        budget,
      );
      // Same rule as the main phase: a window is charged what it was allotted,
      // not what its last check overran to, so one window cannot swallow the
      // windows after it.
      budget.drawn += Math.min(budget.spent - drawnBefore, allot);
      return sub.assignments;
    };
    const out = await improveByWindows({
      board: incumbent,
      fixtures,
      existing,
      // `frozen` only. A caller-`locked` fixture needs no help from the window
      // plan: it carries its pin into every sub-solve on its own fixture record
      // and `encodeBuild` §4 asserts it as a unit clause.
      frozen: new Set(frozenIds),
      courts: config.courts,
      total: fixtures.length,
      deadlineMs: wallMs,
      elapsed,
      hasBudget: () => budget.drawn < budget.total,
      solveWindow,
    });
    if (isStrictlyBetter(out.metrics, incumbentMetrics)) {
      incumbent = out.board;
      incumbentMetrics = out.metrics;
      // DEFENSIVE, and inert as the guard above is written: `already_optimal`
      // needs `tiersCompleted === TIER_COUNT`, which this arm excludes. Kept
      // because the day somebody lets the fallback run on a fully-proved board,
      // an LNS improvement reported as `already_optimal` is a lie about a proof
      // — and the failure would be silent.
      improved = true;
      // NOT ASSERTED ANYWHERE, and deliberately so rather than by oversight.
      // `engine: "z3+lns"` needs a run where the fallback both RUNS and wins,
      // and those two do not currently overlap: the pass only runs when the
      // tiers fall short, and at every budget where they do, T0 has already
      // reached a board no LEGAL board beats — so a stub that "improved" on it
      // would be refused by the verifier gate, and asserting on one would be
      // asserting on the stub. If Task 13's bench finds a real improving board,
      // the assertion belongs there.
      usedLns = true;
    }
  }

  // 7. The gate. Encoder and verifier disagreeing is the exact bug class this
  //    design exists to prevent, so it is never silent — but it is also never
  //    an exception, because the organiser still needs a board, and it is a
  //    DELTA rather than an absolute test (see `rejectedBlockingConflicts`).
  //
  //    `repair.ts` throws `RepairVerificationError` in the analogous place and
  //    this deliberately does not, so the loudness has to come from somewhere.
  const conflicts = conflictsForBoard(incumbent, proved);
  const ours = new Set(incumbent.map((a) => a.fixtureId));
  const rejected = rejectedBlockingConflicts(rawSeedConflicts, conflicts, ours);
  if (rejected.length > 0) {
    // The one place this library prints. The caller is handed a VALID board and
    // a status field they may never read, so an encoder/verifier fork would
    // otherwise reach nobody until an organiser filed a ticket about it.
    // eslint-disable-next-line no-console
    console.error(
      `buildSchedule: verifier rejected the solver's board (${rejected
        .map((c) => `${c.fixtureId}:${c.reason}`)
        .join(", ")}) — falling back to the greedy seed`,
    );
    return { ...greedy("verifier_rejected", budgetExpired), tiersCompleted };
  }

  const moved = movedFrom(incumbent);
  const lost = lostFrom(incumbent);

  // `already_optimal` needs BOTH halves: every tier ran to a verdict, and
  // nothing to show for it. Without the first it would claim a proof on a board
  // nobody looked at; without the second it would fire on a board that was just
  // improved. It is ALL FOUR tiers, not just T0 — "greedy already placed every
  // card" is not a statement about the makespan, and a board that could still
  // be made shorter is not optimal in any sense an organiser would accept.
  //
  // AND IT NEEDS A THIRD THING: a lattice the incumbent is actually ON. A
  // completed ladder over a lattice that cannot express the board being called
  // optimal is not a weaker proof, it is no proof at all — every walk was unsat
  // on its first ask because the tier freeze itself is unachievable there. That
  // case reports `not_searched`, which says the true thing.
  //
  // `infeasible` is unaffected and deliberately tested first: it needs
  // `placed === 0`, and a seed that placed nothing has no row to be off the
  // lattice, so the two can never compete for the same run.
  let status: BuildStatus = "ok";
  if (tiersCompleted === TIER_COUNT && !improved) {
    status =
      incumbentMetrics.placed === 0 && fixtures.length > 0
        ? "infeasible"
        : seedOffLattice
          ? "not_searched"
          : "already_optimal";
  }

  return {
    assignments: incumbent,
    conflicts,
    metrics: incumbentMetrics,
    // Where the board CAME FROM. `z3+lns` is claimed only when a window pass
    // actually produced the board being returned — an LNS pass that ran and
    // improved nothing leaves the tiers' own answer in place, and saying
    // otherwise would attribute the board to the wrong solver.
    engine: usedLns ? "z3+lns" : incumbent === seedAssignments ? "greedy" : "z3",
    status,
    tiersCompleted,
    budgetExpired,
    elapsedMs: elapsed(),
    moved,
    lost,
    rlimitSpent: budget.spent,
    lnsWindowRlimits,
  };
}

/**
 * The lattice, minus every slot on a court the organiser did not configure (R3).
 *
 * `buildGrid` takes its court list from `repairCourts`, which folds in every
 * court an `existing` row uses. That is right for a REPAIR — a card already
 * sitting on court 5 may stay on court 5 — and wrong for a BUILD, which would
 * otherwise place brand-new fixtures onto a court that exists only because some
 * other division borrowed it. The verifier never tests court membership, so
 * nothing here was ever reported; it is a product ruling, not a parity fix.
 *
 * Applied as a post-filter rather than by narrowing what `buildGrid` generates,
 * because `repairCourts` has no knob and `build-grid.ts` is shared with the
 * repair solver. Slot ORDER is preserved, which matters: `buildGrid` sorts by
 * (court, startAt) and the encoder names its variables by slot INDEX, so a
 * filter that reordered would silently rename every variable.
 *
 * PINNED SLOTS ARE EXEMPT. A card the caller locked onto an unlisted court must
 * still be representable — `encodeBuild` §4 throws outright when a locked
 * placement is missing from the lattice, and short of that the run would report
 * a contradiction the organiser never expressed.
 *
 * `overCap` is carried through unchanged, and deliberately not recomputed: it
 * was decided against the UNFILTERED lattice, so a board whose extra courts
 * pushed it over `MAX_SLOTS` still goes to greedy even though the filtered
 * lattice would have fitted. Conservative in the safe direction, and the cap is
 * two orders of magnitude away from any real board.
 */
function restrictToConfiguredCourts(
  grid: BuildGrid,
  courts: readonly string[],
  pinned: readonly BuildSlot[],
): BuildGrid {
  const allowed = new Set(courts);
  const key = (s: BuildSlot): string => `${s.court}|${s.startAt}`;
  const exempt = new Set(pinned.map(key));
  const slots = grid.slots.filter((s) => allowed.has(s.court) || exempt.has(key(s)));
  if (slots.length === grid.slots.length) return grid;
  const byCourt = new Map<string, number[]>();
  slots.forEach((s, i) => {
    const rows = byCourt.get(s.court);
    if (rows === undefined) byCourt.set(s.court, [i]);
    else rows.push(i);
  });
  return { slots, byCourt, stepMinutes: grid.stepMinutes, overCap: grid.overCap };
}

// --- the three lexicographic tiers ------------------------------------------

export interface Tier {
  name: string;
  /**
   * The metric this tier minimises, in WHOLE MILLISECONDS.
   *
   * `boardMetrics` reports MINUTES, as floats: `(hi - lo) / 60_000` for the
   * makespan and a sum of such quotients for each court's load. Every bound
   * asserted below is a z3 integer, so the two are compared in the unit the
   * underlying quantities actually are — milliseconds — and the float is
   * converted back with `Math.round`, which is exact for any value that came
   * from dividing an integer number of milliseconds by 60_000. Flooring would
   * round a 30-second idle gap down to zero and freeze a bound the incumbent
   * does not meet, which is the one failure mode that would make a later tier
   * unsatisfiable against the board in hand.
   */
  of: (m: BoardMetrics) => number;
  /**
   * Assert "this metric is at most `boundMs`" into the solver's CURRENT scope.
   *
   * Called under `push`/`pop` while the tier walks, and once at the top level to
   * freeze what it achieved. A function rather than an `Arith` term because only
   * two of the three ARE terms: the idle gap is a clause family whose shape
   * depends on the bound, and pretending otherwise would mean an integer
   * variable per participant pair and the arithmetic encoding this whole design
   * exists to avoid.
   */
  atMost: (boundMs: number) => void;
}

export interface TierInput {
  Z3: Z3Context["Z3"];
  solver: Solver<"repair">;
  model: EncodedModel;
  grid: BuildGrid;
  fixtures: readonly SchedulableFixture[];
  config: SlotConfig & { courts: string[] };
}

/**
 * Builds all three tiers, and every assertion they SHARE, exactly once.
 *
 * Called before the tier loop rather than lazily per tier, because two of the
 * three define themselves through assertions (`lo <= start` and friends) and an
 * assertion added inside a `push` would vanish at the matching `pop` — the tier
 * would then "optimise" a variable nothing constrains and report a bound no
 * board meets. Every definition here is an IMPLICATION off a placement literal,
 * so none of it changes which boards are legal.
 *
 * EXPORTED for `scripts/bench-build.ts` only (Task 13, question Q8: how big is
 * the idle-gap clause family at target scale, and which tier dominates). The
 * size of a tier's encoding is invisible from `BuildResult` — every symptom of
 * an expensive tier washes out into "the run stopped early", which is also what
 * a cheap tier under a small budget looks like — so measuring it means stating a
 * bound against a real encoded model and counting the assertions. The
 * alternative was for the bench to restate the clause shapes itself, which is a
 * placer/verifier fork in a new costume. No production caller outside this file.
 */
export function buildTiers(input: TierInput): Tier[] {
  const { Z3, solver, model, grid, fixtures, config } = input;
  const slots = grid.slots;
  const durMs = config.matchMinutes * MS_PER_MIN;

  /** "Some fixture sits in slot s". The same abstraction `build-encode.ts`
   *  uses and exact for the same reason: its §2 says a slot holds at most one
   *  fixture, so an occupancy literal cannot count to two. */
  const occAny = slots.map((_sl, s) => {
    const o = Z3.Bool.const(`m_occ_${s}`);
    solver.add(o.eq(Z3.Or(...fixtures.map((_f, i) => model.place[i]![s]!))));
    return o;
  });

  // --- T1: makespan ---------------------------------------------------------
  //
  // `boardMetrics` reports `maxEnd - minStart` over the PLACED rows, and every
  // row a build produces is exactly `matchMinutes` long, so both ends are known
  // statically per slot. Two free integers squeezed onto the real extremes: the
  // implications force `lo <= every occupied start` and `hi >= every occupied
  // end`, hence `hi - lo >= maxEnd - minStart`, and setting them to the extremes
  // themselves is always available — so `hi - lo <= B` holds for exactly the
  // boards whose true makespan is at most B. Nothing pins them on an empty
  // board, which is why the walk never asks below zero.
  const mkLo = Z3.Int.const("mk_lo");
  const mkHi = Z3.Int.const("mk_hi");
  slots.forEach((sl, s) => {
    solver.add(
      Z3.Implies(occAny[s]!, Z3.And(mkLo.le(sl.startAt), mkHi.ge(sl.startAt + durMs))),
    );
  });
  const makespan = mkHi.sub(mkLo);

  // --- T3: court imbalance --------------------------------------------------
  //
  // `boardMetrics` measures the busiest configured-or-used court minus the
  // quietest, so the court SET it divides by is `config.courts` plus whatever
  // courts the board actually used — a configured court nobody plays on counts
  // as a zero (that is the point of the metric), while an UNconfigured court
  // nobody plays on is not in the set at all.
  //
  // THE SECOND HALF OF THAT SENTENCE IS UNREACHABLE HERE, and the bound is
  // unconditional because of it. Under R3 the only slots left on an
  // unconfigured court are exact matches for a PIN (`restrictToConfiguredCourts`
  // deletes the rest), and every pin is force-asserted true — `encodeBuild` §4
  // for a `locked` fixture, the frozen-anchor loop above for the other source.
  // So an unconfigured court in `grid.byCourt` provably carries load, it is
  // provably in `boardMetrics`' court set, and `lo <= load` is exactly right
  // for it. An earlier draft guarded this with `Implies(load >= 1, ...)`; that
  // guard was not merely untested but DEAD, since its antecedent holds for
  // every reachable input, and a dead guard reads as a case somebody once saw.
  //
  // THAT ARGUMENT WAS BRIEFLY UNSOUND, which is worth recording: the pin builder
  // resolved a `frozen` id through `current` without checking it named a fixture
  // in this run, while the force loop skipped exactly those ids. Such a pin
  // bought a lattice slot nothing could be forced onto — an unconfigured court
  // carrying no load — and this line then pulled the minimum to zero and had T3
  // chase an imbalance the board did not have. `ownFixture` above restores the
  // premise: every pin names a card of this run's, so every pin is forced.
  //
  // (If an unforced pin source is ever added — a pin the solver may decline —
  // this is the line that has to come back, because a court in the lattice with
  // nothing on it would then pull the minimum to zero and report an imbalance
  // the board does not have.)
  const cbLo = Z3.Int.const("cb_lo");
  const cbHi = Z3.Int.const("cb_hi");
  const loadOf = (rowsOnCourt: readonly number[]): Arith<"repair"> =>
    Z3.Sum(
      Z3.Int.val(0),
      ...rowsOnCourt.map((s) => Z3.If(occAny[s]!, Z3.Int.val(durMs), Z3.Int.val(0))),
    );
  for (const rowsOnCourt of grid.byCourt.values()) {
    const load = loadOf(rowsOnCourt);
    solver.add(cbHi.ge(load));
    solver.add(cbLo.le(load));
  }
  // A configured court with no slots at all — blacked out, or outside every
  // session window. `boardMetrics` still seeds it at zero, so it still pulls the
  // minimum down, and leaving it out would understate the imbalance.
  for (const court of config.courts) {
    if (grid.byCourt.has(court)) continue;
    solver.add(cbHi.ge(0));
    solver.add(cbLo.le(0));
  }
  const imbalance = cbHi.sub(cbLo);

  // --- T2: worst idle gap ---------------------------------------------------
  //
  // The one metric with no honest term. `boardMetrics` takes, per participant
  // with two or more rows, the largest wait between CONSECUTIVE matches — and
  // "consecutive" is not a static property of a slot pair, it depends on which
  // other slots that participant occupies. Written as arithmetic it needs an
  // integer per participant pair and an ordering between them, which is the
  // O(n^2) encoding `build-encode.ts` exists to avoid.
  //
  // Stated as a BOUND it collapses. Every row is `matchMinutes` long, so a gap
  // of at most B is the same statement as consecutive STARTS at most
  // `W = B + matchMinutes` apart, and that is a clause family:
  //
  //     for each participant p and each start index k, with j the first start
  //     beyond starts[k] + W:      ~occ[k] \/ ~tail[j] \/ (p occupies something
  //                                in (starts[k], starts[k] + W])
  //
  // where `occ[k]` is "p occupies start k" and `tail[j]` is "p occupies some
  // start >= starts[j]". Both directions hold, which is the only thing that
  // makes the bound the metric rather than an approximation of it:
  //
  //   * SOUND. A violated clause means p occupies starts[k], occupies something
  //     beyond starts[k] + W, and occupies nothing in between — so the SUCCESSOR
  //     of starts[k] is more than W away and the real gap really does exceed B.
  //     Nothing legal is refused.
  //   * COMPLETE. If two consecutive occupied starts a < b are more than W
  //     apart, the clause at k = index(a) is violated: `occ[k]` holds, `tail[j]`
  //     holds because b lies beyond starts[k] + W, and the window between them
  //     is empty precisely because a and b are consecutive.
  //
  // (An earlier draft anchored the first literal on "p occupies some start <=
  // starts[k]" instead. It is equivalent — completeness is already argued at
  // k = index(a), where the two agree — so the extra prefix chain bought
  // nothing and is gone.)
  //
  // Cost is one clause per (participant, start) of length |window|, and only
  // participants with two or more fixtures are built at all — everyone else
  // contributes 0 to the metric by definition and would be pure encoding.
  // `tail` is a chain, so it is O(|starts|) and, unlike the clauses,
  // bound-independent, which is what lets the walk re-state only the clauses.
  const starts = [...new Set(slots.map((s) => s.startAt))].sort((a, b) => a - b);
  const slotsAtStart = starts.map((t) =>
    slots.flatMap((sl, s) => (sl.startAt === t ? [s] : [])),
  );
  /** Fixture indexes per participant, namespaced exactly as `boardMetrics` and
   *  `build-encode.ts` namespace them so an entrant id can never collide with a
   *  person id. */
  const byParticipant = new Map<string, number[]>();
  fixtures.forEach((f, i) => {
    for (const p of new Set([
      ...[f.home, f.away].filter((e): e is string => e !== undefined).map((e) => `e:${e}`),
      ...(f.people ?? []).map((p) => `p:${p}`),
    ])) {
      const rows = byParticipant.get(p);
      if (rows === undefined) byParticipant.set(p, [i]);
      else rows.push(i);
    }
  });

  let gapGroups = 0;
  const gapParticipants = [...byParticipant.values()]
    .filter((group) => group.length >= 2)
    .map((group) => {
      const g = gapGroups++;
      const occ = starts.map((_t, k) => {
        const o = Z3.Bool.const(`gp_${g}_${k}`);
        solver.add(
          o.eq(Z3.Or(...group.flatMap((i) => slotsAtStart[k]!.map((s) => model.place[i]![s]!)))),
        );
        return o;
      });
      const tail: Bool<"repair">[] = new Array<Bool<"repair">>(occ.length);
      for (let k = occ.length - 1; k >= 0; k--) {
        if (k === occ.length - 1) {
          tail[k] = occ[k]!;
          continue;
        }
        const v = Z3.Bool.const(`gt_${g}_${k}`);
        solver.add(v.eq(Z3.Or(occ[k]!, tail[k + 1]!)));
        tail[k] = v;
      }
      return { occ, tail };
    });

  const assertGapAtMost = (boundMs: number): void => {
    const width = boundMs + durMs;
    for (const p of gapParticipants) {
      for (let k = 0; k < starts.length; k++) {
        let j = k + 1;
        while (j < starts.length && starts[j]! <= starts[k]! + width) j++;
        // Nothing lies beyond the window, so no start can be stranded past it —
        // and `starts[k]` only grows, so neither can any later k.
        if (j >= starts.length) break;
        const between: Bool<"repair">[] = [];
        for (let i = k + 1; i < j; i++) between.push(p.occ[i]!);
        solver.add(Z3.Or(Z3.Not(p.occ[k]!), Z3.Not(p.tail[j]!), ...between));
      }
    }
  };

  const ms = (minutes: number): number => Math.round(minutes * MS_PER_MIN);
  return [
    {
      name: "makespan",
      of: (m) => ms(m.makespanMinutes),
      atMost: (boundMs) => solver.add(makespan.le(boundMs)),
    },
    {
      name: "idleGap",
      of: (m) => ms(m.worstIdleGapMinutes),
      atMost: assertGapAtMost,
    },
    {
      name: "imbalance",
      of: (m) => ms(m.courtImbalanceMinutes),
      atMost: (boundMs) => solver.add(imbalance.le(boundMs)),
    },
  ];
}
