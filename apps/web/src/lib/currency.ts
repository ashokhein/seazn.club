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

/** Event Pass one-time price in minor units for a currency. */
export function passPrice(currency: Currency): number {
  const pass = stripePlans.passes?.find((p) => p.key === "event_pass");
  if (!pass) throw new Error("stripe-plans.json is missing the event_pass");
  return amountFor(pass.price, currency);
}

/**
 * Format minor units in a currency for marketing surfaces: whole amounts drop
 * the decimals ("$20", "₹1,499"), fractional ones keep them ("$16.67").
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
