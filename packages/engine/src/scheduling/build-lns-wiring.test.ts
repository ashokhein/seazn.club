// Where the LNS fallback attaches to `buildSchedule`.
//
// `build-lns.test.ts` owns the pass itself. What is left to pin here is the
// seam, and it is four separate claims: WHEN the pass runs, WHAT it is handed,
// whether its answer is taken, and how the result attributes it. Three of them
// are invisible from a returned board, so they are asserted through a stubbed
// `improveByWindows` (`vi.doMock`, the same instrument `build.test.ts` uses for
// its injected verifier fork).
//
// The trigger is forced with `rlimit: 1`, which is the reproducible way to make
// a `check()` return `unknown`: T0 exhausts the resource limit on its first
// question, sets `budgetExpired` and leaves `tiersCompleted` at 0. Measured
// elsewhere in this suite as `rlimit 1 -> unknown`, `rlimit 100 -> sat` on the
// same model, and deterministic — `rlimit` is a resource counter, not a clock.
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

  it("runs the pass on an unfinished run, hands it the incumbent, and takes a better board", async () => {
    const { seen, mod } = await withStub(() => bothPlaced);
    const built = await mod.buildSchedule({ fixtures, config, rlimit: 1 });

    expect(seen).toHaveLength(1);
    expect({
      board: seen[0]!.board.map((a) => a.fixtureId),
      fixtures: seen[0]!.fixtures.map((f) => f.id),
      frozen: [...(seen[0]!.frozen ?? [])],
      courts: [...seen[0]!.courts],
      total: seen[0]!.total,
      deadlineMs: seen[0]!.deadlineMs,
    }).toEqual({
      // The INCUMBENT, which here is greedy's legalised seed — not the raw
      // greedy board and not the fixture list.
      board: ["a"],
      fixtures: ["a", "b"],
      frozen: [],
      courts: ["C1"],
      total: 2,
      deadlineMs: 30_000,
    });
    expect({
      rows: built.assignments.map((a) => a.fixtureId),
      placed: built.metrics.placed,
      engine: built.engine,
      status: built.status,
    }).toEqual({ rows: ["b", "a"], placed: 2, engine: "z3+lns", status: "ok" });
  }, 180_000);

  it("carries the caller's frozen ids into the pass", async () => {
    const { seen, mod } = await withStub((incumbent) => incumbent);
    await mod.buildSchedule({ fixtures, config, rlimit: 1, frozen: ["a"] });
    expect([...(seen[0]?.frozen ?? [])]).toEqual(["a"]);
  }, 180_000);

  it("keeps the tiers' own board when the pass finds nothing better", async () => {
    // The pass returning a board is not the pass IMPROVING anything, and the
    // difference has to survive into `engine`: attributing an untouched board
    // to LNS would make the telemetry Task 15 reads say the fallback is paying
    // for itself when it is not.
    const { seen, mod } = await withStub(() => []);
    const built = await mod.buildSchedule({ fixtures, config, rlimit: 1 });
    expect(seen).toHaveLength(1);
    expect({
      rows: built.assignments.map((a) => a.fixtureId),
      engine: built.engine,
    }).toEqual({ rows: ["a"], engine: "greedy" });
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
      m.buildSchedule({ fixtures, config, rlimit: 1 }),
    );
    const floor = boardMetrics(legalSeed(), config.courts, fixtures.length);
    expect(isStrictlyBetter(floor, built.metrics)).toBe(false);
    expect(built.budgetExpired).toBe(true);
  }, 180_000);
});
