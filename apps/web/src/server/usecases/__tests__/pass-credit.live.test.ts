// LIVE contract test for the Event Pass → subscription credit (v3/07 D12).
//
// pass-credit.test.ts already pins every DECISION the usecase makes, against a
// fake balance ledger. What it cannot answer is the half that belongs to
// Stripe: a negative customer balance transaction is only worth something if
// Stripe actually draws it down on the next subscription invoice, in the right
// currency, for the right amount, and leaves the remainder for the invoice
// after. "£25 account credit — pays future invoices automatically" (dict key
// billing.credit) is a promise about SOMEONE ELSE'S system. Only that system
// can confirm it.
//
// Skipped unless BILLING_LIVE=1. Runs against Stripe TEST mode (sk_test in the
// repo-root .env.local, which vitest.config.ts keeps only under that flag) and
// creates throwaway customers, payment intents and subscriptions; no real money
// moves. Real Postgres required — the usecase reads organizations/subscriptions
// /competition_passes, and the point of a live test is that nothing is faked.
//
//   BILLING_LIVE=1 npx vitest run --root apps/web \
//     src/server/usecases/__tests__/pass-credit.live.test.ts --testTimeout=30000
//
// These subscriptions carry NO TRIAL, which is a real production shape:
// checkoutTrialDays() returns 0 for any org whose trial is spent, so a
// re-subscribing pass buyer is billed on day one. It also puts the first real
// invoice inside this run instead of 14 days away. The 14-day trial path — and
// the $0 trial invoice that must NOT eat the credit — is the clock suite,
// pass-credit-clock.live.test.ts.
//
// Tax is left OFF on these subscriptions. The credit applies to the invoice
// TOTAL, so tax would only scale every number here; billing-automatic-tax.live
// owns the tax question.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Stripe from "stripe";
import { buildEmbeddedCheckoutParams } from "@/lib/billing";
import { PASS_CREDIT_INTENT_KEY, creditPassTowardSubscription } from "../pass-credit";
import {
  PASS_GBP,
  PRO_ANNUAL_GBP,
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

describe.skipIf(!LIVE || !HAS_DB)("pass credit against live Stripe (test mode)", () => {
  // Constructed in beforeAll, not at describe-body scope: Vitest evaluates the
  // describe factory during COLLECTION even when skipIf is true, so
  // `new Stripe(process.env.STRIPE_SECRET_KEY!)` right here throws
  // "Neither apiKey nor config.authenticator provided" on every run without
  // BILLING_LIVE=1 — a suite-collection failure, not a clean skip. Confirmed
  // 2026-07-26 against the raw vitest JSON reporter (numFailedTestSuites:1)
  // after a terminal summary wrongly read as a pass.
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

  /**
   * The subscription a credited org lands on. `currency` is REQUIRED: our
   * prices carry currency_options, and without it Stripe bills the price's usd
   * amount while the credit sits in gbp — dead money on the invoice, which is
   * the exact failure the usecase's currency guard exists to prevent upstream.
   */
  async function subscribe(customerId: string, price: string): Promise<Stripe.Invoice> {
    const sub = await stripe.subscriptions.create({
      customer: customerId,
      items: [{ price }],
      currency: "gbp",
      expand: ["latest_invoice"],
    });
    cleanup.push(() => stripe.subscriptions.cancel(sub.id));
    const invoice = sub.latest_invoice;
    expect(invoice && typeof invoice !== "string", "first invoice must be expanded").toBe(true);
    return invoice as Stripe.Invoice;
  }

  it("lands the pass payment on the customer as a negative balance", async () => {
    const f = await fixture();

    const res = await creditPassTowardSubscription(f.orgId);
    expect(res).toMatchObject({ outcome: "credited", amountMinor: PASS_GBP, currency: "gbp" });

    // What the billing page reads back as "£25 account credit":
    // getBillingOverview -> creditMinor = max(-customer.balance, 0).
    const customer = (await stripe.customers.retrieve(f.customerId)) as Stripe.Customer;
    expect(customer.balance).toBe(-PASS_GBP);

    const txns = await stripe.customers.listBalanceTransactions(f.customerId, { limit: 10 });
    expect(txns.data).toHaveLength(1);
    expect(txns.data[0]!.metadata?.[PASS_CREDIT_INTENT_KEY]).toBe(f.intent);
    expect(txns.data[0]!.currency).toBe("gbp");
  }, 30_000);

  it("pays down the first MONTHLY invoice and carries the remainder", async () => {
    const f = await fixture();
    const { monthly } = await proPrices();
    await creditPassTowardSubscription(f.orgId);

    const invoice = await subscribe(f.customerId, monthly);

    expect(invoice.currency).toBe("gbp");
    expect(invoice.total).toBe(PRO_MONTHLY_GBP);
    expect(invoice.starting_balance).toBe(-PASS_GBP);
    // £25 credit vs a £15 invoice: the invoice is covered in full and £10 is
    // left on the customer for the next one. The credit can never exceed the
    // invoice, so this is the only shape a monthly upgrade can take.
    expect(invoice.amount_due).toBe(0);
    expect(invoice.ending_balance).toBe(-(PASS_GBP - PRO_MONTHLY_GBP));

    const customer = (await stripe.customers.retrieve(f.customerId)) as Stripe.Customer;
    expect(customer.balance).toBe(-(PASS_GBP - PRO_MONTHLY_GBP));
  }, 30_000);

  it("pays down the first ANNUAL invoice in one go, with nothing left over", async () => {
    const f = await fixture();
    const { annual } = await proPrices();
    await creditPassTowardSubscription(f.orgId);

    const invoice = await subscribe(f.customerId, annual);

    expect(invoice.total).toBe(PRO_ANNUAL_GBP);
    expect(invoice.starting_balance).toBe(-PASS_GBP);
    // £125 - £25. The whole credit is consumed by invoice one; annual buyers
    // never see the carry-over the monthly case has.
    expect(invoice.amount_due).toBe(PRO_ANNUAL_GBP - PASS_GBP);
    expect(invoice.ending_balance).toBe(0);
  }, 30_000);

  it("shows the credited first invoice in a PREVIEW, before anything is billed", async () => {
    // The support answer to "what will I actually be charged?" — and the only
    // way to see a 14-day-away invoice today without a test clock.
    const f = await fixture();
    const { monthly } = await proPrices();
    await creditPassTowardSubscription(f.orgId);

    const preview = await stripe.invoices.createPreview({
      customer: f.customerId,
      subscription_details: { items: [{ price: monthly }] },
      currency: "gbp",
    });

    // Observed live 2026-07-25: the preview applies the balance in full, and
    // even computes `ending_balance` — which the API reference says is null
    // until an invoice is finalized. So a preview is a complete answer to "what
    // will I be charged at trial end?", credit included, with nothing billed.
    expect(preview.total).toBe(PRO_MONTHLY_GBP);
    expect(preview.starting_balance).toBe(-PASS_GBP);
    expect(preview.ending_balance).toBe(-(PASS_GBP - PRO_MONTHLY_GBP));
    expect(preview.amount_due).toBe(0);

    // Nothing was billed: a preview must not consume the credit.
    const customer = (await stripe.customers.retrieve(f.customerId)) as Stripe.Customer;
    expect(customer.balance).toBe(-PASS_GBP);
  }, 30_000);

  it("does NOT discount the Checkout session itself — the credit lands on the invoice", async () => {
    // The one thing the rest of this file cannot see. Production does not call
    // subscriptions.create: it builds a Checkout Session, and on the spent-trial
    // path (trialDays 0) Checkout collects the first payment inside the session.
    // So does the £25 come off what the buyer is asked to pay at checkout, or
    // off the invoice behind it? Stripe's docs do not say. This asks it with the
    // REAL params (buildEmbeddedCheckoutParams), not an approximation.
    const f = await fixture();
    const { monthly } = await proPrices();
    await creditPassTowardSubscription(f.orgId);

    const session = await stripe.checkout.sessions.create(
      buildEmbeddedCheckoutParams({
        priceId: monthly,
        orgId: f.orgId,
        returnUrl: "https://seazn.club/return",
        trialDays: 0,
        customerId: f.customerId,
        currency: "gbp",
      }),
    );

    // Observed live 2026-07-25: the session quotes the FULL £15. A customer
    // balance is an invoice-level instrument and Checkout does not net it off
    // the amount it quotes, so a spent-trial buyer sees no discount on the
    // checkout screen — any copy promising one would be wrong.
    //
    // What this does NOT establish: what is actually collected when such a
    // session is COMPLETED. That needs a browser, so it belongs to e2e, not
    // here. The trial path — the default, and the one most pass buyers take —
    // is not affected either way: Checkout collects nothing at session time and
    // the day-14 invoice draws the credit down, which pass-credit-clock.live
    // proves end to end.
    expect(session.amount_total).toBe(PRO_MONTHLY_GBP);
    expect(session.currency).toBe("gbp");

    // Creating a session must not spend the credit either — an abandoned
    // checkout has to leave the customer exactly as it found them.
    const customer = (await stripe.customers.retrieve(f.customerId)) as Stripe.Customer;
    expect(customer.balance).toBe(-PASS_GBP);
  }, 30_000);

  it("credits nothing when the pass currency is not the subscription's", async () => {
    // A gbp pass against an org pinned to usd: a gbp balance would sit on the
    // customer forever, unreadable by a usd invoice.
    const f = await fixture({ subCurrency: "usd" });

    const res = await creditPassTowardSubscription(f.orgId);
    expect(res.outcome).toBe("currency_mismatch");
    expect(res.amountMinor).toBe(0);

    const customer = (await stripe.customers.retrieve(f.customerId)) as Stripe.Customer;
    expect(customer.balance).toBe(0);
  }, 30_000);

  it("credits ONCE when checkout is started twice — the abandoned-checkout case", async () => {
    const f = await fixture();

    const first = await creditPassTowardSubscription(f.orgId);
    const second = await creditPassTowardSubscription(f.orgId);

    expect(first.outcome).toBe("credited");
    // The group-cap check (pass_credit_redemptions, V335) now runs before the
    // per-intent Stripe scan, so an ordinary same-intent retry reads as
    // `group_already_redeemed` — the local row, not the Stripe metadata, is
    // what stops it. `already_credited` is still reachable (see
    // pass-credit.test.ts "still recovers via the per-intent scan") when that
    // local row is missing but Stripe already holds the credit.
    expect(second.outcome).toBe("group_already_redeemed");

    const customer = (await stripe.customers.retrieve(f.customerId)) as Stripe.Customer;
    expect(customer.balance).toBe(-PASS_GBP);
    const txns = await stripe.customers.listBalanceTransactions(f.customerId, { limit: 10 });
    expect(txns.data).toHaveLength(1);
  }, 30_000);

  it("credits only the NET of a partially refunded pass", async () => {
    const f = await fixture();
    await stripe.refunds.create({ payment_intent: f.intent, amount: 1_000 });

    const res = await creditPassTowardSubscription(f.orgId);
    expect(res).toMatchObject({ outcome: "credited", amountMinor: PASS_GBP - 1_000 });

    const customer = (await stripe.customers.retrieve(f.customerId)) as Stripe.Customer;
    expect(customer.balance).toBe(-(PASS_GBP - 1_000));
  }, 30_000);
});
