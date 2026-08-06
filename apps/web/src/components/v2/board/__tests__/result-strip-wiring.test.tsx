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
//   2. `metrics`/`solver` are declared on the /schedule/auto response schema and
//      Task 9 now populates them — but the hook still types them OPTIONAL, and
//      deliberately. A cached response or a server one deploy behind carries
//      neither, and typing them as required would render a board of zeros
//      instead of no strip at all. So the hook must still leave `lastRun` null
//      when the wire is silent, which is what the last spec here pins.
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
import { dayKey } from "@/lib/schedule-board";
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
  tiers_total: 4,
  budget_expired: true,
  elapsed_ms: 3200,
  moved: 6,
};

/** The same card, already on the timetable — the shape every bulk tool needs
 *  before it will PATCH anything. `shiftDay` and `swapCourts` skip cards with no
 *  time, so a test using the unplaced fixture above would prove nothing about
 *  either of them. */
const AT = "2026-08-05T10:00:00.000Z";
const PLACED_FIXTURE = {
  ...FIXTURE,
  scheduled_at: AT,
  court_label: "1",
} as unknown as BoardFixture;

// Stable identities: the hook memoises on these, and fresh arrays every render
// re-fire the effects that set state — an infinite loop, not a test.
const DIVISIONS = [DIVISION];
const FIXTURES = [FIXTURE];
const PLACED_FIXTURES = [PLACED_FIXTURE];
const NAMES = {};
const LABELS = {};

function driveWith(fixtures: BoardFixture[]) {
  let latest: BoardActions | null = null;
  renderIsland(() => {
    latest = useBoardActions(DIVISIONS, fixtures, NAMES, LABELS, true);
    return null;
  }, {});
  return () => latest as BoardActions;
}

const driveHook = () => driveWith(FIXTURES);
const drivePlaced = () => driveWith(PLACED_FIXTURES);

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

/**
 * THE STRIP DESCRIBES A BOARD. The moment that board is edited, every number on
 * it is about a timetable that no longer exists — "Optimised · Scheduled 6/6 ·
 * Total length 1h 30m" sitting above a board the organiser has just dragged a
 * card across. `lastRun` was set and cleared only inside `autoRun`, so it
 * outlived every other write on the surface.
 *
 * The rule is the simplest one that cannot rot: EVERY board write clears it.
 * `togglePin` is included even though a pin moves no card and invalidates no
 * number the strip prints — "which writes invalidate which cell" is a judgement
 * the next person has to re-make, and re-make correctly, on every new cell.
 *
 * Each case proves the write actually happened (a PATCH went out, or the gate
 * endpoint was called) before asserting the clear. Without that half, an action
 * that silently did nothing — a bulk tool skipping every card because it has no
 * time — would satisfy the assertion by never running at all.
 */
describe("a board write clears the previous run's report", () => {
  beforeEach(() => {
    net.calls = [];
    net.auto = {
      assignments: [{ fixture_id: "f1", scheduled_at: AT, court_label: "1" }],
      conflicts: [],
      metrics: METRICS,
      solver: SOLVER,
    };
  });

  const patches = () => net.calls.filter((c) => c.startsWith("/api/v1/fixtures/"));

  it("moveCard clears it", async () => {
    const actions = drivePlaced();
    await actions().autoRun("s1", false);
    expect(actions().lastRun).not.toBeNull();
    net.calls = [];

    await actions().moveCard("f1", "2026-08-05T11:00:00.000Z", "2");

    expect(patches()).toHaveLength(1);
    expect(actions().lastRun).toBeNull();
  });

  it("togglePin clears it", async () => {
    const actions = drivePlaced();
    await actions().autoRun("s1", false);
    expect(actions().lastRun).not.toBeNull();
    net.calls = [];

    await actions().togglePin(PLACED_FIXTURE);

    expect(patches()).toHaveLength(1);
    expect(actions().lastRun).toBeNull();
  });

  it("shiftDay clears it", async () => {
    const actions = drivePlaced();
    await actions().autoRun("s1", false);
    expect(actions().lastRun).not.toBeNull();
    net.calls = [];

    await actions().shiftDay(dayKey(AT), 15);

    expect(patches()).toHaveLength(1);
    expect(actions().lastRun).toBeNull();
  });

  it("swapCourts clears it", async () => {
    const actions = drivePlaced();
    await actions().autoRun("s1", false);
    expect(actions().lastRun).not.toBeNull();
    net.calls = [];

    await actions().swapCourts(dayKey(AT), "1", "2");

    expect(patches()).toHaveLength(1);
    expect(actions().lastRun).toBeNull();
  });

  /** Publish and start go through `act`. Starting a division WRITES — the
   *  quick-start rolling-times pass runs inside `startDivision` — so the board
   *  under the strip can change here too. */
  it("act clears it", async () => {
    const actions = drivePlaced();
    await actions().autoRun("s1", false);
    expect(actions().lastRun).not.toBeNull();
    net.calls = [];

    await actions().act("/api/v1/divisions/d1/start", "started");

    expect(net.calls).toContain("/api/v1/divisions/d1/start");
    expect(actions().lastRun).toBeNull();
  });
});
