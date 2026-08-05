// Task 11 — the JOIN between the auto-schedule response and the result strip.
//
// The strip itself is pinned by result-strip.test.tsx. What no static render can
// see is whether `useBoardActions.autoRun` ever hands it anything, and the two
// ways that goes wrong are both silent:
//
//   1. `autoRun` returns EARLY when the proposal is empty. An `infeasible` run
//      can place nothing at all — and that is precisely the run whose report the
//      organiser most needs — so capturing the telemetry after that return would
//      hide the strip on the one board that has to explain itself.
//   2. `metrics`/`solver` are declared on the /schedule/auto response schema but
//      `autoSchedule` does not populate them yet (verified against
//      server/usecases/schedule.ts on this branch: AutoScheduleOut is still
//      `{ assignments, conflicts }`). Typing them as required would make the
//      strip render a board of zeros for every real run today, so the hook must
//      leave `lastRun` null when the wire is silent.
//
// Driven through the shared hook dispatcher harness — vitest runs `environment:
// "node"` here and there is no jsdom, so a stateful island cannot be clicked.
import { beforeEach, describe, expect, it, vi } from "vitest";

/** Every call the hook made, plus the /schedule/auto body it gets back next. */
const net = vi.hoisted(() => ({
  calls: [] as string[],
  auto: {} as Record<string, unknown>,
}));

vi.mock("@/lib/client-v1", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/client-v1")>();
  return {
    ...actual,
    apiV1: (url: string) => {
      net.calls.push(url);
      if (url.endsWith("/schedule/auto")) return Promise.resolve(net.auto);
      if (url.endsWith("/schedule/apply")) return Promise.resolve({ applied: 1, conflicts: [] });
      return Promise.resolve({ conflicts: [] });
    },
  };
});

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => undefined, push: () => undefined }),
}));

import { renderIsland } from "@/components/__tests__/_hook-harness";
import { useBoardActions, type BoardActions } from "../use-board-actions";
import type { BoardDivision, BoardFixture } from "../types";

const DIVISION = { id: "d1", name: "Under 12s", seq: 3 } as unknown as BoardDivision;
const FIXTURE = {
  id: "f1",
  division_id: "d1",
  status: "scheduled",
  scheduled_at: null,
  court_label: null,
  schedule_locked: false,
} as unknown as BoardFixture;

const METRICS = {
  makespan_minutes: 260,
  worst_idle_gap_minutes: 45,
  court_imbalance_minutes: 25,
  placed: 20,
  total: 22,
};
const SOLVER = {
  engine: "z3",
  status: "infeasible",
  tiers_completed: 2,
  budget_expired: true,
  elapsed_ms: 3200,
  moved: 6,
};

// Stable identities: the hook memoises on these, and fresh arrays every render
// re-fire the effects that set state — an infinite loop, not a test.
const DIVISIONS = [DIVISION];
const FIXTURES = [FIXTURE];
const NAMES = {};
const LABELS = {};

function driveHook() {
  let latest: BoardActions | null = null;
  renderIsland(() => {
    latest = useBoardActions(DIVISIONS, FIXTURES, NAMES, LABELS, true);
    return null;
  }, {});
  return () => latest as BoardActions;
}

describe("autoRun -> result strip wiring", () => {
  beforeEach(() => {
    net.calls = [];
    net.auto = {};
  });

  it("captures the run's metrics and solver telemetry", async () => {
    net.auto = {
      assignments: [{ fixture_id: "f1", scheduled_at: "2026-08-05T10:00:00.000Z", court_label: "1" }],
      conflicts: [],
      metrics: METRICS,
      solver: SOLVER,
    };
    const actions = driveHook();
    expect(actions().lastRun).toBeNull();

    await actions().autoRun("s1", false);

    expect(actions().lastRun).toEqual({ metrics: METRICS, solver: SOLVER });
  });

  it("an EMPTY proposal still reports — the early return must not skip the capture", async () => {
    // An infeasible run that placed nothing is the board most in need of an
    // explanation; capturing after the `assignments.length === 0` return would
    // leave that organiser with a bare "nothing to schedule" and no reason.
    net.auto = { assignments: [], conflicts: [], metrics: { ...METRICS, placed: 0 }, solver: SOLVER };
    const actions = driveHook();

    await actions().autoRun("s1", false);

    expect(net.calls.filter((c) => c.endsWith("/schedule/apply"))).toHaveLength(0);
    expect(actions().lastRun?.solver.status).toBe("infeasible");
    expect(actions().lastRun?.metrics.placed).toBe(0);
  });

  it("a response WITHOUT metrics/solver leaves it null rather than reporting zeros", async () => {
    net.auto = {
      assignments: [{ fixture_id: "f1", scheduled_at: "2026-08-05T10:00:00.000Z", court_label: "1" }],
      conflicts: [],
    };
    const actions = driveHook();

    await actions().autoRun("s1", false);

    expect(actions().lastRun).toBeNull();
  });

  it("a new run clears the previous run's report before it starts", async () => {
    net.auto = {
      assignments: [{ fixture_id: "f1", scheduled_at: "2026-08-05T10:00:00.000Z", court_label: "1" }],
      conflicts: [],
      metrics: METRICS,
      solver: SOLVER,
    };
    const actions = driveHook();
    await actions().autoRun("s1", false);
    expect(actions().lastRun).not.toBeNull();

    // The next run's response carries nothing. A stale strip would attribute the
    // FIRST run's numbers to the second one.
    net.auto = {
      assignments: [{ fixture_id: "f1", scheduled_at: "2026-08-05T10:00:00.000Z", court_label: "1" }],
      conflicts: [],
    };
    await actions().autoRun("s1", false);

    expect(actions().lastRun).toBeNull();
  });
});
