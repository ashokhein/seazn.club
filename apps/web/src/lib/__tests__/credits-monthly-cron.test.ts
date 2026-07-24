// v17 Task 6: the daily cron entry point (api/cron/billing-grant) that grants
// every LIVE wallet its ai.credits.monthly(plan) * quantity_paid allowance —
// scaled for paid plans, flat for community (SPEC-2 §11.2). Idempotent per
// calendar month, inherited from grantMonthly's own idempotency key.
// Real Postgres required; skipped without DATABASE_URL.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { balance, grantMonthlyForAllWallets } from "@/lib/credits";
import { setOrgPlan } from "./_billing-group";

const HAS_DB = !!process.env.DATABASE_URL;

async function seedOrg(): Promise<string> {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: ownerId }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified)
    values (${`cron-${suffix}@test.local`}, 'Cron Owner', true) returning id`;
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug, created_by)
    values (${"Cron Org " + suffix}, ${"cron-org-" + suffix}, ${ownerId}) returning id`;
  return orgId;
}

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("grantMonthlyForAllWallets (billing-grant cron)", () => {
  it("grants a paid wallet the scaled amount (monthly(plan) * quantity_paid)", async () => {
    const orgId = await seedOrg();
    const subId = await setOrgPlan(orgId, "pro");
    await sql`update subscriptions set quantity_paid = 3 where id = ${subId}`;

    await grantMonthlyForAllWallets();

    expect(await balance(subId)).toBe(60 * 3);
  });

  it("grants a community wallet the FLAT 10, ignoring quantity_paid", async () => {
    const orgId = await seedOrg();
    const subId = await setOrgPlan(orgId, "community");
    // Even if quantity_paid were ever non-1 on a community group-of-one,
    // Community is never seat-scaled (SPEC-2 §11.2 — "never grouped").
    await sql`update subscriptions set quantity_paid = 5 where id = ${subId}`;

    await grantMonthlyForAllWallets();

    expect(await balance(subId)).toBe(10);
  });

  it("is a no-op on a second run in the same calendar month (idempotent per period)", async () => {
    const orgId = await seedOrg();
    const subId = await setOrgPlan(orgId, "pro_plus");

    await grantMonthlyForAllWallets();
    expect(await balance(subId)).toBe(200);

    await grantMonthlyForAllWallets();
    expect(await balance(subId)).toBe(200);
  });

  it("skips a canceled subscription (not live)", async () => {
    const orgId = await seedOrg();
    const subId = await setOrgPlan(orgId, "pro", "canceled");

    await grantMonthlyForAllWallets();

    expect(await balance(subId)).toBe(0);
  });
});
