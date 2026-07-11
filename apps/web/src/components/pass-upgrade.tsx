"use client";

import { useState } from "react";
import { loadStripe } from "@stripe/stripe-js";
import { EmbeddedCheckoutProvider, EmbeddedCheckout } from "@stripe/react-stripe-js";
import { track, EVENTS } from "@/lib/analytics";
import { fetchPassCheckoutClientSecret } from "@/lib/billing-checkout-client";

const stripePromise = loadStripe(process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY ?? "");

/** In-page Event Pass purchase via Stripe Embedded Checkout — same up-front
 *  client_secret contract as the Pro UpgradeButton (billing-actions.tsx). */
export function PassUpgradeButton({
  competitionId,
  label,
}: {
  competitionId: string;
  label: string;
}) {
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start() {
    setError(null);
    setLoading(true);
    track(EVENTS.CHECKOUT_STARTED, { plan_key: "event_pass" });
    const result = await fetchPassCheckoutClientSecret(competitionId);
    setLoading(false);
    if (result.ok) setClientSecret(result.clientSecret);
    else setError(result.error);
  }

  if (clientSecret) {
    return (
      <div className="mt-2">
        {/* Full-bleed at phone widths (v3/02 §3.2) — same escape as the Pro
            embedded checkout so the Stripe iframe gets the full viewport. */}
        <div className="-mx-9 w-auto sm:mx-0">
          <EmbeddedCheckoutProvider stripe={stripePromise} options={{ clientSecret }}>
            <EmbeddedCheckout />
          </EmbeddedCheckoutProvider>
        </div>
        <button
          type="button"
          onClick={() => setClientSecret(null)}
          className="mt-3 text-xs text-slate-500 hover:underline"
        >
          Cancel
        </button>
      </div>
    );
  }

  return (
    <div>
      <button
        type="button"
        onClick={start}
        disabled={loading}
        className="btn btn-primary px-5 py-2.5"
        data-pass-buy
      >
        {loading ? "Preparing checkout…" : label}
      </button>
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
    </div>
  );
}
