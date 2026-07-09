// Guards the Stripe plan seed that `npm run stripe:sync` applies. A malformed
// seed silently breaks checkout (the route reads plans.stripe_price_id_*), so
// pin its shape. No DB, no Stripe — pure structural validation.
import { describe, expect, it } from "vitest";
import seed from "../stripe-plans.json";

interface PriceSpec { lookup_key: string; unit_amount: number; interval: string }
interface PlanSpec {
  key: string;
  product: { name: string; description?: string };
  prices: { monthly: PriceSpec; annual: PriceSpec };
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
    const lookups = (seed.plans as PlanSpec[]).flatMap((p) => [
      p.prices.monthly.lookup_key,
      p.prices.annual.lookup_key,
    ]);
    expect(new Set(lookups).size).toBe(lookups.length);
  });
});
