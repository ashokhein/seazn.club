// Nav org precedence. The reported bug: switch org from the breadcrumb
// switcher (a plain link to /o/NEW), then click Settings in the nav — it
// landed on the OLD org, because the nav resolved its org from the seazn_org
// cookie while ActiveOrgSync only corrects that cookie after hydration.
import { describe, expect, it } from "vitest";
import { pickActiveOrg } from "@/lib/active-org";

const A = { id: "id-a", slug: "alpha" };
const B = { id: "id-b", slug: "bravo" };
const orgs = [A, B];

describe("pickActiveOrg", () => {
  it("takes the org in the URL even while the cookie still names the last one", () => {
    expect(pickActiveOrg(orgs, { pathSlug: "bravo", cookieOrgId: "id-a" })).toBe(B);
  });

  it("falls back to the cookie off the /o tree (directory, import, onboarding)", () => {
    expect(pickActiveOrg(orgs, { pathSlug: null, cookieOrgId: "id-b" })).toBe(B);
  });

  it("ignores a path org the user is not a member of, rather than dropping the chrome", () => {
    expect(pickActiveOrg(orgs, { pathSlug: "charlie", cookieOrgId: "id-b" })).toBe(B);
  });

  it("falls back to the first membership with no cookie and no path", () => {
    expect(pickActiveOrg(orgs, {})).toBe(A);
  });

  it("has no active org when the user belongs to none", () => {
    expect(pickActiveOrg([], { pathSlug: "alpha", cookieOrgId: "id-a" })).toBeNull();
  });
});
