// What the Add-ons tab QUOTES for one extra-organisation rider (v17 gap #293,
// Task 6). Pure JSON + pure function, no DB, no Stripe.
//
// The number must come from the `org_addons` SKU Stripe bills, NOT from
// `extraOrgPrice()`. The two agree monthly and diverge annually, so a test that
// only compares the monthly figures cannot tell the right source from the wrong
// one — the annual assertions below are the ones that can fail.
import { describe, expect, it } from "vitest";
import stripePlans from "@/config/stripe-plans.json";
import { extraOrgPrice, SUPPORTED_CURRENCIES } from "@/lib/currency";
import { orgAddonPriceMinor } from "@/lib/org-addons";

describe("orgAddonPriceMinor", () => {
  it("reads the rider SKU's own amount, in every currency and both tiers", () => {
    for (const seed of stripePlans.org_addons ?? []) {
      for (const currency of SUPPORTED_CURRENCIES) {
        const expected =
          currency === "usd"
            ? seed.price.unit_amount
            : ((seed.price.currency_options as Record<string, number>)?.[currency] ??
              seed.price.unit_amount);
        expect(orgAddonPriceMinor(seed.plan_key, currency), `${seed.plan_key} ${currency}`).toBe(
          expected,
        );
      }
    }
  });

  it("is NOT the plan's annual per-organisation tier", () => {
    // The bug this function exists to prevent. `extraOrgPrice(plan, "annual")`
    // is what an extra organisation costs INSIDE the plan's cap on a yearly
    // bill; the rider is a separate monthly charge. Quoting the annual tier to
    // an annual group understates the rider by roughly a third AND implies a
    // yearly cadence that will actually arrive every month.
    for (const plan of ["pro", "pro_plus"] as const) {
      for (const currency of SUPPORTED_CURRENCIES) {
        expect(
          orgAddonPriceMinor(plan, currency),
          `${plan} ${currency}: the rider must not be quoted at the annual tier`,
        ).not.toBe(extraOrgPrice(plan, "annual", currency));
      }
    }
  });

  it("has no interval parameter to get wrong — the rider is monthly on every plan", () => {
    // Pinned as DATA, not as prose: any tier added to the seed with a different
    // interval reds this, and the copy that says "/mo" would then be lying.
    for (const seed of stripePlans.org_addons ?? []) {
      expect(seed.price.interval, seed.key).toBe("month");
    }
    expect(stripePlans.org_addons?.length).toBeGreaterThan(0);
  });

  it("returns null for a plan with no rider to sell", () => {
    // Not 0. A zero would render as "$0/mo each" beside a stepper, i.e. an
    // offer of something free that does not exist.
    expect(orgAddonPriceMinor("community", "usd")).toBeNull();
    expect(orgAddonPriceMinor("event_pass", "usd")).toBeNull();
    expect(orgAddonPriceMinor("", "usd")).toBeNull();
  });
});
