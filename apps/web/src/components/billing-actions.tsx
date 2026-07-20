"use client";

import { useState } from "react";
import { EmbeddedCheckoutProvider, EmbeddedCheckout } from "@stripe/react-stripe-js";
import { track, EVENTS } from "@/lib/analytics";
import { fetchCheckoutClientSecret } from "@/lib/billing-checkout-client";
import { stripePromise } from "@/lib/stripe-browser";
import { useConfirm } from "@/components/ui/confirm-provider";
import { useMsg } from "@/components/i18n/dict-provider";
import { Modal } from "@/components/modal";

/** In-page upgrade via Stripe Embedded Checkout — reveals the checkout inline
 *  (no redirect out) and only returns to the billing page on completion. We
 *  resolve the client_secret UP FRONT and only mount <EmbeddedCheckout> once we
 *  have it; if the checkout call fails, we show the error instead of leaving the
 *  embedded spinner loading forever. */
export function UpgradeButton({
  interval,
  label,
  ghost = false,
  plan = "pro",
}: {
  interval: "monthly" | "annual";
  label: string;
  /** Secondary styling when the button is the non-default interval. */
  ghost?: boolean;
  /** Which paid plan to check out into — defaults to Pro. */
  plan?: "pro" | "pro_plus";
}) {
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start() {
    setError(null);
    setLoading(true);
    track(EVENTS.CHECKOUT_STARTED, { plan_key: plan, interval });
    const result = await fetchCheckoutClientSecret(plan, interval);
    setLoading(false);
    if (result.ok) {
      setClientSecret(result.clientSecret);
    } else {
      setError(result.error);
    }
  }

  if (clientSecret) {
    return (
      <Modal title="Complete your upgrade" size="lg" onClose={() => setClientSecret(null)}>
        {/* Stripe's iframe measures and resizes itself, so this container must
            not impose a height — Modal already caps the sheet at 85vh and
            scrolls. The provider is mounted only once we hold a secret;
            remounting it would restart the checkout session. */}
        <EmbeddedCheckoutProvider stripe={stripePromise} options={{ clientSecret }}>
          <EmbeddedCheckout />
        </EmbeddedCheckoutProvider>
      </Modal>
    );
  }

  return (
    <div>
      <button
        onClick={start}
        disabled={loading}
        className={`btn ${ghost ? "btn-ghost" : "btn-primary"} disabled:opacity-60`}
      >
        {loading ? "Loading checkout…" : label}
      </button>
      {error && <p className="mt-1 text-xs text-red-500">{error}</p>}
    </div>
  );
}

export function DowngradeButton() {
  const msg = useMsg();
  const confirm = useConfirm();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function go() {
    const ok = await confirm({
      title: msg("confirm.downgrade.title"),
      body: msg("confirm.downgrade.body"),
      confirmLabel: msg("confirm.downgrade.label"),
      tone: "danger",
    });
    if (!ok) return;
    setLoading(true);
    setError(null);
    const res = await fetch("/api/billing/downgrade", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    const data = await res.json();
    if (data.ok) {
      window.location.reload();
    } else {
      setError(data.error ?? msg("billing.downgrade.genericError"));
      setLoading(false);
    }
  }

  return (
    <div>
      <button onClick={go} disabled={loading} className="btn btn-ghost disabled:opacity-60">
        {loading ? msg("billing.downgrade.loading") : msg("billing.downgrade.button")}
      </button>
      {error && <p className="mt-1 text-xs text-red-500">{error}</p>}
    </div>
  );
}

// ManageBillingButton (Stripe Customer Portal redirect) died in v3/11 — card,
// plan and invoice management live in-app now (components/billing-manage.tsx).
