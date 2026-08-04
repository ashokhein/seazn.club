// Decomposed repair (#401).
//
// #401 locks "no fixture-count gate — solve the full 500-movable range", and the
// single-solve encoder cannot honour it. Measured: the bare feasibility probe,
// `check(REPAIR_FAMILIES)` with no `AtMost` bound, does not return in 119 s from
// about 80 movable up, at either conflict density; a bigger budget bought
// nothing at 120, 250 or 500. The board is not slow, it is unreachable.
//
// What IS reachable is one component at a time.
//
//   * NOT a partition of `candidatePairs`. That graph is COMPLETE — 124,750 of
//     124,750 pairs at n=500, one component, every size and density — because
//     `span` is blocking-only and the pack window is the only per-fixture
//     blocking interval, so any two cards can be moved onto one court.
//     Partitioning it is a measured dead end.
//   * FREEZE AND COMMIT SEQUENTIALLY. Build the graph over CURRENT PLACEMENTS —
//     same court, or a shared participant, within the separation the pair could
//     owe, plus every order dependency — solve ONE component with the entire
//     rest of the board frozen into `existing`, commit the result, move to the
//     next.
//
// Measured by `scripts/bench-decompose.ts` at a 20 s per-component budget, one
// child process per case, against a single solve that does not return in 119 s
// at any of these sizes:
//
//   | n   | 1-in | comps | max | total ms | k   | lower bound | verdict | after |
//   | 120 |   20 |     9 |  31 |    4 651 |   6 |           6 | proved  |     0 |
//   | 120 |    5 |    10 |  37 |   10 320 |  24 |          24 | proved  |     0 |
//   | 250 |   20 |    25 |  31 |   10 155 |  12 |          12 | proved  |     0 |
//   | 250 |    5 |    23 |  38 |   37 740 |  50 |          50 | proved  |     0 |
//   | 500 |   20 |    46 |  36 |   33 778 |  25 |          25 | proved  |     0 |
//   | 500 |    5 |    40 |  39 |  129 821 | 100 |         100 | proved  |     0 |
//
// Every row verifier-clean, every `k` equal to the clashes the generator
// injected AND to an independently computed lower bound, zero components
// skipped, zero WASM aborts in six runs. Peak RSS 623 MB at 500 light, 899 MB
// at 500 dense. The graph itself costs 1-2 ms.
//
// Freezing is what makes this sound. The frozen cards go in as `existing`, so
// `repairSchedule` constrains every moved card against all of them — a
// component's repair can no more collide with another component than with an
// outside booking. The graph therefore decides QUALITY (how few moves), never
// legality. The one place it decides more than that is `max_fixtures_per_day`,
// which counts across the whole board; see `dayCapGuard` below.
//
// Two properties this file owes its callers:
//
//   1. ANYTIME. Each component commits independently, so a budget that runs out
//      halfway yields a PARTLY repaired board rather than nothing — and the
//      partial board is put through the real verifier before it is returned. A
//      partial repair the verifier rejects is a bug, not a degraded success.
//   2. HONEST MINIMALITY. Restricting which fixtures may move can only RAISE the
//      number of moves, so a decomposed answer is an UPPER BOUND by
//      construction. It is reported as minimal only when a certificate proves it
//      — see `repair-minimality.ts`.
import {
  effectiveHard,
  isBlockingConflict,
  validateAssignments,
  type Assignment,
  type Conflict,
  type OrderDependency,
  type VerifyConfig,
} from "./calendar.ts";
import {
  maxSeparationMinutes,
  sharesParticipant,
  sortFamilies,
  type RepairFamily,
} from "./repair-domain.ts";
import { disjointConflictBound, type MinimalityWitness } from "./repair-minimality.ts";
import {
  repairSchedule,
  RepairVerificationError,
  type RepairInput,
  type RepairResult,
} from "./repair.ts";
import { resetZ3 } from "./z3-load.ts";

const MS_PER_MIN = 60_000;

/**
 * The largest component this solver will attempt, in movable fixtures.
 *
 * Read off the measured single-solve curve at the per-component sizes that
 * actually occur — 40 movable 8.2 s, 50 movable 8.8 s, 60 movable 43.8 s, 70
 * movable 68.9 s, 80 movable never returns — with a measured 1.5-2× on top for
 * the ~465 frozen cards a component of a 500-board carries. 50 is the last size
 * that finishes in single-digit seconds on both densities.
 *
 * This is NOT the fixture-count gate #401 forbids. It fires on the busiest DAY,
 * never on the size of the board: a component cannot span two days, because the
 * overnight gap exceeds every rest a pair can owe. Measured component sizes at
 * n=500 are 36 (light) and 39 (dense) across 46 and 40 components, so a
 * production board of any size passes it and a one-court venue — 16 to 20 cards
 * a day — passes it with room. What it catches is the pathological wide day, and
 * for that the honest answer is to hand the component to LLM repair and SAY SO,
 * rather than burn the whole call's budget proving nothing.
 */
export const COMPONENT_MOVABLE_LIMIT = 50;

/**
 * Wall-clock ceiling on ONE component's solve. Deliberately its own number
 * rather than a reuse of `DEFAULT_REPAIR_BUDGET_MS`: that constant was measured
 * as the budget for a WHOLE call and is quoted as such at its definition, and
 * two meanings on one constant is how a budget silently changes when somebody
 * retunes the other one. It happens to carry the same value, for the same
 * measurement — a component is exactly the "one board the solver can reach"
 * that number was set from.
 */
export const DEFAULT_COMPONENT_BUDGET_MS = 20_000;

/**
 * Wall-clock ceiling on a whole decomposed call.
 *
 * A TERMINATION bound, not a latency target. The measured end-to-end worst case
 * is 129.8 s (500 movable, 1-in-5 clashes, 40 components at a 20 s per-component
 * budget); this is that number with headroom for a production host slower than
 * the bench machine. Any caller on an HTTP path must pass its own `budgetMs` —
 * the anytime property means a smaller budget returns a PARTLY repaired board,
 * which is a strictly better answer than the nothing a single solve returns.
 */
export const DEFAULT_DECOMPOSED_BUDGET_MS = 240_000;

/** One island of the current-placement interaction graph. */
export interface RepairComponent {
  /** Position in solve order. Deterministic: components are ordered by their
   *  smallest fixture id, so the same board always solves in the same order. */
  index: number;
  /** Sorted, so nothing downstream depends on Map or Set iteration order. */
  fixtureIds: readonly string[];
}

export interface RepairComponentInput {
  proposal: readonly Assignment[];
  dependencies?: readonly OrderDependency[];
  config: VerifyConfig;
}

/** Why a component was not solved. */
export type ComponentSkipReason = "over_component_limit" | "budget_exhausted";

export type ComponentOutcome = "clean" | "repaired" | "timeout" | "infeasible" | "skipped";

/** What one component cost and what it bought. `skipped` components carry the
 *  reason, which is what makes "this board was only partly repaired, and here is
 *  the part the solver declined" a machine-readable fact rather than a
 *  guess the caller has to make from a total. */
export interface RepairComponentReport {
  index: number;
  size: number;
  /** Cards frozen into `existing` for this component's solve — the caller's own
   *  immovables plus every other component at its current placement. */
  frozen: number;
  fixtureIds: readonly string[];
  outcome: ComponentOutcome;
  skipReason?: ComponentSkipReason;
  k: number;
  moved: readonly string[];
  checks: number;
  elapsedMs: number;
  relaxed: readonly RepairFamily[];
  /** Families the solver named when the component came back `infeasible`. */
  infeasibleFamilies?: readonly RepairFamily[];
}

export type MinimalityVerdict = "proved" | "upper_bound";

/**
 * Why a `k` is or is not provably the fewest possible moves.
 *
 * The search alone proves nothing global: each component is solved with the rest
 * of the board frozen, and restricting which fixtures may move can only raise
 * the answer. So `k` is an upper bound unless a LOWER bound meets it — an
 * independent set of conflicts whose fixtures do not overlap, each of which
 * needs at least one move of its own. See `repair-minimality.ts`.
 */
export interface MinimalityCertificate {
  verdict: MinimalityVerdict;
  k: number;
  lowerBound: number;
  witnesses: readonly MinimalityWitness[];
  caveats: readonly MinimalityCaveat[];
}

export type MinimalityCaveat =
  /** A per-day cap couples components: solving A first can fill a day B then
   *  cannot use, so the answer is sound but order-dependent. */
  | "day_cap_order_dependent"
  /** Some component was skipped, timed out or came back infeasible, so the board
   *  is not fully repaired and `k` is not a repair of it. */
  | "components_unresolved"
  /** Some component dropped relaxable families to find any answer at all. */
  | "families_relaxed";

export type DecomposedRepairStatus = "clean" | "repaired" | "partial" | "unrepaired";

/** Whether the board was split at all. `whole_board` is the day-cap guard
 *  declining to decompose — today's single-solve behaviour, exactly. */
export type DecompositionMode = "components" | "whole_board";

export type DecompositionModeReason = "day_cap_unindexed_fixtures";

export interface DecomposedRepairInput extends RepairInput {
  /** Default `COMPONENT_MOVABLE_LIMIT`. */
  componentLimit?: number;
  /** Default `DEFAULT_COMPONENT_BUDGET_MS`. */
  componentBudgetMs?: number;
  /** Fires once per component, in solve order, AFTER the component's z3 context
   *  has been torn down — so a caller may assert `z3LoadCount() === 0` here. */
  onComponent?: (report: RepairComponentReport) => void;
}

export interface DecomposedRepairResult {
  status: DecomposedRepairStatus;
  assignments: readonly Assignment[];
  /** Sorted fixture ids. */
  moved: readonly string[];
  k: number;
  elapsedMs: number;
  checks: number;
  /** Union across components, in `REPAIR_FAMILIES` order. */
  relaxed: readonly RepairFamily[];
  components: readonly RepairComponentReport[];
  /** Every fixture in a component this call did not resolve — skipped, timed
   *  out or infeasible — sorted. Exactly the set to hand to LLM repair, so the
   *  caller reads one field instead of reconstructing it from outcomes. */
  unresolvedFixtureIds: readonly string[];
  minimality: MinimalityCertificate;
  mode: DecompositionMode;
  modeReason?: DecompositionModeReason;
  /** Conflicts the board still carries. Empty on `clean`, and on `repaired`
   *  unless a component relaxed families — a relaxed answer is allowed to leave
   *  NON-blocking conflicts behind, and says which families it dropped. Anything
   *  here is either inside a component this call did not resolve, or inside one
   *  that relaxed; a blocking conflict anywhere else throws instead of
   *  returning. */
  residual: readonly Conflict[];
}

// --- the graph --------------------------------------------------------------

class DisjointSet {
  private readonly parent: number[];
  constructor(n: number) {
    this.parent = Array.from({ length: n }, (_, i) => i);
  }
  find(x: number): number {
    let r = x;
    while (this.parent[r]! !== r) {
      this.parent[r] = this.parent[this.parent[r]!]!;
      r = this.parent[r]!;
    }
    return r;
  }
  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent[ra] = rb;
  }
}

/**
 * The islands of the CURRENT-PLACEMENT interaction graph.
 *
 * An edge means "these two cards could constrain each other where they stand":
 * they are on one court, or they share an entrant or a person, and they sit
 * within the separation such a pair could owe — plus an edge for every order
 * dependency, which reaches however far apart the two ends are.
 *
 * The separation comes from `maxSeparationMinutes(config)`, the same upper bound
 * `candidatePairs` prunes on, so a pair that never overlaps but still owes 45
 * minutes' rest keeps its edge. Testing bare occupancy overlap would cut it, and
 * the two halves would then be solved apart from one another — each free to
 * place a card the other's rest rule forbids.
 *
 * Order is a function of the input alone: fixtures sorted by id, components
 * ordered by their smallest id. No Map or Set iteration order reaches the answer.
 */
export function repairComponents(input: RepairComponentInput): RepairComponent[] {
  const ordered = [...input.proposal].sort((a, b) =>
    a.fixtureId < b.fixtureId ? -1 : a.fixtureId > b.fixtureId ? 1 : 0,
  );
  const n = ordered.length;
  const dsu = new DisjointSet(n);
  const indexById = new Map(ordered.map((a, i) => [a.fixtureId, i]));
  const slackMs = maxSeparationMinutes(input.config) * MS_PER_MIN;

  // Time-sorted sweep rather than the full O(n²): at 500 movable the quadratic
  // walk is 125k participant comparisons, and the whole point of this file is
  // that the prologue must not become the new cost.
  const byTime = [...ordered.keys()].sort(
    (i, j) =>
      ordered[i]!.startAt - ordered[j]!.startAt ||
      (ordered[i]!.fixtureId < ordered[j]!.fixtureId ? -1 : 1),
  );
  for (let x = 0; x < byTime.length; x++) {
    const i = byTime[x]!;
    const a = ordered[i]!;
    for (let y = x + 1; y < byTime.length; y++) {
      const j = byTime[y]!;
      const b = ordered[j]!;
      // `byTime` is ascending, so once one start is out of reach every later one
      // is too. The other half of the overlap test is implied by the sort.
      if (b.startAt >= a.endAt + slackMs) break;
      if (a.court === b.court || sharesParticipant(a, b)) dsu.union(i, j);
    }
  }
  for (const dep of input.dependencies ?? []) {
    const i = indexById.get(dep.fixtureId);
    const j = indexById.get(dep.dependsOn);
    if (i !== undefined && j !== undefined) dsu.union(i, j);
  }

  const groups = new Map<number, string[]>();
  for (let i = 0; i < n; i++) {
    const root = dsu.find(i);
    const g = groups.get(root);
    if (g === undefined) groups.set(root, [ordered[i]!.fixtureId]);
    else g.push(ordered[i]!.fixtureId);
  }
  // `ordered` is id-sorted and walked in order, so each group is already sorted
  // and the groups come out in smallest-id order. Sorted again explicitly rather
  // than relying on that: the order is part of the contract.
  return [...groups.values()]
    .sort((a, b) => (a[0]! < b[0]! ? -1 : a[0]! > b[0]! ? 1 : 0))
    .map((fixtureIds, index) => ({ index, fixtureIds }));
}

// --- the day-cap guard ------------------------------------------------------

/**
 * Whether freezing is safe for this config's `max_fixtures_per_day` rules.
 *
 * Freezing converts a card's contribution to a day cap from an `AtMost` literal
 * into a DECREMENT of the bound — `assertDayCap` counts the immovables on each
 * day and asserts `AtMost(movable literals, count - immovable)`. That is exact,
 * but only because both sides count the same cards, and they do not always:
 * `assertDayCap` filters `existing` by `fixtureById.has()`, because an outside
 * booking or a closed court is not a fixture and counting one would invent a cap
 * breach out of a blackout. A PROPOSAL fixture missing from `config.ruleFixtures`
 * is filtered by that same test the moment it is frozen — so the decrement
 * under-counts, the solver believes a day has room it does not, and the verifier
 * rejects a board the solver called repaired. Fourth instance of this wave's
 * dominant bug class: an encoder unit that is not the verifier's unit.
 *
 * On the whole board the mismatch cannot arise, because nothing is frozen: the
 * verifier counts `[...existing.filter(known), ...assignments]` and the encoder
 * bounds exactly those same assignments. So the guard's answer is not to fail —
 * it is to DECLINE TO DECOMPOSE and solve the board whole, which is precisely
 * today's behaviour and therefore never a regression.
 */
function dayCapGuard(
  proposal: readonly Assignment[],
  config: VerifyConfig,
): DecompositionModeReason | null {
  const hasDayCap = effectiveHard(config).some((h) => h.type === "max_fixtures_per_day");
  if (!hasDayCap) return null;
  const known = new Set((config.ruleFixtures ?? []).map((f) => f.id));
  for (const a of proposal) if (!known.has(a.fixtureId)) return "day_cap_unindexed_fixtures";
  return null;
}

// --- the driver -------------------------------------------------------------

/**
 * Repairs a board component by component, committing as it goes, and verifies
 * whatever it produced before returning it.
 *
 * Never throws on exhaustion — a budget that runs out is a `partial` or
 * `unrepaired` result the caller falls back to LLM repair on. It throws in
 * exactly one case: the board it produced disagrees with the real verifier,
 * which is an impossible event and must be loud rather than shipped.
 *
 * SERIALISED PER PROCESS. `resetZ3()` tears down the shared WASM context and its
 * pthreads, so a second decomposed repair running alongside the first would pull
 * the threads out from under a live `check()` — the same abort the reset exists
 * to prevent, arriving by a different road. Two callers (the division runner and
 * the competition runner) each have their own repair loop and a joint run can
 * have both in flight, so this is not hypothetical. Calls queue; the budget
 * clock starts when a call's own work does, not when it was made.
 */
export async function repairDecomposed(
  input: DecomposedRepairInput,
): Promise<DecomposedRepairResult> {
  const run = solverQueue.then(
    () => decomposeAndSolve(input),
    () => decomposeAndSolve(input),
  );
  // The queue must survive a rejected repair, or one thrown verification error
  // would wedge every later call behind it.
  solverQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** The tail of the in-process queue. One WASM context, one solve at a time. */
let solverQueue: Promise<unknown> = Promise.resolve();

async function decomposeAndSolve(
  input: DecomposedRepairInput,
): Promise<DecomposedRepairResult> {
  // `performance.now()`: ambient wall-clock reads are banned engine-wide
  // (scripts/engine-boundary.ts), and an elapsed span is what a monotonic clock
  // is for anyway.
  const t0 = performance.now();
  const elapsed = (): number => performance.now() - t0;
  const { config, proposal } = input;
  const existing = input.existing ?? [];
  const dependencies = input.dependencies ?? [];
  const budgetMs = input.budgetMs ?? DEFAULT_DECOMPOSED_BUDGET_MS;
  const componentBudgetMs = input.componentBudgetMs ?? DEFAULT_COMPONENT_BUDGET_MS;
  const componentLimit = input.componentLimit ?? COMPONENT_MOVABLE_LIMIT;

  // A board that already verifies is answered WITHOUT loading the WASM — the
  // property `z3LoadCount()` exists to make testable.
  const pre = validateAssignments(proposal, config, existing, dependencies);
  if (pre.length === 0) {
    return {
      status: "clean",
      assignments: [...proposal],
      moved: [],
      k: 0,
      elapsedMs: elapsed(),
      checks: 0,
      relaxed: [],
      components: [],
      unresolvedFixtureIds: [],
      minimality: { verdict: "proved", k: 0, lowerBound: 0, witnesses: [], caveats: [] },
      mode: "components",
      residual: [],
    };
  }

  const modeReason = dayCapGuard(proposal, config);
  const mode: DecompositionMode = modeReason === null ? "components" : "whole_board";
  const components: RepairComponent[] =
    mode === "components"
      ? repairComponents({ proposal, dependencies, config })
      : [
          {
            index: 0,
            fixtureIds: [...proposal]
              .map((a) => a.fixtureId)
              .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
          },
        ];

  const dirtyFixtures = new Set(pre.map((c) => c.fixtureId));
  const board = new Map(proposal.map((a) => [a.fixtureId, a]));
  const reports: RepairComponentReport[] = [];
  const resolved = new Set<string>();
  const relaxedByFixture = new Map<string, readonly RepairFamily[]>();
  let checks = 0;
  let anyRelaxed: RepairFamily[] = [];

  for (const component of components) {
    const ids = component.fixtureIds;
    const own = new Set(ids);
    const dirty = ids.some((id) => dirtyFixtures.has(id));
    if (!dirty) {
      // Nothing on this island is in conflict, so there is nothing to solve and
      // no reason to pay a WASM boot for it.
      for (const id of ids) resolved.add(id);
      reports.push(report(component, 0, "clean"));
      input.onComponent?.(reports[reports.length - 1]!);
      continue;
    }

    // THE WHOLE REST OF THE BOARD, at its current placement: the caller's own
    // immovables plus every other component, committed ones included. This is
    // what makes a component's answer legal against cards it never looked at.
    const frozen = [
      ...existing,
      ...proposal.flatMap((a) => (own.has(a.fixtureId) ? [] : [board.get(a.fixtureId)!])),
    ];

    // The limit is a statement about what ONE solve can reach, so it applies to
    // components only. In `whole_board` mode there is nothing to gate — the
    // budget is the bound, exactly as it was before this file existed.
    if (mode === "components" && ids.length > componentLimit) {
      reports.push(report(component, frozen.length, "skipped", "over_component_limit"));
      input.onComponent?.(reports[reports.length - 1]!);
      continue;
    }
    const remaining = budgetMs - elapsed();
    if (remaining <= 0) {
      reports.push(report(component, frozen.length, "skipped", "budget_exhausted"));
      input.onComponent?.(reports[reports.length - 1]!);
      continue;
    }

    const movable = ids.map((id) => board.get(id)!);
    const startedAt = elapsed();
    let result: RepairResult;
    try {
      result = await repairSchedule({
        proposal: movable,
        existing: frozen,
        dependencies,
        config,
        budgetMs: Math.min(componentBudgetMs, remaining),
        gridMinutes: input.gridMinutes,
        onProgress: input.onProgress,
        onPhase: input.onPhase,
      });
    } finally {
      // MANDATORY, and measured: without a reset between component solves, many
      // medium solves share one monotonically-growing WASM heap and nothing
      // frees the per-component `Solver` or its terms. Three runs of three died
      // with `RuntimeError: memory access out of bounds` from the pthread
      // worker, at components 7 of 14, 11 of 16 and 13 of 24; three of three
      // survived with this reset in place. It costs about 1 ms to tear down and
      // 200-300 ms to reboot, absorbed into the next solve.
      //
      // In a `finally` because an encoding-drift throw leaves the same heap
      // behind, and after the LAST component as well as between them: the heap
      // is freed when the call ends rather than at the mercy of the next one.
      await resetZ3();
    }

    checks += "checks" in result ? result.checks : 0;
    const componentElapsed = elapsed() - startedAt;
    if (result.status === "repaired" || result.status === "clean") {
      for (const a of result.assignments) board.set(a.fixtureId, a);
      for (const id of ids) resolved.add(id);
      if (result.relaxed.length > 0) {
        for (const id of ids) relaxedByFixture.set(id, result.relaxed);
        anyRelaxed = sortFamilies([...anyRelaxed, ...result.relaxed]);
      }
      reports.push({
        ...report(component, frozen.length, result.status === "clean" ? "clean" : "repaired"),
        k: result.k,
        moved: [...result.moved].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
        checks: result.checks,
        elapsedMs: componentElapsed,
        relaxed: result.relaxed,
      });
    } else if (result.status === "timeout") {
      reports.push({
        ...report(component, frozen.length, "timeout"),
        checks: result.checks,
        elapsedMs: componentElapsed,
      });
    } else {
      reports.push({
        ...report(component, frozen.length, "infeasible"),
        checks: result.checks,
        elapsedMs: componentElapsed,
        infeasibleFamilies: result.families,
      });
    }
    input.onComponent?.(reports[reports.length - 1]!);
  }

  const assignments = proposal.map((a) => board.get(a.fixtureId) ?? a);
  const moved: string[] = [];
  for (const a of proposal) {
    const now = board.get(a.fixtureId)!;
    if (now.startAt !== a.startAt || now.court !== a.court) moved.push(a.fixtureId);
  }
  moved.sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));

  // ANYTIME MEANS VERIFIED, NOT MERELY RETURNED. Every conflict left on the
  // board must belong to a component this call did NOT resolve; one on a
  // component reported repaired is the solver and the verifier disagreeing about
  // what the rules mean, which is the exact lock-out this wave exists to
  // prevent.
  const after = validateAssignments(assignments, config, existing, dependencies);
  const offending = after.filter((c) => {
    if (!resolved.has(c.fixtureId)) return false;
    const relaxedHere = relaxedByFixture.get(c.fixtureId);
    return relaxedHere === undefined || relaxedHere.length === 0 ? true : isBlockingConflict(c);
  });
  const unresolved = reports.filter((r) => r.outcome !== "clean" && r.outcome !== "repaired");
  const unresolvedCount = unresolved.length;
  const unresolvedFixtureIds = unresolved
    .flatMap((r) => [...r.fixtureIds])
    .sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
  const repairedCount = reports.filter((r) => r.outcome === "repaired").length;
  const status: DecomposedRepairStatus =
    unresolvedCount === 0 ? "repaired" : repairedCount > 0 ? "partial" : "unrepaired";

  const caveats: MinimalityCaveat[] = [];
  if (mode === "components" && components.length > 1 && hasDayCap(config)) {
    caveats.push("day_cap_order_dependent");
  }
  if (unresolvedCount > 0) caveats.push("components_unresolved");
  if (anyRelaxed.length > 0) caveats.push("families_relaxed");

  const bound = disjointConflictBound({
    proposal,
    existing,
    dependencies,
    config,
    conflicts: anyRelaxed.length > 0 ? pre.filter(isBlockingConflict) : pre,
  });
  const result: DecomposedRepairResult = {
    status,
    assignments,
    moved,
    k: moved.length,
    elapsedMs: elapsed(),
    checks,
    relaxed: anyRelaxed,
    components: reports,
    unresolvedFixtureIds,
    minimality: {
      // `k` is an upper bound unless the lower bound MEETS it and nothing
      // weakened the comparison. Never claim minimal from the search alone.
      verdict:
        status === "repaired" && caveats.length === 0 && moved.length === bound.lowerBound
          ? "proved"
          : "upper_bound",
      k: moved.length,
      lowerBound: bound.lowerBound,
      witnesses: bound.witnesses,
      caveats,
    },
    mode,
    residual: after,
  };
  if (modeReason !== null) result.modeReason = modeReason;

  if (offending.length > 0) {
    throw new RepairVerificationError(
      `decomposed repair produced a schedule its own verifier rejects: ${offending.length} conflict(s)`,
      offending,
      {
        status: "repaired",
        assignments,
        moved,
        k: moved.length,
        elapsedMs: elapsed(),
        checks,
        relaxed: anyRelaxed,
      },
    );
  }
  return result;
}

const hasDayCap = (config: VerifyConfig): boolean =>
  effectiveHard(config).some((h) => h.type === "max_fixtures_per_day");

function report(
  component: RepairComponent,
  frozen: number,
  outcome: ComponentOutcome,
  skipReason?: ComponentSkipReason,
): RepairComponentReport {
  const base: RepairComponentReport = {
    index: component.index,
    size: component.fixtureIds.length,
    frozen,
    fixtureIds: component.fixtureIds,
    outcome,
    k: 0,
    moved: [],
    checks: 0,
    elapsedMs: 0,
    relaxed: [],
  };
  if (skipReason !== undefined) base.skipReason = skipReason;
  return base;
}
