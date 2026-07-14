import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { StagesPanel } from "@/components/v2/stages-panel";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));
vi.mock("@/components/ui/confirm-provider", () => ({
  useConfirm: () => vi.fn(async () => false),
}));

// Regression (2026-07-14): a pure League division has ONE stage. The Delete
// affordance was gated on `stages.length > 1`, so the only stage never showed
// Delete — yet the server's deleteStage happily removes the last/only stage
// when nothing is played. Result: once fixtures were generated, the format
// lock ("delete the stages first") had no escape. The button must appear for
// a single unplayed stage, and must NOT appear once a fixture is played.
const STAGE = {
  id: "s1", seq: 0, kind: "league", name: "League",
  config: {}, qualification: null, status: "active",
};
const baseProps = {
  divisionId: "d1", orgSlug: "org", compSlug: "comp", divSlug: "div",
  stages: [STAGE],
  entrantNames: { e1: "Alpha", e2: "Bravo" },
  canEdit: true,
  tz: "UTC",
  canExport: false,
};
const fixture = (status: string) => ({
  id: "f1", stage_id: "s1", pool_id: null, round_no: 1, seq_in_round: 1,
  fixture_no: 1, home_entrant_id: "e1", away_entrant_id: "e2",
  scheduled_at: "2026-08-16T13:30:00.000Z", venue: null, court_label: null,
  status, outcome: null,
});

const deleteButton = />\s*Delete\s*<\/button>/;

describe("StagesPanel — Delete on the only stage", () => {
  it("shows Delete for a single league stage with generated-but-unplayed fixtures", () => {
    const html = renderToStaticMarkup(
      <StagesPanel {...baseProps} fixtures={[fixture("scheduled")]} />,
    );
    expect(html).toMatch(deleteButton);
  });

  it("hides Delete once a fixture is played (matches the server guard)", () => {
    const html = renderToStaticMarkup(
      <StagesPanel {...baseProps} fixtures={[fixture("finalized")]} />,
    );
    expect(html).not.toMatch(deleteButton);
  });

  it("hides Delete from viewers (canEdit=false)", () => {
    const html = renderToStaticMarkup(
      <StagesPanel {...baseProps} canEdit={false} fixtures={[fixture("scheduled")]} />,
    );
    expect(html).not.toMatch(deleteButton);
  });
});
