// In-app downgrade to Community for comped (non-Stripe) orgs. A Stripe-billed
// org must cancel via the portal, so the downgrade refuses. Real Postgres.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { hasFeature } from "@/lib/entitlements";
import { downgradeToCommunity } from "@/lib/billing";

const HAS_DB = !!process.env.DATABASE_URL;

async function seedProOrg(opts: { stripeSub?: string } = {}): Promise<string> {
  const s = randomUUID().slice(0, 8);
  const [{ id: payerId }] = await sql<{ id: string }[]>`
    insert into users (email, display_name)
    values (${"payer-" + s + "@test.local"}, 'Payer') returning id`;
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug, created_by)
    values (${"Bill " + s}, ${"bill-" + s}, ${payerId}) returning id`;
  await sql`
    with s as (
      insert into subscriptions (owner_user_id, plan_key, status, stripe_subscription_id)
      select o.created_by, 'pro', 'active', ${opts.stripeSub ?? null}
        from organizations o where o.id = ${orgId}
      returning id
    )
    update organizations o set subscription_id = s.id from s where o.id = ${orgId}`;
  return orgId;
}

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

describe.skipIf(!HAS_DB)("downgradeToCommunity", () => {
  it("downgrades a comped Pro org and revokes Pro entitlements", async () => {
    const orgId = await seedProOrg();
    // clubs.hierarchy went free-for-all-plans in the clubs W1 wave, so probe a
    // feature that stays Pro-only to prove the downgrade actually revokes.
    expect(await hasFeature(orgId, "exports.branded")).toBe(true); // Pro feature on

    await downgradeToCommunity(orgId);

    const [row] = await sql<
      { plan_key: string }[]
    >`select plan_key from subscriptions where id = (select subscription_id from organizations where id = ${orgId})`;
    expect(row.plan_key).toBe("community");
    expect(await hasFeature(orgId, "exports.branded")).toBe(false); // revoked
  });

  // A DEPARTED org keeps its cancelled subscription id for ever. The guard above
  // lets it through (not live), so the UPDATE actually runs on it — and writing
  // status = 'active' onto a row that still holds an id makes it LIVE again.
  // plan_key alone cannot catch that: the entitlement probe reads false either
  // way once plan_key is 'community'. The status and the second call do.
  it("un-comping a departed org leaves its cancelled status alone and stays idempotent", async () => {
    const orgId = await seedProOrg({ stripeSub: "sub_gone" });
    await sql`update subscriptions set status = 'canceled' where id = (select subscription_id from organizations where id = ${orgId})`;

    await downgradeToCommunity(orgId);

    const [row] = await sql<{ plan_key: string; status: string }[]>`
      select plan_key, status from subscriptions where id = (select subscription_id from organizations where id = ${orgId})`;
    expect(row.plan_key).toBe("community");
    // 'active' here would resurrect liveness on the dead id.
    expect(row.status).toBe("canceled");

    // The docstring promises idempotence: a second call must not 400 with
    // "billed through Stripe" because the first call faked a live status.
    await expect(downgradeToCommunity(orgId)).resolves.toBeUndefined();
  });

  it("refuses when the org is billed through Stripe (must use the portal)", async () => {
    const orgId = await seedProOrg({ stripeSub: "sub_test_123" });
    await expect(downgradeToCommunity(orgId)).rejects.toMatchObject({
      status: 400,
    });
    const [row] = await sql<
      { plan_key: string }[]
    >`select plan_key from subscriptions where id = (select subscription_id from organizations where id = ${orgId})`;
    expect(row.plan_key).toBe("pro"); // unchanged
  });
});
