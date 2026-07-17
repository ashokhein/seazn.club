import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { OfficiatingLane } from "@/components/me/officiating-lane";
import { routes } from "@/lib/routes";
import type { MyOfficiatingAssignment } from "@/server/usecases/me-officiating";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

function makeAssignment(overrides: Partial<MyOfficiatingAssignment> = {}): MyOfficiatingAssignment {
  return {
    fixture_id: "fx1",
    fixture_no: 1,
    official_id: "off1",
    org_name: "Riverside Cup",
    org_slug: "riverside",
    competition_name: "Summer",
    competition_slug: "summer",
    competition_visibility: "public",
    division_name: "U11",
    division_slug: "u11",
    sport_key: "football",
    home_name: "Home FC",
    away_name: "Away FC",
    scheduled_at: null,
    venue_tz: null,
    venue: null,
    court_label: null,
    fixture_status: "scheduled",
    role_key: "referee",
    response: "accepted",
    decline_reason: null,
    responded_at: null,
    ...overrides,
  };
}

// v11.1 follow-up: officials belong to multiple orgs, so /me must surface a
// "Pending invites" card EVEN WHEN the signed-in login has no linked
// officials row yet (a brand-new official's very first invite). Regression:
// before this change the lane only rendered when is_official was true — a
// pending-only login saw nothing at all.
describe("OfficiatingLane — pending invites (v11.1)", () => {
  const claim = { id: "c1", org_name: "Riverside Cup", official_name: "Priya Ref" };

  it("renders the pending-invites card in pending-only mode (isOfficial=false)", () => {
    const html = renderToStaticMarkup(
      <OfficiatingLane isOfficial={false} assignments={[]} blackouts={[]} pendingClaims={[claim]} />,
    );
    expect(html).toContain("Riverside Cup");
    expect(html).toContain("Priya Ref");
    expect(html).toMatch(/>\s*Accept\s*</);
    // pending-only mode: no assignments/blackouts chrome renders at all.
    expect(html).not.toContain("No matches assigned to you yet.");
    expect(html).not.toContain("Can&#x27;t make these dates");
  });

  it("renders nothing when there is neither a link nor a pending invite (caller wouldn't mount it)", () => {
    const html = renderToStaticMarkup(
      <OfficiatingLane isOfficial={false} assignments={[]} blackouts={[]} pendingClaims={[]} />,
    );
    // still a valid empty section — the /me page itself decides whether to
    // mount OfficiatingLane at all (is_official || pendingClaims.length>0).
    expect(html).not.toContain("Accept");
    expect(html).not.toContain("No matches assigned to you yet.");
  });

  it("shows both the pending card AND the assignments/blackouts sections once linked", () => {
    const html = renderToStaticMarkup(
      <OfficiatingLane isOfficial assignments={[]} blackouts={[]} pendingClaims={[claim]} />,
    );
    expect(html).toContain("Riverside Cup");
    expect(html).toContain("No matches assigned to you yet.");
  });
});

// Task 4 (design v11 A4): accepted officials already have scoring auth on
// the fixture console (Tasks 1-3), so "Score this match" now points straight
// at the full board — not the stripped device-link mint that used to live
// behind this control.
describe("OfficiatingLane — score action repoints at the full board", () => {
  it("Score this match links to routes.fixture for the assignment's slugs", () => {
    const a = makeAssignment({
      response: "accepted",
      fixture_status: "scheduled",
      org_slug: "riverside",
      competition_slug: "summer",
      division_slug: "u11",
      fixture_no: 7,
    });
    const html = renderToStaticMarkup(
      <OfficiatingLane isOfficial assignments={[a]} blackouts={[]} pendingClaims={[]} />,
    );
    const expectedHref = routes.fixture("riverside", "summer", "u11", 7);
    expect(expectedHref).toBe("/o/riverside/c/summer/d/u11/f/7");
    const match = html.match(/<a[^>]*href="([^"]*)"[^>]*>Score this match/);
    expect(match).not.toBeNull();
    expect(match![1]).toBe(expectedHref);
  });

  it("does not render a score control for a declined assignment", () => {
    const a = makeAssignment({ response: "declined", fixture_status: "scheduled" });
    const html = renderToStaticMarkup(
      <OfficiatingLane isOfficial assignments={[a]} blackouts={[]} pendingClaims={[]} />,
    );
    expect(html).not.toContain("Score this match");
  });
});
