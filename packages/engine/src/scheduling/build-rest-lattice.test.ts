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
//
// AND `not_searched` HAS ITS OWN OVER-FIRE, which the second half tests in both
// directions. An off-grid ROW is not a vacuous LADDER: one card parked against
// an existing booking's edge, on a board whose other twenty are on-grid, leaves
// z3 searching perfectly well. The status is a claim about the SEARCH, so what
// decides it is whether the region every walk was asked over — the incumbent's
// own frozen metrics — is reachable on the lattice at all, not whether the seed
// happens to sit on it.
import { describe, expect, it } from "vitest";
import { buildSchedule } from "./build.ts";
import { buildGrid, gridStepMinutes } from "./build-grid.ts";
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
  /**
   * THE DEGENERATE LADDER, and this is the case `not_searched` exists for.
   *
   * `startWindows.notBefore` at a non-multiple of the step: greedy starts the
   * card at EXACTLY its `notBefore` (measured), so the seed sits at +7 against a
   * lattice of 0/5/10/… No gcd over durations can fix an absolute anchor. The
   * window then closes at +37 — exactly one match after the anchor — so the
   * LATEST start the lattice can offer is +5, which the `notBefore` forbids.
   * z3 therefore cannot place the card anywhere.
   *
   * That is what makes the ladder vacuous rather than merely approximate. T0
   * freezes `placed >= 1` off greedy's board, the model goes unsat under it, and
   * every later walk is unsat on its FIRST ask for that reason alone — all four
   * tiers "complete" having established nothing. Reporting `already_optimal` off
   * that is a proof about an empty region.
   */
  it("reports not_searched when the lattice cannot reach the seed's own board", async () => {
    const config: Cfg = {
      startAt: T0,
      matchMinutes: 30,
      gapMinutes: 10,
      courts: ["C1"],
      perEntrantMinRest: 35,
      tz: "Europe/London",
      window: { from: T0, to: T0 + 37 * MIN },
      constraints: cons({
        startWindows: [{ target: { kind: "entrant", id: "E1" }, notBefore: T0 + 7 * MIN }],
      }),
    };
    const fixtures: SchedulableFixture[] = [{ id: "a", home: "E1", away: "E2", roundNo: 1 }];
    const seed = slotFixtures({ fixtures, config });
    expect(seed.assignments[0]?.startAt).toBe(T0 + 7 * MIN);
    // The PREMISE, pinned rather than assumed: there IS a lattice (so this is
    // not the over-cap exit below), and every slot on it starts before the
    // anchor the card is held to.
    const slots = buildGrid({ config }).slots;
    expect({
      n: slots.length,
      reachable: slots.filter((s) => s.startAt >= T0 + 7 * MIN).length,
    }).toEqual({ n: 2, reachable: 0 });

    const out = await buildSchedule({ fixtures, config });
    // Every tier runs to a verdict here and none of them improves anything, so
    // the OLD code answered `already_optimal` — a proof about a lattice that
    // does not contain the board being called optimal.
    expect({ status: out.status, tiers: out.tiersCompleted }).toEqual({
      status: "not_searched",
      tiers: 4,
    });
    expect(out.assignments).toEqual(seed.assignments);
    await resetZ3();
  }, 120_000);

  /**
   * AND THE NARROWING, which is the mirror of the bug above.
   *
   * The same off-lattice seed, but with a window wide enough that the lattice
   * CAN carry a board as good as greedy's — the card slides from +7 to +10 at no
   * cost on any of the four metrics. Here the tier walks asked real questions
   * over a non-empty region and got real UNSATs back, so the run genuinely
   * searched this board and proved nothing beats it.
   *
   * `seedOffLattice` ALONE cannot tell the two apart, and reporting
   * `not_searched` off it flags a searched board: the strip then tells an
   * organiser their schedule was never looked at, which is the same class of lie
   * as the `already_optimal` the status was introduced to stop. One off-grid row
   * is an ordinary board — an `existing` booking ending at :37 with a ten-minute
   * gap produces one on a board whose other twenty cards are all on-grid.
   *
   * What tells them apart is whether the FROZEN model — the incumbent's own
   * metrics, which is what every walk was asked relative to — is satisfiable on
   * the lattice at all. That is one `check()`, and it is the question.
   */
  it("still says already_optimal when the lattice can match the off-grid seed", async () => {
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
    // Off the lattice, exactly as above — so this case and the one above differ
    // ONLY in whether the lattice can match the board, which is the narrowing.
    expect(seed.assignments[0]?.startAt).toBe(T0 + 7 * MIN);
    expect(buildGrid({ config }).slots.some((s) => s.startAt === T0 + 7 * MIN)).toBe(false);

    const out = await buildSchedule({ fixtures, config });
    expect({ status: out.status, tiers: out.tiersCompleted }).toEqual({
      status: "already_optimal",
      tiers: 4,
    });
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

  /**
   * THE UNIVERSE, which is a separate exit and used to answer `ok`.
   *
   * A competition window edited to end before the run's own `startAt` — an
   * organiser dragging the end date back over a board they have already begun.
   * `repairUniverse` hands the window back verbatim, so `startAt >= universe.to`
   * and the run leaves before the lattice, before the WASM boot and before the
   * gate. `ok` documents itself as "a board was produced and the gate accepted
   * it" and NEITHER half of that happened; `budgetExpired: false` on the way out
   * says, correctly, that no budget was consumed, which leaves nothing at all in
   * the result telling the caller a solver was never consulted.
   */
  it("reports not_searched when the window ends before the run starts", async () => {
    const DAY = 24 * 60 * MIN;
    const config: Cfg = {
      startAt: T0,
      matchMinutes: 30,
      gapMinutes: 10,
      courts: ["C1"],
      perEntrantMinRest: 0,
      tz: "Europe/London",
      window: { from: T0 - 3 * DAY, to: T0 - DAY },
    };
    const fixtures: SchedulableFixture[] = [{ id: "a", home: "E1", away: "E2", roundNo: 1 }];
    // Not the over-cap exit above: this config asks for a small, perfectly
    // buildable lattice. The run leaves before it is ever consulted.
    const grid = buildGrid({ config });
    expect({ overCap: grid.overCap, empty: grid.slots.length === 0 }).toEqual({
      overCap: false,
      empty: false,
    });

    const out = await buildSchedule({ fixtures, config });
    expect({
      status: out.status,
      engine: out.engine,
      expired: out.budgetExpired,
      tiers: out.tiersCompleted,
      spent: out.rlimitSpent,
    }).toEqual({
      status: "not_searched",
      engine: "greedy",
      expired: false,
      tiers: 0,
      spent: 0,
    });
  }, 120_000);
});
