// buildEmbeddedCheckoutParams / buildPassCheckoutParams shape the Stripe
// Embedded Checkout sessions. Pure (no Stripe/DB) — pins the embedded
// ui_mode, the return_url contract, the 14-day no-card trial and the
// pass/currency extensions (v3/07 §3–4) that the checkout routes depend on.
import { describe, expect, it } from "vitest";
import {
  assertCheckoutAllowed,
  buildEmbeddedCheckoutParams,
  buildPassCheckoutParams,
  checkoutTrialDays,
} from "@/lib/billing";
import {
  currencyFromAcceptLanguage,
  formatMinor,
  passPrice,
  proPlusPrice,
  proPrice,
  type Currency,
  SUPPORTED_CURRENCIES,
} from "@/lib/currency";
import { checkoutSchema } from "@/lib/types";

const base = {
  priceId: "price_123",
  orgId: "org-abc",
  returnUrl: "https://app.test/settings/billing?checkout=success&session_id={CHECKOUT_SESSION_ID}",
  trialDays: 14,
};

describe("buildEmbeddedCheckoutParams", () => {
  it("uses embedded ui_mode with a return_url and no hosted urls", () => {
    const p = buildEmbeddedCheckoutParams({ ...base, customerEmail: "a@b.com" });
    expect(p.ui_mode).toBe("embedded_page");
    expect(p.return_url).toBe(base.returnUrl);
    expect("success_url" in p).toBe(false);
    expect("cancel_url" in p).toBe(false);
    expect(p.mode).toBe("subscription");
    expect(p.line_items).toEqual([{ price: "price_123", quantity: 1 }]);
    expect(p.metadata).toMatchObject({ org_id: "org-abc" });
  });

  it("keeps the 14-day no-card trial (cancel if no method by trial end)", () => {
    const p = buildEmbeddedCheckoutParams({ ...base, customerEmail: "a@b.com" });
    expect(p.payment_method_collection).toBe("if_required");
    expect(p.subscription_data?.trial_period_days).toBe(14);
    expect(p.subscription_data?.trial_settings?.end_behavior?.missing_payment_method).toBe("cancel");
  });

  it("trialDays 0: no trial keys, card collection required, metadata kept", () => {
    const p = buildEmbeddedCheckoutParams({ ...base, trialDays: 0, customerEmail: "a@b.com" });
    expect(p.subscription_data && "trial_period_days" in p.subscription_data).toBe(false);
    expect(p.subscription_data && "trial_settings" in p.subscription_data).toBe(false);
    // No trial → payment due at checkout, so the card is always collected.
    expect("payment_method_collection" in p).toBe(false);
    expect(p.subscription_data?.metadata).toEqual({ org_id: "org-abc" });
  });

  it("reuses an existing customer id, else falls back to customer_email", () => {
    const withCust = buildEmbeddedCheckoutParams({ ...base, customerId: "cus_9" });
    expect(withCust.customer).toBe("cus_9");
    expect("customer_email" in withCust).toBe(false);

    const withEmail = buildEmbeddedCheckoutParams({ ...base, customerEmail: "a@b.com" });
    expect(withEmail.customer_email).toBe("a@b.com");
    expect("customer" in withEmail).toBe(false);
  });

  it("sets the session currency for non-usd, omits it for usd/default", () => {
    const eur = buildEmbeddedCheckoutParams({ ...base, currency: "eur" });
    expect(eur.currency).toBe("eur");
    const usd = buildEmbeddedCheckoutParams({ ...base, currency: "usd" });
    expect("currency" in usd).toBe(false);
    expect("currency" in buildEmbeddedCheckoutParams(base)).toBe(false);
  });
});

describe("one trial per org (product gap 2026-07-13)", () => {
  it("first-ever checkout gets the 14-day trial", () => {
    expect(checkoutTrialDays(undefined)).toBe(14);
    expect(checkoutTrialDays({ trial_used_at: null })).toBe(14);
  });

  it("an org that ever trialed gets no second trial — downgrade/upgrade loop closed", () => {
    expect(checkoutTrialDays({ trial_used_at: "2026-01-01T00:00:00Z" })).toBe(0);
  });

  it("checkout is refused while a live Stripe subscription exists", () => {
    for (const status of ["active", "trialing"]) {
      expect(() =>
        assertCheckoutAllowed({ stripe_subscription_id: "sub_1", status }),
      ).toThrowError(/manage/i);
    }
  });

  it("checkout is allowed with no sub row, a canceled sub, or comped Pro", () => {
    expect(() => assertCheckoutAllowed(undefined)).not.toThrow();
    expect(() =>
      assertCheckoutAllowed({ stripe_subscription_id: "sub_1", status: "canceled" }),
    ).not.toThrow();
    expect(() =>
      assertCheckoutAllowed({ stripe_subscription_id: null, status: "active" }),
    ).not.toThrow();
  });
});

describe("buildPassCheckoutParams (v3/07 §3)", () => {
  const pass = {
    priceId: "price_pass",
    orgId: "org-abc",
    competitionId: "comp-1",
    returnUrl: "https://app.test/o/x/c/y/upgrade?checkout=success&session_id={CHECKOUT_SESSION_ID}",
  };

  it("is a one-time embedded payment carrying org + competition metadata", () => {
    const p = buildPassCheckoutParams({ ...pass, customerEmail: "a@b.com" });
    expect(p.ui_mode).toBe("embedded_page");
    expect(p.mode).toBe("payment");
    expect(p.return_url).toBe(pass.returnUrl);
    expect(p.line_items).toEqual([{ price: "price_pass", quantity: 1 }]);
    expect(p.metadata).toEqual({
      org_id: "org-abc",
      competition_id: "comp-1",
      pass_key: "event_pass",
    });
    // One-time purchase: no trial, no subscription payload.
    expect("subscription_data" in p).toBe(false);
    expect("payment_method_collection" in p).toBe(false);
  });

  it("honours the currency switch like the subscription flow", () => {
    expect(buildPassCheckoutParams({ ...pass, currency: "inr" }).currency).toBe("inr");
    expect("currency" in buildPassCheckoutParams({ ...pass, currency: "usd" })).toBe(false);
  });
});

describe("currency price points (v3/07 §4)", () => {
  it("reads SET price points from stripe-plans.json", () => {
    expect(proPrice("monthly", "usd")).toBe(1900);
    expect(proPrice("monthly", "eur")).toBe(1800);
    expect(proPrice("monthly", "gbp")).toBe(1500);
    expect(proPrice("monthly", "inr")).toBe(139900);
    expect(proPrice("annual", "usd")).toBe(15900);
    expect(passPrice("usd")).toBe(2900);
    expect(passPrice("gbp")).toBe(2500);
    expect(passPrice("aud")).toBe(4500);
  });

  it("formats whole amounts without decimals", () => {
    expect(formatMinor(1900, "usd")).toBe("$19");
    expect(formatMinor(139900, "inr")).toBe("₹1,399");
    expect(formatMinor(20000 / 12, "usd")).toBe("$16.67");
  });

  it("guesses a currency from Accept-Language, defaulting to usd", () => {
    expect(currencyFromAcceptLanguage("en-GB,en;q=0.9")).toBe("gbp");
    expect(currencyFromAcceptLanguage("en-IN")).toBe("inr");
    expect(currencyFromAcceptLanguage("de-DE,de;q=0.9")).toBe("eur");
    expect(currencyFromAcceptLanguage("en-AU")).toBe("aud");
    expect(currencyFromAcceptLanguage("en-US")).toBe("usd");
    expect(currencyFromAcceptLanguage(null)).toBe("usd");
  });
});

describe("Pro Plus price points", () => {
  it("reads SET price points from stripe-plans.json", () => {
    expect(proPlusPrice("monthly", "usd")).toBe(3900);
    expect(proPlusPrice("monthly", "eur")).toBe(3700);
    expect(proPlusPrice("monthly", "gbp")).toBe(3300);
    expect(proPlusPrice("monthly", "inr")).toBe(299900);
    expect(proPlusPrice("monthly", "aud")).toBe(5900);
    expect(proPlusPrice("annual", "usd")).toBe(32700);
  });

  it("annual gives at least a 30% discount vs 12x monthly, Pro + Pro Plus, every currency", () => {
    for (const price of [proPrice, proPlusPrice]) {
      for (const currency of SUPPORTED_CURRENCIES as readonly Currency[]) {
        const monthly = price("monthly", currency);
        const annual = price("annual", currency);
        // ≥30% off: a year of annual costs no more than 70% of 12 monthly bills.
        expect(annual, `${price.name} annual ${currency}`).toBeLessThanOrEqual(
          monthly * 12 * 0.7,
        );
      }
    }
  });
});

describe("checkoutSchema plan_key", () => {
  it("accepts pro and pro_plus", () => {
    expect(checkoutSchema.safeParse({ plan_key: "pro", interval: "monthly" }).success).toBe(true);
    expect(checkoutSchema.safeParse({ plan_key: "pro_plus", interval: "annual" }).success).toBe(true);
  });

  it("rejects an unknown plan_key like business", () => {
    expect(checkoutSchema.safeParse({ plan_key: "business", interval: "monthly" }).success).toBe(false);
  });
});
