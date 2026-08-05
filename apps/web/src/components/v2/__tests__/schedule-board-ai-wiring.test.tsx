// What the BOARD hands the AI consoles — the arguments, not the functions.
//
// `jointDivisionsFor` and `aiPricingInputs` are both well covered by their own
// suites, and that is exactly the problem: extracting a pure function moves the
// mutation surface to its ARGUMENTS. Two mutations at the joint console's
// wiring site (schedule-board.tsx, the `jointDivisionsFor` call) left
// `src/components/v2` fully green at 393/0:
//
//   * `activeEntrantCounts` → `{}` — every joint division priced at 0 active
//     entrants. `sizeScore = movable + 0.5·entrants + 2·courts` is what picks
//     the rung, so this UNDER-QUOTES.
//   * `competition?.divisionSettings ?? {}` → `{}` — every division priced at 0
//     courts (under-quotes again), AND three joint-only disclosures fail open:
//     the "courts are matched by name only" warning goes quiet, the timezone
//     spread collapses to one "UTC", and `personClashBlocks` goes false, so the
//     console stops saying the apply will REFUSE a person clash.
//
// The e2e cannot see either: against its seed the mutated sizes land on the
// same side of the rung threshold, so every `data-ai-line-rung` assertion still
// passes. Only a fixture where each division DIFFERS in each dimension can — a
// board that is uniform in a dimension cannot detect a mutation that flattens
// it. Hence three divisions that disagree about everything below.
//
// There is no DOM here (vitest `environment: "node"`, no jsdom), so the board is
// mounted through the shared hook harness and the AI button is clicked through
// its own `onClick` — see components/__tests__/_hook-harness.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { propsOf, renderIsland } from "@/components/__tests__/_hook-harness";
import type { BoardDivision, BoardFixture, BoardStage } from "../board/types";

const nav = vi.hoisted(() => ({
  refresh: vi.fn(),
  replace: vi.fn(),
  push: vi.fn(),
  search: "",
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: nav.refresh, replace: nav.replace, push: nav.push }),
  usePathname: () => "/o/acme/competitions/c1/schedule",
  useSearchParams: () => new URLSearchParams(nav.search),
}));

// `useLocale` THROWS outside a DictProvider and the harness has no provider
// tree; `useMsg` already falls back to the real English catalog there, which is
// the production path, so the copy stays the shipped copy.
vi.mock("@/components/i18n/dict-provider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/i18n/dict-provider")>();
  return { ...actual, useLocale: () => "en" as const };
});

vi.mock("@/lib/analytics", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/analytics")>();
  return { ...actual, track: vi.fn() };
});

/** Every api call the board made, and how the next one answers. */
const net = vi.hoisted(() => ({
  calls: [] as { url: string; method?: string; json?: unknown }[],
  handler: null as
    | null
    | ((url: string, options?: { method?: string; json?: unknown }) => Promise<unknown>),
}));

vi.mock("@/lib/client-v1", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/client-v1")>();
  return {
    ...actual,
    apiV1: (url: string, options?: { method?: string; json?: unknown }) => {
      net.calls.push({ url, method: options?.method, json: options?.json });
      return net.handler ? net.handler(url, options) : Promise.resolve({ conflicts: [] });
    },
  };
});

import { ScheduleBoard } from "../schedule-board";
import { AiCompetitionConsole } from "../board/ai-competition-console";
import { AiConsole } from "../board/ai-console";

// ---------------------------------------------------------------------------
// A board whose three divisions agree about nothing
// ---------------------------------------------------------------------------

const DIVISIONS: BoardDivision[] = [
  { id: "d1", name: "Under 12s", slug: "u12", status: "active", seq: 4, schedule_locked: false },
  { id: "d2", name: "Under 14s", slug: "u14", status: "active", seq: 11, schedule_locked: false },
  { id: "d3", name: "Masters", slug: "masters", status: "active", seq: 7, schedule_locked: true },
];

const STAGES: BoardStage[] = DIVISIONS.map((d) => ({
  id: `s-${d.id}`,
  division_id: d.id,
  name: "Round robin",
  kind: "round_robin",
  ordinal: 1,
})) as unknown as BoardStage[];

function fixture(id: string, divisionId: string, hour: number): BoardFixture {
  return {
    id,
    stage_id: `s-${divisionId}`,
    division_id: divisionId,
    round_no: 1,
    seq_in_round: 1,
    home_entrant_id: "e1",
    away_entrant_id: "e2",
    scheduled_at: `2026-08-01T${String(hour).padStart(2, "0")}:00:00.000Z`,
    venue: null,
    court_label: "Court 1",
    status: "scheduled",
    schedule_source: "manual",
    schedule_locked: false,
    outcome: null,
  };
}

// Three movable fixtures in d1, two in d2, one in d3 — so a per-division count
// read from the whole board (or from the wrong division) is visible.
const FIXTURES: BoardFixture[] = [
  fixture("f1", "d1", 9),
  fixture("f2", "d1", 10),
  fixture("f3", "d1", 11),
  fixture("f4", "d2", 9),
  fixture("f5", "d2", 12),
  fixture("f6", "d3", 9),
  // Not movable: a cancelled fixture is not `status: "scheduled"` and must not
  // be priced. Put in d3 so a status-blind count reads 2 there, not 1.
  { ...fixture("f7", "d3", 13), status: "cancelled" },
];

/** Every dimension differs per division — that is the whole point. */
const ACTIVE_ENTRANTS = { d1: 6, d2: 40, d3: 18 };

const DIVISION_SETTINGS = {
  d1: { courts: ["Court 1", "Court 2"], tz: "Europe/London", crossPersonClash: "warn" as const },
  d2: {
    courts: ["Court 1", "Court 2", "Court 3"],
    tz: "America/New_York",
    crossPersonClash: "hard" as const,
  },
  d3: { courts: ["Court 9"], tz: "Australia/Sydney" },
};

const SETTINGS = {
  division_id: "d1",
  tz: "Europe/London",
  config: {
    startAt: "2026-08-01T09:00:00.000Z",
    endAt: "2026-08-01T18:00:00.000Z",
    matchMinutes: 60,
    gapMinutes: 0,
    courts: ["Court 1", "Court 2"],
    perEntrantMinRest: 0,
    blackouts: [],
    sessionWindows: [],
  },
} as unknown as Parameters<typeof ScheduleBoard>[0]["settings"];

const ENTRANT_NAMES = { e1: "Alpha", e2: "Bravo" };

type BoardProps = Parameters<typeof ScheduleBoard>[0];

function baseProps(extra: Partial<BoardProps> = {}): BoardProps {
  return {
    divisions: DIVISIONS,
    stages: STAGES,
    fixtures: FIXTURES,
    entrantNames: ENTRANT_NAMES,
    activeEntrantCounts: ACTIVE_ENTRANTS,
    feedLabels: {},
    settings: SETTINGS,
    canEdit: true,
    constraintsAllowed: true,
    canManage: true,
    aiAllowed: true,
    currency: "usd",
    competitionStart: "2026-08-01",
    competitionEnd: "2026-08-02",
    officialsWithBlackout: 0,
    competition: { id: "c1", divisionSettings: DIVISION_SETTINGS },
    ...extra,
  } as BoardProps;
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

// The board reads three browser globals during mount: the saved density, the
// mobile media query, and the URL the division filter pushes onto. Stubbed
// rather than mocked away — every one of them is a real production read, and a
// component that only renders with them stubbed out is a component under test.
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

/** The element carrying `marker` as a prop. */
const marked = (tree: ReactElement[], marker: string, value?: unknown): ReactElement => {
  const el = tree.find((node) =>
    value === undefined
      ? propsOf(node)[marker] !== undefined
      : propsOf(node)[marker] === value,
  );
  if (!el) throw new Error(`nothing rendered with ${marker}`);
  return el;
};

const typed = <T,>(tree: ReactElement[], type: T): ReactElement | undefined =>
  tree.find((node) => node.type === type);

/** Mount the board and click the ✦ AI button, which is the only way either
 *  console mounts. Found by `aria-haspopup="dialog"` — the launch button's own
 *  attribute, so the click goes through the production handler. */
function openConsole(props: BoardProps) {
  const island = renderIsland(ScheduleBoard, props);
  const button = marked(island.tree(), "aria-haspopup", "dialog");
  (propsOf(button).onClick as () => void)();
  return island;
}

beforeEach(() => {
  net.calls.length = 0;
  net.handler = null;
  nav.refresh.mockClear();
  nav.replace.mockClear();
  nav.push.mockClear();
});

describe("the joint console is handed the board's own money numbers", () => {
  function jointDivisions(props: BoardProps = baseProps()) {
    const island = openConsole(props);
    const console_ = typed(island.tree(), AiCompetitionConsole);
    if (!console_) throw new Error("the joint console did not mount");
    return { island, props: propsOf(console_) };
  }

  it("prices each division on ITS OWN entrants, courts and fixtures", () => {
    // The single assertion both surviving mutations die on. Every field differs
    // per division, so neither a flattened `activeEntrantCounts` (all zero) nor
    // a flattened `divisionSettings` (no courts, one UTC, nothing blocking) can
    // reproduce this list.
    const { props } = jointDivisions();
    expect(props.divisions).toEqual([
      {
        id: "d1",
        name: "Under 12s",
        seq: 4,
        scheduleLocked: false,
        courts: ["Court 1", "Court 2"],
        tz: "Europe/London",
        personClashBlocks: false,
        movableFixtures: 3,
        activeEntrants: 6,
      },
      {
        id: "d2",
        name: "Under 14s",
        seq: 11,
        scheduleLocked: false,
        courts: ["Court 1", "Court 2", "Court 3"],
        tz: "America/New_York",
        personClashBlocks: true,
        movableFixtures: 2,
        activeEntrants: 40,
      },
      {
        id: "d3",
        name: "Masters",
        seq: 7,
        scheduleLocked: true,
        courts: ["Court 9"],
        tz: "Australia/Sydney",
        personClashBlocks: false,
        movableFixtures: 1,
        activeEntrants: 18,
      },
    ]);
  });

  it("carries an active-entrant count per division, never one board-wide number", () => {
    // Spelled out on its own so the failure names the money field. `entrants`
    // is half a point each in the size score; flattening these to 0 moves a
    // 40-entrant division down a rung and charges less than the run costs.
    const { props } = jointDivisions();
    const entrants = (props.divisions as { id: string; activeEntrants: number }[]).map((d) => [
      d.id,
      d.activeEntrants,
    ]);
    expect(entrants).toEqual([
      ["d1", 6],
      ["d2", 40],
      ["d3", 18],
    ]);
    // The board-wide sum is what a naive read produces — assert it is NOT that.
    expect(entrants.map(([, n]) => n)).not.toEqual([64, 64, 64]);
  });

  it("carries each division's own courts, timezone and clash rule", () => {
    // Four safety surfaces on one prop: courts price the run AND drive the
    // by-name divergence warning, tz drives the mixed-zone disclosure, and
    // `personClashBlocks` is what tells the organiser the apply will REFUSE.
    const { props } = jointDivisions();
    const settings = (
      props.divisions as { id: string; courts: string[]; tz: string; personClashBlocks: boolean }[]
    ).map((d) => ({ id: d.id, courts: d.courts, tz: d.tz, blocks: d.personClashBlocks }));
    expect(settings).toEqual([
      { id: "d1", courts: ["Court 1", "Court 2"], tz: "Europe/London", blocks: false },
      { id: "d2", courts: ["Court 1", "Court 2", "Court 3"], tz: "America/New_York", blocks: true },
      { id: "d3", courts: ["Court 9"], tz: "Australia/Sydney", blocks: false },
    ]);
  });

  it("falls back per division, not board-wide, when a settings row is missing", () => {
    // A missing row must not borrow another division's courts — that would
    // price capacity this division does not have and make the divergence check
    // agree where it should warn.
    const { props } = jointDivisions(
      baseProps({
        competition: { id: "c1", divisionSettings: { d2: DIVISION_SETTINGS.d2 } },
      }),
    );
    const rows = props.divisions as { id: string; courts: string[]; tz: string }[];
    expect(rows.map((d) => [d.id, d.courts, d.tz])).toEqual([
      ["d1", [], "UTC"],
      ["d2", ["Court 1", "Court 2", "Court 3"], "America/New_York"],
      ["d3", [], "UTC"],
    ]);
  });

  it("hands it the WHOLE board's fixtures, not one division's (#394)", () => {
    // The label source for the review step's blocked rows and for every ghost
    // block. A joint proposal spans every selected division, so a list narrowed
    // to a single division — which on a competition board is EMPTY, because
    // there is no single division — leaves those rows with no code and no
    // matchup. `consoleFixtures` is well covered; the line choosing what to
    // hand it was not, so this asserts the ARGUMENT, not the function.
    const { props } = jointDivisions();
    const fixtures = props.fixtures as { id: string; division_id: string; code: string; matchup: string }[];
    expect(fixtures.map((f) => f.id)).toEqual(["f1", "f2", "f3", "f4", "f5", "f6", "f7"]);
    // More than one division, or a board-wide list is indistinguishable from
    // the single-division one the bug produced on a solo board.
    expect([...new Set(fixtures.map((f) => f.division_id))]).toEqual(["d1", "d2", "d3"]);
    // Every row carries the two label fields the blocked-row cell renders; an
    // empty list passes a bare length check on a filtered `find`, so pin both.
    expect(fixtures.every((f) => f.code.length > 0 && f.matchup.length > 0)).toBe(true);
  });

  it("refreshes the board on BOTH a landed apply and a stale-board refusal", () => {
    // C-1's board half. `onRefetch` is what stops the review step's recovery
    // button — which SPENDS — from re-sending a seq the page rendered with.
    const { props } = jointDivisions();
    (props.onApplied as () => void)();
    expect(nav.refresh).toHaveBeenCalledTimes(1);
    (props.onRefetch as () => void)();
    expect(nav.refresh).toHaveBeenCalledTimes(2);
  });
});

describe("the division console's brief is priced on the LIVE board", () => {
  // The pre-existing gap: `buildAiBrief({ boardFixtures: actions.board })` is
  // pinned only by Playwright. `actions.board` layers the optimistic override a
  // drag applies before the RSC refresh lands; the raw `fixtures` prop does not.
  // Once a scoped repair started narrowing on court and time, reading the prop
  // quoted a dragged fixture against a stale court label — and that under-quotes.
  const ONE = [DIVISIONS[0] as BoardDivision];
  const soloProps = () =>
    baseProps({
      divisions: ONE,
      fixtures: FIXTURES.filter((f) => f.division_id === "d1"),
      competition: undefined,
    });

  function movable(island: { tree: () => ReactElement[] }) {
    const console_ = typed(island.tree(), AiConsole);
    if (!console_) throw new Error("the division console did not mount");
    const brief = propsOf(console_).brief as {
      movableFixtures: { id: string; scheduled_at: string | null; court_label: string | null }[];
      activeEntrants: number;
    };
    return brief;
  }

  it("quotes a dragged fixture at the slot it was dragged to, not the one the server sent", async () => {
    // The PATCH is left hanging on purpose: `moveCard` writes the override
    // BEFORE it awaits, so this is exactly the window in which the console can
    // be opened over a board the server has not caught up with.
    let settle: ((v: unknown) => void) | null = null;
    net.handler = (url) =>
      url.startsWith("/api/v1/fixtures/")
        ? new Promise((resolve) => (settle = resolve as (v: unknown) => void))
        : Promise.resolve({ conflicts: [] });

    const island = renderIsland(ScheduleBoard, soloProps());
    const grid = marked(island.tree(), "onDropCard");
    (propsOf(grid).onDropCard as (id: string, iso: string, court: string) => void)(
      "f1",
      "2026-08-01T16:00:00.000Z",
      "Court 2",
    );
    await flush();
    expect(settle).not.toBeNull(); // the write really is in flight

    const button = marked(island.tree(), "aria-haspopup", "dialog");
    (propsOf(button).onClick as () => void)();

    const f1 = movable(island).movableFixtures.find((f) => f.id === "f1");
    expect(f1).toEqual({
      id: "f1",
      scheduled_at: "2026-08-01T16:00:00.000Z",
      court_label: "Court 2",
    });
    // The server-shaped prop still says otherwise — which is what makes this a
    // real distinction rather than two names for one list.
    expect((FIXTURES.find((f) => f.id === "f1") as BoardFixture).court_label).toBe("Court 1");
  });

  it("prices the single division on its own active-entrant count", () => {
    const island = openConsole(soloProps());
    expect(movable(island).activeEntrants).toBe(6);
    expect(movable(island).movableFixtures).toHaveLength(3);
  });
});
