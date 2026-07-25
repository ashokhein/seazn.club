"use client";

import { useState } from "react";
import { EmbeddedCheckoutProvider, EmbeddedCheckout } from "@stripe/react-stripe-js";
import { Modal } from "@/components/modal";
import { stripePromise } from "@/lib/stripe-browser";
import { fetchCreditPackCheckoutClientSecret } from "@/lib/billing-checkout-client";
import { formatMinor, type Currency, type CreditPackOption } from "@/lib/currency";
// Client-safe i18n: `@/lib/i18n` pulls in `server-only`, which breaks the build
// when this "use client" modal is embedded in the board (A6). Import the pure
// runtime + types the same way the client dict-provider does.
import { t, plural } from "@/lib/i18n-runtime";
import type { Dict, Locale } from "@/lib/i18n-constants";

/**
 * The Buy Credits modal (SPEC-6 §A4): a radio ladder of never-expire credit
 * packs, opened from the Credits tab. The ladder is the `creditPackOptions`
 * catalog (single source — `stripe-plans.json`'s `packs`, priced in the group's
 * LOCKED currency, SPEC-2 §6); `[Pay {price}]` starts the SAME embedded Checkout
 * the Pro/Pass sheets use (billing-actions / pass-upgrade), so nothing here
 * invents a new Stripe flow — on success Stripe redirects the page to the
 * checkout route's `return_url` and the billing page reconciles from there.
 */
export function BuyCredits({
  packs,
  currency,
  dict,
  locale,
  triggerLabel,
}: {
  packs: CreditPackOption[];
  currency: Currency;
  dict: Dict;
  locale: Locale;
  /** Overrides the default "Buy credits" trigger copy (e.g. the operator
   *  console's "Top up"). Reuses the same modal + checkout underneath. */
  triggerLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (packs.length === 0) return null;

  function close() {
    setOpen(false);
    setSelected(null);
    setClientSecret(null);
    setError(null);
    setLoading(false);
  }

  const chosen = packs.find((p) => p.key === selected) ?? null;

  async function pay() {
    if (!chosen) return;
    setError(null);
    setLoading(true);
    const result = await fetchCreditPackCheckoutClientSecret(chosen.key);
    setLoading(false);
    if (result.ok) setClientSecret(result.clientSecret);
    else setError(result.error);
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="btn btn-primary text-xs"
        data-buy-credits
      >
        {triggerLabel ?? t(dict, "billing.credits.buy")}
      </button>

      {open && clientSecret && (
        // Embedded Stripe Checkout — same chrome as the Pass sheet. Stripe's
        // iframe self-sizes, so no fixed height here; Modal caps it at 85vh.
        <Modal title={t(dict, "billing.credits.buyModal.checkoutTitle")} size="lg" onClose={close}>
          <EmbeddedCheckoutProvider stripe={stripePromise} options={{ clientSecret }}>
            <EmbeddedCheckout />
          </EmbeddedCheckoutProvider>
        </Modal>
      )}

      {open && !clientSecret && (
        <Modal
          title={t(dict, "billing.credits.buyModal.title")}
          onClose={close}
          footer={
            <>
              <button type="button" onClick={close} className="btn btn-ghost">
                {t(dict, "confirm.cancel")}
              </button>
              <button
                type="button"
                onClick={pay}
                disabled={!chosen || loading}
                className="btn btn-primary disabled:opacity-40"
              >
                {loading
                  ? t(dict, "billing.credits.buyModal.preparing")
                  : chosen
                    ? t(dict, "billing.credits.buyModal.pay", {
                        price: formatMinor(chosen.amountMinor, currency, locale),
                      })
                    : t(dict, "billing.credits.buyModal.choose")}
              </button>
            </>
          }
        >
          <fieldset className="space-y-2">
            <legend className="sr-only">{t(dict, "billing.credits.buyModal.title")}</legend>
            {packs.map((pack) => {
              const active = pack.key === selected;
              return (
                <label
                  key={pack.key}
                  className={`flex cursor-pointer items-center gap-3 rounded-xl border p-3 transition focus-within:ring-2 focus-within:ring-purple-500 ${
                    active
                      ? "border-purple-500 bg-purple-50"
                      : "border-slate-200 hover:border-purple-300"
                  }`}
                >
                  <input
                    type="radio"
                    name="credit-pack"
                    value={pack.key}
                    checked={active}
                    onChange={() => setSelected(pack.key)}
                    className="h-4 w-4 accent-purple-600"
                  />
                  <span className="flex flex-1 flex-wrap items-baseline justify-between gap-x-2">
                    <span className="font-semibold text-slate-800">
                      {formatMinor(pack.amountMinor, currency, locale)}
                    </span>
                    <span className="text-sm text-slate-600">
                      {plural(dict, "billing.credits.creditsCount", pack.credits, locale)}
                    </span>
                  </span>
                  <span className="flex shrink-0 gap-1">
                    {pack.bonusPct > 0 && (
                      <span className="badge bg-emerald-100 text-emerald-700">
                        {t(dict, "billing.credits.buyModal.bonus", { pct: pack.bonusPct })}
                      </span>
                    )}
                    {pack.bestValue && (
                      <span className="badge bg-purple-600 text-white">
                        {t(dict, "billing.credits.buyModal.bestValue")}
                      </span>
                    )}
                  </span>
                </label>
              );
            })}
          </fieldset>
          <p className="mt-3 text-xs text-slate-500">
            {t(dict, "billing.credits.buyModal.reassurance")}
          </p>
          {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
        </Modal>
      )}
    </>
  );
}
