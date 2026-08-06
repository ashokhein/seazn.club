// Task 12 — the Polish button, and what the three schedule actions actually
// POST.
//
// The board's three buttons all reach the same endpoint and differ only in the
// body, so the wiring is the whole feature: a Polish button that posts
// `mode: "reflow"` renders identically, passes every render assertion, and runs
// the wrong solver. There is no DOM here (vitest `environment: "node"`, no
// jsdom), so the board is mounted through the shared hook harness and each
// button is fired through its own `onClick` — the production handler, not a
// re-implementation of it.
//
// All three are asserted together on purpose. `mode` is absent on two of them
// and present on one, and a mutation that stamped every call with the same
// value would satisfy any spec that only ever looked at one button.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { propsOf, renderIsland } from "@/components/__tests__/_hook-harness";
import type { BoardDivision, BoardFixture, BoardStage } from "../board/types";

const nav = vi.hoisted(() => ({ refresh: vi.fn(), replace: vi.fn(), push: vi.fn(), search: "" }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: nav.refresh, replace: nav.replace, push: nav.push }),
  usePathname: () => "/o/acme/competitions/c1/schedule",
  useSearchParams: () => new URLSearchParams(nav.search),
}));

// `useLocale` THROWS outside a DictProvider and the harness has no provider
// tree; `useMsg` falls back to the real English catalog there, which is the
// production path, so the copy asserted below is the shipped copy.
vi.mock("@/components/i18n/dict-provider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/i18n/dict-provider")>();
  return { ...actual, useLocale: () => "en" as const };
});

vi.mock("@/lib/analytics", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/analytics")>();
  return { ...actual, track: vi.fn() };
});

const net = vi.hoisted(() => ({
  calls: [] as { url: string; method?: string; json?: unknown }[],
  auto: {} as Record<string, unknown>,
}));

vi.mock("@/lib/client-v1", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/client-v1")>();
  return {
    ...actual,
    apiV1: (url: string, options?: { method?: string; json?: unknown }) => {
      net.calls.push({ url, method: options?.method, json: options?.json });
      if (url.endsWith("/schedule/auto")) return Promise.resolve(net.auto);
      if (url.endsWith("/schedule/apply")) return Promise.resolve({ applied: 1, conflicts: [] });
      return Promise.resolve({ conflicts: [] });
    },
  };
});

import { ScheduleBoard } from "../schedule-board";
import { ScheduleResultStrip } from "../board/result-strip";

const DIVISIONS: BoardDivision[] = [
  { id: "d1", name: "Under 12s", slug: "u12", status: "active", seq: 4, schedule_locked: false },
];
const STAGES: BoardStage[] = [
  { id: "s1", division_id: "d1", name: "Round robin", kind: "round_robin", ordinal: 1 },
] as unknown as BoardStage[];
const FIXTURES: BoardFixture[] = [
  {
    id: "f1",
    stage_id: "s1",
    division_id: "d1",
    round_no: 1,
    seq_in_round: 1,
    home_entrant_id: "e1",
    away_entrant_id: "e2",
    scheduled_at: "2026-08-01T09:00:00.000Z",
    venue: null,
    court_label: "Court 1",
    status: "scheduled",
    schedule_source: "manual",
    schedule_locked: false,
    outcome: null,
  } as unknown as BoardFixture,
];

const SETTINGS = {
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

type BoardProps = Parameters<typeof ScheduleBoard>[0];

const baseProps = (): BoardProps =>
  ({
    divisions: DIVISIONS,
    stages: STAGES,
    fixtures: FIXTURES,
    entrantNames: { e1: "Alpha", e2: "Bravo" },
    activeEntrantCounts: { d1: 2 },
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
    competition: { id: "c1", divisionSettings: { d1: SETTINGS } },
  }) as unknown as BoardProps;

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

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** The element carrying `prop === value`. */
const withProp = (tree: ReactElement[], prop: string, value: unknown): ReactElement => {
  const el = tree.find((node) => propsOf(node)[prop] === value);
  if (!el) throw new Error(`nothing rendered with ${prop}="${String(value)}"`);
  return el;
};

/** The body of the last POST to /schedule/auto. */
const lastAutoBody = () =>
  net.calls.filter((c) => c.url.endsWith("/schedule/auto")).at(-1)?.json as
    | Record<string, unknown>
    | undefined;

beforeEach(() => {
  net.calls.length = 0;
  net.auto = { assignments: [], conflicts: [] };
  nav.refresh.mockClear();
});

describe("the board's three schedule actions post three different bodies", () => {
  it("Polish posts mode:polish over the unlocked cards only", async () => {
    const island = renderIsland(ScheduleBoard, baseProps());
    const button = withProp(island.tree(), "data-testid", "schedule-polish");
    // The label is the shipped copy, not a stand-in — `useMsg` falls back to the
    // real English catalog here.
    expect(propsOf(button).children).toBe("Improve times");

    await (propsOf(button).onClick as () => Promise<void> | void)();
    await flush();

    expect(lastAutoBody()).toStrictEqual({ only_unlocked: true, mode: "polish" });
  });

  /**
   * The two pre-existing buttons must keep sending NO `mode` at all.
   *
   * The server DERIVES it (`AutoScheduleRequest`'s preprocess: an absent flag
   * means reflow, `only_unlocked: false` means build) and that derivation is
   * pinned on its own side. A client that started stamping a mode would move the
   * decision to the caller silently — the bodies would still be accepted, and
   * the first divergence would show up as the wrong solver running.
   */
  it("Auto-schedule and Re-flow keep letting the server derive the mode", async () => {
    const island = renderIsland(ScheduleBoard, baseProps());
    const tree = island.tree();
    const buttons = tree.filter(
      (n) => typeof n.type === "string" && n.type === "button" && propsOf(n).onClick !== undefined,
    );
    const auto = buttons.find((b) => String(propsOf(b).children ?? "").includes("Auto-schedule"));
    const reflow = buttons.find((b) => propsOf(b).children === "Re-flow remaining");
    if (!auto || !reflow) throw new Error("the pre-existing schedule actions did not render");

    await (propsOf(auto).onClick as () => Promise<void> | void)();
    await flush();
    expect(lastAutoBody()).toStrictEqual({ only_unlocked: false });

    await (propsOf(reflow).onClick as () => Promise<void> | void)();
    await flush();
    expect(lastAutoBody()).toStrictEqual({ only_unlocked: true });
  });

  /** The strip is the board's whole report on the run. A Polish that fired and
   *  said nothing is the same to an organiser as one that did not fire. */
  it("hands the Polish run's telemetry to the result strip", async () => {
    net.auto = {
      assignments: [],
      conflicts: [],
      metrics: {
        makespan_minutes: 260,
        worst_idle_gap_minutes: 45,
        court_imbalance_minutes: 25,
        placed: 20,
        total: 22,
      },
      solver: {
        engine: "z3",
        status: "ok",
        mode: "polish",
        tiers_completed: 4,
        tiers_total: 4,
        budget_expired: false,
        elapsed_ms: 3200,
        moved: 6,
        lost: 2,
      },
    };
    const island = renderIsland(ScheduleBoard, baseProps());
    await (
      propsOf(withProp(island.tree(), "data-testid", "schedule-polish")).onClick as () =>
        | Promise<void>
        | void
    )();
    await flush();

    const strip = island.tree().find((n) => n.type === ScheduleResultStrip);
    if (!strip) throw new Error("the result strip did not mount after the run");
    // The run's OWN numbers, not a default: `lost` and `mode` are the two Task 12
    // added, and both have to survive the hop from the response to the component.
    expect(propsOf(strip).solver).toMatchObject({ mode: "polish", lost: 2, moved: 6 });
    expect(propsOf(strip).metrics).toMatchObject({ placed: 20, total: 22 });
  });
});
