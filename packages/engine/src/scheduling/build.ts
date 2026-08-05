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
// incumbent simply stands and `budgetExpired` says why.
//
// The same care applies to `unsat`. With no locked card the empty board
// satisfies every clause `encodeBuild` writes — every constraint there is an
// at-most, a negation or an equivalence, and `placed[i]` is free to be false —
// so the model can only be GLOBALLY unsat because a locked pin contradicts the
// board around it. That is a fact about the pins, not about the schedule, and
// `infeasible` is claimed only after a bare feasibility probe has established
// it.
import { boardMetrics, isStrictlyBetter, type BoardMetrics } from "./build-objectives.ts";
import { buildGrid } from "./build-grid.ts";
import { encodeBuild, type BuildConfig } from "./build-encode.ts";
import {
  isBlockingConflict,
  slotFixtures,
  validateAssignments,
  RULE_BY_REASON,
  type Assignment,
  type Conflict,
  type OrderDependency,
  type SchedulableFixture,
  type SlotConfig,
} from "./calendar.ts";
import { repairUniverse } from "./repair-domain.ts";
import { loadZ3, withZ3Lock } from "./z3-load.ts";

/** Set by `scripts/bench-build.ts` (Task 15) — a placeholder until it runs. */
export const DEFAULT_BUILD_RLIMIT = 40_000_000;
/** The outer safety cap. Not the stopping rule; see the header. */
export const DEFAULT_BUILD_WALL_MS = 30_000;

export type BuildStatus =
  /** A board was produced and the gate accepted it. */
  | "ok"
  /** Every tier that ran completed, and none of them could improve on the
   *  greedy seed. A PROOF, not an opinion — the distinction from `ok` is
   *  exactly the distinction between "we stopped looking" and "there is
   *  nothing to find". */
  | "already_optimal"
  /** z3 proved the model has no solution at all. Only reachable through a
   *  locked pin (see the header). The greedy board is still returned. */
  | "infeasible"
  /** The encoder and `validateAssignments` disagreed. The greedy seed is
   *  returned and the disagreement is logged. */
  | "verifier_rejected"
  /** The WASM would not boot. A fallback, never an exception. */
  | "z3_unavailable"
  /** Reserved for a caller that declines to queue behind `withZ3Lock` rather
   *  than wait for it (Task 6). `buildSchedule` itself always waits, so it
   *  never returns this. */
  | "solver_busy";

export interface BuildInput {
  fixtures: readonly SchedulableFixture[];
  config: SlotConfig & { courts: string[] };
  existing?: readonly Assignment[];
  dependencies?: readonly OrderDependency[];
  /** POLISH only: fixture ids that may not move. */
  frozen?: readonly string[];
  rlimit?: number;
  wallMs?: number;
  mode?: "build" | "polish";
}

export interface BuildResult {
  assignments: readonly Assignment[];
  /** Everything wrong with `assignments`, INCLUDING one `no_slot` row per
   *  fixture that is not on the board. `validateAssignments` cannot report an
   *  absence — it iterates the rows it is given — so without this a solver that
   *  placed nothing would hand back an empty conflict list and read as a clean
   *  board. */
  conflicts: readonly Conflict[];
  metrics: BoardMetrics;
  /** Where the returned board came from, not which solver was consulted: `z3`
   *  means the board on this result is one z3 produced. */
  engine: "greedy" | "z3" | "z3+lns";
  status: BuildStatus;
  tiersCompleted: number;
  budgetExpired: boolean;
  elapsedMs: number;
  moved: number;
}

export function buildSchedule(input: BuildInput): Promise<BuildResult> {
  // `withZ3Lock` is NOT reentrant. It is taken exactly here, and nothing below
  // may take it again — `loadZ3` deliberately does not, and neither does
  // anything in `build-encode.ts`.
  return withZ3Lock(() => solveBuild(input));
}

async function solveBuild(input: BuildInput): Promise<BuildResult> {
  // `performance.now()`, never `Date.now()` — `scripts/engine-boundary.ts` bans
  // ambient wall-clock reads in engine source, and a monotonic clock is the
  // right one for a duration anyway.
  const t0 = performance.now();
  const elapsed = (): number => performance.now() - t0;
  const { fixtures, config } = input;
  const existing = input.existing ?? [];
  const dependencies = input.dependencies ?? [];
  const wallMs = input.wallMs ?? DEFAULT_BUILD_WALL_MS;
  const rlimit = input.rlimit ?? DEFAULT_BUILD_RLIMIT;
  const verifyConfig: BuildConfig = { ...config };

  // 1. The seed. Also the floor: nothing below can return a board this one
  //    beats, because every later board is taken only through
  //    `isStrictlyBetter` against this one.
  const seed = slotFixtures({ fixtures, config, existing });
  const seedMetrics = boardMetrics(seed.assignments, config.courts, fixtures.length);

  /**
   * A board's conflicts, in full.
   *
   * `validateAssignments` answers for the rows it is handed; the fixtures that
   * are NOT on the board are the other half of the truth and it cannot see
   * them. Greedy's own diagnosis is preferred for those, because it names the
   * binding constraint (`start_window`, or the person it collided with) where a
   * synthesised row can only say "nothing fitted".
   */
  const conflictsFor = (board: readonly Assignment[]): Conflict[] => {
    const onBoard = new Set(board.map((a) => a.fixtureId));
    const out: Conflict[] = validateAssignments(board, verifyConfig, existing, dependencies);
    for (const f of fixtures) {
      if (onBoard.has(f.id)) continue;
      const greedySaid = seed.conflicts.filter((c) => c.fixtureId === f.id);
      if (greedySaid.length > 0) {
        out.push(...greedySaid);
        continue;
      }
      out.push({
        fixtureId: f.id,
        reason: "no_slot",
        detail: "no legal slot in the lattice",
        rule: RULE_BY_REASON.no_slot,
      });
    }
    return out;
  };

  const greedy = (status: BuildStatus, budgetExpired = false): BuildResult => ({
    assignments: seed.assignments,
    conflicts: conflictsFor(seed.assignments),
    metrics: seedMetrics,
    engine: "greedy",
    status,
    tiersCompleted: 0,
    budgetExpired,
    elapsedMs: elapsed(),
    moved: 0,
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

  const pinned = fixtures.flatMap((f) => (f.locked !== undefined ? [f.locked] : []));
  const grid = buildGrid({ config, existing, pinned });
  if (grid.overCap || grid.slots.length === 0) return greedy("ok");

  // 3. z3. A boot failure is a fallback, never an exception: auto-schedule must
  //    always hand back a board.
  let Z3;
  try {
    ({ Z3 } = await loadZ3());
  } catch {
    return greedy("z3_unavailable");
  }

  const solver = new Z3.Solver();
  solver.set("rlimit", rlimit);
  /** The outer cap, refreshed before every check the way `repair.ts` does it —
   *  one `timeout` set once would give the last check the whole budget again. */
  const armTimeout = (): void => {
    solver.set("timeout", Math.max(1, Math.ceil(wallMs - elapsed())));
  };
  armTimeout();

  const model = encodeBuild({
    Z3,
    solver,
    fixtures,
    grid,
    config: verifyConfig,
    existing,
    dependencies,
  });

  /** `AtLeast` takes a NON-EMPTY tuple, not varargs. `Z3.AtLeast(...lits, k)`
   *  compiles and then fails at runtime with a spread TypeError out of z3's own
   *  internals; `repair.ts:862` spells the same shape correctly. */
  const atLeastPlaced = (k: number): void => {
    const [head, ...rest] = model.placed;
    if (head === undefined) return;
    solver.add(Z3.AtLeast([head, ...rest], k));
  };

  // 4. POLISH freezes the cards an entrant has already been told about.
  for (const id of input.frozen ?? []) {
    const i = fixtures.findIndex((f) => f.id === id);
    const at = seed.assignments.find((a) => a.fixtureId === id);
    if (i < 0 || at === undefined) continue;
    const s = grid.slots.findIndex((sl) => sl.court === at.court && sl.startAt === at.startAt);
    if (s >= 0) solver.add(model.place[i]![s]!);
  }

  let budgetExpired = false;

  // 5. The infeasibility probe — asked ONLY when a card is pinned.
  //
  //    Without a pin the model is satisfiable by inspection (the empty board),
  //    so the probe could only ever answer "sat" and would cost a full check
  //    for it; at 200 fixtures a bare `check()` is ~10 s of a 30 s budget, which
  //    is not a price to pay for a foregone conclusion. With a pin it is the
  //    only way to tell "these two cards were pinned onto one slot" from "n
  //    cards will not fit", and those want opposite answers.
  if (pinned.length > 0) {
    armTimeout();
    const probe = await solver.check();
    if (probe === "unsat") return greedy("infeasible");
    // `unknown` here is exhaustion, not a verdict: fall through and let the
    // walk below report `budgetExpired` on the greedy incumbent.
    if (probe === "unknown") budgetExpired = true;
  }

  let incumbent: readonly Assignment[] = seed.assignments;
  let incumbentMetrics = seedMetrics;
  let tiersCompleted = 0;
  let checks = 0;
  let improved = false;

  // 6. T0 — maximise the number placed. This is what turns greedy's `no_slot`
  //    GUESS into a proof: UNSAT at `placed >= n` is the proof that n is out of
  //    reach, and SAT is a board that reaches it. Descending from the full
  //    count means the FIRST satisfiable bound is the optimum, by construction.
  for (let target = fixtures.length; target > incumbentMetrics.placed; target--) {
    if (budgetExpired || elapsed() >= wallMs) {
      budgetExpired = true;
      break;
    }
    solver.push();
    atLeastPlaced(target);
    armTimeout();
    checks++;
    const verdict = await solver.check();
    if (verdict === "sat") {
      const board = model.assignmentsFrom(model.slotOf(solver.model()));
      const metrics = boardMetrics(board, config.courts, fixtures.length);
      solver.pop();
      if (isStrictlyBetter(metrics, incumbentMetrics)) {
        incumbent = board;
        incumbentMetrics = metrics;
        improved = true;
      }
      // Freeze the achieved count as a hard bound for every later tier: a tier
      // that shortens the makespan must not buy it by dropping a card.
      atLeastPlaced(incumbentMetrics.placed);
      break;
    }
    solver.pop();
    if (verdict === "unknown") {
      budgetExpired = true;
      break;
    }
  }
  // The tier completed iff it ran to a verdict rather than to the budget: a SAT
  // at some bound, or UNSAT all the way down to the incumbent's own count.
  if (checks > 0 && !budgetExpired) tiersCompleted = 1;

  // Tiers 1-3 land in Task 5; the incumbent contract above is what they extend.
  // Each of them is another descending-bound walk over `incumbent` /
  // `incumbentMetrics` / `improved` / `budgetExpired`, and each increments
  // `tiersCompleted` on the same "ran to a verdict" condition.

  // 7. The gate. Encoder and verifier disagreeing is the exact bug class this
  //    design exists to prevent, so it is never silent — but it is also never
  //    an exception, because the organiser still needs a board.
  //
  //    ABSOLUTE, not a delta: `repair.ts` throws `RepairVerificationError` in
  //    the analogous place and this deliberately does not, so the loudness has
  //    to come from somewhere. It is scoped to the cards this run actually
  //    placed — a blocking conflict `validateAssignments` attributes to a
  //    sibling division's immovable row is not a board this solver produced,
  //    and refusing our own answer over it would be a lock-out with no fix.
  const conflicts = conflictsFor(incumbent);
  const ours = new Set(incumbent.map((a) => a.fixtureId));
  const blocking = conflicts.filter((c) => isBlockingConflict(c) && ours.has(c.fixtureId));
  if (blocking.length > 0) {
    // The one place this library prints. The caller is handed a VALID board and
    // a status field they may never read, so an encoder/verifier fork would
    // otherwise reach nobody until an organiser filed a ticket about it.
    // eslint-disable-next-line no-console
    console.error(
      `buildSchedule: verifier rejected the solver's board (${blocking
        .map((c) => `${c.fixtureId}:${c.reason}`)
        .join(", ")}) — falling back to the greedy seed`,
    );
    return { ...greedy("verifier_rejected", budgetExpired), tiersCompleted };
  }

  const seedById = new Map(seed.assignments.map((a) => [a.fixtureId, a]));
  const moved = incumbent.filter((a) => {
    const was = seedById.get(a.fixtureId);
    return was === undefined || was.court !== a.court || was.startAt !== a.startAt;
  }).length;

  // `already_optimal` needs BOTH halves: a check that came back with a verdict,
  // and nothing to show for it. Without the first it would claim a proof on a
  // board nobody looked at; without the second it would fire on a board that
  // was just improved.
  let status: BuildStatus = "ok";
  if (checks > 0 && !improved && !budgetExpired) {
    status =
      incumbentMetrics.placed === 0 && fixtures.length > 0 ? "infeasible" : "already_optimal";
  }

  return {
    assignments: incumbent,
    conflicts,
    metrics: incumbentMetrics,
    engine: incumbent === seed.assignments ? "greedy" : "z3",
    status,
    tiersCompleted,
    budgetExpired,
    elapsedMs: elapsed(),
    moved,
  };
}
