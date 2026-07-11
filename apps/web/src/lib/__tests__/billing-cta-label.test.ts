// A trialing Pro org has a Stripe customer but no card (14-day no-card trial),
// so the primary billing CTA must ask for a card — not read as generic card
// management. Since v3/11 both targets are in-app (no portal).
import { describe, expect, it } from "vitest";
import { billingCtaLabel } from "@/lib/billing";

describe("billingCtaLabel", () => {
  it("prompts to add a card while trialing", () => {
    expect(billingCtaLabel("trialing")).toBe("Add a card to keep Pro →");
  });

  it("is card management once active or past due (in-app, not portal)", () => {
    expect(billingCtaLabel("active")).toBe("Manage payment methods");
    expect(billingCtaLabel("past_due")).toBe("Manage payment methods");
  });
});
