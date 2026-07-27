// v17 Task 6 (re-review, CRITICAL cadence fix): the daily cron entry point
// (api/cron/billing-grant) that grants every LIVE wallet its
// ai.credits.monthly(plan) * quantity_paid allowance — scaled for paid plans,
// flat for community (SPEC-2 §11.2). Each grant first expires any unspent
// grant-bucket leftover from the prior period (D1, use-or-lose, Task 6 review
// fix) before adding the new allowance. Idempotent per period: EVERY wallet —
// paid or Community — keys its period off the plain calendar month
// (`YYYY-MM`, server clock; README §7 item 7's anchor). This is deliberately
// NOT the Stripe billing-cycle boundary (`current_period_end`): SPEC-2 §5.4
// Cadence requires the grant to be monthly *regardless of billing cadence* —
// an annual Pro ($159/yr) still gets 60/mo × 12, not a 720 lump — and an
// annual subscription's `current_period_end` only advances once a year, so
// anchoring on it (a prior version of this cron did, for paid wallets) is a
// cadence regression, not an approximation.
// Real Postgres required; skipped without DATABASE_URL.
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
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

afterEach(() => {
  vi.useRealTimers();
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

  it("REGRESSION (#290): grants the resolved Community rate for a canceled (churned) subscription, not zero", { timeout: CRON_TEST_TIMEOUT }, async () => {
    const orgId = await seedOrg();
    // comped_at stays null (setOrgPlan's default) — orgPlanKey's `canceled`
    // arm degrades this to community, exactly like any other entitlement
    // read of this org (hasFeature, getLimit, the billing page).
    const subId = await setOrgPlan(orgId, "pro", "canceled");

    await grantMonthlyForAllWallets();

    // Before #290 the raw status filter (`status in ('trialing','active',
    // 'past_due')`) skipped this row entirely — a churned org got 0 credits
    // forever even though every OTHER entitlement read already resolves it
    // to Community and expects the Community grant to back that up.
    expect(await balance(subId)).toBe(10);
  });

  it("REGRESSION (#290): grants the resolved Community rate for an incomplete (never-paid) subscription", { timeout: CRON_TEST_TIMEOUT }, async () => {
    const orgId = await seedOrg();
    const subId = await setOrgPlan(orgId, "pro", "incomplete");

    await grantMonthlyForAllWallets();

    expect(await balance(subId)).toBe(10);
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

  it("a paid wallet's period is the calendar month, never current_period_end — a Stripe cycle change within the same month is a no-op", { timeout: CRON_TEST_TIMEOUT }, async () => {
    const orgId = await seedOrg();
    const subId = await setOrgPlan(orgId, "pro");
    const cycle1 = new Date("2026-07-05T00:00:00Z");
    await sql`update subscriptions set current_period_end = ${cycle1} where id = ${subId}`;

    await grantMonthlyForAllWallets();
    expect(await balance(subId)).toBe(60);

    // Same calendar month, same period boundary — a second poll (e.g. the
    // next day's cron run) must be a no-op.
    await grantMonthlyForAllWallets();
    expect(await balance(subId)).toBe(60);

    // Stripe rolls the subscription to a new cycle (webhook sync advances
    // current_period_end) but we're still in the SAME calendar month — this
    // must stay a no-op. Anchoring on current_period_end (the pre-fix
    // behavior) would have expired + re-granted here; the fix must not.
    const cycle2 = new Date("2026-07-19T00:00:00Z");
    await sql`update subscriptions set current_period_end = ${cycle2} where id = ${subId}`;

    await grantMonthlyForAllWallets();
    expect(await grantBalance(subId)).toBe(60); // still exactly one month's grant, not 120
    expect(await balance(subId)).toBe(60);
  });

  it("Community wallets grant on plain calendar month (no Stripe period at all)", { timeout: CRON_TEST_TIMEOUT }, async () => {
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

  it("REGRESSION (SPEC-2 §5.4 Cadence): an annual (yearly-renewing) Pro subscription still grants 12x/year, not a single lump", { timeout: 30000 }, async () => {
    // grantMonthlyForAllWallets scans every LIVE subscription row in the
    // schema each call; this test calls it across simulated months, which —
    // on a long-running local schema with many accumulated fixture rows —
    // can exceed vitest's default 5s per-test timeout
    // ([[feedback_run_live_billing_tests]]-adjacent gotcha, not a real
    // slowdown in the code path itself).
    const orgId = await seedOrg();
    const subId = await setOrgPlan(orgId, "pro");
    // Simulate an ANNUAL Stripe cycle: current_period_end sits a full year
    // out and never moves across this test — exactly the shape that made
    // the old current_period_end-anchored cron grant only ONCE for the
    // whole year (60, not 720/12mo). The fix must grant fresh credits every
    // calendar month regardless.
    await sql`
      update subscriptions
         set current_period_end = ${new Date("2027-06-01T00:00:00Z")}
       where id = ${subId}`;

    vi.useFakeTimers({ now: new Date("2026-06-05T00:00:00Z"), toFake: ["Date"] });

    await grantMonthlyForAllWallets();
    expect(await balance(subId)).toBe(60); // month N

    // Same calendar month — a second poll must stay a no-op.
    await grantMonthlyForAllWallets();
    expect(await balance(subId)).toBe(60);

    // Advance to month N+1 — current_period_end is UNCHANGED (still a year
    // out), yet a fresh grant must land: cadence is monthly, not
    // billing-cycle.
    vi.setSystemTime(new Date("2026-07-03T00:00:00Z"));
    await grantMonthlyForAllWallets();
    expect(await grantBalance(subId)).toBe(60); // reset to this month's own 60, not banked to 120
    expect(await balance(subId)).toBe(60);

    // ...and month N+2, proving this isn't a one-off double-grant fluke —
    // 3 calendar months in, 3 grants, still 60 in the bucket each time
    // (180 total ever granted across the ledger, use-or-lose resets each).
    vi.setSystemTime(new Date("2026-08-10T00:00:00Z"));
    await grantMonthlyForAllWallets();
    expect(await grantBalance(subId)).toBe(60);
    expect(await balance(subId)).toBe(60);
  });
});
