// Multi-currency price points (v3/07 §4). Pure + isomorphic: the pricing page
// (server), the currency switcher (client) and the checkout routes all read
// the same stripe-plans.json price points — SET amounts, never FX conversions.
import stripePlans from "@/config/stripe-plans.json";

export const SUPPORTED_CURRENCIES = ["usd", "eur", "gbp", "inr", "aud"] as const;
export type Currency = (typeof SUPPORTED_CURRENCIES)[number];

/** Cookie the pricing-page switcher writes; checkout honours it (v3/07 §4). */
export const CURRENCY_COOKIE = "seazn_currency";

export function isSupportedCurrency(value: unknown): value is Currency {
  return typeof value === "string" && (SUPPORTED_CURRENCIES as readonly string[]).includes(value);
}

/** Narrow Stripe's plain-string currency (any case) for display helpers; usd
 *  fallback keeps formatting total even if an unexpected currency appears. */
export function asCurrency(value: unknown): Currency {
  const lower = typeof value === "string" ? value.toLowerCase() : value;
  return isSupportedCurrency(lower) ? lower : "usd";
}

interface PriceSpec {
  unit_amount: number;
  currency_options?: Record<string, number>;
}

function amountFor(spec: PriceSpec, currency: Currency): number {
  if (currency === "usd") return spec.unit_amount;
  return spec.currency_options?.[currency] ?? spec.unit_amount;
}

/** Pro price in minor units for a currency, straight from stripe-plans.json. */
export function proPrice(interval: "monthly" | "annual", currency: Currency): number {
  const pro = stripePlans.plans.find((p) => p.key === "pro");
  if (!pro) throw new Error("stripe-plans.json is missing the pro plan");
  return amountFor(pro.prices[interval], currency);
}

/** Pro Plus price in minor units for a currency, from stripe-plans.json. */
export function proPlusPrice(interval: "monthly" | "annual", currency: Currency): number {
  const plus = stripePlans.plans.find((p) => p.key === "pro_plus");
  if (!plus) throw new Error("stripe-plans.json is missing the pro_plus plan");
  return amountFor(plus.prices[interval], currency);
}

/**
 * What ONE more organisation in the billing group costs, in minor units.
 *
 * Read from the price seed's tier 2 (`up_to: "inf"`), not computed — the tier
 * amounts are SET per-currency price points like every other amount in that
 * file, never an FX conversion or an arithmetic half. Stripe bills from those
 * tiers, so this is the only number that can honestly be advertised.
 *
 * It IS half of tier 1 today, and a lot of copy says so in prose across four
 * locales. `extra-org-price-parity.test.ts` fails if that stops being true, and
 * names the strings to rewrite — so the price can be changed, it just cannot be
 * changed quietly.
 */
export function extraOrgPrice(
  plan: "pro" | "pro_plus",
  interval: "monthly" | "annual",
  currency: Currency,
): number {
  const spec = stripePlans.plans.find((p) => p.key === plan);
  if (!spec) throw new Error(`stripe-plans.json is missing the ${plan} plan`);
  const price = spec.prices[interval];
  const tier = price.tiers?.find((t) => t.up_to === "inf");
  if (!tier) throw new Error(`${plan} ${interval} has no extra-organisation tier`);
  return amountFor(tier, currency);
}

/** Event Pass one-time price in minor units for a currency. */
export function passPrice(currency: Currency): number {
  const pass = stripePlans.passes?.find((p) => p.key === "event_pass");
  if (!pass) throw new Error("stripe-plans.json is missing the event_pass");
  return amountFor(pass.price, currency);
}

/**
 * Format minor units in a currency for marketing surfaces: whole amounts drop
 * the decimals ("$19", "₹1,399"), fractional ones keep them ("$13.25").
 */
export function formatMinor(
  amountMinor: number,
  currency: Currency,
  locale = "en",
): string {
  const amount = amountMinor / 100;
  const whole = Number.isInteger(amount);
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: currency.toUpperCase(),
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: whole ? 0 : 2,
  }).format(amount);
}

/**
 * Best-effort currency guess from an Accept-Language header — the fallback
 * when neither a subscription currency nor the switcher cookie exists.
 */
export function currencyFromAcceptLanguage(header: string | null): Currency {
  if (!header) return "usd";
  const lang = header.split(",")[0]?.trim().toLowerCase() ?? "";
  const region = lang.split("-")[1] ?? "";
  if (region === "gb" || region === "uk") return "gbp";
  if (region === "in" || lang.startsWith("hi")) return "inr";
  if (region === "au") return "aud";
  const EURO_REGIONS = new Set([
    "de", "fr", "es", "it", "nl", "pt", "ie", "at", "be", "fi", "gr", "sk", "si", "lv", "lt", "ee", "lu", "mt", "cy", "hr",
  ]);
  const EURO_LANGS = new Set(["de", "fr", "es", "it", "nl", "pt", "fi", "el"]);
  if (EURO_REGIONS.has(region) || (!region && EURO_LANGS.has(lang))) return "eur";
  return "usd";
}
