// The run budget (controller ruling R11).
//
// `rlimit` is ONE ALLOWANCE FOR THE WHOLE RUN — every check of every tier, plus
// every window the LNS fallback opens. It used to be none of those things, and
// the reason is a z3 API shape that reads like the opposite of what it does:
//
//   * `solver.set("rlimit", n)` is RE-ARMED ON EVERY `check()`. Measured, on
//     z3-solver 5.0.0: three checks at 50_000 on one solver each returned
//     `sat`, spending ~40_000 apiece — 120_000 against a limit that reads like
//     50_000.
//   * it is a PER-CHECK DELTA, not an absolute threshold. With the context's
//     `rlimit count` already at 86_090, a check at `rlimit: 50_000` still
//     returned `sat` and spent 40_672.
//
// So setting it once, as the solver used to, bounded a CHECK and never a run,
// and the only thing actually stopping a run was the wall-clock backstop — the
// machine-dependent boundary D9 exists to keep OUT of the stopping rule and
// R10 says must never fire at all.
//
// The model below is `build-determinism.test.ts`'s: two courts, a real rest
// rule and a round-robin's worth of shared entrants, so all four tiers have
// something to chew on. MEASURED on it:
//
//   * the whole run, unconstrained, costs 201_748 units and completes 4 tiers;
//   * a SUCCESSFUL check costs ~40_672;
//   * an ABORTED check still costs ~28_500 — told it may spend 10, it spends
//     28_668 — because z3 tests the limit at intervals rather than stopping on
//     it, so every check carries a floor cost it pays regardless.
//
// THE BUDGET HERE IS 100_000, AND THE TWO NUMBERS IT SITS BETWEEN ARE THE WHOLE
// TEST. It is ~2.5x a single successful check, so under the old set-it-once
// behaviour every check has room and the run completes all four tiers, spending
// the full 201_900. It is half what the run costs, so under a run total it
// stops at tier 1 having spent 103_661. Both measured, on both behaviours.
//
// An earlier draft used 60_000 and was TOOTHLESS: that is under 1.5x a
// successful check, so the old behaviour ran out of road too and produced the
// same `budgetExpired: true` and the same early stop. The mutation sweep caught
// it. The lesson is that ~28_500 is what a check that GIVES UP costs, and
// sizing a per-check budget against it measures nothing.
//
// Asserting BOTH the tier count and the spend is deliberate: the tier count
// alone would also move if the model got harder, and the spend alone would also
// move if a check got cheaper.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildSchedule } from "./build.ts";
import { boardMetrics, isStrictlyBetter } from "./build-objectives.ts";
import { isBlockingConflict, slotFixtures, validateAssignments } from "./calendar.ts";
import { resetZ3 } from "./z3-load.ts";
import type { Assignment, SchedulableFixture, SlotConfig } from "./calendar.ts";

const MIN = 60_000;
const T0 = Date.UTC(2026, 7, 8, 9, 0);

const config: SlotConfig & { courts: string[] } = {
  startAt: T0,
  matchMinutes: 30,
  gapMinutes: 10,
  courts: ["C1", "C2"],
  perEntrantMinRest: 30,
  window: { from: T0, to: T0 + 240 * MIN },
  tz: "Europe/London",
};

const fixtures: SchedulableFixture[] = [
  { id: "a", home: "E1", away: "E2", roundNo: 1 },
  { id: "b", home: "E3", away: "E4", roundNo: 1 },
  { id: "c", home: "E1", away: "E3", roundNo: 2 },
  { id: "d", home: "E2", away: "E4", roundNo: 2 },
];

/** Greedy's LEGAL board — the floor the solver is held to however early its
 *  budget cuts it off. */
const legalSeed = (): Assignment[] => {
  const raw = slotFixtures({ fixtures, config });
  const bad = new Set(
    validateAssignments(raw.assignments, config)
      .filter(isBlockingConflict)
      .map((c) => c.fixtureId),
  );
  return raw.assignments.filter((a) => !bad.has(a.fixtureId));
};

describe("buildSchedule run budget", () => {
  // BEFORE as well as after. The engine's vitest config runs `isolate: false`
  // on a thread pool, so every file in a worker shares one z3 instance — and
  // z3's WASM heap only ever GROWS. This file's three solves (one at 40M
  // rlimit) are the heaviest in the suite, so inheriting an already-grown heap
  // kills the worker outright: it passes 3/3 in isolation and dies with a bare
  // `STACK_TRACE_ERROR` in a full run, which reads as a flake and is not one.
  beforeAll(async () => {
    await resetZ3();
  });

  afterAll(async () => {
    await resetZ3();
  });

  it("bounds the WHOLE run, not each check", async () => {
    // `generous` is the control, and it is what makes the rest non-vacuous: it
    // establishes that this model really does solve to a verdict on all four
    // tiers, and what the run costs when nothing stops it. Without it `capped`
    // would pass against a solver that never got anywhere at all.
    const generous = await buildSchedule({ fixtures, config, rlimit: 40_000_000 });
    expect({ tiers: generous.tiersCompleted, expired: generous.budgetExpired }).toEqual({
      tiers: 4,
      expired: false,
    });
    expect(generous.rlimitSpent).toBeGreaterThan(150_000);

    const capped = await buildSchedule({ fixtures, config, rlimit: 100_000 });
    // Each of these three a per-check limit gets wrong. Measured under the
    // mutant that arms `rlimit` once per check at the nominal value: tiers 4,
    // `budgetExpired` false, spent 201_900.
    expect(capped.budgetExpired).toBe(true);
    // EXACT, not `< generous`. The run is bounded by two independent
    // mechanisms — `arm()`'s per-check `set("rlimit", room)` and the
    // `settle()`/`phaseLimit` accounting gate — and the gate ALONE stops the
    // run. So a mutant that removes only the per-check re-arm still stops
    // early, just later: measured at this budget, clean stops at tier 1 having
    // spent 103_661 and the arming-only mutant at tier 2 having spent 108_594.
    // Both are `< 4` and both sit inside the spend window below, so an
    // inequality here tests only the gate and lets the arming half rot.
    expect(capped.tiersCompleted).toBe(1);
    expect(capped.tiersCompleted).toBeLessThan(generous.tiersCompleted);
    // The run stopped because it had SPENT the allowance, not because a clock
    // ran out — so the spend sits just above the budget...
    expect(capped.rlimitSpent).toBeGreaterThan(100_000);
    // ...and nowhere near the 201_748 the run costs when nothing bounds it.
    // THIS is the assertion that tells a run total from a per-check limit; the
    // slack covers one check's overshoot (3_661 measured here).
    expect(capped.rlimitSpent).toBeLessThan(150_000);
  }, 300_000);

  it("still never returns a board below the greedy floor when the budget runs out", async () => {
    // Running out is a NORMAL outcome — the incumbent stands, `status` is
    // ordinary. What must not happen is the run handing back something worse
    // than today's board.
    const capped = await buildSchedule({ fixtures, config, rlimit: 100_000 });
    const floor = boardMetrics(legalSeed(), config.courts, fixtures.length);
    expect(isStrictlyBetter(floor, capped.metrics)).toBe(false);
    expect(capped.status).toBe("ok");
  }, 300_000);

  it("stops in the same place on the same budget, and a bigger budget is never worse", async () => {
    // `rlimit` is a resource counter rather than a clock (D9), so WHERE a run
    // stops is a property of the search and not of the machine. Two runs at one
    // budget must stop identically; a larger budget must not buy a worse board.
    const a = await buildSchedule({ fixtures, config, rlimit: 100_000 });
    const b = await buildSchedule({ fixtures, config, rlimit: 100_000 });
    expect({ tiers: a.tiersCompleted, rows: a.assignments, metrics: a.metrics }).toEqual({
      tiers: b.tiersCompleted,
      rows: b.assignments,
      metrics: b.metrics,
    });
    const richer = await buildSchedule({ fixtures, config, rlimit: 40_000_000 });
    expect(a.tiersCompleted).toBeLessThanOrEqual(richer.tiersCompleted);
    expect(isStrictlyBetter(a.metrics, richer.metrics)).toBe(false);
  }, 300_000);
});
