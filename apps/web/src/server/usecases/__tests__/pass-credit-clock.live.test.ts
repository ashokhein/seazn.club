// LIVE test of the Event Pass credit across a REAL 14-day trial, using a Stripe
// test clock.
//
// pass-credit.live.test.ts bills on day one (the spent-trial shape) because it
// has to finish in seconds. But the shape most pass buyers actually take is the
// other one: checkoutTrialDays() returns 14, Checkout opens a trialing
// subscription, and the credit then sits on the customer for two weeks before
// any invoice draws it. Two things about that gap are only assertable against
// Stripe's own clock:
//
//   1. the $0 invoice Stripe raises at trial start must NOT consume the credit
//      (a credit applies "up to the invoice total", and that total is zero)
//   2. the day-14 invoice must draw it down and carry the remainder to day 44
//
// Both are the substance of "pays future invoices automatically". Neither can
// be reached by waiting.
//
// Skipped unless BILLING_LIVE=1. Stripe TEST mode only — test clocks do not
// exist in live mode. Slow by construction (each advance is asynchronous and
// Stripe processes a whole billing cycle inside it), hence the long per-test
// timeout:
//
//   BILLING_LIVE=1 npx vitest run --root apps/web \
//     src/server/usecases/__tests__/pass-credit-clock.live.test.ts \
//     --testTimeout=300000
import { afterAll, describe, expect, it } from "vitest";
import Stripe from "stripe";
import { creditPassTowardSubscription } from "../pass-credit";
import {
  PASS_GBP,
  PRO_MONTHLY_GBP,
  dropSeededOrgs,
  passFixture,
  proPrices,
} from "./pass-credit-live-fixture";

const LIVE = process.env.BILLING_LIVE === "1" && !!process.env.STRIPE_SECRET_KEY;
const HAS_DB = !!process.env.DATABASE_URL;

const DAY = 24 * 60 * 60;
/** checkoutTrialDays() — the trial a first-time org gets (lib/billing.ts). */
const TRIAL_DAYS = 14;

const cleanup: Array<() => Promise<unknown>> = [];

afterAll(async () => {
  for (const fn of cleanup) await fn().catch(() => undefined);
  if (HAS_DB) await dropSeededOrgs();
});

describe.skipIf(!LIVE || !HAS_DB)("pass credit across a 14-day trial (test clock)", () => {
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

  /**
   * Move the clock and wait for Stripe to finish billing everything the jump
   * crossed. `advance` returns immediately with status "advancing"; every
   * invoice this test reads is written during that window, so reading before
   * "ready" is reading a half-billed account.
   */
  async function advanceTo(clockId: string, to: number): Promise<void> {
    await stripe.testHelpers.testClocks.advance(clockId, { frozen_time: to });
    const deadline = Date.now() + 240_000;
    for (;;) {
      const clock = await stripe.testHelpers.testClocks.retrieve(clockId);
      if (clock.status === "ready") return;
      if (clock.status === "internal_failure")
        throw new Error(`test clock ${clockId} failed while advancing`);
      if (Date.now() > deadline)
        throw new Error(`test clock ${clockId} stuck in ${clock.status}`);
      await new Promise((r) => setTimeout(r, 2_000));
    }
  }

  /** Subscription invoices oldest-first, so they read as a timeline. */
  async function invoiceTimeline(customerId: string): Promise<Stripe.Invoice[]> {
    const list = await stripe.invoices.list({ customer: customerId, limit: 20 });
    return [...list.data].reverse();
  }

  it("holds the credit through the trial, then spends it across two invoices", async () => {
    const now = Math.floor(Date.now() / 1000);
    const clock = await stripe.testHelpers.testClocks.create({
      frozen_time: now,
      name: "pass credit trial",
    });
    // Deleting the clock takes its customers and subscriptions with it — the
    // only teardown this suite needs, and the reason nothing else is registered.
    cleanup.push(() => stripe.testHelpers.testClocks.del(clock.id));

    const f = await passFixture(stripe, { testClock: clock.id });
    const { monthly } = await proPrices();

    // What POST /api/billing/checkout does before it builds the session.
    const res = await creditPassTowardSubscription(f.orgId);
    expect(res).toMatchObject({ outcome: "credited", amountMinor: PASS_GBP });

    // …and what Checkout then opens: a trialing subscription. requireCard is
    // true for every pass holder (orgHoldsAnyPass), so the card is already on
    // the customer — modelled here by the fixture's default payment method.
    const sub = await stripe.subscriptions.create({
      customer: f.customerId,
      items: [{ price: monthly }],
      currency: "gbp",
      trial_period_days: TRIAL_DAYS,
    });
    expect(sub.status).toBe("trialing");

    // ── Day 0 ────────────────────────────────────────────────────────────────
    // The trial invoice is £0. A credit applies only up to the invoice total,
    // so a £0 total must leave all £25 alone; if Stripe ever "spent" it here,
    // the buyer would reach day 14 with nothing and be charged in full.
    const atStart = await invoiceTimeline(f.customerId);
    expect(atStart).toHaveLength(1);
    expect(atStart[0]!.total).toBe(0);
    const afterTrialStart = (await stripe.customers.retrieve(f.customerId)) as Stripe.Customer;
    expect(afterTrialStart.balance).toBe(-PASS_GBP);

    // ── Day 15: the first real invoice ───────────────────────────────────────
    await advanceTo(clock.id, now + (TRIAL_DAYS + 1) * DAY);

    const afterTrial = await invoiceTimeline(f.customerId);
    expect(afterTrial.length).toBeGreaterThanOrEqual(2);
    const first = afterTrial[1]!;
    expect(first.total).toBe(PRO_MONTHLY_GBP);
    expect(first.starting_balance).toBe(-PASS_GBP);
    // £25 credit, £15 invoice: nothing to charge, £10 carried.
    expect(first.amount_due).toBe(0);
    expect(first.ending_balance).toBe(-(PASS_GBP - PRO_MONTHLY_GBP));
    expect(first.status).toBe("paid");

    // ── Day 46: the remainder is spent, then the card pays the difference ────
    await advanceTo(clock.id, now + (TRIAL_DAYS + 32) * DAY);

    const afterRenewal = await invoiceTimeline(f.customerId);
    expect(afterRenewal.length).toBeGreaterThanOrEqual(3);
    const second = afterRenewal[2]!;
    expect(second.total).toBe(PRO_MONTHLY_GBP);
    expect(second.starting_balance).toBe(-(PASS_GBP - PRO_MONTHLY_GBP));
    // £15 invoice, £10 credit left: £5 actually leaves the card, and the
    // balance is now spent.
    expect(second.amount_due).toBe(PRO_MONTHLY_GBP - (PASS_GBP - PRO_MONTHLY_GBP));
    expect(second.ending_balance).toBe(0);
    expect(second.status).toBe("paid");

    const spent = (await stripe.customers.retrieve(f.customerId)) as Stripe.Customer;
    expect(spent.balance).toBe(0);
  }, 600_000);
});
