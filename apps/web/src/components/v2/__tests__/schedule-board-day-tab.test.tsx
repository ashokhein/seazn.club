// The day tab after an Auto-schedule: the board must show the day it just
// filled, not the day it was looking at before.
//
// THE BUG. `const [day, setDay] = useState(days[0]); if (!day) setDay(days[0])`
// captured the tab at FIRST render and could never re-derive it: the pinned
// value is a non-empty string, so the `!day` escape hatch is dead. On an empty
// board `days` is `[dayKey(cfg.startAt)]` (or today), so a solver run that
// placed the matches on any other date left `day` naming a day the board no
// longer has. `dayFixtures` filters to nothing, `BoardGrid` draws an empty
// grid, and nothing downstream of the RSC refresh ever looks at the tab again —
// the organiser reads "no matches" over a board that is in fact fully placed,
// and it does not self-correct.
//
// WHY THIS FILE AND NOT A STATIC RENDER. The bug is the transition, not either
// end of it: mounted directly at the second state the board is correct, so
// `renderToStaticMarkup` cannot express it. `renderIsland(...).rerender()`
// hands down fresh props the way an RSC refresh does while hook state carries
// over, which is exactly the shape of the failure.
//
// WHY IT ASSERTS THE OPPOSITE CASE TOO. The ‹ / › arrows deliberately step onto
// days that are NOT in `days` — an organiser scrubbing an empty date is a
// feature. A fix that simply snapped `day` back into `days` on every render
// would delete that, and would still pass the first test here. So the second
// test drives the real arrow handler and pins that the empty day it chose
// survives the next render.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { propsOf, renderIsland } from "@/components/__tests__/_hook-harness";
import { dayKey } from "@/lib/schedule-board";
import type { BoardDivision, BoardFixture, BoardStage } from "../board/types";

const nav = vi.hoisted(() => ({
  refresh: vi.fn(),
  replace: vi.fn(),
  push: vi.fn(),
  search: "",
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: nav.refresh, replace: nav.replace, push: nav.push }),
  usePathname: () => "/o/acme/c/champs/d/u12/schedule",
  useSearchParams: () => new URLSearchParams(nav.search),
}));

// `useLocale` THROWS outside a DictProvider and the harness has no provider
// tree; `useMsg` already falls back to the real English catalog there, which is
// the production path, so the labels read below are the shipped ones.
vi.mock("@/components/i18n/dict-provider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/i18n/dict-provider")>();
  return { ...actual, useLocale: () => "en" as const };
});

vi.mock("@/lib/analytics", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/analytics")>();
  return { ...actual, track: vi.fn() };
});

// The board fires a conflicts check on mount and after every refresh; it must
// not reach the network, and it must not throw.
vi.mock("@/lib/client-v1", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/client-v1")>();
  return { ...actual, apiV1: () => Promise.resolve({ conflicts: [] }) };
});

import { ScheduleBoard } from "../schedule-board";
import { BoardGrid } from "../board/board-grid";
import { BoardTray } from "../board/board-tray";

// ---------------------------------------------------------------------------
// A one-division board whose configured start day is NOT the day it gets
// scheduled onto — the asymmetry is the test. A seed where the solver happened
// to place onto `cfg.startAt` agrees with the bug and proves nothing.
// ---------------------------------------------------------------------------

/** Midday UTC on both dates, so the local calendar day is unambiguous — and
 *  every expectation below is computed with the component's OWN `dayKey`, which
 *  is local-time, rather than hardcoded. */
const CONFIGURED_START = "2026-08-01T12:00:00.000Z";
const PLACED_ON = "2026-09-21T12:00:00.000Z";
const CONFIGURED_DAY = dayKey(CONFIGURED_START);
const PLACED_DAY = dayKey(PLACED_ON);

const DIVISIONS: BoardDivision[] = [
  { id: "d1", name: "Under 12s", slug: "u12", status: "active", seq: 4, schedule_locked: false },
];

const STAGES: BoardStage[] = [
  { id: "s-d1", division_id: "d1", name: "Round robin", kind: "round_robin", ordinal: 1 },
] as unknown as BoardStage[];

function fixture(id: string, scheduledAt: string | null, court: string | null): BoardFixture {
  return {
    id,
    stage_id: "s-d1",
    division_id: "d1",
    round_no: 1,
    seq_in_round: 1,
    home_entrant_id: "e1",
    away_entrant_id: "e2",
    scheduled_at: scheduledAt,
    venue: null,
    court_label: court,
    status: "scheduled",
    schedule_source: scheduledAt === null ? "manual" : "auto",
    schedule_locked: false,
    outcome: null,
  } as unknown as BoardFixture;
}

/** Six matches with no time — the fresh board an organiser presses the button on. */
const UNSCHEDULED: BoardFixture[] = ["f1", "f2", "f3", "f4", "f5", "f6"].map((id) =>
  fixture(id, null, null),
);

/** The same six after the solver placed them, on a day the board never showed. */
const SCHEDULED: BoardFixture[] = UNSCHEDULED.map((f, i) =>
  fixture(
    f.id,
    new Date(Date.parse(PLACED_ON) + (i % 3) * 30 * 60_000).toISOString(),
    i < 3 ? "Court 1" : "Court 2",
  ),
);

const SETTINGS = {
  division_id: "d1",
  tz: "UTC",
  config: {
    startAt: CONFIGURED_START,
    matchMinutes: 30,
    gapMinutes: 0,
    courts: ["Court 1", "Court 2"],
    perEntrantMinRest: 0,
    blackouts: [],
    sessionWindows: [],
  },
} as unknown as Parameters<typeof ScheduleBoard>[0]["settings"];

type BoardProps = Parameters<typeof ScheduleBoard>[0];

function baseProps(fixtures: BoardFixture[]): BoardProps {
  return {
    divisions: DIVISIONS,
    stages: STAGES,
    fixtures,
    entrantNames: { e1: "Alpha", e2: "Bravo" },
    activeEntrantCounts: { d1: 4 },
    feedLabels: {},
    settings: SETTINGS,
    canEdit: true,
    constraintsAllowed: true,
    canManage: true,
    aiAllowed: false,
    currency: "usd",
    competitionStart: "2026-08-01",
    competitionEnd: "2026-12-31",
    officialsWithBlackout: 0,
  } as BoardProps;
}

// The board reads three browser globals during mount: the saved density, the
// mobile media query, and the URL the division filter pushes onto. Stubbed
// rather than mocked away — `matchMedia` answering false is what keeps the
// density on "board" (the agenda has no grid to be empty).
const localStore = new Map<string, string>();
vi.stubGlobal("window", {
  localStorage: {
    getItem: (k: string) => localStore.get(k) ?? null,
    setItem: (k: string, v: string) => void localStore.set(k, v),
  },
  matchMedia: () => ({ matches: false }),
  get location() {
    return { search: nav.search };
  },
});

const gridOf = (tree: ReactElement[]): ReactElement => {
  const el = tree.find((node) => node.type === BoardGrid);
  if (!el)
    throw new Error(
      "the board rendered no BoardGrid — saw " +
        tree
          .map((n) => (typeof n.type === "string" ? n.type : ((n.type as { name?: string }).name ?? "?")))
          .join(","),
    );
  return el;
};
const trayOf = (tree: ReactElement[]): ReactElement => {
  const el = tree.find((node) => node.type === BoardTray);
  if (!el) throw new Error("the board rendered no BoardTray");
  return el;
};

beforeEach(() => {
  localStore.clear();
  nav.search = "";
});

describe("the day tab re-derives when the board's days change", () => {
  it("an apply that places every match on a new day shows that day, not the old one", () => {
    const island = renderIsland(ScheduleBoard, baseProps(UNSCHEDULED));

    // Before: nothing placed, so the only day the board knows is the configured
    // start, and all six matches are in the tray.
    expect(propsOf(gridOf(island.tree())).day).toBe(CONFIGURED_DAY);
    expect(propsOf(gridOf(island.tree())).fixtures).toHaveLength(0);
    expect(propsOf(trayOf(island.tree())).unscheduled).toHaveLength(6);

    // The RSC refresh after `schedule/apply` — same component, fresh server props.
    island.rerender(baseProps(SCHEDULED));

    // The tray emptying is the half that always worked (it is not day-scoped);
    // asserting it here is what makes the grid assertion's claim honest — the
    // props DID arrive, and the grid was empty anyway.
    expect(propsOf(trayOf(island.tree())).unscheduled).toHaveLength(0);

    // THE BUG: `day` stayed at CONFIGURED_DAY and the grid drew nothing.
    expect(propsOf(gridOf(island.tree())).day).toBe(PLACED_DAY);
    expect(propsOf(gridOf(island.tree())).fixtures).toHaveLength(6);
  });

  it("keeps a day the organiser scrubbed to, even though it holds no matches", () => {
    const island = renderIsland(ScheduleBoard, baseProps(SCHEDULED));
    expect(propsOf(gridOf(island.tree())).day).toBe(PLACED_DAY);

    // Drive the real ›-arrow handler. It steps onto a day that is deliberately
    // NOT in `days` — scrubbing an empty date is the feature a naive
    // "snap back into the list" fix would delete.
    const next = island
      .tree()
      .find((node) => propsOf(node)["aria-label"] === "Next day");
    if (!next) throw new Error("the board rendered no next-day control");
    (propsOf(next).onClick as () => void)();

    const dayAfter = propsOf(gridOf(island.tree())).day;
    expect(dayAfter).not.toBe(PLACED_DAY);
    expect(propsOf(gridOf(island.tree())).fixtures).toHaveLength(0);

    // …and it survives a re-render that changes nothing about the day list.
    island.rerender(baseProps(SCHEDULED));
    expect(propsOf(gridOf(island.tree())).day).toBe(dayAfter);
  });
});
