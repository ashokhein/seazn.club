// buildEmbeddedCheckoutParams shapes the Stripe Embedded Checkout session.
// Pure (no Stripe/DB) — pins the embedded ui_mode, the return_url contract, and
// the 14-day no-card trial that the checkout route depends on.
import { describe, expect, it } from "vitest";
import { buildEmbeddedCheckoutParams } from "@/lib/billing";

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
});
