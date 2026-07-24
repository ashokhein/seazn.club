// v17 Task 6: the daily cron entry point (api/cron/billing-grant) that grants
// every LIVE wallet its ai.credits.monthly(plan) * quantity_paid allowance —
// scaled for paid plans, flat for community (SPEC-2 §11.2). Each grant first
// expires any unspent grant-bucket leftover from the prior period (D1,
// use-or-lose, Task 6 review fix) before adding the new allowance. Idempotent
// per period: paid wallets key off the real `current_period_end` billing-cycle
// boundary (README §7 item 7's anchor), Community falls back to plain
// calendar month (accepted simplification, no Stripe period to anchor on).
// Real Postgres required; skipped without DATABASE_URL.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { balance, grantBalance, grantMonthlyForAllWallets } from "@/lib/credits";
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

// grantMonthlyForAllWallets full-table-scans every LIVE subscription row in
// the schema on each call. Run in isolation that's instant, but inside the
// FULL vitest run (thousands of fixture rows accumulated by every other
// suite in the same session) it can comfortably exceed vitest's default 5s
// per-test timeout — not a regression in the code path itself, just the cost
// of "every wallet" scaling with the whole test session's row count. Every
// test here bumps its timeout accordingly.
const CRON_TEST_TIMEOUT = 20000;

describe.skipIf(!HAS_DB)("grantMonthlyForAllWallets (billing-grant cron)", () => {
  it("grants a paid wallet the scaled amount (monthly(plan) * quantity_paid)", { timeout: CRON_TEST_TIMEOUT }, async () => {
    const orgId = await seedOrg();
    const subId = await setOrgPlan(orgId, "pro");
    await sql`update subscriptions set quantity_paid = 3 where id = ${subId}`;

    await grantMonthlyForAllWallets();

    expect(await balance(subId)).toBe(60 * 3);
  });

  it("grants a community wallet the FLAT 10, ignoring quantity_paid", { timeout: CRON_TEST_TIMEOUT }, async () => {
    const orgId = await seedOrg();
    const subId = await setOrgPlan(orgId, "community");
    // Even if quantity_paid were ever non-1 on a community group-of-one,
    // Community is never seat-scaled (SPEC-2 §11.2 — "never grouped").
    await sql`update subscriptions set quantity_paid = 5 where id = ${subId}`;

    await grantMonthlyForAllWallets();

    expect(await balance(subId)).toBe(10);
  });

  it("is a no-op on a second run in the same calendar month (idempotent per period)", { timeout: CRON_TEST_TIMEOUT }, async () => {
    const orgId = await seedOrg();
    const subId = await setOrgPlan(orgId, "pro_plus");

    await grantMonthlyForAllWallets();
    expect(await balance(subId)).toBe(200);

    await grantMonthlyForAllWallets();
    expect(await balance(subId)).toBe(200);
  });

  it("skips a canceled subscription (not live)", { timeout: CRON_TEST_TIMEOUT }, async () => {
    const orgId = await seedOrg();
    const subId = await setOrgPlan(orgId, "pro", "canceled");

    await grantMonthlyForAllWallets();

    expect(await balance(subId)).toBe(0);
  });

  it("expires the prior period's unspent grant balance before granting the new period (D1)", { timeout: CRON_TEST_TIMEOUT }, async () => {
    const orgId = await seedOrg();
    const subId = await setOrgPlan(orgId, "pro");
    // Leftover from a prior period the wallet never spent.
    await sql`
      insert into ai_credit_ledger (wallet_id, delta, source, bucket, balance_after, idempotency_key)
      values (${subId}, 15, 'monthly_grant', 'grant', 15, ${`seed-${randomUUID().slice(0, 8)}`})`;
    expect(await grantBalance(subId)).toBe(15);

    await grantMonthlyForAllWallets();

    // Not 15 + 60 banked — expired then re-granted to exactly this period's amount.
    expect(await grantBalance(subId)).toBe(60);
    expect(await balance(subId)).toBe(60);
  });

  it("anchors a paid wallet's period on current_period_end — a new Stripe cycle grants again within the same calendar month", { timeout: 30000 }, async () => {
    // grantMonthlyForAllWallets scans every LIVE subscription row in the
    // schema each call; this test calls it 3x sequentially, which — on a
    // long-running local schema with many accumulated fixture rows — can
    // exceed vitest's default 5s per-test timeout ([[feedback_run_live_billing_tests]]-adjacent
    // gotcha, not a real slowdown in the code path itself).
    const orgId = await seedOrg();
    const subId = await setOrgPlan(orgId, "pro");
    const cycle1 = new Date("2026-07-05T00:00:00Z");
    await sql`update subscriptions set current_period_end = ${cycle1} where id = ${subId}`;

    await grantMonthlyForAllWallets();
    expect(await balance(subId)).toBe(60);

    // Same calendar month, same period boundary — a second poll (e.g. the
    // next day's cron run) must be a no-op, not a calendar-month re-grant.
    await grantMonthlyForAllWallets();
    expect(await balance(subId)).toBe(60);

    // Stripe rolls the subscription to its next cycle (webhook sync advances
    // current_period_end) — still the same calendar month, but a genuinely
    // new billing period, so the next poll must expire + re-grant.
    const cycle2 = new Date("2026-07-19T00:00:00Z");
    await sql`update subscriptions set current_period_end = ${cycle2} where id = ${subId}`;

    await grantMonthlyForAllWallets();
    expect(await grantBalance(subId)).toBe(60); // reset to the new period's own amount, not 120
    expect(await balance(subId)).toBe(60);
  });

  it("Community wallets fall back to plain calendar month (no Stripe period to anchor on)", { timeout: CRON_TEST_TIMEOUT }, async () => {
    const orgId = await seedOrg();
    const subId = await setOrgPlan(orgId, "community");
    const [row] = await sql<{ current_period_end: string | null }[]>`
      select current_period_end from subscriptions where id = ${subId}`;
    expect(row?.current_period_end).toBeNull();

    await grantMonthlyForAllWallets();
    expect(await balance(subId)).toBe(10);

    await grantMonthlyForAllWallets();
    expect(await balance(subId)).toBe(10); // still idempotent via the calendar-month key
  });
});
