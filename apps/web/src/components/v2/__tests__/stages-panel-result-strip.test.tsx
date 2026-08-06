// Task 12 item 4 — "Auto-schedule remaining" reports its run too.
//
// The stages panel holds the SECOND call site for POST /stages/{id}/schedule/auto
// (v3/04 §3 item 3, fired from the pinned unscheduled section). Task 9 populates
// `metrics` and `solver` on every response, so this entry point already receives
// the solver's report and drops it on the floor: the same run, launched from the
// board, explains itself in full; launched from here it says "Placed 6 matches"
// and nothing about what the solver could not do.
//
// That asymmetry is the defect. An organiser who reaches auto-schedule from the
// division page has no way to learn that four cards went unplaced or that the
// run ran out of time — the numbers are on the wire and nothing renders them.
//
// No DOM here (vitest `environment: "node"`), so the panel is mounted through
// the shared hook harness and the CTA is fired through its own `onClick`.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { propsOf, renderIsland } from "@/components/__tests__/_hook-harness";

const nav = vi.hoisted(() => ({ refresh: vi.fn(), push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: nav.refresh, push: nav.push }) }));
vi.mock("@/components/ui/confirm-provider", () => ({ useConfirm: () => vi.fn(async () => false) }));

const net = vi.hoisted(() => ({
  calls: [] as { url: string; json?: unknown }[],
  auto: {} as Record<string, unknown>,
}));

vi.mock("@/lib/client-v1", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/client-v1")>();
  return {
    ...actual,
    apiV1: (url: string, options?: { method?: string; json?: unknown }) => {
      net.calls.push({ url, json: options?.json });
      if (url.endsWith("/schedule/auto")) return Promise.resolve(net.auto);
      if (url.endsWith("/schedule/apply")) return Promise.resolve({ applied: 6 });
      return Promise.resolve({});
    },
  };
});

import { StagesPanel } from "@/components/v2/stages-panel";
import { ScheduleResultStrip } from "@/components/v2/board/result-strip";

const STAGE = {
  id: "s1",
  seq: 0,
  kind: "league",
  name: "League",
  config: {},
  qualification: null,
  status: "active",
};

/** UNSCHEDULED, deliberately: the auto-schedule CTA lives in the pinned
 *  unscheduled section, so a fixture with a time would not render it at all. */
const FIXTURE = {
  id: "f1",
  stage_id: "s1",
  pool_id: null,
  round_no: 1,
  seq_in_round: 1,
  fixture_no: 1,
  home_entrant_id: "e1",
  away_entrant_id: "e2",
  scheduled_at: null,
  venue: null,
  court_label: null,
  status: "scheduled",
  outcome: null,
};

const baseProps = {
  divisionId: "d1",
  competitionId: "c1",
  orgSlug: "org",
  compSlug: "comp",
  divSlug: "div",
  stages: [STAGE],
  fixtures: [FIXTURE],
  entrantNames: { e1: "Alpha", e2: "Bravo" },
  canEdit: true,
  tz: "UTC",
  canExport: false,
} as unknown as Parameters<typeof StagesPanel>[0];

const METRICS = {
  makespan_minutes: 260,
  worst_idle_gap_minutes: 45,
  court_imbalance_minutes: 25,
  placed: 18,
  total: 22,
};
const SOLVER = {
  engine: "greedy",
  status: "ok",
  mode: "reflow",
  tiers_completed: 0,
  tiers_total: 4,
  budget_expired: true,
  elapsed_ms: 8000,
  moved: 6,
  seeded: 6,
  lost: 2,
};

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * The panel's auto-schedule CTA, by testid.
 *
 * NOT by shape: the first cut of this helper took "the first button with an
 * onClick and a className" and fired the stage's "Generate matches" action
 * instead — which reaches a different endpoint entirely, so both specs failed
 * for a reason that had nothing to do with the strip. Nor by copy: the label is
 * translated, and it swaps to "Working…" mid-run.
 */
function fireAutoSchedule(tree: ReactElement[]): Promise<void> {
  const cta = tree.find((n) => propsOf(n)["data-testid"] === "stage-auto-schedule");
  if (!cta) throw new Error("the unscheduled section rendered no auto-schedule CTA");
  return Promise.resolve((propsOf(cta).onClick as () => Promise<void> | void)()) as Promise<void>;
}

beforeEach(() => {
  net.calls.length = 0;
  net.auto = { assignments: [] };
  nav.refresh.mockClear();
});

describe("StagesPanel — Auto-schedule remaining reports its run", () => {
  it("renders the result strip with the run's own telemetry", async () => {
    net.auto = {
      assignments: [{ fixture_id: "f1", scheduled_at: "2026-08-01T09:00:00.000Z", court_label: "C1" }],
      metrics: METRICS,
      solver: SOLVER,
    };
    const island = renderIsland(StagesPanel, baseProps);
    expect(island.tree().find((n) => n.type === ScheduleResultStrip)).toBeUndefined();

    await fireAutoSchedule(island.tree());
    await flush();

    const strip = island.tree().find((n) => n.type === ScheduleResultStrip);
    if (!strip) throw new Error("the result strip did not mount after the run");
    // The run's OWN numbers. `placed: 18 / total: 22` and `lost: 2` disagree with
    // the "Placed 6 matches" notice beside them on purpose — the notice counts
    // what the APPLY wrote, the strip reports what the SOLVER did, and a wiring
    // that fed the strip the apply's numbers would be caught here.
    expect(propsOf(strip).metrics).toMatchObject({ placed: 18, total: 22 });
    expect(propsOf(strip).solver).toMatchObject({ lost: 2, mode: "reflow", budget_expired: true });
  });

  /**
   * An EMPTY proposal still reports, exactly as the board does. This entry point
   * fires from the unscheduled section, so "the solver could place none of them"
   * is not an edge case here — it is the run most in need of an explanation, and
   * capturing after the early return would hide the strip precisely there.
   */
  it("reports a run that placed nothing, instead of a bare 'nothing to schedule'", async () => {
    net.auto = { assignments: [], metrics: { ...METRICS, placed: 0 }, solver: SOLVER };
    const island = renderIsland(StagesPanel, baseProps);

    await fireAutoSchedule(island.tree());
    await flush();

    expect(net.calls.filter((c) => c.url.endsWith("/schedule/apply"))).toHaveLength(0);
    const strip = island.tree().find((n) => n.type === ScheduleResultStrip);
    if (!strip) throw new Error("an empty proposal left the organiser with no report");
    expect(propsOf(strip).metrics).toMatchObject({ placed: 0 });
  });

  /** A cached response, or a server one deploy behind, carries neither block.
   *  A strip full of zeros is a worse answer than no strip. */
  it("stays away when the response carries no telemetry", async () => {
    net.auto = {
      assignments: [{ fixture_id: "f1", scheduled_at: "2026-08-01T09:00:00.000Z", court_label: "C1" }],
    };
    const island = renderIsland(StagesPanel, baseProps);

    await fireAutoSchedule(island.tree());
    await flush();

    expect(island.tree().find((n) => n.type === ScheduleResultStrip)).toBeUndefined();
  });

  /**
   * …and it goes away again the moment the board it describes does.
   *
   * `lastRun` was set and cleared only inside `autoScheduleStage`, so pressing
   * Undo — which puts a DIFFERENT board back — left the strip on screen still
   * reporting the run that has just been reversed. Same defect as the board's,
   * and the same rule fixes it: every write clears the report.
   *
   * By testid, never copy: the label is translated.
   */
  it("clears the report when Undo puts a different board back", async () => {
    net.auto = {
      assignments: [{ fixture_id: "f1", scheduled_at: "2026-08-01T09:00:00.000Z", court_label: "C1" }],
      metrics: METRICS,
      solver: SOLVER,
    };
    const island = renderIsland(StagesPanel, baseProps);
    await fireAutoSchedule(island.tree());
    await flush();
    expect(island.tree().find((n) => n.type === ScheduleResultStrip)).toBeDefined();

    const undo = island.tree().find((n) => propsOf(n)["data-testid"] === "schedule-undo");
    if (!undo) throw new Error("a successful apply rendered no undo affordance");
    await Promise.resolve((propsOf(undo).onClick as () => Promise<void> | void)());
    await flush();

    // The undo really was sent — otherwise a strip that vanished for any other
    // reason would satisfy the assertion below.
    expect(net.calls.some((c) => c.url.endsWith("/undo"))).toBe(true);
    expect(island.tree().find((n) => n.type === ScheduleResultStrip)).toBeUndefined();
  });
});
