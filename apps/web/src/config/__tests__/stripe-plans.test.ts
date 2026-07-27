// Guards the Stripe plan seed that `npm run stripe:sync` applies. A malformed
// seed silently breaks checkout (the route reads plans.stripe_price_id_*), so
// pin its shape. No DB, no Stripe — pure structural validation.
import { describe, expect, it } from "vitest";
import seed from "../stripe-plans.json";

interface PriceSpec {
  lookup_key: string;
  unit_amount: number;
  interval?: string;
  currency_options?: Record<string, number>;
  tiers?: { unit_amount: number; currency_options?: Record<string, number> }[];
}
interface PlanSpec {
  key: string;
  product: { name: string; description?: string };
  prices: { monthly: PriceSpec; annual: PriceSpec };
}
/** One product + one flat price: the Event Pass rungs, credit packs, seat and
 *  size-pack add-ons all share this shape. */
interface PassSpec {
  key: string;
  product: { name: string; description?: string };
  price: PriceSpec;
}

/** Every price the sync script sends to Stripe, from every section of the seed —
 *  so a new section can't quietly opt out of the guards below. */
function allPrices(): PriceSpec[] {
  const flat = ["passes", "packs", "seats", "size_packs"] as const;
  return [
    ...(seed.plans as PlanSpec[]).flatMap((p) => [p.prices.monthly, p.prices.annual]),
    ...flat.flatMap((section) => ((seed[section] ?? []) as PassSpec[]).map((s) => s.price)),
  ];
}

describe("stripe-plans seed", () => {
  it("declares a valid currency and at least the pro plan", () => {
    expect(typeof seed.currency).toBe("string");
    expect(seed.currency).toMatch(/^[a-z]{3}$/);
    const keys = (seed.plans as PlanSpec[]).map((p) => p.key);
    expect(keys).toContain("pro");
  });

  it("gives every plan a product and both monthly + annual prices", () => {
    for (const plan of seed.plans as PlanSpec[]) {
      expect(plan.product?.name, `${plan.key} product name`).toBeTruthy();
      for (const interval of ["monthly", "annual"] as const) {
        const price = plan.prices[interval];
        expect(price, `${plan.key}.${interval}`).toBeTruthy();
        expect(price.lookup_key, `${plan.key}.${interval} lookup_key`).toMatch(/^[a-z0-9_]+$/);
        expect(price.unit_amount, `${plan.key}.${interval} amount`).toBeGreaterThan(0);
      }
      expect(plan.prices.monthly.interval).toBe("month");
      expect(plan.prices.annual.interval).toBe("year");
    }
  });

  it("uses globally-unique lookup_keys (Stripe requires them unique per account)", () => {
    const lookups = allPrices().map((p) => p.lookup_key);
    expect(new Set(lookups).size, lookups.join(" ")).toBe(lookups.length);
  });

  // v17 #294 added a SECOND Event Pass rung, so `passes` stopped being a
  // one-element array. Two hazards become live the moment a section holds more
  // than one entry, and both are silent:
  //  - a duplicated lookup_key makes stripe:sync mint a replacement price for
  //    one entry and archive the other's on every run, flapping the price ids;
  //  - a missing currency_options entry does NOT fail — lib/currency's
  //    `amountFor` falls back to `unit_amount`, so the L rung would advertise
  //    and charge 5900 *gbp* minor units (£59) instead of its £49 price point.
  it("gives every price a SET amount in all five supported currencies", () => {
    for (const price of allPrices()) {
      for (const currency of ["eur", "gbp", "inr", "aud"]) {
        // `?? 0` rather than a bare lookup: toBeGreaterThan(undefined) throws a
        // TypeError before vitest ever prints the message naming the currency.
        expect(
          price.currency_options?.[currency] ?? 0,
          `${price.lookup_key} is missing a ${currency} price point`,
        ).toBeGreaterThan(0);
      }
      expect(price.unit_amount, `${price.lookup_key} usd amount`).toBeGreaterThan(0);
    }
  });

  it("keys both Event Pass rungs to their plans rows, at M < L", () => {
    const passes = seed.passes as PassSpec[];
    expect(passes.map((p) => p.key)).toEqual(["event_pass", "event_pass_l"]);
    const [m, l] = passes;
    expect(l!.price.unit_amount).toBeGreaterThan(m!.price.unit_amount);
    for (const currency of ["eur", "gbp", "inr", "aud"] as const) {
      expect(
        l!.price.currency_options?.[currency] ?? 0,
        `${currency}: L must cost more than M`,
      ).toBeGreaterThan(m!.price.currency_options?.[currency] ?? 0);
    }
  });
});
