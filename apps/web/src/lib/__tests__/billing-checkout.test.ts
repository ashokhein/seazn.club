// buildEmbeddedCheckoutParams / buildPassCheckoutParams shape the Stripe
// Embedded Checkout sessions. Pure (no Stripe/DB) — pins the embedded
// ui_mode, the return_url contract, the 14-day no-card trial and the
// pass/currency extensions (v3/07 §3–4) that the checkout routes depend on.
import { describe, expect, it } from "vitest";
import { buildEmbeddedCheckoutParams, buildPassCheckoutParams } from "@/lib/billing";
import {
  currencyFromAcceptLanguage,
  formatMinor,
  passPrice,
  proPrice,
} from "@/lib/currency";

const base = {
  priceId: "price_123",
  orgId: "org-abc",
  returnUrl: "https://app.test/settings/billing?checkout=success&session_id={CHECKOUT_SESSION_ID}",
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
    expect(proPrice("monthly", "usd")).toBe(2000);
    expect(proPrice("monthly", "eur")).toBe(1900);
    expect(proPrice("monthly", "gbp")).toBe(1600);
    expect(proPrice("monthly", "inr")).toBe(149900);
    expect(proPrice("annual", "usd")).toBe(20000);
    expect(passPrice("usd")).toBe(3900);
    expect(passPrice("gbp")).toBe(3300);
    expect(passPrice("aud")).toBe(5900);
  });

  it("formats whole amounts without decimals", () => {
    expect(formatMinor(2000, "usd")).toBe("$20");
    expect(formatMinor(149900, "inr")).toBe("₹1,499");
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
