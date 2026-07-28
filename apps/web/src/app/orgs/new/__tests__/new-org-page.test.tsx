// The /orgs/new page's one decision (v17 gap #293 review).
//
// WHY THIS FILE EXISTS. The page hands `CreateOrgForm` the organisations the
// visitor can actually OPEN, and the picker builds its "buy another slot" link
// out of them. Nothing else in the stack witnesses that hand-off, so two
// one-line edits used to leave every suite green and the feature dead:
//
//   memberOrgIds={orgs.filter(…).map(…)}  ->  {[]}   the link renders for
//                                                    nobody, ever
//   drop the `role !== "scorer"` filter            a scorer-role organisation
//                                                    gets linked, requireOrgPage
//                                                    bounces to /my-matches,
//                                                    and the dead end is back
//
// Rendered as a server component: an async function returning an element tree,
// so it is awaited and walked (same shape as the Add-ons tab's page test).
import { describe, expect, it, vi, beforeEach } from "vitest";
import { propsOf, walk } from "@/components/__tests__/_hook-harness";
import { CreateOrgForm } from "@/components/create-org-form";
import type { OrgMembership } from "@/lib/types";

const redirect = vi.fn();
vi.mock("next/navigation", () => ({ redirect: (to: string) => redirect(to) }));
vi.mock("@/lib/auth", () => ({
  getCurrentUser: vi.fn(async () => ({ id: "user-1", email: "payer@example.com" })),
  getUserOrgs: vi.fn(async () => []),
}));
vi.mock("@/lib/resolve-locale", () => ({ resolveLocale: vi.fn(async () => "en") }));
vi.mock("@/lib/i18n", async () => {
  const runtime = await vi.importActual<typeof import("@/lib/i18n-runtime")>(
    "@/lib/i18n-runtime",
  );
  const ui = (await import("@/dictionaries/en/ui.json")).default;
  return { getDictionary: async () => ui, t: runtime.t };
});

import { getUserOrgs } from "@/lib/auth";
import NewOrgPage from "../page";

const orgs = vi.mocked(getUserOrgs);

const membership = (id: string, role: string): OrgMembership =>
  ({ id, name: id, slug: id, role }) as unknown as OrgMembership;

async function formProps(memberships: OrgMembership[]) {
  orgs.mockResolvedValue(memberships);
  const tree = await NewOrgPage();
  const form = walk(tree).find((el) => el.type === CreateOrgForm);
  expect(form, "the page must still render CreateOrgForm").toBeTruthy();
  return propsOf(form!);
}

beforeEach(() => vi.clearAllMocks());

describe("/orgs/new hands the form the organisations the visitor can open", () => {
  it("passes the visitor's own organisation ids", async () => {
    const props = await formProps([membership("org-a", "owner"), membership("org-b", "admin")]);
    expect(props.memberOrgIds).toEqual(["org-a", "org-b"]);
  });

  it("withholds a scorer-role organisation — requireOrgPage bounces those", async () => {
    // The positive discriminator is in the same list: the owner org survives,
    // so this is the scorer being filtered and not an empty hand-off.
    const props = await formProps([membership("org-a", "owner"), membership("org-scorer", "scorer")]);
    expect(props.memberOrgIds).toEqual(["org-a"]);
  });

  it("passes an empty list rather than nothing when the visitor has no orgs", async () => {
    const props = await formProps([]);
    expect(props.memberOrgIds).toEqual([]);
  });
});
