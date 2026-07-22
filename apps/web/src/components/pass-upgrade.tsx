"use client";

import { useState } from "react";
import { EmbeddedCheckoutProvider, EmbeddedCheckout } from "@stripe/react-stripe-js";
import { track, EVENTS } from "@/lib/analytics";
import { fetchPassCheckoutClientSecret } from "@/lib/billing-checkout-client";
import { stripePromise } from "@/lib/stripe-browser";
import { Modal } from "@/components/modal";

/**
 * The Event Pass checkout sheet (spec D11) — the same chrome the Pro checkout
 * uses on the billing page (billing-actions.tsx): `<Modal size="lg">`, so the
 * two purchases differ only in what is being sold.
 *
 * Deliberately NOT titled "Complete your upgrade" like Pro's. Pro's title
 * describes a plan change; this is one $29 payment for one competition and
 * leaves the org on community. D12/D13 exist precisely because buyers conflate
 * the pass with a subscription, so the chrome must not add to that. Parity here
 * is of presentation, not of wording.
 *
 * Split out from PassUpgradeButton because it holds no state of its own: the
 * button owns the client_secret, this owns how it is shown.
 */
export function PassCheckoutSheet({
  clientSecret,
  onClose,
}: {
  clientSecret: string;
  onClose: () => void;
}) {
  return (
    <Modal title="Complete your purchase" size="lg" onClose={onClose}>
      {/* Stripe's iframe measures and resizes itself, so this container must not
          impose a height — Modal already caps the sheet at 85vh and scrolls. The
          provider is mounted only once we hold a secret; remounting it would
          restart the checkout session. */}
      <EmbeddedCheckoutProvider stripe={stripePromise} options={{ clientSecret }}>
        <EmbeddedCheckout />
      </EmbeddedCheckoutProvider>
    </Modal>
  );
}

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
    return <PassCheckoutSheet clientSecret={clientSecret} onClose={() => setClientSecret(null)} />;
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
