import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { OfficiatingLane } from "@/components/me/officiating-lane";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

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
