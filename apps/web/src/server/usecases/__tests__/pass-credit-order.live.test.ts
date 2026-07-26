// LIVE test of the "ordering risk" the redemption-timing move creates (grant
// timing moved 2026-07-26 — see
// docs/superpowers/specs/2026-07-26-pass-credit-redemption-design.md §1,
// "Ordering risk").
//
// pass-credit.live.test.ts already proves the credit lands correctly when it
// is granted BEFORE a subscription is created (the old, pre-checkout timing,
// still exercised there as the ground truth for what a credited invoice looks
// like). This file asks the question the design doc raises about the NEW
// timing on the no-trial (spent-trial) path specifically:
//
//   Today (pre-move) the credit already sits on the customer before Checkout
//   ever draws invoice #1, so a no-trial buyer's first invoice is discounted.
//   Under the new timing the grant runs from the subscription-created webhook
//   / reconcile-on-return, BOTH of which fire AFTER a no-trial Checkout
//   Session has already created and paid its first invoice as part of
//   completing the session. So the spec predicts: invoice #1 is paid at full
//   price, and the credit only reduces invoice #2.
//
// This cannot be driven through Stripe's hosted Checkout UI (no browser), so
// the closest honest proxy — mirroring pass-credit.live.test.ts's own
// `subscribe()` helper, which is itself documented there as "what Checkout
// does under the hood for this path" — is: create the subscription directly
// via stripe.subscriptions.create with NO trial_period_days, inspect invoice
// #1 BEFORE calling creditPassTowardSubscription (proving the ordering risk is
// real: it must be full price, undiscounted), THEN call
// creditPassTowardSubscription (simulating the webhook/reconcile firing
// after), and confirm the credit now sits on the customer for invoice #2.
//
// Skipped unless BILLING_LIVE=1. Stripe TEST mode only; real Postgres
// required.
//
//   BILLING_LIVE=1 npx vitest run --root apps/web \
//     src/server/usecases/__tests__/pass-credit-order.live.test.ts \
//     --testTimeout=30000
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Stripe from "stripe";
import { sql } from "@/lib/db";
import { checkoutTrialDays } from "@/lib/billing";
import { PASS_CREDIT_INTENT_KEY, creditPassTowardSubscription } from "../pass-credit";
import {
  PASS_GBP,
  PRO_MONTHLY_GBP,
  dropSeededOrgs,
  passFixture,
  proPrices,
} from "./pass-credit-live-fixture";

const LIVE = process.env.BILLING_LIVE === "1" && !!process.env.STRIPE_SECRET_KEY;
const HAS_DB = !!process.env.DATABASE_URL;

const cleanup: Array<() => Promise<unknown>> = [];

afterAll(async () => {
  for (const fn of cleanup) await fn().catch(() => undefined);
  if (HAS_DB) await dropSeededOrgs();
});

describe.skipIf(!LIVE || !HAS_DB)("pass credit ordering risk: no-trial path (test mode)", () => {
  // beforeAll, not describe-body scope — see pass-credit.live.test.ts: Vitest
  // evaluates this factory during collection even when skipIf is true, so
  // constructing here throws on every run without BILLING_LIVE=1.
  let stripe: Stripe;
  beforeAll(() => {
    stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
  });

  /** A fixture whose Stripe customer is deleted when the suite ends. */
  async function fixture(opts: Parameters<typeof passFixture>[1] = {}) {
    const f = await passFixture(stripe, opts);
    cleanup.push(() => stripe.customers.del(f.customerId));
    return f;
  }

  it(
    "invoice #1 is full price; the credit only reaches invoice #2",
    async () => {
      const f = await fixture();
      const { monthly } = await proPrices();

      // The real production shape this test pins: checkoutTrialDays()=0. The
      // fixture's org is seeded on a fresh (null trial_used_at) community
      // subscription, so stamp it spent exactly like a prior real subscription
      // would have — then read it back and run the REAL function, so this
      // isn't just asserted, it's exercised the same way the checkout route
      // exercises it.
      await sql`
        update subscriptions set trial_used_at = now()
        where id = (select subscription_id from organizations where id = ${f.orgId})`;
      const [subRow] = await sql<{ trial_used_at: string | null }[]>`
        select trial_used_at from subscriptions
        where id = (select subscription_id from organizations where id = ${f.orgId})`;
      expect(checkoutTrialDays(subRow)).toBe(0);

      // Mirror what a completed no-trial Checkout Session does under the
      // hood: create + pay invoice #1 as part of completing the session —
      // BEFORE either hook (webhook / reconcile-on-return) has had a chance
      // to run creditPassTowardSubscription.
      const sub = await stripe.subscriptions.create({
        customer: f.customerId,
        items: [{ price: monthly }],
        currency: "gbp",
        expand: ["latest_invoice"],
      });
      cleanup.push(() => stripe.subscriptions.cancel(sub.id));
      const invoice1 = sub.latest_invoice;
      expect(invoice1 && typeof invoice1 !== "string", "invoice #1 must be expanded").toBe(true);
      const firstInvoice = invoice1 as Stripe.Invoice;

      // The ordering risk, made concrete: with nothing granted yet, invoice #1
      // is undiscounted — the customer pays full price on their first bill,
      // which the OLD (pre-checkout) timing would never have allowed.
      expect(firstInvoice.currency).toBe("gbp");
      expect(firstInvoice.total).toBe(PRO_MONTHLY_GBP);
      expect(firstInvoice.starting_balance).toBe(0);
      expect(firstInvoice.amount_due).toBe(PRO_MONTHLY_GBP);
      expect(firstInvoice.status).toBe("paid");

      const beforeCredit = (await stripe.customers.retrieve(f.customerId)) as Stripe.Customer;
      expect(beforeCredit.balance).toBe(0);

      // NOW simulate the webhook / reconcile-on-return firing, the moment
      // after AFTER the session (and its first invoice) has already
      // completed.
      const res = await creditPassTowardSubscription(f.orgId);
      expect(res).toMatchObject({ outcome: "credited", amountMinor: PASS_GBP, currency: "gbp" });

      const afterCredit = (await stripe.customers.retrieve(f.customerId)) as Stripe.Customer;
      expect(afterCredit.balance).toBe(-PASS_GBP);
      const txns = await stripe.customers.listBalanceTransactions(f.customerId, { limit: 10 });
      expect(txns.data).toHaveLength(1);
      expect(txns.data[0]!.metadata?.[PASS_CREDIT_INTENT_KEY]).toBe(f.intent);

      // Invoice #1 itself is untouched — a customer balance transaction only
      // ever applies going FORWARD, never retroactively to an invoice that
      // already finalized and paid.
      const refetchedFirst = await stripe.invoices.retrieve(firstInvoice.id!);
      expect(refetchedFirst.total).toBe(PRO_MONTHLY_GBP);
      expect(refetchedFirst.amount_paid).toBe(PRO_MONTHLY_GBP);

      // Where the design doc predicts the credit lands: invoice #2, previewed
      // via the subscription's upcoming invoice (same technique
      // pass-credit.live.test.ts's own preview test uses for the trial path).
      // `subscription` and `currency` are mutually exclusive on this endpoint
      // (Stripe: "You may only specify one of these parameters") — previewing
      // an EXISTING subscription's next invoice always bills in that
      // subscription's own currency, so there is nothing left to pick.
      const preview = await stripe.invoices.createPreview({
        customer: f.customerId,
        subscription: sub.id,
      });
      expect(preview.total).toBe(PRO_MONTHLY_GBP);
      expect(preview.starting_balance).toBe(-PASS_GBP);
      // £25 credit vs a £15 invoice: invoice #2 is covered in full and £10
      // carries forward — exactly the monthly shape pass-credit.live.test.ts
      // pins for the OLD timing's invoice #1, just one invoice later here.
      expect(preview.amount_due).toBe(0);
      expect(preview.ending_balance).toBe(-(PASS_GBP - PRO_MONTHLY_GBP));

      // Confirms the doc's claim that nothing is LOST, only delayed: the full
      // £25 is still accounted for — £0 spent on invoice #1, all £25 still on
      // the customer, ready for invoice #2.
      expect(afterCredit.balance).toBe(-PASS_GBP);
    },
    30_000,
  );
});
