// v17 gap #333 — a billing group's PAYER must be able to open the billing UI
// for the bill they fund, even when they are not a member of any organisation
// on it.
//
// That state is reachable by design, not by accident: `transferGroup` moves
// `subscriptions.owner_user_id` ALONE and leaves memberships untouched, and an
// org owner may remove the payer from the org at any time. Gated on membership
// — which is what every organiser page under `/o/[orgSlug]` is, and rightly —
// the payer keeps paying for a group whose Billing, Credits and Add-ons tabs
// all 404 on them. Not even cancelling is reachable.
//
// The relaxation is ONE sentence wide and these tests bound it on every side:
// a stranger is still refused, a scorer still bounces, and a member is admitted
// on exactly the terms they had before.
//
// Real Postgres required; skipped without DATABASE_URL.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { User } from "@/lib/types";

// The membership list is read through this cache; a stale answer would make a
// just-removed member look admitted.
vi.mock("@/lib/cache", () => ({
  cacheEnabled: () => false,
  cacheGet: async () => null,
  cacheSet: async () => {},
  cacheDelPattern: async () => {},
  incrWindow: async () => 1,
}));

// `notFound()` / `redirect()` throw control-flow errors that Next unwraps. Make
// each one a distinguishable exception so a test can tell "refused" from
// "bounced to My matches" — a refusal that silently became a redirect would
// otherwise read as a pass.
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
  redirect: (to: string) => {
    throw new Error(`REDIRECT:${to}`);
  },
  permanentRedirect: (to: string) => {
    throw new Error(`PERMANENT_REDIRECT:${to}`);
  },
}));

const authState = vi.hoisted(() => ({ userId: "" }));
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    getCurrentUser: async () => (authState.userId ? ({ id: authState.userId } as User) : null),
    getActiveOrgId: async () => null,
  };
});

import { sql } from "@/lib/db";
import { createOrgForUser } from "@/lib/auth";
import { setOrgPlan } from "@/lib/__tests__/_billing-group";
import { requireBillingPage, requireOrgPage } from "@/server/page-auth";

const HAS_DB = !!process.env.DATABASE_URL;
const uniq = () => randomUUID().slice(0, 8);

async function makeUser(label: string): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified)
    values (${`payer-access-${label}-${uniq()}@test.local`}, ${label}, true) returning id`;
  return row!.id;
}

/**
 * The shape the issue describes: a club (`orgSlug`) whose owner is `ownerId`,
 * billed by a group whose payer is `payerId` — and the payer is NOT a member of
 * the club. Built the way production reaches it: the club keeps its own
 * memberships, only its `subscription_id` moves onto the payer's group.
 */
async function makeFundedClub(): Promise<{
  payerId: string;
  ownerId: string;
  orgId: string;
  orgSlug: string;
}> {
  const payerId = await makeUser("Payer");
  const ownerId = await makeUser("ClubOwner");
  // The payer's own organisation carries the group they pay for.
  const payerOrg = await createOrgForUser(payerId, `Payer Org ${uniq()}`);
  const groupId = await setOrgPlan(payerOrg.id, "pro");
  await sql`update subscriptions set owner_user_id = ${payerId} where id = ${groupId}`;

  const club = await createOrgForUser(ownerId, `Funded Club ${uniq()}`);
  await sql`update organizations set subscription_id = ${groupId} where id = ${club.id}`;
  const [row] = await sql<{ slug: string }[]>`
    select slug from organizations where id = ${club.id}`;
  return { payerId, ownerId, orgId: club.id, orgSlug: row!.slug };
}

async function setRole(orgId: string, userId: string, role: string): Promise<void> {
  await sql`
    insert into org_members (org_id, user_id, role) values (${orgId}, ${userId}, ${role})
    on conflict (org_id, user_id) do update set role = ${role}`;
}

describe.skipIf(!HAS_DB)("a group's payer can open the billing UI for the bill they fund", () => {
  beforeEach(() => {
    authState.userId = "";
  });

  it("admits the payer of an organisation's group even with no membership in it", async () => {
    const club = await makeFundedClub();
    authState.userId = club.payerId;

    // The state the issue is about: they fund it and are not in it.
    const [membership] = await sql`
      select 1 from org_members where org_id = ${club.orgId} and user_id = ${club.payerId}`;
    expect(membership).toBeUndefined();

    const page = await requireBillingPage(club.orgSlug, { tail: "/settings/billing" });

    expect(page.org.id).toBe(club.orgId);
    expect(page.user.id).toBe(club.payerId);
    // Admitted to the BILL, not to the club: no role, and nothing editable.
    expect(page.viaPayer).toBe(true);
    expect(page.canEdit).toBe(false);
    expect(page.org.role).toBeNull();
  });

  it("still refuses a non-member who does not pay for the organisation's group", async () => {
    const club = await makeFundedClub();
    const stranger = await makeUser("Stranger");
    authState.userId = stranger;

    await expect(requireBillingPage(club.orgSlug, { tail: "/settings/billing" })).rejects.toThrow(
      "NOT_FOUND",
    );
  });

  it("still refuses a payer of a DIFFERENT group", async () => {
    const club = await makeFundedClub();
    const other = await makeFundedClub();
    // Pays for their own bill, and only for their own.
    authState.userId = other.payerId;

    await expect(requireBillingPage(club.orgSlug, { tail: "/settings/billing" })).rejects.toThrow(
      "NOT_FOUND",
    );
  });

  it("admits a member on exactly the terms requireOrgPage gives them", async () => {
    const club = await makeFundedClub();
    authState.userId = club.ownerId;

    const viaBilling = await requireBillingPage(club.orgSlug, { tail: "/settings/billing" });
    const viaOrg = await requireOrgPage(club.orgSlug, { tail: "/settings/billing" });

    expect(viaBilling.org.role).toBe("owner");
    expect(viaBilling.org.role).toBe(viaOrg.org.role);
    expect(viaBilling.canEdit).toBe(viaOrg.canEdit);
    expect(viaBilling.auth).toEqual(viaOrg.auth);
    expect(viaBilling.viaPayer).toBe(false);
  });

  it("still bounces a scorer who does not pay for the group", async () => {
    const club = await makeFundedClub();
    const scorer = await makeUser("Scorer");
    await setRole(club.orgId, scorer, "scorer");
    authState.userId = scorer;

    await expect(requireBillingPage(club.orgSlug, { tail: "/settings/billing" })).rejects.toThrow(
      "REDIRECT:/my-matches",
    );
  });

  it("admits a viewer, as the billing tabs have always been member-visible", async () => {
    const club = await makeFundedClub();
    const viewer = await makeUser("Viewer");
    await setRole(club.orgId, viewer, "viewer");
    authState.userId = viewer;

    const page = await requireBillingPage(club.orgSlug, { tail: "/settings/billing" });
    expect(page.org.role).toBe("viewer");
    expect(page.viaPayer).toBe(false);
  });
});

// ---------------------------------------------------------------------------

/**
 * The wiring, which is half of what #333 asks for: "the Add-ons, Billing and
 * Credits tabs should reach it together — solving it for one leaves the same
 * dead end on the other two." A payer-aware gate that only one tab calls closes
 * nothing, and no behavioural test of a single page would notice.
 */
describe("all three billing tabs reach the same gate", () => {
  const dir = path.resolve(__dirname, "..");
  const surfaces = [
    "billing/page.tsx",
    "credits/page.tsx",
    "add-ons/page.tsx",
    // The Credits tab's own Export button. A payer who can open the tab and
    // then 404s on its download is the same dead end one door further in.
    "billing/credits.csv/route.ts",
  ] as const;

  it.each(surfaces)("%s gates on requireBillingPage, not requireOrgPage", (surface) => {
    const src = readFileSync(path.join(dir, surface), "utf8");
    expect(src).toContain("requireBillingPage(");
    expect(src).not.toContain("requireOrgPage(");
  });
});
