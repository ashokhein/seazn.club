import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type Stripe from "stripe";
import {
  isTiered,
  priceCreateParams,
  priceHasDrifted,
  tieredCurrencyOptionsParam,
  ensurePrice,
  type PriceSpec,
  type Seed,
} from "../../../../scripts/stripe-sync.ts";

// The seed the sync script reads. Asserting against the REAL file (not a
// fixture) is the point: a hand-edit that breaks the tier shape must fail here
// rather than at `npm run stripe:sync` against a live Stripe account.
const seed = JSON.parse(readFileSync(join(__dirname, "../config/stripe-plans.json"), "utf8")) as Seed;
const proMonthly = seed.plans.find((p) => p.key === "pro")!.prices.monthly;
const proTiers = proMonthly.tiers!;
const eventPass = seed.passes!.find((p) => p.key === "event_pass")!.price;

// ---------------------------------------------------------------------------
// Live-price fixtures. Stripe's response types have ~20 required fields each and
// priceHasDrifted reads five of them, so the builders take a Partial<> and widen
// once, in one place — the cast is the fixture's, not the assertions'.
// ---------------------------------------------------------------------------

/** Minimal live-price stub — only the fields priceHasDrifted reads. */
function livePrice(over: Partial<Stripe.Price>): Stripe.Price {
  return {
    id: "price_old",
    object: "price",
    product: "prod_1",
    currency: "usd",
    billing_scheme: "per_unit",
    tiers_mode: null,
    unit_amount: null,
    currency_options: {},
    ...over,
  } as unknown as Stripe.Price;
}

/** A tier as Stripe returns it: the fallback bound comes back as `up_to: null`,
 *  not the "inf" token the seed writes. */
function liveTier(up_to: number | null, unit_amount: number): Stripe.Price.Tier {
  return {
    up_to,
    unit_amount,
    unit_amount_decimal: null, // Stripe brands Decimal; nothing under test reads it
    flat_amount: null,
    flat_amount_decimal: null,
  };
}

function liveCurrencyOption(
  over: Partial<Stripe.Price.CurrencyOptions>,
): Stripe.Price.CurrencyOptions {
  return {
    custom_unit_amount: null,
    tax_behavior: null,
    unit_amount: null,
    ...over,
  } as unknown as Stripe.Price.CurrencyOptions;
}

/** A live price that exactly matches the seed's pro-monthly tiered spec. */
function liveTieredPro(): Stripe.Price {
  return livePrice({
    billing_scheme: "tiered",
    tiers_mode: "graduated",
    unit_amount: null,
    tiers: [liveTier(1, proTiers[0]!.unit_amount), liveTier(null, proTiers[1]!.unit_amount)],
    currency_options: Object.fromEntries(
      Object.keys(proMonthly.currency_options ?? {}).map((c) => [
        c,
        liveCurrencyOption({
          tiers: [
            liveTier(1, proTiers[0]!.currency_options![c]!),
            liveTier(null, proTiers[1]!.currency_options![c]!),
          ],
        }),
      ]),
    ),
  });
}

afterEach(() => vi.restoreAllMocks());

describe("seed shape", () => {
  it("prices the plans as graduated tiers and the pass as flat", () => {
    for (const plan of seed.plans) {
      expect(isTiered(plan.prices.monthly)).toBe(true);
      expect(isTiered(plan.prices.annual)).toBe(true);
    }
    expect(isTiered(eventPass)).toBe(false);
  });

  it("keeps unit_amount equal to tier 1 (the pricing page advertises tier 1)", () => {
    for (const plan of seed.plans) {
      for (const spec of [plan.prices.monthly, plan.prices.annual]) {
        expect(spec.tiers![0]!.unit_amount).toBe(spec.unit_amount);
        expect(spec.tiers![0]!.currency_options).toEqual(spec.currency_options);
      }
    }
  });

  // The half-price rule is the product promise ("each extra organisation is half
  // the base rate") and it only exists as prose in the JSON's $comment_tiers.
  // Encoded here because a fat-fingered 9000 for 900 is a 10× overcharge that no
  // other test in the repo would catch.
  it("prices every extra organisation at half the base, rounded down", () => {
    /** Half, rounded DOWN to a whole major unit. */
    const halfDown = (tier1: number) => Math.floor(tier1 / 200) * 100;
    /** INR keeps its x99 charm points: half, down to the nearest whole ₹…99. */
    const halfDownInr = (tier1: number) =>
      (Math.floor((Math.floor(tier1 / 2 / 100) - 99) / 100) * 100 + 99) * 100;

    for (const plan of seed.plans) {
      for (const [interval, spec] of Object.entries(plan.prices)) {
        const label = `${plan.key}/${interval}`;
        const tiers = spec.tiers!;
        expect(tiers, label).toHaveLength(2);
        const [t1, t2] = [tiers[0]!, tiers[1]!];
        expect(t2.up_to, label).toBe("inf");
        expect({ label, amount: t2.unit_amount }).toEqual({
          label,
          amount: halfDown(t1.unit_amount),
        });
        for (const [currency, tier1] of Object.entries(t1.currency_options ?? {})) {
          const want = currency === "inr" ? halfDownInr(tier1) : halfDown(tier1);
          expect({ label, currency, amount: t2.currency_options?.[currency] }).toEqual({
            label,
            currency,
            amount: want,
          });
        }
      }
    }
  });

  it("fails closed on a half-declared tiered spec instead of minting a flat price", () => {
    // A per_unit price bills quantity × base: a 2-org Pro group would pay $38.
    const noScheme: PriceSpec = { ...proMonthly, billing_scheme: undefined };
    const noTiers: PriceSpec = { ...proMonthly, tiers: undefined };
    expect(() => isTiered(noScheme)).toThrow(/half-declared/);
    expect(() => priceCreateParams(noScheme, "prod_1", "usd", "pro")).toThrow(/half-declared/);
    expect(() => isTiered(noTiers)).toThrow(/half-declared/);
  });
});

describe("priceCreateParams — flat", () => {
  it("sends unit_amount + flat currency_options, and no tier fields", () => {
    const params = priceCreateParams(eventPass, "prod_1", "usd", "event_pass");
    expect(params.unit_amount).toBe(2900);
    expect(params.currency_options?.gbp).toEqual({ unit_amount: 2500 });
    expect(params.billing_scheme).toBeUndefined();
    expect(params.tiers).toBeUndefined();
    expect(params.recurring).toBeUndefined(); // one-time pass must not regress
    expect(params.lookup_key).toBe("seazn_event_pass");
    expect(params.transfer_lookup_key).toBe(true);
  });
});

describe("priceCreateParams — tiered", () => {
  const params = priceCreateParams(proMonthly, "prod_1", "usd", "pro");

  it("sends the graduated ladder and no top-level unit_amount", () => {
    expect(params.billing_scheme).toBe("tiered");
    expect(params.tiers_mode).toBe("graduated");
    expect(params.tiers).toEqual([
      { up_to: 1, unit_amount: 1900 },
      { up_to: "inf", unit_amount: 900 },
    ]);
    // Stripe rejects unit_amount when billing_scheme=tiered.
    expect(params.unit_amount).toBeUndefined();
    expect(params.recurring).toEqual({ interval: "month" });
  });

  it("transposes per-tier currency amounts into per-currency ladders", () => {
    expect(params.currency_options?.gbp).toEqual({
      tiers: [
        { up_to: 1, unit_amount: 1500 },
        { up_to: "inf", unit_amount: 700 },
      ],
    });
    // No currency option may carry a flat unit_amount on a tiered price.
    for (const opt of Object.values(params.currency_options ?? {})) {
      expect(opt.unit_amount).toBeUndefined();
      expect(opt.tiers).toHaveLength(2);
    }
  });

  it("throws when a tier skips a currency instead of billing a partial ladder", () => {
    const holed: PriceSpec = {
      ...proMonthly,
      tiers: [proTiers[0]!, { ...proTiers[1]!, currency_options: { eur: 900 } }],
    };
    expect(() => tieredCurrencyOptionsParam(holed)).toThrow(/missing a gbp amount/);
  });
});

describe("priceHasDrifted — tiered", () => {
  it("is false when the live ladder matches", () => {
    expect(priceHasDrifted(liveTieredPro(), proMonthly)).toBe(false);
  });

  it("detects a tier unit_amount change", () => {
    const p = liveTieredPro();
    p.tiers![1]!.unit_amount = 950;
    expect(priceHasDrifted(p, proMonthly)).toBe(true);
  });

  it("detects a tier count change", () => {
    const p = liveTieredPro();
    p.tiers!.push(liveTier(null, 500));
    expect(priceHasDrifted(p, proMonthly)).toBe(true);
  });

  it("detects an up_to boundary change", () => {
    const p = liveTieredPro();
    p.tiers![0]!.up_to = 5;
    expect(priceHasDrifted(p, proMonthly)).toBe(true);
  });

  it("detects a per-currency tier change", () => {
    const p = liveTieredPro();
    p.currency_options!.inr!.tiers![1]!.unit_amount = 1;
    expect(priceHasDrifted(p, proMonthly)).toBe(true);
  });

  it("detects a missing currency price point", () => {
    const p = liveTieredPro();
    delete p.currency_options!.aud;
    expect(priceHasDrifted(p, proMonthly)).toBe(true);
  });

  it("detects a tiers_mode change", () => {
    expect(
      priceHasDrifted(livePrice({ ...liveTieredPro(), tiers_mode: "volume" }), proMonthly),
    ).toBe(true);
  });

  it("treats an unexpanded ladder as unchanged (never remint every run)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const p = liveTieredPro();
    delete p.tiers; // what the API returns when `expand` omits them
    expect(priceHasDrifted(p, proMonthly)).toBe(false);
    expect(warn).toHaveBeenCalled();
  });
});

describe("priceHasDrifted — flat", () => {
  it("is false when amounts match and true on a currency amount change", () => {
    const match = livePrice({
      unit_amount: 2900,
      currency_options: Object.fromEntries(
        Object.entries(eventPass.currency_options ?? {}).map(([c, a]) => [
          c,
          liveCurrencyOption({ unit_amount: a }),
        ]),
      ),
    });
    expect(priceHasDrifted(match, eventPass)).toBe(false);
    match.currency_options!.gbp!.unit_amount = 2600;
    expect(priceHasDrifted(match, eventPass)).toBe(true);
  });

  it("sees a live tiered price as drift against a flat spec", () => {
    expect(priceHasDrifted(liveTieredPro(), eventPass)).toBe(true);
  });
});

describe("ensurePrice — flat → tiered", () => {
  function fakeStripe(existing: Stripe.Price) {
    // Typed by signature (not by naming unused params) so `mock.calls[0][0]` is
    // checked against the real Stripe param types in the assertions below.
    const create = vi.fn<(p: Stripe.PriceCreateParams) => Promise<Stripe.Price>>(
      async () => ({ id: "price_new" }) as Stripe.Price,
    );
    const update = vi.fn<(id: string, p: Stripe.PriceUpdateParams) => Promise<Stripe.Price>>(
      async () => existing,
    );
    const list = vi.fn<(p: Stripe.PriceListParams) => Promise<Stripe.ApiList<Stripe.Price>>>(
      async () => ({ data: [existing] }) as Stripe.ApiList<Stripe.Price>,
    );
    return {
      // Only the four calls ensurePrice makes; widening once here beats
      // stubbing the whole SDK surface.
      stripe: {
        prices: { list, create, update },
        products: { create: vi.fn() },
      } as unknown as Stripe,
      create,
      update,
      list,
    };
  }

  it("mints a replacement and archives the old flat price (never updates it)", async () => {
    const flat = livePrice({ unit_amount: 1900, billing_scheme: "per_unit" });
    const { stripe, create, update, list } = fakeStripe(flat);
    const out = await ensurePrice(stripe, proMonthly, { name: "Pro" }, "pro", "usd", null);

    expect(out.priceId).toBe("price_new");
    // Immutability: the new price is created tiered, the old one only archived.
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]![0]).toMatchObject({
      billing_scheme: "tiered",
      transfer_lookup_key: true,
    });
    expect(update).toHaveBeenCalledWith("price_old", { active: false });
    expect(update.mock.calls[0]![1]).not.toHaveProperty("unit_amount");
    // Drift is invisible unless tiers + currency_options are expanded.
    expect(list.mock.calls[0]![0].expand).toContain("data.tiers");
    expect(list.mock.calls[0]![0].expand).toContain("data.currency_options");
  });

  it("replaces a price minted in the wrong base currency", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const wrong = liveTieredPro();
    wrong.currency = "gbp";
    const { stripe, create, update } = fakeStripe(wrong);
    const out = await ensurePrice(stripe, proMonthly, { name: "Pro" }, "pro", "usd", null);
    expect(out.priceId).toBe("price_new");
    expect(create).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith("price_old", { active: false });
    expect(warn).toHaveBeenCalled();
  });

  it("is a no-op when the live tiered price already matches", async () => {
    const { stripe, create, update } = fakeStripe(liveTieredPro());
    const out = await ensurePrice(stripe, proMonthly, { name: "Pro" }, "pro", "usd", null);
    expect(out.priceId).toBe("price_old");
    expect(create).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });
});
