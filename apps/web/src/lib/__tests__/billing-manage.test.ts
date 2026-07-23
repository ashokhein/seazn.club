// In-app billing management core (v3/11) — the pure param builders and
// mappers behind the portal-replacement routes: card-only SetupIntents, the
// interval switch with its pinned proration_date (preview == actual), the
// invoice/payment-method display rows and the lazy renewal re-sync predicate.
import { describe, expect, it } from "vitest";
import { asCurrency } from "@/lib/currency";
import {
  buildAddressUpdateParams,
  buildApplyPromoParams,
  discountSummary,
  taxIdRows,
  buildSetupIntentParams,
  buildIntervalPreviewParams,
  buildIntervalChangeParams,
  summarizeIntervalPreview,
  invoiceRows,
  paymentMethodRows,
  intervalForPrice,
  needsRenewalResync,
  cardRemovalConsequence,
} from "@/lib/billing-manage";

const change = {
  customerId: "cus_1",
  subscriptionId: "sub_1",
  itemId: "si_1",
  priceId: "price_annual",
  trialing: false,
  prorationDate: 1_770_000_000,
};

describe("buildSetupIntentParams", () => {
  it("is card-only and off_session (no redirect methods, SAQ-A iframe)", () => {
    expect(buildSetupIntentParams("cus_1")).toEqual({
      customer: "cus_1",
      usage: "off_session",
      payment_method_types: ["card"],
    });
  });
});

describe("buildIntervalPreviewParams / buildIntervalChangeParams", () => {
  it("previews an immediate switch with the pinned proration_date", () => {
    const p = buildIntervalPreviewParams(change);
    expect(p.customer).toBe("cus_1");
    expect(p.subscription).toBe("sub_1");
    expect(p.subscription_details).toEqual({
      items: [{ id: "si_1", price: "price_annual" }],
      proration_behavior: "always_invoice",
      proration_date: change.prorationDate,
    });
  });

  it("applies with the SAME pinned proration_date and expands the SCA secret", () => {
    const p = buildIntervalChangeParams(change);
    expect(p.items).toEqual([{ id: "si_1", price: "price_annual" }]);
    expect(p.proration_behavior).toBe("always_invoice");
    expect(p.proration_date).toBe(change.prorationDate);
    expect(p.payment_behavior).toBe("allow_incomplete");
    expect(p.expand).toEqual(["latest_invoice.confirmation_secret"]);
  });

  // Stripe rejects the pair outright: "You cannot specify `proration_date`
  // when `billing_cycle_anchor=now`". Both builders shipped it for months —
  // the shape assertions above were happy, because a param object cannot tell
  // you the API refuses it. This is the rule itself, stated once.
  it("never sends billing_cycle_anchor alongside proration_date", () => {
    for (const params of [
      buildIntervalPreviewParams(change).subscription_details as Record<string, unknown>,
      buildIntervalChangeParams(change) as unknown as Record<string, unknown>,
      buildIntervalPreviewParams({ ...change, trialing: true })
        .subscription_details as Record<string, unknown>,
      buildIntervalChangeParams({ ...change, trialing: true }) as unknown as Record<
        string,
        unknown
      >,
    ]) {
      expect(
        params.billing_cycle_anchor !== undefined && params.proration_date !== undefined,
      ).toBe(false);
    }
  });

  it("switches a trialing sub without prorations or anchor reset (nothing paid yet)", () => {
    const trial = { ...change, trialing: true };
    const preview = buildIntervalPreviewParams(trial);
    expect(preview.subscription_details?.proration_behavior).toBe("none");
    expect(preview.subscription_details).not.toHaveProperty("billing_cycle_anchor");
    expect(preview.subscription_details).not.toHaveProperty("proration_date");

    const update = buildIntervalChangeParams(trial);
    expect(update.proration_behavior).toBe("none");
    expect(update).not.toHaveProperty("billing_cycle_anchor");
    expect(update).not.toHaveProperty("proration_date");
    expect(update).not.toHaveProperty("payment_behavior");
  });
});

describe("summarizeIntervalPreview", () => {
  const lines = {
    data: [
      { amount: 15_000, period: { end: 1_800_000_000 } },
      { amount: -6_482, period: { end: 1_790_000_000 } },
    ],
  };

  it("itemizes the breakdown behind the total (the real-invoice shape, VAT included)", () => {
    // £150.00 new period, −£64.82 credit for unused time, £85.18 subtotal,
    // +£17.04 VAT = £102.22 charged today — the invoice this dialog previews.
    const s = summarizeIntervalPreview({
      total: 10_222,
      subtotal: 8_518,
      currency: "gbp",
      lines,
    });
    expect(s).toEqual({
      dueTodayMinor: 10_222,
      creditMinor: 0,
      newPeriodMinor: 15_000,
      unusedCreditMinor: 6_482,
      subtotalMinor: 8_518,
      taxMinor: 1_704,
      currency: "gbp",
      newPeriodEnd: new Date(1_800_000_000 * 1000).toISOString(),
    });
  });

  it("reports no tax line when the customer is not taxed (total == subtotal)", () => {
    const s = summarizeIntervalPreview({ total: 8_518, subtotal: 8_518, currency: "gbp", lines });
    expect(s.taxMinor).toBe(0);
    expect(s.dueTodayMinor).toBe(8_518);
  });

  it("negative total = customer credit, nothing due today", () => {
    // Downgrade direction: a big unused-time credit outweighs the new period.
    const s = summarizeIntervalPreview({
      total: -4_500,
      subtotal: -4_500,
      currency: "usd",
      lines: { data: [{ amount: 2_000, period: null }, { amount: -6_500, period: null }] },
    });
    expect(s.dueTodayMinor).toBe(0);
    expect(s.creditMinor).toBe(4_500);
    expect(s.newPeriodMinor).toBe(2_000);
    expect(s.unusedCreditMinor).toBe(6_500);
  });

  it("tolerates missing line periods and amounts", () => {
    const s = summarizeIntervalPreview({ total: 0, subtotal: 0, currency: "eur", lines: { data: [] } });
    expect(s.newPeriodEnd).toBeNull();
    expect(s.newPeriodMinor).toBe(0);
    expect(s.unusedCreditMinor).toBe(0);
  });
});

describe("invoiceRows", () => {
  const inv = (over: Record<string, unknown>) => ({
    id: "in_1",
    number: "SZ-0001",
    created: 1_760_000_000,
    total: 2000,
    currency: "usd",
    status: "paid",
    hosted_invoice_url: "https://invoice.stripe.com/i/x",
    invoice_pdf: "https://pay.stripe.com/invoice/x/pdf",
    ...over,
  });

  it("maps display fields and keeps only Stripe-hosted URLs", () => {
    const [row] = invoiceRows([inv({})]);
    expect(row).toEqual({
      id: "in_1",
      number: "SZ-0001",
      createdIso: new Date(1_760_000_000 * 1000).toISOString(),
      totalMinor: 2000,
      currency: "usd",
      status: "paid",
      hostedUrl: "https://invoice.stripe.com/i/x",
      pdfUrl: "https://pay.stripe.com/invoice/x/pdf",
      isOpen: false,
    });
  });

  it("drops drafts, flags open invoices (renewal needing payment), sorts newest first", () => {
    const rows = invoiceRows([
      inv({ id: "in_draft", status: "draft" }),
      inv({ id: "in_old", created: 1_700_000_000 }),
      inv({ id: "in_open", created: 1_765_000_000, status: "open" }),
    ]);
    expect(rows.map((r) => r.id)).toEqual(["in_open", "in_old"]);
    expect(rows[0].isOpen).toBe(true);
  });

  it("nulls missing urls/number instead of leaking undefined", () => {
    const [row] = invoiceRows([
      inv({ number: null, hosted_invoice_url: null, invoice_pdf: undefined }),
    ]);
    expect(row.number).toBeNull();
    expect(row.hostedUrl).toBeNull();
    expect(row.pdfUrl).toBeNull();
  });
});

describe("paymentMethodRows", () => {
  const pm = (id: string, over: Record<string, unknown> = {}) => ({
    id,
    type: "card",
    card: { brand: "visa", last4: "4242", exp_month: 12, exp_year: 2030 },
    ...over,
  });

  it("maps card fields and puts the default first", () => {
    const rows = paymentMethodRows([pm("pm_b"), pm("pm_a")], "pm_a");
    expect(rows.map((r) => r.id)).toEqual(["pm_a", "pm_b"]);
    expect(rows[0]).toEqual({
      id: "pm_a",
      brand: "visa",
      last4: "4242",
      expMonth: 12,
      expYear: 2030,
      isDefault: true,
    });
    expect(rows[1].isDefault).toBe(false);
  });

  it("ignores non-card payment methods and handles no default", () => {
    const rows = paymentMethodRows(
      [pm("pm_1"), { id: "pm_sepa", type: "sepa_debit" }],
      null,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].isDefault).toBe(false);
  });
});

describe("cardRemovalConsequence (Task 6C staff card removal — panel confirm copy)", () => {
  it("is a plain detach when other cards remain, regardless of status", () => {
    expect(cardRemovalConsequence(1, "active")).toBe(
      "This card will be detached from the customer.",
    );
    expect(cardRemovalConsequence(2, "trialing")).toBe(
      "This card will be detached from the customer.",
    );
  });

  it("warns the next invoice will fail when it's the last card on an active/past_due sub", () => {
    expect(cardRemovalConsequence(0, "active")).toBe(
      "This is the last card on file — the next invoice will fail.",
    );
    expect(cardRemovalConsequence(0, "past_due")).toBe(
      "This is the last card on file — the next invoice will fail.",
    );
  });

  it("warns of cancellation at trial end instead, when it's the last card on a trialing sub", () => {
    // The pair that proves the branch is REALLY keyed on status: same
    // cardsRemainingAfter (0), different copy.
    expect(cardRemovalConsequence(0, "trialing")).toBe(
      "This is the last card on file — the subscription will cancel at trial end.",
    );
  });
});

describe("asCurrency", () => {
  it("narrows Stripe's plain-string currency to a supported one, usd fallback", () => {
    expect(asCurrency("gbp")).toBe("gbp");
    expect(asCurrency("GBP")).toBe("gbp");
    expect(asCurrency("jpy")).toBe("usd");
    expect(asCurrency(null)).toBe("usd");
  });
});

describe("intervalForPrice", () => {
  const plan = { stripe_price_id_monthly: "price_m", stripe_price_id_annual: "price_y" };

  it("resolves the interval from the plans table price ids", () => {
    expect(intervalForPrice("price_m", plan)).toBe("monthly");
    expect(intervalForPrice("price_y", plan)).toBe("annual");
    expect(intervalForPrice("price_other", plan)).toBeNull();
    expect(intervalForPrice(null, plan)).toBeNull();
  });
});

describe("buildAddressUpdateParams (billing details v3/11)", () => {
  it("maps name + address and drops empty optional lines", () => {
    const p = buildAddressUpdateParams({
      name: "Riverside Club",
      address: {
        line1: "10 Downing St",
        line2: "",
        city: "London",
        state: "",
        postal_code: "SW1A 1AA",
        country: "GB",
      },
    });
    expect(p).toEqual({
      name: "Riverside Club",
      address: { line1: "10 Downing St", city: "London", postal_code: "SW1A 1AA", country: "GB" },
    });
  });

  it("omits name when not provided", () => {
    const p = buildAddressUpdateParams({
      address: { line1: "1 Main St", city: "Delhi", postal_code: "110001", country: "IN" },
    });
    expect("name" in p).toBe(false);
    expect(p.address).toMatchObject({ country: "IN" });
  });
});

describe("taxIdRows", () => {
  it("maps id/type/value and verification status, unverified fallback", () => {
    const rows = taxIdRows([
      { id: "txi_1", type: "gb_vat", value: "GB123456789", verification: { status: "verified" } },
      { id: "txi_2", type: "in_gst", value: "22AAAAA0000A1Z5", verification: null },
    ]);
    expect(rows).toEqual([
      { id: "txi_1", type: "gb_vat", value: "GB123456789", status: "verified" },
      { id: "txi_2", type: "in_gst", value: "22AAAAA0000A1Z5", status: "unverified" },
    ]);
  });
});

describe("discountSummary", () => {
  it("describes a percent-forever coupon with its promo code", () => {
    const s = discountSummary([
      {
        id: "di_1",
        coupon: { id: "co_1", name: "Launch deal", percent_off: 10, duration: "forever" },
        promotion_code: { id: "promo_1", code: "LAUNCH10" },
      },
    ]);
    expect(s).toEqual({
      id: "di_1",
      label: "Launch deal (LAUNCH10)",
      description: "10% off forever",
    });
  });

  it("describes an amount-off repeating coupon without a code", () => {
    const s = discountSummary([
      {
        id: "di_2",
        coupon: {
          id: "co_2",
          name: null,
          amount_off: 500,
          currency: "gbp",
          duration: "repeating",
          duration_in_months: 3,
        },
        promotion_code: null,
      },
    ]);
    expect(s?.label).toBe("co_2");
    expect(s?.description).toBe("£5 off for 3 months");
  });

  it("reads the dahlia shape: coupon nested under discount.source", () => {
    // stripe-node v22 pins API 2026-06-24.dahlia, where discount.coupon moved
    // to discount.source.coupon (expand: "discounts.source.coupon").
    const s = discountSummary([
      {
        id: "di_3",
        source: {
          type: "coupon",
          coupon: { id: "co_3", name: null, percent_off: 10, duration: "forever" },
        },
        promotion_code: { id: "promo_3", code: "SEAZN10TEST" },
      },
    ]);
    expect(s).toEqual({
      id: "di_3",
      label: "co_3 (SEAZN10TEST)",
      description: "10% off forever",
    });
  });

  it("returns null for empty or string-only discount lists", () => {
    expect(discountSummary([])).toBeNull();
    expect(discountSummary(["di_x"])).toBeNull();
    expect(discountSummary(undefined)).toBeNull();
  });
});

describe("buildApplyPromoParams", () => {
  it("targets the promotion code id in the discounts array", () => {
    expect(buildApplyPromoParams("promo_123")).toEqual({
      discounts: [{ promotion_code: "promo_123" }],
    });
  });
});

describe("needsRenewalResync (webhook-optional self-heal)", () => {
  const past = new Date(Date.now() - 86_400_000).toISOString();
  const future = new Date(Date.now() + 86_400_000).toISOString();
  const sub = (over: Record<string, unknown>) => ({
    status: "active",
    current_period_end: future,
    stripe_subscription_id: "sub_1",
    ...over,
  });

  it("resyncs a past_due sub (payment may have completed off-site)", () => {
    expect(needsRenewalResync(sub({ status: "past_due" }))).toBe(true);
  });

  it("resyncs when the mirrored period end is in the past (missed renewal webhook)", () => {
    expect(needsRenewalResync(sub({ current_period_end: past }))).toBe(true);
    expect(needsRenewalResync(sub({ status: "trialing", current_period_end: past }))).toBe(true);
  });

  it("stays quiet for healthy, canceled, or non-Stripe subs", () => {
    expect(needsRenewalResync(sub({}))).toBe(false);
    expect(needsRenewalResync(sub({ status: "canceled", current_period_end: past }))).toBe(false);
    expect(
      needsRenewalResync(sub({ stripe_subscription_id: null, current_period_end: past })),
    ).toBe(false);
    expect(needsRenewalResync(null)).toBe(false);
  });
});
