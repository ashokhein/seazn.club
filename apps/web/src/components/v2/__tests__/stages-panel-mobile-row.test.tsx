import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { StagesPanel } from "@/components/v2/stages-panel";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));
vi.mock("@/components/ui/confirm-provider", () => ({
  useConfirm: () => vi.fn(async () => false),
}));

// Regression (fix-ui audit 03-console-division.md, "Division fixtures list —
// mobile 390px — fixture rows overlap their own status badges/buttons"):
// team names and the badges/buttons cluster used to share one
// `flex flex-wrap` row, which can visually collide on narrow viewports.
// The row must stack (team names, then badges/buttons on their own line)
// below the sm breakpoint, and stay side-by-side at sm+ via `sm:contents`.
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
const fixture = {
  id: "f1", stage_id: "s1", pool_id: null, round_no: 1, seq_in_round: 1,
  fixture_no: 1, home_entrant_id: "e1", away_entrant_id: "e2",
  scheduled_at: "2026-08-16T13:30:00.000Z", venue: null, court_label: null,
  status: "scheduled", outcome: null,
};

describe("StagesPanel — mobile fixture-row layout", () => {
  it("stacks the badges/buttons cluster onto its own row on mobile, restoring the desktop row via sm:contents", () => {
    const html = renderToStaticMarkup(<StagesPanel {...baseProps} fixtures={[fixture]} />);
    // Outer row must switch to a column on mobile.
    expect(html).toMatch(/flex-col[^"]*sm:flex-row/);
    // The badges/buttons wrapper must vanish from the flex tree at sm+.
    expect(html).toMatch(/class="[^"]*sm:contents[^"]*"/);
  });
});
