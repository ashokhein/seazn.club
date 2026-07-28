// LIVE verification that stripe-sync.ts propagates a copy-only edit
// (product name/description) to an ALREADY-EXISTING Stripe product — #298's
// "run stripe:sync and verify the rendered Checkout copy" step, made concrete
// and repeatable. Before the products.update branch in ensurePrice, a copy edit
// to stripe-plans.json whose price was unchanged silently never reached Stripe:
// the matched-price path returned before looking at the product at all.
//
// Self-contained: mints its OWN scratch product + price under a throwaway
// lookup_key and archives both afterwards. It never touches the real seed's
// products, and it never runs `npm run stripe:sync` (that would re-push the
// whole catalog into an account shared with other work).
//
// Skipped unless BILLING_LIVE=1 with a TEST-mode secret key. Run from apps/web:
//   BILLING_LIVE=1 STRIPE_SECRET_KEY=sk_test_... \
//     npx vitest run src/__tests__/stripe-sync.live.test.ts
import { afterAll, describe, expect, it } from "vitest";
import Stripe from "stripe";
import { ensurePrice, REQUIRED_CURRENCIES, type PriceSpec } from "../../../../scripts/stripe-sync.ts";

const KEY = process.env.STRIPE_SECRET_KEY ?? "";
// sk_test_ only: this suite WRITES (creates a product, a price, then archives
// both). A live-mode key must never reach it, and a restricted key (rk_) may
// silently lack products:write.
const LIVE = process.env.BILLING_LIVE === "1" && KEY.startsWith("sk_test_");

const cleanup: Array<() => Promise<unknown>> = [];
afterAll(async () => {
  for (const fn of cleanup) await fn().catch(() => undefined);
});

describe.skipIf(!LIVE)("stripe-sync product copy (live Stripe, test mode)", () => {
  /** A throwaway flat spec. Every currency the seed requires has to be priced or
   *  priceCreateParams refuses to sync (a hole would fall back to adaptive FX
   *  pricing) — the amounts are arbitrary, only their presence matters here. */
  function scratchSpec(lookupKey: string): PriceSpec {
    return {
      lookup_key: lookupKey,
      unit_amount: 500,
      currency_options: Object.fromEntries(REQUIRED_CURRENCIES.map((c) => [c, 500])),
    };
  }

  it(
    "a description-only seed edit reaches the live product on the next sync, and a repeat run writes nothing",
    async () => {
      const stripe = new Stripe(KEY);
      // Count the REAL products.update calls this run makes, without mocking the
      // API away — the no-op assertion at the end is only meaningful if it is
      // measured against a live client that would genuinely have written.
      const updates: string[] = [];
      const rawUpdate = stripe.products.update.bind(stripe.products);
      stripe.products.update = ((id: string, params: Stripe.ProductUpdateParams) => {
        updates.push(id);
        return rawUpdate(id, params);
      }) as typeof stripe.products.update;

      const spec = scratchSpec(`seazn_copy_probe_${Date.now()}`);

      // Sync 1: nothing exists yet, so this mints the product + price with the
      // OLD description (the products.create path — no update).
      const first = await ensurePrice(
        stripe,
        spec,
        { name: "Copy probe", description: "old description" },
        "copy_probe",
        "usd",
        null,
      );
      cleanup.push(() => stripe.prices.update(first.priceId, { active: false }));
      cleanup.push(() => rawUpdate(first.productId, { active: false }));

      const before = await stripe.products.retrieve(first.productId);
      expect(before.description).toBe("old description");
      expect(updates).toEqual([]);

      // Sync 2: identical price (no drift), NEW description only — exactly the
      // shape of a copy-only stripe-plans.json edit.
      const second = await ensurePrice(
        stripe,
        spec,
        { name: "Copy probe", description: "new description" },
        "copy_probe",
        "usd",
        null,
      );
      expect(second.priceId).toBe(first.priceId); // the price itself never changed
      const after = await stripe.products.retrieve(second.productId);
      expect(after.description).toBe("new description");
      expect(updates).toEqual([first.productId]);

      // Sync 3: same seed again. A sync that rewrote every product on every run
      // would pass both assertions above; only the call count catches it.
      const third = await ensurePrice(
        stripe,
        spec,
        { name: "Copy probe", description: "new description" },
        "copy_probe",
        "usd",
        null,
      );
      expect(third.priceId).toBe(first.priceId);
      expect(updates).toEqual([first.productId]); // still one write, not two
    },
    30_000,
  );
});
