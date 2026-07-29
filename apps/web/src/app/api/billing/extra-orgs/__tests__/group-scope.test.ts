// v17 gap #334 — a group-scoped billing WRITE must act on the group the
// REQUEST names, not on the one the `seazn_org` cookie happens to still hold.
//
// The window is real and narrow: `ActiveOrgSync` re-points the cookie from a
// client effect that runs AFTER the destination page has painted, so a payer
// who lands on group B's Add-ons tab and saves early is authorised (they own
// both groups, `requireBillingOwner` has nothing to refuse) while the route
// resolves group A. And `count` is a TOTAL, not a delta — so choosing 1 for B
// rewrites A's total to 1 and CANCELS the riders A was standing on.
//
// These tests therefore assert the money, not a status code: group A's rider
// quantity in Stripe must be untouched. A 4xx would prove a refusal; only an
// unchanged quantity proves the write landed on the right bill.
//
// Real Postgres required; skipped without DATABASE_URL.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { User } from "@/lib/types";

// The entitlement/slug caches would otherwise answer a stale org row between
// tests in this file; every read here must see the row it just wrote.
vi.mock("@/lib/cache", () => ({
  cacheEnabled: () => false,
  cacheGet: async () => null,
  cacheSet: async () => {},
  cacheDelPattern: async () => {},
  incrWindow: async () => 1,
}));

/** A miniature Stripe: one item list per subscription id, mutated in place, so
 *  "what is group A billed for now" is a real observation rather than a spy
 *  argument. */
const stripeState = vi.hoisted(() => {
  const subs = new Map<
    string,
    { id: string; items: { id: string; quantity: number; price: { lookup_key: string | null } }[] }
  >();
  return { subs };
});
vi.mock("@/lib/stripe", () => ({
  getStripe: () => ({
    subscriptions: {
      retrieve: async (id: string) => {
        const sub = stripeState.subs.get(id);
        if (!sub) throw new Error(`test stripe: no subscription ${id}`);
        return { id: sub.id, items: { data: sub.items } };
      },
    },
    subscriptionItems: {
      update: async (itemId: string, params: { quantity?: number }) => {
        for (const sub of stripeState.subs.values()) {
          const item = sub.items.find((i) => i.id === itemId);
          if (item && params.quantity !== undefined) item.quantity = params.quantity;
        }
        return {};
      },
      create: async (params: { subscription: string; quantity: number }) => {
        const sub = stripeState.subs.get(params.subscription);
        if (!sub) throw new Error(`test stripe: no subscription ${params.subscription}`);
        sub.items.push({
          id: `si_${randomUUID().slice(0, 8)}`,
          quantity: params.quantity,
          price: { lookup_key: ORG_ADDON_LOOKUP_KEY },
        });
        return {};
      },
      del: async (itemId: string) => {
        for (const sub of stripeState.subs.values()) {
          const at = sub.items.findIndex((i) => i.id === itemId);
          if (at >= 0) sub.items.splice(at, 1);
        }
        return {};
      },
    },
    prices: { list: async () => ({ data: [{ id: "price_org_addon_test" }] }) },
  }),
}));

/** The session. `cookieOrgId` IS the `seazn_org` cookie — the value that lags
 *  the URL — and `requireUser` is the signed-in payer. */
const authState = vi.hoisted(() => ({ userId: "", cookieOrgId: null as string | null }));
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    requireUser: async () => ({ id: authState.userId }) as unknown as User,
    getCurrentUser: async () => ({ id: authState.userId }) as unknown as User,
    getActiveOrgId: async () => authState.cookieOrgId,
  };
});

/** The request's own headers. `orgScope` is what the page the payer is
 *  actually looking at puts on the request. */
const headerState = vi.hoisted(() => ({ orgScope: null as string | null }));
vi.mock("next/headers", () => ({
  headers: async () =>
    new Headers(headerState.orgScope ? { "x-seazn-org": headerState.orgScope } : {}),
  cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }),
}));

import { sql } from "@/lib/db";
import { createOrgForUser } from "@/lib/auth";
import { setOrgPlan } from "@/lib/__tests__/_billing-group";
import { orgAddonForPlan } from "@/lib/org-addons";
import { POST } from "@/app/api/billing/extra-orgs/route";

const ORG_ADDON_LOOKUP_KEY = orgAddonForPlan("pro")?.lookupKey ?? "extra_org_pro";
const HAS_DB = !!process.env.DATABASE_URL;
const uniq = () => randomUUID().slice(0, 8);

async function makeUser(): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified)
    values (${`group-scope-${uniq()}@test.local`}, 'Group Scope Payer', true) returning id`;
  return row!.id;
}

/** A billed Pro group of one org, holding `riders` extra-organisation units in
 *  Stripe. Returns everything a caller needs to point a request at it. */
async function makeBilledGroup(
  payerId: string,
  riders: number,
): Promise<{ orgId: string; orgSlug: string; groupId: string; stripeSubId: string }> {
  const org = await createOrgForUser(payerId, `Group Scope ${uniq()}`);
  const groupId = await setOrgPlan(org.id, "pro");
  const stripeSubId = `sub_${uniq()}`;
  await sql`
    update subscriptions
       set stripe_subscription_id = ${stripeSubId}, owner_user_id = ${payerId}
     where id = ${groupId}`;
  stripeState.subs.set(stripeSubId, {
    id: stripeSubId,
    items:
      riders > 0
        ? [{ id: `si_${uniq()}`, quantity: riders, price: { lookup_key: ORG_ADDON_LOOKUP_KEY } }]
        : [],
  });
  const [row] = await sql<{ slug: string }[]>`
    select slug from organizations where id = ${org.id}`;
  return { orgId: org.id, orgSlug: row!.slug, groupId, stripeSubId };
}

/** Extra-org units Stripe is billing this subscription for. */
function ridersOn(stripeSubId: string): number {
  const sub = stripeState.subs.get(stripeSubId);
  return (sub?.items ?? []).reduce((n, i) => n + i.quantity, 0);
}

function postExtraOrgs(count: number): Promise<Response> {
  return POST(
    new Request("http://test.local/api/billing/extra-orgs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ count }),
    }),
  );
}

describe.skipIf(!HAS_DB)("group-scoped billing writes follow the request, not the cookie", () => {
  beforeEach(() => {
    stripeState.subs.clear();
    authState.userId = "";
    authState.cookieOrgId = null;
    headerState.orgScope = null;
  });

  // Fixtures are left in place, as every other DB-backed suite here does: the
  // rows are unique per run and the test database is throwaway. Unpicking them
  // means organizations -> subscriptions -> users in FK order, which is more
  // teardown than a disposable schema is worth.

  it("saves group B's total onto group B while the cookie still names group A", async () => {
    const payer = await makeUser();
    // The group the payer just navigated AWAY from. Three riders it is
    // standing on and paying for.
    const a = await makeBilledGroup(payer, 3);
    // The group whose Add-ons tab is on screen. No riders yet.
    const b = await makeBilledGroup(payer, 0);

    // The race, exactly: the URL (and so the page) is B's; ActiveOrgSync has
    // not yet re-pointed the cookie, which still says A.
    authState.userId = payer;
    authState.cookieOrgId = a.orgId;
    headerState.orgScope = b.orgSlug;

    const res = await postExtraOrgs(1);

    // Not a refusal — the payer owns both groups and this is a legitimate
    // purchase. It simply has to land on B.
    expect(res.status).toBe(200);
    // THE MONEY, asserted FIRST: A never asked for anything. The two riders it
    // is standing on must not be cancelled by a save meant for another bill.
    expect(ridersOn(a.stripeSubId)).toBe(3);
    expect(ridersOn(b.stripeSubId)).toBe(1);
  });

  it("still uses the cookie when the request names no group", async () => {
    const payer = await makeUser();
    const a = await makeBilledGroup(payer, 0);

    authState.userId = payer;
    authState.cookieOrgId = a.orgId;
    headerState.orgScope = null;

    const res = await postExtraOrgs(2);

    expect(res.status).toBe(200);
    expect(ridersOn(a.stripeSubId)).toBe(2);
  });

  it("refuses a request naming a group its caller does not pay for", async () => {
    const payer = await makeUser();
    const stranger = await makeUser();
    const mine = await makeBilledGroup(payer, 0);
    const theirs = await makeBilledGroup(stranger, 4);

    authState.userId = payer;
    authState.cookieOrgId = mine.orgId;
    headerState.orgScope = theirs.orgSlug;

    const res = await postExtraOrgs(1);

    expect(res.status).toBe(403);
    expect(ridersOn(theirs.stripeSubId)).toBe(4);
    expect(ridersOn(mine.stripeSubId)).toBe(0);
  });

  it("refuses a request naming an organisation that does not exist", async () => {
    const payer = await makeUser();
    const a = await makeBilledGroup(payer, 3);

    authState.userId = payer;
    authState.cookieOrgId = a.orgId;
    headerState.orgScope = "no-such-organisation-slug";

    const res = await postExtraOrgs(1);

    // 400 — the same class, and the same remedy ("pick an organisation
    // again"), as a stale cookie. Never a silent fall back to the cookie:
    // that is the bug this closes.
    expect(res.status).toBe(400);
    expect(ridersOn(a.stripeSubId)).toBe(3);
  });
});
