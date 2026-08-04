// Termination at scale (#401).
//
// #401 says it plainly: "the real bound is TERMINATION". The wave accepts high
// latency on a 500-fixture board — what it cannot accept is a repair that never
// comes back, because the caller is an HTTP request and the fallback to LLM
// repair only happens if control returns at all.
//
// So these tests assert a BOUND, not that the call finished. "It returned" is
// true of a call that took four minutes, and four minutes is the failure this
// budget exists to prevent. The bounds below are set from the measured table in
// `scripts/bench-repair.ts` (see the commit body): budget + a slack covering the
// prologue and the granularity at which the encode samples its clock.
//
// Both cases run far above the 5 s vitest default, so each carries an explicit
// timeout. That is deliberate — weakening the assertion to fit the default
// would delete the only test of the property the wave exists to guarantee.
import { afterAll, describe, expect, it } from "vitest";
import { repairSchedule, type RepairPhase } from "./repair.ts";
import { syntheticBoard } from "./repair-synthetic-board.ts";
import { resetZ3, z3LoadCount } from "./z3-load.ts";

afterAll(async () => {
  await resetZ3();
});

const TEST_TIMEOUT = 120_000;

describe("termination under budget", () => {
  it(
    "a 500-movable board returns inside its budget rather than hanging",
    async () => {
      const board = syntheticBoard({ n: 500, clashEvery: 20 });
      expect(board.proposal).toHaveLength(500);
      expect(board.clashes).toBeGreaterThan(0);

      // 500 movable is the `COMPETITION_MOVABLE_CAP`. At that size the O(n²)
      // encode alone runs into the tens of seconds, so this budget expires
      // DURING the encode — which is the case that used to escape entirely,
      // the budget having once been tested only around `check()`.
      const budgetMs = 3_000;
      const t0 = performance.now();
      const r = await repairSchedule({
        proposal: board.proposal,
        config: board.config,
        dependencies: board.dependencies,
        budgetMs,
      });
      const wall = performance.now() - t0;

      expect(["repaired", "timeout", "infeasible", "clean"]).toContain(r.status);
      // The bound is the point. Slack covers the un-sampled prologue (verifier
      // pre-check, WASM boot, domain build) plus one 1024-pair sampling
      // interval; measured overshoot is well under a second.
      expect(wall).toBeLessThan(budgetMs + 4_000);
      expect(r.elapsedMs).toBeLessThan(budgetMs + 4_000);
    },
    TEST_TIMEOUT,
  );

  it(
    "the budget binds inside the solver too, not only inside the encode",
    async () => {
      // Small enough that the encode finishes well inside the budget, large
      // enough that the feasibility probe does not — so the clock that has to
      // hold here is z3's own `timeout` parameter, not the encode's sampling
      // loop. A budget respected only up to `check()` would hang here for as
      // long as z3 felt like taking.
      const board = syntheticBoard({ n: 120, clashEvery: 20 });
      const budgetMs = 5_000;
      const t0 = performance.now();
      const r = await repairSchedule({
        proposal: board.proposal,
        config: board.config,
        dependencies: board.dependencies,
        budgetMs,
      });
      const wall = performance.now() - t0;

      expect(r.status).toBe("timeout");
      if (r.status !== "timeout") return;
      expect(r.checks).toBeGreaterThanOrEqual(1); // it really did reach the solver
      expect(wall).toBeLessThan(budgetMs + 4_000);
    },
    TEST_TIMEOUT,
  );
});

describe("phase instrumentation", () => {
  it(
    "reports the phase boundaries in order, and stops at the pre-check on a clean board",
    async () => {
      // A board with no injected clash verifies, so the call returns before z3
      // is ever loaded — the one phase that fires is the pre-check, and the
      // WASM stays untouched.
      const clean = syntheticBoard({ n: 40, clashEvery: Number.MAX_SAFE_INTEGER });
      const seen: { phase: RepairPhase; elapsedMs: number }[] = [];
      const before = z3LoadCount();
      const r = await repairSchedule({
        proposal: clean.proposal,
        config: clean.config,
        dependencies: clean.dependencies,
        budgetMs: 30_000,
        onPhase: (p) => seen.push(p),
      });
      expect(r.status).toBe("clean");
      expect(seen.map((p) => p.phase)).toEqual(["precheck"]);
      expect(z3LoadCount()).toBe(before);
    },
    TEST_TIMEOUT,
  );

  it(
    "separates prologue, domain build and encode on a board that reaches the solver",
    async () => {
      const board = syntheticBoard({ n: 20, clashEvery: 20 });
      expect(board.clashes).toBeGreaterThan(0);
      const seen: { phase: RepairPhase; elapsedMs: number }[] = [];
      await repairSchedule({
        proposal: board.proposal,
        config: board.config,
        dependencies: board.dependencies,
        budgetMs: 30_000,
        onPhase: (p) => seen.push(p),
      });
      expect(seen.map((p) => p.phase)).toEqual(["precheck", "z3_ready", "domains", "encoded"]);
      // Monotonic, and each boundary strictly after the last: a hook that fired
      // from one place four times would satisfy the order assertion above.
      for (let i = 1; i < seen.length; i++) {
        expect(seen[i]!.elapsedMs).toBeGreaterThan(seen[i - 1]!.elapsedMs);
      }
    },
    TEST_TIMEOUT,
  );
});
