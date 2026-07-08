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
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug) values (${"Bill " + s}, ${"bill-" + s}) returning id`;
  await sql`
    insert into subscriptions (org_id, plan_key, status, stripe_subscription_id)
    values (${orgId}, 'pro', 'active', ${opts.stripeSub ?? null})
    on conflict (org_id) do update set plan_key = 'pro', stripe_subscription_id = ${opts.stripeSub ?? null}`;
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
    expect(await hasFeature(orgId, "clubs.hierarchy")).toBe(true); // Pro feature on

    await downgradeToCommunity(orgId);

    const [row] = await sql<{ plan_key: string }[]>`select plan_key from subscriptions where org_id = ${orgId}`;
    expect(row.plan_key).toBe("community");
    expect(await hasFeature(orgId, "clubs.hierarchy")).toBe(false); // revoked
  });

  it("refuses when the org is billed through Stripe (must use the portal)", async () => {
    const orgId = await seedProOrg({ stripeSub: "sub_test_123" });
    await expect(downgradeToCommunity(orgId)).rejects.toMatchObject({ status: 400 });
    const [row] = await sql<{ plan_key: string }[]>`select plan_key from subscriptions where org_id = ${orgId}`;
    expect(row.plan_key).toBe("pro"); // unchanged
  });
});
