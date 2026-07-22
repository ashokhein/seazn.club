// The extra-organisation price is a number in ONE place (stripe-plans.json's
// `up_to: "inf"` tier, which is what Stripe actually bills from) and a word in
// many: "half your plan's rate" appears in the pricing matrix note, the pricing
// FAQ, the Pro Plus answer, the billing.extra-org tip, both product
// descriptions in the seed itself, and the billing groups help article — across
// four locales.
//
// So the price is changeable, but not quietly. Change the tier and this test
// goes red with the list of copy that has just started lying. That is the whole
// job: nothing here computes the price, and nothing should — a second
// arithmetic source of truth is how the advertised number and the charged one
// drift apart.
import { describe, expect, it } from "vitest";
import stripePlans from "@/config/stripe-plans.json";
import { extraOrgPrice, proPrice, proPlusPrice, SUPPORTED_CURRENCIES } from "@/lib/currency";

const PLANS = ["pro", "pro_plus"] as const;
const INTERVALS = ["monthly", "annual"] as const;

/** Every string that states the half-price rule in prose. If the seed stops
 *  being half, these are what must be rewritten — in all four locales. */
const COPY_THAT_SAYS_HALF = [
  "dictionaries/<locale>/marketing.json: pricing.matrix.orgs.max_owned.note",
  "dictionaries/<locale>/marketing.json: pricing.faq.groups.a",
  "dictionaries/<locale>/marketing.json: pricing.faq.proPlus.a",
  "dictionaries/<locale>/ui.json: tips.billing.extra-org.body",
  "config/tips.ts: billing.extra-org body (the fallback copy)",
  "config/stripe-plans.json: both plans' product.description",
  "content/help/billing/groups.md: 'What the group buys' and 'Adding an organisation'",
].join("\n  - ");

describe("extra-organisation price", () => {
  it("is read from the tier Stripe bills, in every currency", () => {
    for (const plan of PLANS) {
      for (const interval of INTERVALS) {
        const spec = stripePlans.plans.find((p) => p.key === plan)!;
        const tier = spec.prices[interval].tiers!.find((t) => t.up_to === "inf")!;
        for (const currency of SUPPORTED_CURRENCIES) {
          const expected =
            currency === "usd"
              ? tier.unit_amount
              : ((tier.currency_options as Record<string, number>)?.[currency] ??
                tier.unit_amount);
          expect(extraOrgPrice(plan, interval, currency)).toBe(expected);
        }
      }
    }
  });

  it("still matches the 'half your plan's rate' the copy promises", () => {
    const offenders: string[] = [];
    for (const plan of PLANS) {
      for (const interval of INTERVALS) {
        for (const currency of SUPPORTED_CURRENCIES) {
          const base = plan === "pro" ? proPrice(interval, currency) : proPlusPrice(interval, currency);
          const extra = extraOrgPrice(plan, interval, currency);
          // Rounded DOWN to a whole major unit (INR to the nearest x99), so
          // exact halves are not required — but the customer must never be
          // charged MORE than half, and never so much less that "half" is a
          // meaningfully wrong description of what they pay.
          const half = base / 2;
          if (extra > half || extra < half * 0.9)
            offenders.push(`${plan} ${interval} ${currency}: base ${base}, extra ${extra}`);
        }
      }
    }
    expect(
      offenders,
      offenders.length === 0
        ? ""
        : `The extra-organisation price is no longer half the base rate, but this copy still says it is:\n  - ${COPY_THAT_SAYS_HALF}\n\nMismatches:\n  ${offenders.join("\n  ")}`,
    ).toEqual([]);
  });

  it("never exceeds the base rate, whatever the tiers are set to", () => {
    // A guard that survives a deliberate move away from half: an "extra" org
    // costing more than the first would make the group a penalty rather than a
    // discount, and every surface that sells grouping would be selling a lie.
    for (const plan of PLANS) {
      for (const interval of INTERVALS) {
        for (const currency of SUPPORTED_CURRENCIES) {
          const base = plan === "pro" ? proPrice(interval, currency) : proPlusPrice(interval, currency);
          expect(extraOrgPrice(plan, interval, currency)).toBeLessThanOrEqual(base);
        }
      }
    }
  });

  it("charges less for a Pro extra organisation than Pro Plus does", () => {
    // Pins the ladder itself: the tiers are independent numbers in JSON, so
    // nothing but this stops a Pro extra org being priced above a Pro Plus one.
    for (const interval of INTERVALS) {
      for (const currency of SUPPORTED_CURRENCIES) {
        expect(extraOrgPrice("pro", interval, currency)).toBeLessThan(
          extraOrgPrice("pro_plus", interval, currency),
        );
      }
    }
  });
});
