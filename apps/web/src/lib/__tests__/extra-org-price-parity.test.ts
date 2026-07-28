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
import { APPROVED_DICTIONARY_COPY } from "./_approved-dictionary-copy";

const PLANS = ["pro", "pro_plus"] as const;
const INTERVALS = ["monthly", "annual"] as const;

/**
 * Every surface that states the extra-organisation rate. If the seed stops
 * being at-most-half, these are what must be rewritten — in all four locales
 * for the dictionary keys, once each for the help articles.
 *
 * IT WAS STALE AND NOTHING ASSERTED IT (v17 gap wave 7, #299). The list named
 * six surfaces; there were nine, and three of the six carried a falsehood for
 * four rounds of this wave while this file's own message pointed at them. A
 * list that only ever appears inside a failure string is documentation, and
 * documentation drifts — so the dictionary half of it is now checked against
 * the approved-copy inventory below, and the help half against the computed
 * axis in `help-copy-truth.test.ts`.
 */
const HALF_RATE_DICTIONARY_KEYS = [
  "pricing.matrix.orgs.max_owned.note",
  "pricing.faq.groups.a",
  "pricing.faq.proPlus.a",
  "tips.billing.extra-org.body",
  "orgNew.bill.addToExistingHint",
  "billing.group.attach.confirmCharge",
];

const COPY_THAT_SAYS_HALF = [
  ...HALF_RATE_DICTIONARY_KEYS.map((k) => `dictionaries/<locale>/*.json: ${k}`),
  "config/tips.ts: billing.extra-org body (the source of truth the en dictionary mirrors)",
  "config/stripe-plans.json: both plans' product.description",
  "content/help/billing/add-ons.md: 'Extra organisations'",
  "content/help/billing/groups.md: frontmatter, 'What the group buys', 'Adding an organisation', 'What an added organisation costs', 'Common questions'",
  "content/help/getting-started/create-your-organisation.md: 'Can I run more than one organisation?'",
  "e2e/billing-groups.spec.ts + e2e/billing-groups-journey.spec.ts: the attach-dialog assertion",
].join("\n  - ");

describe("extra-organisation price", () => {
  // The list above is only as good as its agreement with what is actually
  // pinned. Without this it is a comment, and it spent four rounds being one.
  it("names every dictionary key the approved-copy gate pins for this claim", () => {
    const pinned = new Set(APPROVED_DICTIONARY_COPY.map((e) => e.key));
    for (const key of HALF_RATE_DICTIONARY_KEYS) {
      expect(pinned.has(key), `${key} is listed here but not pinned by the gate`).toBe(true);
    }
    // …and the other direction, so a key pinned FOR THIS CLAIM cannot drop off
    // the list. Matched on the `why` note, which names the claim it decides.
    const pinnedForThisClaim = APPROVED_DICTIONARY_COPY.filter((e) =>
      /extra-organisation rate/i.test(e.why),
    ).map((e) => e.key);
    expect(pinnedForThisClaim.sort()).toEqual([...HALF_RATE_DICTIONARY_KEYS].sort());
  });

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
