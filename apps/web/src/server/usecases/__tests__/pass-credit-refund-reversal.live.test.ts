// LIVE contract test for the webhook refund backstop (design 2026-07-26 §5).
//
// pass-credit-refund-reversal.test.ts already pins the money ARITHMETIC
// (min(redemption.amount_minor, max(-customer.balance, 0))) against a fake
// balance ledger. What it cannot answer is whether a REAL Stripe customer
// balance behaves the way that arithmetic assumes once an actual invoice has
// drawn part of it down. This asks Stripe directly: grant a real credit,
// spend part of it on a real MONTHLY invoice (mirroring
// pass-credit.live.test.ts's "pays down the first MONTHLY invoice and carries
// the remainder" test to reach a genuinely partially-spent state), refund the
// real pass PaymentIntent the way a Dashboard refund would, call
// `reversePassCreditOnRefund` directly, and check the real resulting balance.
//
// Skipped unless BILLING_LIVE=1. Runs against Stripe TEST mode. Real Postgres
// required — the usecase reads pass_credit_redemptions/subscriptions.
//
//   BILLING_LIVE=1 npx vitest run --root apps/web \
//     src/server/usecases/__tests__/pass-credit-refund-reversal.live.test.ts \
//     --testTimeout=60000
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Stripe from "stripe";
import { sql } from "@/lib/db";
import { creditPassTowardSubscription, reversePassCreditOnRefund } from "../pass-credit";
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

describe.skipIf(!LIVE || !HAS_DB)("pass credit reversal against live Stripe (test mode)", () => {
  // Constructed in beforeAll, not at describe-body scope: Vitest evaluates
  // the describe factory during COLLECTION even when skipIf is true, so
  // `new Stripe(process.env.STRIPE_SECRET_KEY!)` right here throws on every
  // run without BILLING_LIVE=1 — a suite-collection failure that a terminal
  // summary can misreport as a clean skip (see pass-credit.live.test.ts).
  let stripe: Stripe;
  beforeAll(() => {
    stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
  });

  it("reverses only the unspent remainder of a partially-consumed credit on refund", async () => {
    const f = await passFixture(stripe);
    cleanup.push(() => stripe.customers.del(f.customerId));

    const { monthly } = await proPrices();
    const credited = await creditPassTowardSubscription(f.orgId);
    expect(credited).toMatchObject({ outcome: "credited", amountMinor: PASS_GBP });

    // Spend part of the £25 grant on a real MONTHLY invoice — mirrors
    // pass-credit.live.test.ts: a £25 credit against a £15 invoice is covered
    // in full and leaves £10 (PASS_GBP - PRO_MONTHLY_GBP) on the customer.
    const sub = await stripe.subscriptions.create({
      customer: f.customerId,
      items: [{ price: monthly }],
      currency: "gbp",
      expand: ["latest_invoice"],
    });
    cleanup.push(() => stripe.subscriptions.cancel(sub.id));
    const invoice = sub.latest_invoice as Stripe.Invoice;
    expect(invoice.total).toBe(PRO_MONTHLY_GBP);
    expect(invoice.ending_balance).toBe(-(PASS_GBP - PRO_MONTHLY_GBP));

    const beforeRefund = (await stripe.customers.retrieve(f.customerId)) as Stripe.Customer;
    expect(beforeRefund.balance).toBe(-(PASS_GBP - PRO_MONTHLY_GBP));

    // The Dashboard-refund path this whole function exists for: support (or a
    // chargeback) refunds the pass charge directly. Nothing about the
    // subscription or its invoice changes on its own — that is the gap
    // `reversePassCreditOnRefund` closes.
    await stripe.refunds.create({ payment_intent: f.intent });

    await reversePassCreditOnRefund(f.intent);

    // Only the unspent £10 comes back. The £15 already billed to the invoice
    // is written off, not clawed back — reversing the full £25 would have put
    // this customer at +£15, a debt they never agreed to.
    const after = (await stripe.customers.retrieve(f.customerId)) as Stripe.Customer;
    expect(after.balance).toBe(0);

    const [row] = await sql<{ reversed_at: string | null; reversed_minor: number | null }[]>`
      select reversed_at, reversed_minor from pass_credit_redemptions
      where payment_intent = ${f.intent}`;
    expect(row?.reversed_at).not.toBeNull();
    expect(row?.reversed_minor).toBe(PASS_GBP - PRO_MONTHLY_GBP);
  }, 60_000);
});
