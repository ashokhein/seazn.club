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

/** One amount the sync script sends to Stripe. */
interface SeedAmount {
  /** Label for failure messages: the price's lookup_key, plus `tier N` when the
   *  amount is one rung of a graduated ladder (tiers carry no key of their own). */
  label: string;
  /** Set only on nodes that DECLARE one. A tier inherits its price's label but
   *  never its key, or every tiered price would read as a duplicate. */
  lookupKey?: string;
  unit_amount: number;
  currency_options?: Record<string, number>;
}

/**
 * Every amount the sync script sends to Stripe, from every section of the seed.
 *
 * Found by WALKING the seed rather than from a hand-written list of sections:
 * the old list promised "a new section can't quietly opt out" but was itself
 * the thing that had to be remembered, and v17 #293 found two live holes in it
 * — `org_addons` was never added, and every graduated TIER amount was invisible
 * because the walk stopped at the price's own `unit_amount`. Anything carrying
 * a `unit_amount` is now covered the day it is written.
 */
function allPrices(source: unknown = seed): SeedAmount[] {
  const out: SeedAmount[] = [];
  const walk = (node: unknown, label: string): void => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const child of node) walk(child, label);
      return;
    }
    const rec = node as Record<string, unknown>;
    const lookupKey = typeof rec.lookup_key === "string" ? rec.lookup_key : undefined;
    const own = lookupKey ?? label;
    if (typeof rec.unit_amount === "number") {
      out.push({
        label: own,
        lookupKey,
        unit_amount: rec.unit_amount,
        currency_options: rec.currency_options as Record<string, number> | undefined,
      });
    }
    for (const [key, value] of Object.entries(rec)) {
      // A leaf map of currency -> amount; its numbers belong to the node above.
      if (key === "currency_options") continue;
      if (key === "tiers" && Array.isArray(value)) {
        value.forEach((tier, i) => walk(tier, `${own} tier ${i + 1}`));
        continue;
      }
      walk(value, own);
    }
  };
  walk(source, "seed");
  return out;
}

/** The four currencies every price must SET a point in (usd is `unit_amount`).
 *  A hole here does NOT fail at sync time — lib/currency's `amountFor` falls
 *  back to `unit_amount` and Stripe falls back to adaptive pricing — so it is
 *  only ever caught here. */
const CURRENCIES = ["eur", "gbp", "inr", "aud"] as const;

/** Loose mirror of the seed, for building deliberately-broken clones: the
 *  imported JSON's inferred type has every currency as a required key, which is
 *  exactly what a hole fixture needs to remove. */
interface MutablePrice {
  lookup_key?: string;
  unit_amount: number;
  currency_options?: Record<string, number>;
  tiers?: MutablePrice[];
}
interface MutableSeed {
  plans: { prices: Record<string, MutablePrice> }[];
  org_addons?: { price: MutablePrice }[];
}
const holedClone = (): MutableSeed => JSON.parse(JSON.stringify(seed)) as MutableSeed;

/** Every (price, currency) point the seed fails to SET, as readable labels.
 *  A pure function so it can be pointed at a deliberately-broken clone — the
 *  only way to prove the guard actually covers a section, since the real seed
 *  is (and must stay) complete. */
function missingCurrencyPoints(source: unknown = seed): string[] {
  return allPrices(source).flatMap((price) =>
    CURRENCIES.filter((c) => !((price.currency_options?.[c] ?? 0) > 0)).map(
      (c) => `${price.label} is missing a ${c} price point`,
    ),
  );
}

/** lookup_keys used by more than one price. Stripe requires them unique per
 *  account: a duplicate makes `stripe:sync` mint a replacement price for one
 *  entry and archive the other's ON EVERY RUN, flapping the price ids that live
 *  subscriptions resolve through. */
function duplicateLookupKeys(source: unknown = seed): string[] {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const price of allPrices(source)) {
    if (!price.lookupKey) continue; // a tier has no key of its own
    if (seen.has(price.lookupKey)) dupes.add(price.lookupKey);
    seen.add(price.lookupKey);
  }
  return [...dupes];
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
    expect(duplicateLookupKeys()).toEqual([]);
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
    expect(missingCurrencyPoints()).toEqual([]);
    for (const price of allPrices()) {
      expect(price.unit_amount, `${price.label} usd amount`).toBeGreaterThan(0);
    }
  });

  // The guards above are only as good as what `allPrices()` collects, and the
  // real seed is complete — so they pass whether or not a section is covered.
  // These two point them at deliberately-broken clones, which is the only way
  // to prove coverage. v17 #293 found `org_addons` exempt from both (the old
  // hand-written section list did not name it) and every graduated TIER exempt
  // from the currency guard (the walk stopped at tier 1).
  it("catches a hole in a NEWER section and inside a graduated tier, not just tier 1", () => {
    const holedSection = holedClone();
    delete holedSection.org_addons![0]!.price.currency_options!.gbp;
    expect(missingCurrencyPoints(holedSection)).toEqual([
      "seazn_extra_org_pro_monthly is missing a gbp price point",
    ]);

    const holedTier = holedClone();
    delete holedTier.plans[0]!.prices.monthly!.tiers![1]!.currency_options!.inr;
    // The extra-organisation tier: a hole here bills every org past the first
    // at the usd amount in rupees.
    expect(missingCurrencyPoints(holedTier)).toEqual([
      "seazn_pro_monthly tier 2 is missing a inr price point",
    ]);
  });

  // Ground truth read straight off the file text, independent of the walk: if
  // the two ever disagree the walk is skipping something it should be guarding.
  it("collects EVERY amount and EVERY lookup_key present in the file", () => {
    const raw = JSON.stringify(seed);
    const declaredAmounts = raw.match(/"unit_amount":/g) ?? [];
    const declaredKeys = [...raw.matchAll(/"lookup_key":"([a-z0-9_]+)"/g)].map((m) => m[1]!);
    expect(allPrices()).toHaveLength(declaredAmounts.length);
    expect(new Set(allPrices().flatMap((p) => p.lookupKey ?? []))).toEqual(new Set(declaredKeys));
    // ...and the labels say which rung, since a tier has no key to name it.
    expect(allPrices().map((p) => p.label)).toContain("seazn_pro_monthly tier 2");
  });

  it("catches a duplicated lookup_key in a NEWER section", () => {
    const dupe = holedClone();
    dupe.org_addons![1]!.price.lookup_key = dupe.org_addons![0]!.price.lookup_key;
    expect(duplicateLookupKeys(dupe)).toEqual(["seazn_extra_org_pro_monthly"]);
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
