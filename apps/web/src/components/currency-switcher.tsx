"use client";

import { useRouter } from "next/navigation";
import { CURRENCY_COOKIE, SUPPORTED_CURRENCIES, type Currency } from "@/lib/currency";

const LABELS: Record<Currency, string> = {
  usd: "$ USD",
  eur: "€ EUR",
  gbp: "£ GBP",
  inr: "₹ INR",
  aud: "A$ AUD",
};

/** Pricing-page currency switcher (v3/07 §4): writes the cookie the checkout
 *  routes honour, then re-renders the server page in the chosen currency. */
export function CurrencySwitcher({ current }: { current: Currency }) {
  const router = useRouter();
  return (
    <label className="inline-flex items-center gap-2 text-sm text-slate-500">
      <span className="sr-only sm:not-sr-only">Currency</span>
      <select
        value={current}
        data-currency-switcher
        onChange={(e) => {
          document.cookie = `${CURRENCY_COOKIE}=${e.target.value}; path=/; max-age=31536000; samesite=lax`;
          router.refresh();
        }}
        className="input w-auto py-1.5 text-sm"
      >
        {SUPPORTED_CURRENCIES.map((c) => (
          <option key={c} value={c}>
            {LABELS[c]}
          </option>
        ))}
      </select>
    </label>
  );
}
