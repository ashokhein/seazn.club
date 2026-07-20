// A trialing Pro org usually has a Stripe customer but no card (14-day no-card
// trial), so the primary billing CTA must ask for a card — not read as generic
// card management. Since v3/11 both targets are in-app (no portal).
//
// 2026-07-20: the label also takes has_payment_method, because keying on status
// alone told orgs that had ALREADY added a card to add one.
import { describe, expect, it } from "vitest";
import { billingCtaLabel } from "@/lib/billing";

describe("billingCtaLabel", () => {
  it("prompts to add a card while trialing without one", () => {
    expect(billingCtaLabel("trialing", false)).toBe("Add a card to keep Pro →");
  });

  it("stops asking once the trialing org has a card on file", () => {
    expect(billingCtaLabel("trialing", true)).toBe("Manage payment methods");
  });

  it("is card management once active or past due (in-app, not portal)", () => {
    expect(billingCtaLabel("active", false)).toBe("Manage payment methods");
    expect(billingCtaLabel("past_due", false)).toBe("Manage payment methods");
    expect(billingCtaLabel("active", true)).toBe("Manage payment methods");
    expect(billingCtaLabel("past_due", true)).toBe("Manage payment methods");
  });
});
