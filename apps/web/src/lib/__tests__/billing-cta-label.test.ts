// A trialing Pro org has a Stripe customer but no card (14-day no-card trial),
// so the billing-page portal button must ask for a card — not read as generic
// "Manage billing". Regression for the "Add a card to keep Pro" CTA.
import { describe, expect, it } from "vitest";
import { billingCtaLabel } from "@/lib/billing";

describe("billingCtaLabel", () => {
  it("prompts to add a card while trialing", () => {
    expect(billingCtaLabel("trialing")).toBe("Add a card to keep Pro →");
  });

  it("is generic billing management once active or past due", () => {
    expect(billingCtaLabel("active")).toBe("Manage billing →");
    expect(billingCtaLabel("past_due")).toBe("Manage billing →");
  });
});
