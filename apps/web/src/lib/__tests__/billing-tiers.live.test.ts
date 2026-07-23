// LIVE verification for graduated-tier billing (#213) — NOT a unit test.
//
// The billing-group model prices each extra org at HALF the plan rate via a
// Stripe graduated/tiered price whose quantity is the org count. Every unit
// test mocks Stripe and the e2e fixture returns canned amounts, so the tier
// arithmetic — which is STRIPE's, not ours — had never actually been observed
// settling. This asks a real (test-mode) Stripe account to bill it.
//
// Self-contained: it creates its OWN graduated price mirroring the shape
// scripts/stripe-sync.ts sends from apps/web/src/config/stripe-plans.json (Pro
// monthly: tier1 up_to 1 = $19.00, tier2 up_to inf = $9.00), so it proves the
// arithmetic independent of whether the account has been synced. Everything is
// cleaned up; no real money moves. Skipped unless BILLING_LIVE=1. Run:
//   BILLING_LIVE=1 STRIPE_SECRET_KEY=sk_test_... \
//     npx vitest run --root apps/web src/lib/__tests__/billing-tiers.live.test.ts
import { afterAll, describe, expect, it } from "vitest";
import Stripe from "stripe";

const LIVE =
  process.env.BILLING_LIVE === "1" && (process.env.STRIPE_SECRET_KEY ?? "").startsWith("sk_test");

const BASE = 1900; // tier 1 — a group of one pays the full base
const EXTRA = 900; // tier 2+ — each additional org at half

const cleanup: Array<() => Promise<unknown>> = [];
afterAll(async () => {
  for (const fn of cleanup) await fn().catch(() => undefined);
});

describe.skipIf(!LIVE)("graduated tier billing (live Stripe, test mode)", () => {
  it("bills a 5-org group at base + 4×half ($19 + 4×$9 = $55), and quotes +$9 for a 6th", async () => {
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

    const product = await stripe.products.create({ name: `tier-probe-${Date.now()}` });
    cleanup.push(() => stripe.products.update(product.id, { active: false }));

    const price = await stripe.prices.create({
      product: product.id,
      currency: "usd",
      recurring: { interval: "month" },
      billing_scheme: "tiered",
      tiers_mode: "graduated",
      tiers: [
        { up_to: 1, unit_amount: BASE },
        { up_to: "inf", unit_amount: EXTRA },
      ],
    });
    cleanup.push(() => stripe.prices.update(price.id, { active: false }));

    const customer = await stripe.customers.create({
      email: `tier-probe-${Date.now()}@example.com`,
      payment_method: "pm_card_visa",
      invoice_settings: { default_payment_method: "pm_card_visa" },
    });
    cleanup.push(() => stripe.customers.del(customer.id));

    // A group of FIVE organisations = subscription-item quantity 5.
    const sub = await stripe.subscriptions.create({
      customer: customer.id,
      items: [{ price: price.id, quantity: 5 }],
      expand: ["latest_invoice"],
    });
    cleanup.push(() => stripe.subscriptions.cancel(sub.id));

    // THE HEADLINE: Stripe's own graduated arithmetic on the first invoice.
    const invoice = sub.latest_invoice as Stripe.Invoice;
    const expectedFive = BASE + 4 * EXTRA; // 1900 + 3600 = 5500
    expect(invoice.subtotal).toBe(expectedFive);
    // Not a flat per_unit price (5 × 1900 = 9500 would be the bug).
    expect(invoice.subtotal).not.toBe(5 * BASE);

    // previewAttachCharge's world: the recurring quote for a SIXTH org is the
    // base plus five halves — i.e. exactly +$9 over the five-org figure.
    const itemId = sub.items.data[0].id;
    const preview = await stripe.invoices.createPreview({
      customer: customer.id,
      subscription: sub.id,
      subscription_details: { items: [{ id: itemId, quantity: 6 }] },
      preview_mode: "recurring",
    });
    const expectedSix = BASE + 5 * EXTRA; // 1900 + 4500 = 6400
    expect(preview.total).toBe(expectedSix);
    expect(preview.total - expectedFive).toBe(EXTRA); // one more org = half rate
  }, 30_000); // live Stripe: several sequential round trips
});
