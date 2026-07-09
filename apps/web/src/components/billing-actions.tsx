"use client";

import { useCallback, useState } from "react";
import { loadStripe } from "@stripe/stripe-js";
import { EmbeddedCheckoutProvider, EmbeddedCheckout } from "@stripe/react-stripe-js";
import { track, EVENTS } from "@/lib/analytics";

// Load Stripe.js once for the whole app (publishable key is public).
const stripePromise = loadStripe(process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY ?? "");

/** In-page upgrade via Stripe Embedded Checkout — reveals the checkout inline
 *  (no redirect out) and only returns to the billing page on completion. */
export function UpgradeButton({
  interval,
  label,
}: {
  interval: "monthly" | "annual";
  label: string;
}) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchClientSecret = useCallback(async () => {
    const res = await fetch("/api/billing/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ plan_key: "pro", interval }),
    });
    const data = await res.json();
    if (!data.ok || !data.data?.client_secret) {
      throw new Error(data.error ?? "Checkout is unavailable right now.");
    }
    return data.data.client_secret as string;
  }, [interval]);

  if (open) {
    return (
      <div className="mt-2">
        <EmbeddedCheckoutProvider stripe={stripePromise} options={{ fetchClientSecret }}>
          <EmbeddedCheckout />
        </EmbeddedCheckoutProvider>
        <button
          type="button"
          onClick={() => setOpen(false)}
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
        onClick={() => {
          setError(null);
          setOpen(true);
          track(EVENTS.CHECKOUT_STARTED, { plan_key: "pro", interval });
        }}
        className="btn btn-primary"
      >
        {label}
      </button>
      {error && <p className="mt-1 text-xs text-red-500">{error}</p>}
    </div>
  );
}

export function DowngradeButton() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function go() {
    if (!confirm("Downgrade to Community? Pro features become unavailable immediately.")) return;
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

export function ManageBillingButton({
  label = "Manage billing →",
  primary = false,
}: {
  label?: string;
  primary?: boolean;
} = {}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function go() {
    setLoading(true);
    setError(null);
    const res = await fetch("/api/billing/portal", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    const data = await res.json();
    if (data.ok && data.data?.url) {
      window.location.href = data.data.url;
    } else {
      setError(data.error ?? "Something went wrong");
      setLoading(false);
    }
  }

  return (
    <div>
      <button
        onClick={go}
        disabled={loading}
        className={`btn ${primary ? "btn-primary" : "btn-ghost"} disabled:opacity-60`}
      >
        {loading ? "Opening portal…" : label}
      </button>
      {error && <p className="mt-1 text-xs text-red-500">{error}</p>}
    </div>
  );
}
