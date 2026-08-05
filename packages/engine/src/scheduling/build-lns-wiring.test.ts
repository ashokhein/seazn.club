// Where the LNS fallback attaches to `buildSchedule`.
//
// `build-lns.test.ts` owns the pass itself. What is left to pin here is the
// seam, and it is four separate claims: WHEN the pass runs, WHAT it is handed,
// whether its answer is taken, and how the result attributes it. Three of them
// are invisible from a returned board, so they are asserted through a stubbed
// `improveByWindows` (`vi.doMock`, the same instrument `build.test.ts` uses for
// its injected verifier fork).
//
// THE TRIGGER IS A MEASURED BAND, and both of its edges matter. The fallback
// runs only when the tiers fell short AND the run budget has something left, and
// on this model those two overlap in a narrow window:
//
//   rlimit 200-500   tiers 1, main phase charged its 75% share, reserve intact
//   rlimit 600+      tiers 4 — the tiers finish and the fallback is not wanted
//
// `rlimit: 1` used to be the lever and is no longer viable: the main phase's
// allotment is now floored at 1 rather than 0, so it takes a check, and one
// check costs ~382 on this model however small the limit. Deterministic either
// way — `rlimit` is a resource counter, not a clock.
const LNS_LEVER_RLIMIT = 400;
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { boardMetrics, isStrictlyBetter } from "./build-objectives.ts";
import {
  isBlockingConflict,
  slotFixtures,
  validateAssignments,
  type Assignment,
  type SchedulableFixture,
  type SlotConfig,
} from "./calendar.ts";
import type { SchedulingConstraints } from "./constraints.ts";
import { resetZ3 } from "./z3-load.ts";
import type { LnsInput, LnsOutput } from "./build-lns.ts";

const MIN = 60_000;
const T0 = Date.UTC(2026, 7, 8, 9, 0);

const cons = (over: Partial<SchedulingConstraints>): SchedulingConstraints => ({
  noBackToBack: false,
  startWindows: [],
  fieldFairness: "off",
  parallelism: "mixed",
  crossPersonClash: "warn",
  ...over,
});

const fx = (id: string, home: string, away: string): SchedulableFixture => ({
  id,
  home,
  away,
  roundNo: 1,
});

/** The measured corner from `build.test.ts`: two slots on one court, and a
 *  start window that makes greedy take the early one for the wrong card. Greedy
 *  places `[a@C1+0]` and reports `start_window` for `b`; the full solver places
 *  both as `[b@C1+0, a@C1+30]`. With `rlimit: 1` the solver never gets there,
 *  which is exactly the state LNS exists to rescue. */
const config: SlotConfig & { courts: string[] } = {
  startAt: T0,
  matchMinutes: 30,
  gapMinutes: 0,
  courts: ["C1"],
  perEntrantMinRest: 0,
  tz: "Europe/London",
  window: { from: T0, to: T0 + 180 * MIN },
  sessionWindows: [{ from: T0, to: T0 + 60 * MIN }],
  constraints: cons({ startWindows: [{ target: { kind: "entrant", id: "E3" }, notAfter: T0 }] }),
};
const fixtures = [fx("a", "E1", "E2"), fx("b", "E3", "E4")];

const row = (id: string, startMin: number, entrants: string[]): Assignment => ({
  fixtureId: id,
  court: "C1",
  startAt: T0 + startMin * MIN,
  endAt: T0 + (startMin + 30) * MIN,
  entrants,
  people: [],
});
/** The board the full solver reaches, and a legal one — so the verifier gate
 *  cannot be what refuses it. */
const bothPlaced = [row("b", 0, ["E3", "E4"]), row("a", 30, ["E1", "E2"])];

const legalSeed = (): Assignment[] => {
  const raw = slotFixtures({ fixtures, config });
  const bad = new Set(
    validateAssignments(raw.assignments, config)
      .filter(isBlockingConflict)
      .map((c) => c.fixtureId),
  );
  return raw.assignments.filter((a) => !bad.has(a.fixtureId));
};

/** Loads `build.ts` with `improveByWindows` replaced. Returns the recorded
 *  inputs, so the seam can be asserted rather than inferred. */
const withStub = async (
  board: (incumbent: readonly Assignment[]) => readonly Assignment[],
): Promise<{ seen: LnsInput[]; mod: typeof import("./build.ts") }> => {
  const seen: LnsInput[] = [];
  vi.doMock("./build-lns.ts", async () => {
    const actual = await vi.importActual<typeof import("./build-lns.ts")>("./build-lns.ts");
    return {
      ...actual,
      improveByWindows: (input: LnsInput): Promise<LnsOutput> => {
        seen.push(input);
        const out = board(input.board);
        return Promise.resolve({
          board: out,
          metrics: boardMetrics(out, input.courts, input.total),
          windows: 1,
        });
      },
    };
  });
  return { seen, mod: await import("./build.ts") };
};

describe("buildSchedule — the LNS seam", () => {
  afterEach(() => {
    vi.doUnmock("./build-lns.ts");
    vi.resetModules();
  });
  afterAll(async () => {
    await resetZ3();
  });

  it("runs the pass on an unfinished run and hands it the incumbent", async () => {
    const { seen, mod } = await withStub(() => bothPlaced);
    const built = await mod.buildSchedule({ fixtures, config, rlimit: LNS_LEVER_RLIMIT });

    expect(seen).toHaveLength(1);
    expect({
      board: seen[0]!.board.map((a) => a.fixtureId),
      fixtures: seen[0]!.fixtures.map((f) => f.id),
      frozen: [...(seen[0]!.frozen ?? [])],
      courts: [...seen[0]!.courts],
      total: seen[0]!.total,
      deadlineMs: seen[0]!.deadlineMs,
    }).toEqual({
      // The INCUMBENT — the board the tiers actually reached, not the raw
      // greedy seed and not the fixture list. At this budget T0 completes and
      // places both, so the incumbent is z3's board and not greedy's `["a"]`.
      board: ["a", "b"],
      fixtures: ["a", "b"],
      frozen: [],
      courts: ["C1"],
      total: 2,
      deadlineMs: 30_000,
    });
    // NOT asserted here: that the pass's board is TAKEN and the result is
    // labelled `z3+lns`. On this corner it cannot be. The fallback only runs
    // when the tiers fall short, and at every budget where they do, T0 has
    // already placed both cards on the single court's two slots — so the
    // incumbent is `placed: 2, makespan: 60` and NO legal board beats it. A
    // stub board that did would be illegal and the verifier gate would refuse
    // it, which is a different test. `bothPlaced` here differs from the
    // incumbent in row order only, so the pass correctly declines it and the
    // result stays `z3`.
    //
    // The accept RULE is unit-tested in `build-lns.test.ts`; what is currently
    // unproven end to end is the `z3+lns` label. Recorded as owed rather than
    // papered over with a stub assertion that proves the stub.
    expect(built.engine).not.toBe("greedy");
  }, 180_000);

  it("carries the caller's frozen ids into the pass", async () => {
    const { seen, mod } = await withStub((incumbent) => incumbent);
    await mod.buildSchedule({ fixtures, config, rlimit: LNS_LEVER_RLIMIT, frozen: ["a"] });
    expect([...(seen[0]?.frozen ?? [])]).toEqual(["a"]);
  }, 180_000);

  it("keeps the tiers' own board when the pass finds nothing better", async () => {
    // The pass returning a board is not the pass IMPROVING anything, and the
    // difference has to survive into `engine`: attributing an untouched board
    // to LNS would make the telemetry Task 15 reads say the fallback is paying
    // for itself when it is not.
    const { seen, mod } = await withStub(() => []);
    const built = await mod.buildSchedule({ fixtures, config, rlimit: LNS_LEVER_RLIMIT });
    expect(seen).toHaveLength(1);
    expect({
      rows: built.assignments.map((a) => a.fixtureId),
      engine: built.engine,
    }).toEqual({ rows: ["a", "b"], engine: "z3" });
  }, 180_000);

  it("does not run the pass on a run that proved every tier", async () => {
    // `tiersCompleted === TIER_COUNT` is the optimality predicate — NOT
    // `!budgetExpired`. A board every tier ran to a verdict on has nothing left
    // for a window to find, and paying for one would be a full second solve for
    // a guaranteed non-improvement.
    const { seen, mod } = await withStub(() => bothPlaced);
    const built = await mod.buildSchedule({ fixtures, config });
    expect({ tiers: built.tiersCompleted, calls: seen.length, engine: built.engine }).toEqual({
      tiers: 4,
      calls: 0,
      engine: "z3",
    });
  }, 180_000);

  it("runs the real pass without deadlocking on the z3 lock, and never regresses", async () => {
    // `withZ3Lock` is process-wide and NOT reentrant, and the window solve
    // re-enters the build solver. A second acquire would not fail this test, it
    // would hang it — so the assertion that matters most here is that it
    // returns at all.
    //
    // With `rlimit: 1` every sub-solve is starved too, so no window can improve
    // anything; what is pinned is the floor, which is the one guarantee that
    // has to hold whatever the windows come back with.
    const built = await import("./build.ts").then((m) =>
      m.buildSchedule({ fixtures, config, rlimit: LNS_LEVER_RLIMIT }),
    );
    const floor = boardMetrics(legalSeed(), config.courts, fixtures.length);
    expect(isStrictlyBetter(floor, built.metrics)).toBe(false);
    expect(built.budgetExpired).toBe(true);
  }, 180_000);
});
