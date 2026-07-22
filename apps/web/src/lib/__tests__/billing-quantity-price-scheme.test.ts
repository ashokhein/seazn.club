// Stripe prices are IMMUTABLE, so moving the plan prices from flat to graduated
// tiers mints new prices and archives the old ones — every subscription created
// before that migration is still on the archived FLAT price. A per_unit price
// bills `quantity x base`, so raising quantity above 1 on one of those charges
// N x the full rate instead of base + half per extra org: a two-org Pro group
// would be billed $38 where it owes $28.
//
// Billing groups made quantity > 1 reachable (buildEmbeddedCheckoutParams now
// takes one), so the guard fails CLOSED: refusing to charge is recoverable,
// silently overcharging a customer is not.
import { describe, expect, it } from "vitest";
import {
  PRICE_NOT_TIERED,
  assertPriceBillsQuantity,
  buildEmbeddedCheckoutParams,
  buildPassCheckoutParams,
} from "@/lib/billing";

const base = {
  priceId: "price_pro_monthly",
  orgId: "org-1",
  returnUrl: "https://seazn.club/return",
  trialDays: 0,
  customerEmail: "payer@example.com",
};

describe("assertPriceBillsQuantity", () => {
  it("refuses quantity > 1 on a flat per_unit price", () => {
    expect(() =>
      assertPriceBillsQuantity({
        priceId: "price_legacy",
        billingScheme: "per_unit",
        quantity: 2,
      }),
    ).toThrow(PRICE_NOT_TIERED);
  });

  it("refuses quantity > 1 when the scheme is unknown (fails closed)", () => {
    expect(() =>
      assertPriceBillsQuantity({ priceId: "price_legacy", billingScheme: null, quantity: 3 }),
    ).toThrow(PRICE_NOT_TIERED);
    expect(() =>
      assertPriceBillsQuantity({ priceId: "price_legacy", billingScheme: undefined, quantity: 3 }),
    ).toThrow(PRICE_NOT_TIERED);
  });

  it("allows quantity > 1 on a tiered price", () => {
    expect(() =>
      assertPriceBillsQuantity({ priceId: "price_tiered", billingScheme: "tiered", quantity: 5 }),
    ).not.toThrow();
  });

  it("allows quantity 1 on any scheme — a one-org group is a legitimate flat buy", () => {
    for (const scheme of ["per_unit", "tiered", null, undefined] as const) {
      expect(() =>
        assertPriceBillsQuantity({ priceId: "price_x", billingScheme: scheme, quantity: 1 }),
      ).not.toThrow();
    }
  });
});

describe("buildEmbeddedCheckoutParams quantity guard", () => {
  it("throws for a multi-org group on a legacy flat price", () => {
    expect(() =>
      buildEmbeddedCheckoutParams({ ...base, quantity: 2, billingScheme: "per_unit" }),
    ).toThrow(PRICE_NOT_TIERED);
  });

  it("throws when the caller supplies a quantity but no scheme", () => {
    expect(() => buildEmbeddedCheckoutParams({ ...base, quantity: 2 })).toThrow(PRICE_NOT_TIERED);
  });

  it("bills the group size against a tiered price", () => {
    const params = buildEmbeddedCheckoutParams({
      ...base,
      quantity: 3,
      billingScheme: "tiered",
    });
    expect(params.line_items).toEqual([{ price: base.priceId, quantity: 3 }]);
  });

  it("still builds a single-seat checkout on a flat price (no regression)", () => {
    const flat = buildEmbeddedCheckoutParams({ ...base, quantity: 1, billingScheme: "per_unit" });
    expect(flat.line_items).toEqual([{ price: base.priceId, quantity: 1 }]);
    // And with no quantity at all, which is what every pre-groups caller sends.
    const bare = buildEmbeddedCheckoutParams(base);
    expect(bare.line_items).toEqual([{ price: base.priceId, quantity: 1 }]);
  });
});

describe("Event Pass checkout", () => {
  // A pass is a one-time purchase for a SINGLE competition. It is legitimately
  // a flat, quantity-1 line item and must never be multiplied by group size.
  it("is always quantity 1 and never hits the guard", () => {
    const params = buildPassCheckoutParams({
      priceId: "price_event_pass",
      orgId: "org-1",
      competitionId: "comp-1",
      competitionName: "Spring Cup",
      returnUrl: "https://seazn.club/return",
      customerEmail: "member@example.com",
    });
    expect(params.line_items).toEqual([{ price: "price_event_pass", quantity: 1 }]);
  });
});
