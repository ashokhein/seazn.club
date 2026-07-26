// Shared setup for the two LIVE pass-credit suites (pass-credit.live.test.ts
// and pass-credit-clock.live.test.ts). Not a test file: vitest's default
// include only collects *.test.ts / *.spec.ts, so this is never run on its own.
//
// Both suites need the same thing — an org that has really paid Stripe for one
// Event Pass, wired to a real Stripe customer — and it is worth having exactly
// one definition of "really paid" rather than two that can drift.
import { expect } from "vitest";
import type Stripe from "stripe";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";

/** Set price points from stripe-plans.json — the gbp column, never converted. */
export const PASS_GBP = 2_500;
export const PRO_MONTHLY_GBP = 1_500;
export const PRO_ANNUAL_GBP = 12_500;

export interface PassFixture {
  orgId: string;
  customerId: string;
  intent: string;
}

/** Every org seeded this run, for the suite's afterAll. */
export const seededOrgIds: string[] = [];

const uniq = () => randomUUID().slice(0, 12);

/**
 * The state POST /api/billing/checkout finds when a pass buyer upgrades: a
 * Stripe customer carrying a real succeeded pass payment, and the local rows
 * (organizations → subscriptions, competition_passes) the usecase reads.
 *
 * `subCurrency` is the org's pinned billing currency and defaults to the pass
 * currency; passing a different one builds the mismatch case. `testClock`
 * attaches the customer to a clock — the only way to reach a trial-end invoice
 * without waiting 14 days.
 */
export async function passFixture(
  stripe: Stripe,
  opts: {
    amount?: number;
    currency?: string;
    subCurrency?: string;
    testClock?: string;
  } = {},
): Promise<PassFixture> {
  const amount = opts.amount ?? PASS_GBP;
  const currency = opts.currency ?? "gbp";
  const suffix = uniq();

  const customer = await stripe.customers.create({
    email: `pass-credit-probe-${suffix}@example.com`,
    payment_method: "pm_card_visa",
    invoice_settings: { default_payment_method: "pm_card_visa" },
    ...(opts.testClock ? { test_clock: opts.testClock } : {}),
  });

  // The pass purchase itself. off_session + allow_redirects:"never" so a test
  // card confirms in one call without a return url; never payment_method_types
  // (dynamic payment methods stay on).
  const pi = await stripe.paymentIntents.create({
    amount,
    currency,
    customer: customer.id,
    payment_method: "pm_card_visa",
    confirm: true,
    off_session: true,
    automatic_payment_methods: { enabled: true, allow_redirects: "never" },
    description: `Event Pass probe ${suffix}`,
  });
  expect(pi.status, "the pass payment must have succeeded").toBe("succeeded");

  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug)
    values (${"Pass Credit Live " + suffix}, ${"pass-credit-live-" + suffix}) returning id`;
  seededOrgIds.push(orgId);
  await sql`
    with _owner as (
      insert into users (email, display_name, email_verified)
      values ('passcredit-' || gen_random_uuid() || '@test.local', 'Probe Owner', true)
      returning id
    ),
    _seed_sub as (
      insert into subscriptions (owner_user_id, plan_key, status, stripe_customer_id, currency)
      select coalesce(o.created_by, (select id from _owner)), 'community', 'active',
             ${customer.id}, ${opts.subCurrency ?? currency}
      from organizations o where o.id = ${orgId}
      returning id
    )
    update organizations set subscription_id = (select id from _seed_sub) where id = ${orgId}`;

  const [{ id: competitionId }] = await sql<{ id: string }[]>`
    insert into competitions (org_id, name, slug)
    values (${orgId}, ${"Probe Cup " + suffix}, ${"probe-cup-" + suffix}) returning id`;
  // A day old: comfortably inside the 30-day window, and far enough back that
  // the alreadyCredited scan's `created >= purchased_at` bound cannot be
  // tripped by clock skew between this machine and Stripe.
  await sql`
    insert into competition_passes (competition_id, org_id, stripe_payment_intent, purchased_at)
    values (${competitionId}, ${orgId}, ${pi.id}, now() - interval '1 day')`;

  return { orgId, customerId: customer.id, intent: pi.id };
}

/** The gbp-priced Pro prices Stripe holds, straight from the plans table. */
export async function proPrices(): Promise<{ monthly: string; annual: string }> {
  const [pro] = await sql<{ monthly: string | null; annual: string | null }[]>`
    select stripe_price_id_monthly as monthly, stripe_price_id_annual as annual
    from plans where key = 'pro'`;
  expect(pro?.monthly, "plans table needs Stripe price ids (npm run stripe:sync)").toBeTruthy();
  return { monthly: pro!.monthly!, annual: pro!.annual! };
}

/** Drop every row this run seeded, then close the shared postgres client. */
export async function dropSeededOrgs(): Promise<void> {
  if (seededOrgIds.length) {
    await sql`delete from competition_passes where org_id = any(${seededOrgIds})`;
    await sql`delete from competitions where org_id = any(${seededOrgIds})`;
    // Orgs point AT subscriptions (V314), so capture the group ids, drop the
    // orgs to clear the FK, then the subscriptions they billed through.
    const groups = await sql<{ subscription_id: string }[]>`
      select subscription_id from organizations
      where id = any(${seededOrgIds}) and subscription_id is not null`;
    await sql`delete from organizations where id = any(${seededOrgIds})`;
    if (groups.length)
      await sql`delete from subscriptions where id = any(${groups.map((g) => g.subscription_id)})`;
  }
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
}
