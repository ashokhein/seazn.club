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
//
// EVERY BOUND BELOW IS RELATIVE TO THE HOST, not to the machine it was authored
// on. This suite runs its files concurrently and shares the box with whatever
// else is building; a measured 5× slowdown on this very machine was enough to
// push the n=120 encode past a fixed 5 s budget, at which point the budget
// expired in the ENCODE, `checks` came back 0, and the second test here stopped
// exercising the solver it exists to test. See `solver-test-bounds.ts`. The
// factor is 1 on an idle host, so none of these bars drop.
import { afterAll, describe, expect, it } from "vitest";
import { repairSchedule, type RepairPhase } from "./repair.ts";
import { syntheticBoard } from "./repair-synthetic-board.ts";
import {
  atABudgetThatReachesTheSolver,
  measureLoadFactor,
  scaleForLoad,
  timedUnderLoad,
} from "./solver-test-bounds.ts";
import { resetZ3, z3LoadCount } from "./z3-load.ts";

afterAll(async () => {
  await resetZ3();
});

/** Once per FILE, not per test: it costs ~70 ms and load does not change
 *  meaningfully inside one file's run. */
const LOAD = measureLoadFactor();
const scale = (ms: number): number => scaleForLoad(ms, LOAD);
const TEST_TIMEOUT = scale(120_000);

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
      //
      // NOT scaled, and that is the point: the scenario is "the budget runs out
      // mid-encode", and a budget stretched to fit a slow host would let the
      // encode finish and quietly test something else. What scales is the
      // SLACK, below — how far past its deadline the call is allowed to
      // notice, which is a property of how fast this box encodes 1 024 pairs.
      const budgetMs = 3_000;
      const {
        result: r,
        wallMs: wall,
        factor,
      } = await timedUnderLoad(() =>
        repairSchedule({
          proposal: board.proposal,
          config: board.config,
          dependencies: board.dependencies,
          budgetMs,
        }),
      );

      expect(["repaired", "timeout", "infeasible", "clean"]).toContain(r.status);

      // THE BUDGET CLAIM IS `elapsedMs`, NOT `wallMs`, and the difference is not
      // pedantry — it is a whole failure mode.
      //
      // `repairSchedule` is `withZ3Lock(() => solveRepair(input))` (repair.ts:214)
      // and the solver's clock starts INSIDE `solveRepair` (repair.ts:221), after
      // the lock is acquired. Sibling test files share this process, every one of
      // their solves takes the same process-wide lock, and this 500-movable board
      // queues behind them. So `wall` = queue wait + budget, while `elapsedMs` is
      // the budget alone.
      //
      // Asserting the tight bound on `wall` measured OTHER TESTS' solve time and
      // reported it as this solver overshooting: 10 168 ms against a 7 000 ms
      // bound in a full-suite run, versus a standalone probe on the same idle host
      // that returned in 3 003 ms against a 3 000 ms budget — 3 ms of real
      // overshoot. Loosening the bound would have buried a correct solver under a
      // number it did not produce.
      //
      // Slack covers the un-sampled prologue (verifier pre-check, WASM boot,
      // domain build — measured 85-352 ms at this size) plus one sampling
      // interval, now 128 pairs / 16 fixtures rather than the original 1 024.
      // Both are CPU work, so both stretch with the host.
      const allowance = budgetMs + scaleForLoad(4_000, factor);
      expect(r.elapsedMs).toBeLessThan(allowance);

      // Wall still gets an assertion, because an unbounded queue in front of the
      // solver is a real way for a caller to hang and `elapsedMs` cannot see it.
      // The bound is deliberately loose: it catches "never returns", which is the
      // only wall-clock property that survives an oversubscribed machine.
      expect(wall).toBeLessThan(TEST_TIMEOUT);
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
      // Scaling cannot save this one. The scenario REQUIRES the encode to fit so
      // that z3's own clock is what stops the run; on a loaded host a 5 s budget
      // is eaten by the encode, `checks` comes back 0, and the assertion below
      // would be measuring the encode's sampling loop while claiming to measure
      // the solver's timeout. Observe the budget that reaches `check()` instead
      // of estimating it — and if none does, the `checks >= 1` assertion fails
      // honestly rather than passing on the wrong code path.
      let wall = 0;
      let factor = 1;
      const { result: r, budgetMs } = await atABudgetThatReachesTheSolver<
        Awaited<ReturnType<typeof repairSchedule>>
      >({
        from: 5_000,
        attempts: 4,
        reachedSolver: (res) => res.status === "timeout" && res.checks >= 1,
        run: async (ms) => {
          const timed = await timedUnderLoad(() =>
            repairSchedule({
              proposal: board.proposal,
              config: board.config,
              dependencies: board.dependencies,
              budgetMs: ms,
            }),
          );
          wall = timed.wallMs;
          factor = timed.factor;
          return timed.result;
        },
      });

      expect(r.status).toBe("timeout");
      if (r.status !== "timeout") return;
      expect(r.checks).toBeGreaterThanOrEqual(1); // it really did reach the solver
      // Same distinction as the test above, and the same reason: `wall` includes
      // the wait for the process-wide z3 lock, which is other tests' solve time.
      // This assertion passed on the run that exposed it next door — by luck of
      // scheduling, not by being right. The budget claim is the solver's own clock.
      expect(r.elapsedMs).toBeLessThan(budgetMs + scaleForLoad(4_000, factor));
      expect(wall).toBeLessThan(TEST_TIMEOUT);
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
