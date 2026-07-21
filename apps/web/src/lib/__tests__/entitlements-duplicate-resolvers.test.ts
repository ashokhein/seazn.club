// The app used to resolve entitlements in three places: lib/entitlements.ts,
// api/orgs/[id]/entitlements/route.ts and assertMayOwnAnotherOrg. The last two
// re-implemented resolution in raw SQL and drifted — neither honoured
// comped_until or the past_due grace. This suite pins the org-creation cap to
// the ONE resolver, so a lapsed comp can no longer keep the Pro cap.
//
// Real Postgres required; skipped without DATABASE_URL. Seeds are run-unique.
import { afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

// Route-level auth is stubbed (no cookie/JWT in a unit test); everything the
// route actually does runs for real. importOriginal is load-bearing here —
// assertMayOwnAnotherOrg below is the REAL implementation, not a mock. Same
// pattern as billing-pass-duplicate.test.ts:44-50.
vi.mock("@/lib/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth")>()),
  requireOrgRole: vi.fn(async () => ({
    user: { id: "d0d0d0d0-0000-4000-8000-000000000009" },
    role: "owner" as const,
  })),
}));

import { sql } from "@/lib/db";
import { assertMayOwnAnotherOrg } from "@/lib/auth";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import { GET as entitlementsGET } from "@/app/api/orgs/[id]/entitlements/route";

const HAS_DB = !!process.env.DATABASE_URL;
const uniq = () => randomUUID().slice(0, 8);

/** A user owning exactly one org, with an explicit subscriptions row.
 *  Returns both ids. Same local-helper convention as
 *  entitlements-comp-liveness.test.ts:26-45 — there is no factories module. */
async function seedOwnerWithOneOrg(): Promise<{ userId: string; orgId: string }> {
  const s = uniq();
  const [{ id: userId }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified)
    values (${`dupres-${s}@test.local`}, 'Dup Owner', true) returning id`;
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug, created_by)
    values (${"Dup " + s}, ${"dup-" + s}, ${userId}) returning id`;
  await sql`insert into org_members (org_id, user_id, role) values (${orgId}, ${userId}, 'owner')`;
  await sql`
    insert into subscriptions (org_id, plan_key, status)
    values (${orgId}, 'community', 'active')`;
  return { userId, orgId };
}

interface EntPayload {
  plan_key: string;
  status: string;
  trial_end: string | null;
  current_period_end: string | null;
  usage: { competitions_active_count: number; dashboards_public_count: number };
  entitlements: Record<string, { enabled?: boolean; limit?: number | null }>;
}

async function readPanel(orgId: string): Promise<EntPayload> {
  // Overrides/subscriptions are written by raw SQL above, which the resolver's
  // 5-min cache never sees; bust it the way the app's write paths do.
  await invalidateOrgEntitlements(orgId);
  const res = await entitlementsGET(new Request("http://t/x"), {
    params: Promise.resolve({ id: orgId }),
  });
  const body = (await res.json()) as { ok: boolean; data: EntPayload };
  expect(body.ok).toBe(true);
  return body.data;
}

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

// Every case here writes subscriptions/overrides in raw SQL and then resolves
// through getLimit, so each busts the entitlement cache first — same reason as
// readPanel. Freshly-seeded orgs happen to be a guaranteed cache miss today,
// but relying on that would go stale the moment a case resolves an org twice.
describe.skipIf(!HAS_DB)("assertMayOwnAnotherOrg respects read-time degradations", () => {
  it("refuses a lapsed comp beyond the community cap", async () => {
    const { userId, orgId } = await seedOwnerWithOneOrg();
    await sql`
      update subscriptions
      set plan_key = 'pro', comped_until = now() - interval '1 day',
          stripe_subscription_id = null
      where org_id = ${orgId}`;
    await invalidateOrgEntitlements(orgId);
    // community orgs.max_owned = 1, and they already own one.
    await expect(assertMayOwnAnotherOrg(userId)).rejects.toThrow();
  });

  it("still allows a live pro org a second org", async () => {
    const { userId, orgId } = await seedOwnerWithOneOrg();
    await sql`
      update subscriptions set plan_key = 'pro', status = 'active'
      where org_id = ${orgId}`;
    await invalidateOrgEntitlements(orgId);
    // pro orgs.max_owned = 3 (V112 seeded 5; V270__pricing_v3_matrix.sql:9
    // dropped it to 3, which is why the grandfathering overrides exist).
    // Owning one, a second is within cap.
    await expect(assertMayOwnAnotherOrg(userId)).resolves.toBeUndefined();
  });

  it("lets a user who owns nothing create their first", async () => {
    const s = uniq();
    const [{ id: userId }] = await sql<{ id: string }[]>`
      insert into users (email, display_name, email_verified)
      values (${`dupres-none-${s}@test.local`}, 'No Orgs', true) returning id`;
    await expect(assertMayOwnAnotherOrg(userId)).resolves.toBeUndefined();
  });

  it("an unlimited override on an owned org lifts the user (v3 grandfathering)", async () => {
    const { userId, orgId } = await seedOwnerWithOneOrg();
    // Community caps at 1 and they already own one, so only the override can
    // let this through. A null int_value is UNLIMITED, not "no answer".
    await sql`
      insert into org_entitlement_overrides (org_id, feature_key, int_value)
      values (${orgId}, 'orgs.max_owned', null)`;
    await invalidateOrgEntitlements(orgId);
    await expect(assertMayOwnAnotherOrg(userId)).resolves.toBeUndefined();
  });

  it("ignores an expired override", async () => {
    const { userId, orgId } = await seedOwnerWithOneOrg();
    await sql`
      insert into org_entitlement_overrides (org_id, feature_key, int_value, expires_at)
      values (${orgId}, 'orgs.max_owned', 9, now() - interval '1 day')`;
    await invalidateOrgEntitlements(orgId);
    await expect(assertMayOwnAnotherOrg(userId)).rejects.toThrow();
  });
});

describe.skipIf(!HAS_DB)("the org plan panel shows what enforcement will do", () => {
  it("keeps its response shape", async () => {
    const { orgId } = await seedOwnerWithOneOrg();
    const data = await readPanel(orgId);
    expect(Object.keys(data).sort()).toEqual([
      "current_period_end",
      "entitlements",
      "plan_key",
      "status",
      "trial_end",
      "usage",
    ]);
    expect(data.trial_end).toBeNull();
    expect(data.plan_key).toBe("community");
    expect(data.status).toBe("active");
    expect(data.current_period_end).toBeNull();
    expect(data.usage).toEqual({
      competitions_active_count: 0,
      dashboards_public_count: 0,
    });
    // Boolean keys still report { enabled }, numeric keys still { limit }.
    expect(data.entitlements["exports"]).toEqual({ enabled: true });
    expect(data.entitlements["competitions.max_active"]).toEqual({ limit: 1 });
  });

  it("degrades a lapsed comp instead of promising the Pro matrix", async () => {
    const { orgId } = await seedOwnerWithOneOrg();
    await sql`
      update subscriptions
      set plan_key = 'pro', comped_until = now() - interval '1 day',
          stripe_subscription_id = null
      where org_id = ${orgId}`;
    const data = await readPanel(orgId);
    // The raw plan_key is still reported (contract), but every VALUE resolves
    // as community: pro is unlimited here, community caps at 1.
    expect(data.plan_key).toBe("pro");
    expect(data.entitlements["competitions.max_active"]).toEqual({ limit: 1 });
    expect(data.entitlements["api.access"]).toEqual({ enabled: false });
  });

  it("ignores an expired override", async () => {
    const { orgId } = await seedOwnerWithOneOrg();
    await sql`
      insert into org_entitlement_overrides (org_id, feature_key, bool_value, expires_at)
      values (${orgId}, 'api.access', true, now() - interval '1 day')`;
    const data = await readPanel(orgId);
    expect(data.entitlements["api.access"]).toEqual({ enabled: false });
  });

  it("does not demote an unlimited override to the plan's number", async () => {
    const { orgId } = await seedOwnerWithOneOrg();
    // community competitions.max_active = 1; a null int_value is UNLIMITED,
    // and coalescing it against the plan row silently took the grant away.
    await sql`
      insert into org_entitlement_overrides (org_id, feature_key, int_value)
      values (${orgId}, 'competitions.max_active', null)`;
    const data = await readPanel(orgId);
    expect(data.entitlements["competitions.max_active"]).toEqual({ limit: null });
  });
});
