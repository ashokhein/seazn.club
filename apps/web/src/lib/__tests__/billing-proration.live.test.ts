// LIVE contract test for the in-app plan-change params — NOT a unit test.
//
// The shape assertions in billing-manage.test.ts passed for months while every
// in-app plan change was dead on arrival: we sent `proration_date` together
// with `billing_cycle_anchor: "now"`, which Stripe refuses with "You cannot
// specify `proration_date` when `billing_cycle_anchor=now`". A param object
// cannot tell you the API rejects it — only the API can. This file asks it.
//
// Skipped unless BILLING_LIVE=1. It runs against Stripe TEST mode (the key in
// .env.local is rk_test_*) and creates + cancels a throwaway customer and
// subscription; no real money moves. Run:
//   BILLING_LIVE=1 DATABASE_URL=... npx vitest run --root apps/web \
//     src/lib/__tests__/billing-proration.live.test.ts
import { afterAll, describe, expect, it } from "vitest";
import Stripe from "stripe";
import postgres from "postgres";
import { buildIntervalChangeParams, buildIntervalPreviewParams } from "@/lib/billing-manage";

const LIVE = process.env.BILLING_LIVE === "1" && !!process.env.STRIPE_SECRET_KEY;

const cleanup: Array<() => Promise<unknown>> = [];
afterAll(async () => {
  for (const fn of cleanup) await fn().catch(() => undefined);
});

describe.skipIf(!LIVE)("in-app plan change params (live Stripe, test mode)", () => {
  it("previews and applies a real interval switch without a parameter rejection", async () => {
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
    const sql = postgres(process.env.DATABASE_URL!, {
      connection: { search_path: process.env.DB_SCHEMA ?? "seazn_club" },
    });
    const [pro] = await sql<{ monthly: string; annual: string }[]>`
      select stripe_price_id_monthly as monthly, stripe_price_id_annual as annual
      from plans where key = 'pro'`;
    const [plus] = await sql<{ annual: string }[]>`
      select stripe_price_id_annual as annual from plans where key = 'pro_plus'`;
    await sql.end();
    expect(pro?.annual, "plans table needs Stripe price ids").toBeTruthy();

    const customer = await stripe.customers.create({
      email: `proration-probe-${Date.now()}@example.com`,
      payment_method: "pm_card_visa",
      invoice_settings: { default_payment_method: "pm_card_visa" },
    });
    cleanup.push(() => stripe.customers.del(customer.id));
    const sub = await stripe.subscriptions.create({
      customer: customer.id,
      items: [{ price: pro.annual }],
    });
    cleanup.push(() => stripe.subscriptions.cancel(sub.id));

    const ctx = {
      customerId: customer.id,
      subscriptionId: sub.id,
      itemId: sub.items.data[0].id,
      trialing: false,
      prorationDate: Math.floor(Date.now() / 1000),
    };

    // Every target the console offers: the interval switch and the same-interval
    // plan upgrade. Both went through the same builders, so both were broken.
    for (const priceId of [pro.monthly, plus.annual]) {
      const preview = await stripe.invoices.createPreview(
        buildIntervalPreviewParams({ ...ctx, priceId }),
      );
      expect(typeof preview.total).toBe("number");
    }

    // The apply call takes the SAME pinned proration_date, and the interval
    // change must reset the cycle on its own — we no longer ask it to.
    const updated = await stripe.subscriptions.update(
      sub.id,
      buildIntervalChangeParams({ ...ctx, priceId: pro.monthly }),
    );
    const item = updated.items.data[0];
    expect(item.price.recurring?.interval).toBe("month");
    const start = item.current_period_start;
    const end = item.current_period_end;
    const days = (end - start) / 86_400;
    expect(days, "cycle reset to one month without billing_cycle_anchor").toBeLessThan(32);
  }, 60_000);
});
