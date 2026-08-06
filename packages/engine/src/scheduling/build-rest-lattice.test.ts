// The lattice has to be able to hold the board greedy just produced.
//
// `gridStepMinutes` used to be `max(REPAIR_GRID_MINUTES, gcd(match, gap))`,
// which never read a rest amount — while `slotFixtures` chains a participant's
// next start on `lastEnd + rest`. On any config whose rest is not a multiple of
// that gcd the seed therefore sits BETWEEN the lattice's slots, and the effect
// is not "the solver does a bit worse": z3 cannot express the incumbent at all,
// so the first tier bound it is handed (`atMost(<the incumbent's own
// makespan>)`) makes the whole model unsat, every later walk comes back unsat
// on the first ask, all four tiers "complete" with nothing found, and the run
// reports `already_optimal` about a board it never searched.
//
// Measured before the fix, on the first case below: `engine: "greedy"`,
// `status: "already_optimal"`, `tiersCompleted: 4`, `budgetExpired: false`.
//
// The second half is the residue. A gcd cannot rescue an ABSOLUTE off-lattice
// anchor — a `startWindows.notBefore` at 09:07, a blackout edge, an existing
// booking's `endAt + gap` — nor a lattice that would exceed `MAX_SLOTS`. Those
// still leave the solver unable to represent the incumbent, and the fix there
// is to say so (`status: "not_searched"`) rather than to claim a proof.
import { describe, expect, it } from "vitest";
import { buildSchedule } from "./build.ts";
import { gridStepMinutes } from "./build-grid.ts";
import { boardMetrics } from "./build-objectives.ts";
import { slotFixtures } from "./calendar.ts";
import { resetZ3 } from "./z3-load.ts";
import type { SchedulableFixture, SlotConfig } from "./calendar.ts";
import type { SchedulingConstraints } from "./constraints.ts";

const MIN = 60_000;
const T0 = Date.UTC(2026, 7, 8, 9, 0);

type Cfg = SlotConfig & { courts: string[] };

const cons = (over: Partial<SchedulingConstraints>): SchedulingConstraints => ({
  noBackToBack: false,
  startWindows: [],
  fieldFairness: "off",
  parallelism: "mixed",
  crossPersonClash: "warn",
  ...over,
});

describe("gridStepMinutes folds every interval that can displace a start", () => {
  it("reads perEntrantMinRest, not just match and gap", () => {
    // gcd(30, 10) = 10, and greedy's second start is at +65. gcd(30, 10, 35) = 5,
    // which divides 65.
    expect(gridStepMinutes({ matchMinutes: 30, gapMinutes: 10, perEntrantMinRest: 35 })).toBe(5);
  });

  it("leaves a rest that is already a multiple of the old step alone", () => {
    // The whole point of a gcd: a config whose rest lands on the existing
    // lattice keeps the coarser step and the larger lattice it buys.
    expect(gridStepMinutes({ matchMinutes: 30, gapMinutes: 10, perEntrantMinRest: 30 })).toBe(10);
    expect(gridStepMinutes({ matchMinutes: 60, gapMinutes: 15, perEntrantMinRest: 0 })).toBe(15);
  });

  it("reads constraints.restMin and constraints.restByGroup", () => {
    expect(
      gridStepMinutes({
        matchMinutes: 60,
        gapMinutes: 30,
        perEntrantMinRest: 0,
        constraints: cons({ restMin: 20 }),
      }),
    ).toBe(10);
    expect(
      gridStepMinutes({
        matchMinutes: 60,
        gapMinutes: 30,
        perEntrantMinRest: 0,
        constraints: cons({ restByGroup: { P1: 45 } }),
      }),
    ).toBe(15);
  });

  it("reads a compiled min_rest_minutes rule, from either channel", () => {
    const rule = {
      type: "min_rest_minutes",
      minutes: 25,
      rest_scope: "per_person",
      scope: { kind: "competition" },
    } as const;
    // gcd(60, 30, 25) = 5. Scope is deliberately NOT consulted: a step that
    // holds only the fixtures a rule names is not a lattice.
    expect(
      gridStepMinutes({ matchMinutes: 60, gapMinutes: 30, perEntrantMinRest: 0, hard: [rule] }),
    ).toBe(5);
    expect(
      gridStepMinutes({
        matchMinutes: 60,
        gapMinutes: 30,
        perEntrantMinRest: 0,
        constraints: cons({ hard: [rule] }),
      }),
    ).toBe(5);
  });

  it("reads restByDivision", () => {
    expect(
      gridStepMinutes({
        matchMinutes: 60,
        gapMinutes: 30,
        perEntrantMinRest: 0,
        restByDivision: { D1: 40 },
      }),
    ).toBe(10);
  });

  it("never goes below the shared five-minute floor", () => {
    expect(gridStepMinutes({ matchMinutes: 30, gapMinutes: 10, perEntrantMinRest: 7 })).toBe(5);
  });
});

// --- end to end -------------------------------------------------------------

/** Two courts, and a rest that lands OFF the old ten-minute lattice.
 *
 *  Measured greedy behaviour: `a` takes C1 at +0; `b` shares E1, so its ready
 *  time is `30 + 35 = +65`, and both courts are free then — greedy takes the
 *  first, stacking both matches on C1. Court imbalance 60, which is exactly what
 *  T3 exists to remove, and it can be removed at no cost on any other tier
 *  (`b@C2+65` has the same makespan, the same idle gap and the same `placed`).
 *
 *  So the board z3 must find is `a@C1+0, b@C2+65` — and +65 exists only once the
 *  step reads the rest. */
const restConfig: Cfg = {
  startAt: T0,
  matchMinutes: 30,
  gapMinutes: 10,
  courts: ["C1", "C2"],
  perEntrantMinRest: 35,
  tz: "Europe/London",
  window: { from: T0, to: T0 + 180 * MIN },
};

const restFixtures: SchedulableFixture[] = [
  { id: "a", home: "E1", away: "E2", roundNo: 1 },
  { id: "b", home: "E1", away: "E3", roundNo: 1 },
];

describe("a rest-configured board is actually searched", () => {
  it("greedy stacks both cards on one court, off the old lattice", () => {
    // The premise, pinned so a change in `slotFixtures` cannot quietly make the
    // case below vacuous by handing z3 a board it has nothing to improve.
    const seed = slotFixtures({ fixtures: restFixtures, config: restConfig });
    expect(seed.assignments.map((a) => [a.fixtureId, a.court, a.startAt - T0])).toEqual([
      ["a", "C1", 0],
      ["b", "C1", 65 * MIN],
    ]);
    expect(boardMetrics(seed.assignments, restConfig.courts, 2).courtImbalanceMinutes).toBe(60);
  });

  it("z3 balances the courts instead of calling the seed optimal", async () => {
    const out = await buildSchedule({ fixtures: restFixtures, config: restConfig });
    // The board, not the provenance: a z3 run that finds nothing better
    // legitimately reports `engine: "greedy"`, so `engine === "z3"` alone would
    // be the wrong assertion. This is a strictly better board on D3's third
    // tier, at no cost on the two above it.
    expect(out.metrics.courtImbalanceMinutes).toBe(0);
    expect(out.metrics.placed).toBe(2);
    expect(out.metrics.makespanMinutes).toBe(95);
    expect(new Set(out.assignments.map((a) => a.court))).toEqual(new Set(["C1", "C2"]));
    // The solver really ran — z3's own counter moved.
    expect(out.rlimitSpent).toBeGreaterThan(0);
    // And the seed is representable, so a completed ladder is a real proof.
    expect(out.status).toBe("ok");
    expect(out.tiersCompleted).toBe(4);
    await resetZ3();
  }, 120_000);
});

// --- the residue a gcd cannot reach ----------------------------------------

describe("a board the lattice cannot hold is never called optimal", () => {
  /** `startWindows.notBefore` at a non-multiple of the step. Greedy starts the
   *  card at EXACTLY its `notBefore` (measured), so the seed sits at +7 against
   *  a lattice of 0/5/10/… No gcd over durations can fix an absolute anchor. */
  it("reports not_searched when the seed sits between two slots", async () => {
    const config: Cfg = {
      startAt: T0,
      matchMinutes: 30,
      gapMinutes: 10,
      courts: ["C1"],
      perEntrantMinRest: 35,
      tz: "Europe/London",
      window: { from: T0, to: T0 + 180 * MIN },
      constraints: cons({
        startWindows: [{ target: { kind: "entrant", id: "E1" }, notBefore: T0 + 7 * MIN }],
      }),
    };
    const fixtures: SchedulableFixture[] = [{ id: "a", home: "E1", away: "E2", roundNo: 1 }];
    const seed = slotFixtures({ fixtures, config });
    expect(seed.assignments[0]?.startAt).toBe(T0 + 7 * MIN);

    const out = await buildSchedule({ fixtures, config });
    // Every tier runs to a verdict here and none of them improves anything, so
    // the OLD code answered `already_optimal` — a proof about a lattice that
    // does not contain the board being called optimal.
    expect(out.status).toBe("not_searched");
    expect(out.assignments).toEqual(seed.assignments);
    await resetZ3();
  }, 120_000);

  /** Over `MAX_SLOTS` the lattice is returned EMPTY, so it holds nothing at
   *  all. That exit used to return `ok`, which reads as a searched board. */
  it("reports not_searched when the lattice is over the size cap", async () => {
    const config: Cfg = {
      startAt: T0,
      matchMinutes: 30,
      gapMinutes: 10,
      courts: ["C1"],
      perEntrantMinRest: 35,
      tz: "Europe/London",
      // 70 days at a five-minute step is >20 000 slots on one court.
      window: { from: T0, to: T0 + 70 * 24 * 60 * MIN },
    };
    const fixtures: SchedulableFixture[] = [{ id: "a", home: "E1", away: "E2", roundNo: 1 }];
    const out = await buildSchedule({ fixtures, config });
    expect(out.status).toBe("not_searched");
    expect(out.engine).toBe("greedy");
    expect(out.assignments).toHaveLength(1);
  }, 120_000);
});
