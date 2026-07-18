import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { StagesPanel } from "@/components/v2/stages-panel";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));
vi.mock("@/components/ui/confirm-provider", () => ({
  useConfirm: () => vi.fn(async () => false),
}));

// Regression (design/fix-ui/03-console-division.md "rounds displayed out of
// chronological order"): a Cricket T20 League phase had Tour 3's fixtures
// kicking off a full day BEFORE Tour 1/2, yet it rendered last because the
// round list was ordered by round_no (generation order) instead of actual
// kickoff time. An organiser reading "what's next" off the round list would
// be misled — Tour 3 already happened before Tour 1 even started. Rounds must
// render in earliest-actual-kickoff order.
const STAGE = {
  id: "s1", seq: 0, kind: "league", name: "League",
  config: {}, qualification: null, status: "active",
};
const baseProps = {
  divisionId: "d1", competitionId: "c1", orgSlug: "org", compSlug: "comp", divSlug: "div",
  stages: [STAGE],
  entrantNames: { e1: "Alpha", e2: "Bravo", e3: "Charlie", e4: "Delta" },
  canEdit: true,
  tz: "UTC",
  canExport: false,
};

// Mirrors the reported Autumn Cup 2026 data: Tour 1 = Jul 21, Tour 2 = Jul
// 21-22, Tour 3 = Jul 20 (earliest of all three, but generated/round_no last).
const fixtures = [
  {
    id: "f1", stage_id: "s1", pool_id: null, round_no: 1, seq_in_round: 1,
    fixture_no: 1, home_entrant_id: "e1", away_entrant_id: "e2",
    scheduled_at: "2026-07-21T19:28:00.000Z", venue: null, court_label: null,
    status: "scheduled", outcome: null,
  },
  {
    id: "f2", stage_id: "s1", pool_id: null, round_no: 2, seq_in_round: 1,
    fixture_no: 2, home_entrant_id: "e3", away_entrant_id: "e4",
    scheduled_at: "2026-07-22T19:28:00.000Z", venue: null, court_label: null,
    status: "scheduled", outcome: null,
  },
  {
    id: "f3", stage_id: "s1", pool_id: null, round_no: 3, seq_in_round: 1,
    fixture_no: 3, home_entrant_id: "e1", away_entrant_id: "e3",
    scheduled_at: "2026-07-20T21:28:00.000Z", venue: null, court_label: null,
    status: "scheduled", outcome: null,
  },
];

describe("StagesPanel — round display order", () => {
  it("orders rounds by actual earliest kickoff time, not round_no", () => {
    const html = renderToStaticMarkup(<StagesPanel {...baseProps} fixtures={fixtures} />);
    const round1 = html.indexOf(">Round 1<");
    const round2 = html.indexOf(">Round 2<");
    const round3 = html.indexOf(">Round 3<");
    expect(round1).toBeGreaterThan(-1);
    expect(round2).toBeGreaterThan(-1);
    expect(round3).toBeGreaterThan(-1);
    // Round 3 kicks off Jul 20 (earliest) so it must render FIRST, ahead of
    // Round 1 (Jul 21) and Round 2 (Jul 22) — chronological, not generation order.
    expect(round3).toBeLessThan(round1);
    expect(round1).toBeLessThan(round2);
  });

  it("falls back to round_no order when no round has a scheduled kickoff yet", () => {
    const unscheduled = fixtures.map((f) => ({ ...f, scheduled_at: null }));
    const html = renderToStaticMarkup(<StagesPanel {...baseProps} fixtures={unscheduled} />);
    const round1 = html.indexOf(">Round 1<");
    const round2 = html.indexOf(">Round 2<");
    const round3 = html.indexOf(">Round 3<");
    expect(round1).toBeLessThan(round2);
    expect(round2).toBeLessThan(round3);
  });
});
