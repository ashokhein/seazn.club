// The lattice has to be able to hold the board greedy just produced.
//
// `gridStepMinutes` is `max(REPAIR_GRID_MINUTES, gcd(match, gap))` and never
// reads a rest — while `slotFixtures` chains a participant's next start on
// `lastEnd + rest`. On any config whose rest is not a multiple of that gcd the
// seed therefore sits BETWEEN the lattice's slots, and the effect is not "the
// solver does a bit worse": z3 cannot express the incumbent at all, so the first
// tier bound it is handed (`atMost(<the incumbent's own makespan>)`) makes the
// whole model unsat, every later walk comes back unsat on the first ask, all
// four tiers "complete" with nothing found, and the run reports
// `already_optimal` about a board it never searched.
//
// Measured before the fix, on the first end-to-end case below: `engine:
// "greedy"`, `status: "already_optimal"`, `tiersCompleted: 4`, `budgetExpired:
// false`.
//
// THERE ARE TWO WAYS TO FIX THAT, AND THE CHEAP-LOOKING ONE IS THE EXPENSIVE
// ONE. Folding every rest amount into the step makes the seed land on the grid
// by construction — and collapses the step to the five-minute floor on every
// config whose rest is incommensurate with its pitch, which is an ~8x lattice
// for every board in the system. Measured at the 8 s wall, the same bench at
// `--hard-rest=80` (step 40) against `--hard-rest=45` (step 5): slots at
// n=10/80/140 24/168/288 -> 136/1260/2192, last improving size 80 -> 20,
// `canSolveWithin` admitting n<=80 -> n<=20, and three runs of eighteen killed
// outright by an `ast_manager::register_node_core` OOM inside the WASM — which
// in the bench is a row and in production is the request's whole process.
//
// So the seed is made representable by PINNING it (`seedPinsOf` in `build.ts`,
// `seedPins` in `build-grid.ts`): the incumbent's own `(court, startAt)` pairs
// go into the lattice, which costs O(n) extra slots and only on the boards that
// are off-grid at all. The invariant it buys is the one the tier ladder needs —
// THE SOLVER IS NEVER UNABLE TO EXPRESS ITS OWN INCUMBENT.
//
// The last third of this file is the residue. A pin is refused when the slot is
// inadmissible (a blackout, a session edge, an existing booking) and dropped
// when its court is not configured, and a lattice over `MAX_SLOTS` or a universe
// that ends before the run starts holds nothing at all. Those still leave the
// solver unable to search, and the fix there is to say so
// (`status: "not_searched"`) rather than to claim a proof.
import { describe, expect, it } from "vitest";
import { buildSchedule, seedPinsOf } from "./build.ts";
import { buildGrid, gridStepMinutes } from "./build-grid.ts";
import { boardMetrics } from "./build-objectives.ts";
import { slotFixtures } from "./calendar.ts";
import { resetZ3 } from "./z3-load.ts";
import type { Assignment, SchedulableFixture, SlotConfig } from "./calendar.ts";
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

/** Two courts, and a rest that lands OFF the ten-minute lattice.
 *
 *  Measured greedy behaviour: `a` takes C1 at +0; `b` shares E1, so its ready
 *  time is `30 + 35 = +65`, and `slotFixtures` walks courts IN ORDER, so it
 *  stacks both matches on C1. Court imbalance 60, which is exactly what T3
 *  exists to remove, and it can be removed at no cost on any other tier.
 *
 *  +65 is on no 5/10/15-minute lattice anchored at local midnight, so without a
 *  pin the incumbent is inexpressible and every tier bound is unsat on its first
 *  ask. */
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

/** The configuration that started all of this, in its purest form: one court,
 *  `match 30 / gap 10 / rest 35`, three cards chained onto one entrant at
 *  +0 / +65 / +130. Two of those three starts are off a ten-minute lattice. */
const chainConfig: Cfg = { ...restConfig, courts: ["C1"] };
const chainFixtures: SchedulableFixture[] = [
  { id: "a", home: "E1", away: "E2", roundNo: 1 },
  { id: "b", home: "E1", away: "E3", roundNo: 1 },
  { id: "c", home: "E1", away: "E4", roundNo: 1 },
];

describe("the step is match and gap only", () => {
  it("does not read a rest, so a rest-chained seed lands between slots", () => {
    // `gcd(30, 10) = 10`, and greedy's second start is at +65. The step is not
    // refined to divide it — the pins below are what make it representable.
    expect(gridStepMinutes(restConfig)).toBe(10);
    expect(65 % gridStepMinutes(restConfig)).not.toBe(0);
  });

  it("keeps the coarse step a back-to-back court is entitled to", () => {
    expect(gridStepMinutes({ matchMinutes: 40, gapMinutes: 0 })).toBe(40);
    expect(gridStepMinutes({ matchMinutes: 60, gapMinutes: 15 })).toBe(15);
  });
});

describe("seedPinsOf", () => {
  const at = (court: string, min: number): Assignment => ({
    fixtureId: `f${min}`,
    court,
    startAt: T0 + min * MIN,
    endAt: T0 + (min + 30) * MIN,
    entrants: ["E1"],
    people: [],
  });

  it("offers the incumbent's own (court, startAt) pairs, de-duplicated", () => {
    // The third row shares C1+65 with the second — impossible on a legal board,
    // and the count is what the O(n) claim is stated in, so it may not double.
    expect(seedPinsOf([at("C1", 0), at("C1", 65), at("C1", 65), at("C2", 65)], ["C1", "C2"])).toEqual([
      { court: "C1", startAt: T0 },
      { court: "C1", startAt: T0 + 65 * MIN },
      { court: "C2", startAt: T0 + 65 * MIN },
    ]);
  });

  it("drops a row on a court the organiser did not configure", () => {
    // `restrictToConfiguredCourts` would drop the slot again a line later, and
    // buying an unconfigured court a lattice slot is the ghost-pin defect (R20):
    // the slot outlives the card that justified it and takes a real fixture.
    //
    // UNREACHABLE THROUGH `buildSchedule` TODAY, and deliberately still here:
    // `slotFixtures` iterates `config.courts` alone (`calendar.ts:734`), so the
    // seed cannot name another court, while `buildGrid` takes its court list
    // from `repairCourts`, which folds in every court an `existing` row uses.
    // The day those two converge, this is the guard that keeps the pins honest.
    expect(seedPinsOf([at("C1", 0), at("C9", 65)], ["C1"])).toEqual([{ court: "C1", startAt: T0 }]);
  });
});

describe("the lattice holds the seed", () => {
  it("carries every chained start, at one extra slot per off-grid row", () => {
    const seed = slotFixtures({ fixtures: chainFixtures, config: chainConfig });
    // The premise: +0 / +65 / +130, two of them off a ten-minute lattice.
    expect(seed.assignments.map((a) => (a.startAt - T0) / MIN)).toEqual([0, 65, 130]);

    const bare = buildGrid({ config: chainConfig });
    const pins = seedPinsOf(seed.assignments, chainConfig.courts);
    const pinned = buildGrid({ config: chainConfig, seedPins: pins });

    // THE INVARIANT. Every seed row is expressible, which is the whole content
    // of the fix — the tier ladder's first bound is the incumbent's own metric,
    // and a lattice that cannot hold the incumbent refutes nothing.
    const keys = new Set(pinned.slots.map((s) => `${s.court}|${s.startAt}`));
    expect(seed.assignments.filter((a) => !keys.has(`${a.court}|${a.startAt}`))).toEqual([]);
    expect(bare.slots.some((s) => s.startAt === T0 + 65 * MIN)).toBe(false);

    // AND THE COST, stated as arithmetic rather than "O(n)". A 180-minute window
    // at a ten-minute step holds 16 starts (0…150, the last match ending at the
    // edge); +130 is already one of them and only +65 is new. The step-refining
    // alternative divides the step by 8 and multiplies EVERY board's lattice to
    // match, whether or not it is off-grid.
    expect({ bare: bare.slots.length, pinned: pinned.slots.length, pins: pins.length }).toEqual({
      bare: 16,
      pinned: 17,
      pins: 3,
    });
  });

  it("refuses a seed pin the lattice would refuse anyway", () => {
    // ALIGNMENT is what a seed pin bypasses; LEGALITY is not. Greedy never
    // produces such a row — it reads the same blackouts — but `buildGrid` is
    // handed the pins by a caller, and an admitted-unconditionally slot inside a
    // blackout is a slot ANY fixture may then be placed in.
    const config: Cfg = {
      ...chainConfig,
      blackouts: [{ from: T0 + 60 * MIN, to: T0 + 90 * MIN }],
    };
    const inside = { court: "C1", startAt: T0 + 65 * MIN };
    const outside = { court: "C1", startAt: T0 + 125 * MIN };
    const g = buildGrid({ config, seedPins: [inside, outside] });
    const has = (s: { court: string; startAt: number }): boolean =>
      g.slots.some((x) => x.court === s.court && x.startAt === s.startAt);
    expect({ inside: has(inside), outside: has(outside) }).toEqual({ inside: false, outside: true });
  });
});

// --- end to end -------------------------------------------------------------

describe("a rest-configured board is actually searched", () => {
  it("greedy stacks both cards on one court, off the lattice", () => {
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
    //
    // Note WHICH card moved: `a` goes to C2 at +0 and `b` keeps the pinned +65.
    // The improvement is reachable because the pin makes the incumbent's
    // makespan achievable at all — the lattice has no +65 on C2, so a solver
    // that could not express the seed could not have got here either.
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

  it("proves the chained board optimal instead of never searching it", async () => {
    // ONE COURT, so there is nothing to rebalance and the honest verdict is
    // `already_optimal` — the difference from the old behaviour is not the
    // status but what stands behind it. Before the pins the same word came off
    // four tiers that were each unsat on their first ask because the incumbent
    // was inexpressible; here every bound was asked over a region containing the
    // incumbent, and z3 spent real budget refuting it.
    const out = await buildSchedule({ fixtures: chainFixtures, config: chainConfig });
    expect({ status: out.status, tiers: out.tiersCompleted, placed: out.metrics.placed }).toEqual({
      status: "already_optimal",
      tiers: 4,
      placed: 3,
    });
    expect(out.assignments.map((a) => (a.startAt - T0) / MIN)).toEqual([0, 65, 130]);
    expect(out.rlimitSpent).toBeGreaterThan(0);
    await resetZ3();
  }, 120_000);

  it("searches a board held to an absolute anchor no step could divide", async () => {
    // The residue a gcd was never going to reach, and the clearest case for
    // pinning over refining: `startWindows.notBefore` at +7 is not a duration,
    // so no step over match/gap/rest divides it. Greedy starts the card at
    // exactly its anchor; the window then closes at +37, one match later, so the
    // LATEST start the ten-minute lattice offers is +0 and z3 has nowhere legal
    // to put the card at all.
    //
    // That is the vacuous ladder in its purest form — and the pin dissolves it:
    // +7 is in the lattice, `placed >= 1` is satisfiable, and the four tiers
    // that complete have refuted a region that contains the board.
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
    // The premise, pinned rather than assumed: the BARE lattice cannot reach the
    // anchor, so this case is about the pin and nothing else.
    const bare = buildGrid({ config }).slots;
    expect({ n: bare.length, reachable: bare.filter((s) => s.startAt >= T0 + 7 * MIN).length }).toEqual({
      n: 1,
      reachable: 0,
    });

    const out = await buildSchedule({ fixtures, config });
    expect({ status: out.status, tiers: out.tiersCompleted }).toEqual({
      status: "already_optimal",
      tiers: 4,
    });
    expect(out.assignments).toEqual(seed.assignments);
    await resetZ3();
  }, 120_000);
});

// --- what pinning does NOT rescue -------------------------------------------

describe("a board the lattice cannot hold is never called optimal", () => {
  /** Over `MAX_SLOTS` the lattice is returned EMPTY, so it holds nothing at
   *  all — and no pin can help, because there is nothing to pin them into. That
   *  exit used to return `ok`, which reads as a searched board. */
  it("reports not_searched when the lattice is over the size cap", async () => {
    const config: Cfg = {
      startAt: T0,
      matchMinutes: 30,
      gapMinutes: 10,
      courts: ["C1"],
      perEntrantMinRest: 35,
      tz: "Europe/London",
      // 200 days at a ten-minute step is >20 000 starts on one court.
      window: { from: T0, to: T0 + 200 * 24 * 60 * MIN },
    };
    const fixtures: SchedulableFixture[] = [{ id: "a", home: "E1", away: "E2", roundNo: 1 }];
    expect(buildGrid({ config }).overCap).toBe(true);
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
