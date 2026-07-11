"use client";

import { useState } from "react";
import { EmbeddedCheckoutProvider, EmbeddedCheckout } from "@stripe/react-stripe-js";
import { track, EVENTS } from "@/lib/analytics";
import { fetchCheckoutClientSecret } from "@/lib/billing-checkout-client";
import { stripePromise } from "@/lib/stripe-browser";
import { useConfirm } from "@/components/ui/confirm-provider";
import { msg } from "@/lib/messages";

/** In-page upgrade via Stripe Embedded Checkout — reveals the checkout inline
 *  (no redirect out) and only returns to the billing page on completion. We
 *  resolve the client_secret UP FRONT and only mount <EmbeddedCheckout> once we
 *  have it; if the checkout call fails, we show the error instead of leaving the
 *  embedded spinner loading forever. */
export function UpgradeButton({
  interval,
  label,
  ghost = false,
}: {
  interval: "monthly" | "annual";
  label: string;
  /** Secondary styling when the button is the non-default interval. */
  ghost?: boolean;
}) {
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start() {
    setError(null);
    setLoading(true);
    track(EVENTS.CHECKOUT_STARTED, { plan_key: "pro", interval });
    const result = await fetchCheckoutClientSecret(interval);
    setLoading(false);
    if (result.ok) {
      setClientSecret(result.clientSecret);
    } else {
      setError(result.error);
    }
  }

  if (clientSecret) {
    return (
      <div className="mt-2">
        {/* Full-bleed at phone widths (v3/02 §3.2 — the reported 375px break):
            escape the card p-5 + main px-4 so the Stripe iframe gets the full
            viewport; no fixed min-width parent. */}
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
      setError(data.error ?? "Something went wrong");
      setLoading(false);
    }
  }

  return (
    <div>
      <button onClick={go} disabled={loading} className="btn btn-ghost disabled:opacity-60">
        {loading ? "Downgrading…" : "Downgrade to Community"}
      </button>
      {error && <p className="mt-1 text-xs text-red-500">{error}</p>}
    </div>
  );
}

// ManageBillingButton (Stripe Customer Portal redirect) died in v3/11 — card,
// plan and invoice management live in-app now (components/billing-manage.tsx).
