// W6 (#401) — the guarantees `solveBoard` makes to both AI runners, tested at
// the seam rather than through a runner: a throw, a queue, a wall clock and a
// kill switch are all states the engine cannot be talked into on demand.
//
// `repairDecomposed` is the only thing mocked. Everything else in the engine
// barrel is the real module, so `Assignment`/`VerifyConfig` stay honest.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `vi.hoisted`, not a bare const: `vi.mock` is lifted above every import, so a
// module-scope spy is still in its temporal dead zone when the factory runs.
const { repairDecomposed } = vi.hoisted(() => ({ repairDecomposed: vi.fn() }));
vi.mock("@seazn/engine/scheduling", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@seazn/engine/scheduling")>()),
  repairDecomposed,
}));

import {
  applySolverMoves,
  solveBoard,
  solverBudgetMs,
  __setSolverBusyForTest,
} from "../schedule-ai-solver";
import type { Assignment, VerifyConfig } from "@seazn/engine/scheduling";

const T = (iso: string) => new Date(iso).getTime();
const board: Assignment[] = [
  {
    fixtureId: "a",
    court: "Court 1",
    startAt: T("2026-08-01T13:00:00Z"),
    endAt: T("2026-08-01T13:30:00Z"),
    entrants: ["e1"],
    people: [],
  },
];
const config: VerifyConfig & { courts: readonly string[] } = {
  tz: "Europe/London",
  matchMinutes: 30,
  gapMinutes: 0,
  perEntrantMinRest: 0,
  blackouts: [],
  sessionWindows: [],
  courts: ["Court 1", "Court 2"],
};
const input = { proposal: board, existing: [], dependencies: [], config };

beforeEach(() => {
  repairDecomposed.mockReset();
  __setSolverBusyForTest(false);
  delete process.env.SCHEDULING_REPAIR_SOLVER;
  delete process.env.SCHEDULING_REPAIR_BUDGET_MS;
});

afterEach(() => {
  vi.useRealTimers();
  __setSolverBusyForTest(false);
});

describe("solveBoard (#401)", () => {
  it("never lets a solver throw reach the run, and records it", async () => {
    // The worst case the engine can produce: it built a board its own verifier
    // rejects. Loud inside the engine, and no reason at all for an organiser's
    // schedule request to 500.
    repairDecomposed.mockRejectedValueOnce(new Error("RepairVerificationError"));

    const out = await solveBoard(input);

    expect(out.assignments).toBeNull();
    expect(out.telemetry.solver_ran).toBe(true);
    expect(out.telemetry.fallback).toBe("error");
  });

  it("declines rather than queues when another run holds the solver", async () => {
    // `repairDecomposed` serialises per process, so waiting here would spend
    // this run's whole budget doing nothing and THEN fall back.
    __setSolverBusyForTest(true);

    const out = await solveBoard(input);

    expect(out.telemetry.fallback).toBe("queue_wait");
    expect(out.telemetry.solver_ran).toBe(false);
    expect(repairDecomposed).not.toHaveBeenCalled();
  });

  it("stops waiting at the wall and reports a fallback, not a repair", async () => {
    vi.useFakeTimers();
    // A call that simply never settles — a queue we are parked behind, or a
    // solve that has stopped making progress.
    repairDecomposed.mockReturnValueOnce(new Promise(() => {}));

    const pending = solveBoard({ ...input, budgetMs: 1_000 });
    await vi.advanceTimersByTimeAsync(1_000 + 10_000 + 10);
    const out = await pending;

    expect(out.assignments).toBeNull();
    expect(out.telemetry.timed_out).toBe(true);
    expect(out.telemetry.fallback).toBe("budget");
  });

  it("makes no attempt at all when the kill switch is off", async () => {
    process.env.SCHEDULING_REPAIR_SOLVER = "off";

    const out = await solveBoard(input);

    expect(out.telemetry).toEqual({ solver_ran: false, fallback: "disabled" });
    expect(repairDecomposed).not.toHaveBeenCalled();
  });

  it("reports what a relaxed repair gave up, and does not hide it inside `unresolved`", async () => {
    // The contract that made this worth its own test: a component reported
    // `repaired` with a non-empty `relaxed` leaves NON-blocking residue that
    // `unresolvedFixtureIds` deliberately excludes. Reading only `unresolved`
    // would report that board as spotless.
    repairDecomposed.mockResolvedValueOnce({
      status: "repaired",
      assignments: board,
      moved: ["a"],
      k: 1,
      elapsedMs: 12,
      checks: 3,
      relaxed: ["blackout"],
      components: [{ index: 0, size: 1, frozen: 0, fixtureIds: ["a"], outcome: "repaired", k: 1, moved: ["a"], checks: 3, elapsedMs: 12, relaxed: ["blackout"] }],
      unresolvedFixtureIds: [],
      minimality: { verdict: "proved", k: 1, lowerBound: 1, witnesses: [], caveats: ["families_relaxed"] },
      mode: "components",
      residual: [{ fixtureId: "a", reason: "blackout" }],
    });

    const out = await solveBoard(input);

    expect(out.telemetry.unresolved).toBe(0);
    expect(out.telemetry.relaxed).toEqual(["blackout"]);
    expect(out.telemetry.residual).toBe(1);
  });

  it("defaults the budget to 45s and honours the deployment override", () => {
    expect(solverBudgetMs()).toBe(45_000);
    process.env.SCHEDULING_REPAIR_BUDGET_MS = "7000";
    expect(solverBudgetMs()).toBe(7_000);
  });
});

describe("applySolverMoves", () => {
  it("rewrites only the fixtures the solver moved", () => {
    const plan = {
      assignments: [
        { fixture_id: "a", scheduled_at: "2026-08-01T14:00:00+01:00", court_label: "Court 1" },
        { fixture_id: "b", scheduled_at: "2026-08-01T14:00:00+01:00", court_label: "Court 2" },
      ],
    };
    const repaired: Assignment[] = [
      { ...board[0]!, fixtureId: "a", court: "Court 2", startAt: T("2026-08-01T15:00:00Z") },
    ];

    const out = applySolverMoves(plan, repaired, ["a"], () => "2026-08-01T16:00:00+01:00");

    expect(out.assignments[0]).toEqual({
      fixture_id: "a",
      scheduled_at: "2026-08-01T16:00:00+01:00",
      court_label: "Court 2",
    });
    // Untouched byte for byte — a diff between the two boards shows the repair
    // and nothing else.
    expect(out.assignments[1]).toBe(plan.assignments[1]);
  });
});
