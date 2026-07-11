"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Elements, PaymentElement, useElements, useStripe } from "@stripe/react-stripe-js";
import { stripeAppearance, stripePromise } from "@/lib/stripe-browser";
import { useConfirm } from "@/components/ui/confirm-provider";
import { asCurrency, formatMinor } from "@/lib/currency";
import type { IntervalPreview, PaymentMethodRow } from "@/lib/billing-manage";

/**
 * In-app billing management (v3/11) — the client half of the portal
 * replacement. Card entry stays inside Stripe's PaymentElement iframe (SAQ A);
 * everything else is our UI hitting the /api/billing/* manage routes, then
 * router.refresh() so the server components re-read Stripe.
 */

async function post(path: string, body?: unknown) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  return res.json();
}

function fmtDate(iso: string | null) {
  if (!iso) return null;
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

const BRAND_LABEL: Record<string, string> = {
  visa: "Visa",
  mastercard: "Mastercard",
  amex: "American Express",
  discover: "Discover",
};

// ---------------------------------------------------------------------------
// Payment methods
// ---------------------------------------------------------------------------

export function PaymentMethodsManager({
  methods,
  autoOpen = false,
}: {
  methods: PaymentMethodRow[];
  autoOpen?: boolean;
}) {
  const router = useRouter();
  const [adding, setAdding] = useState(autoOpen && methods.length === 0);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function act(path: string, body: unknown, id: string) {
    setBusy(id);
    setError(null);
    const data = await post(path, body);
    if (!data.ok) setError(data.error ?? "Something went wrong");
    setBusy(null);
    router.refresh();
  }

  return (
    <div>
      {methods.length === 0 && !adding && (
        <p className="text-sm text-slate-500">
          No card on file yet — invoices can’t be paid automatically.
        </p>
      )}

      <ul className="space-y-2">
        {methods.map((pm) => (
          <li
            key={pm.id}
            className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-200 px-4 py-3"
          >
            <div className="text-sm">
              <span className="font-medium text-slate-800 capitalize">
                {BRAND_LABEL[pm.brand] ?? pm.brand}
              </span>{" "}
              <span className="text-slate-600">•••• {pm.last4}</span>
              <span className="ml-2 text-xs text-slate-500">
                expires {String(pm.expMonth).padStart(2, "0")}/{pm.expYear}
              </span>
              {pm.isDefault && (
                <span className="badge ml-2 bg-purple-100 text-purple-700">default</span>
              )}
            </div>
            {!pm.isDefault && (
              <div className="flex gap-2">
                <button
                  className="btn btn-ghost text-xs"
                  disabled={busy !== null}
                  onClick={() =>
                    act("/api/billing/default-payment-method", { payment_method_id: pm.id }, pm.id)
                  }
                >
                  {busy === pm.id ? "Saving…" : "Make default"}
                </button>
                <button
                  className="btn btn-ghost text-xs text-red-600"
                  disabled={busy !== null}
                  onClick={() =>
                    act("/api/billing/remove-payment-method", { payment_method_id: pm.id }, pm.id)
                  }
                >
                  Remove
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>

      {error && <p className="mt-2 text-xs text-red-500">{error}</p>}

      {adding ? (
        <AddCardForm onClose={() => setAdding(false)} />
      ) : (
        <button className="btn btn-primary mt-3" onClick={() => setAdding(true)}>
          {methods.length === 0 ? "Add card" : "Add another card"}
        </button>
      )}
    </div>
  );
}

/** Fetches a SetupIntent, then mounts PaymentElement with its client_secret. */
function AddCardForm({ onClose }: { onClose: () => void }) {
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    post("/api/billing/setup-intent").then((data) => {
      if (!alive) return;
      if (data.ok && data.data?.client_secret) setClientSecret(data.data.client_secret);
      else setError(data.error ?? "Could not start card setup");
    });
    return () => {
      alive = false;
    };
  }, []);

  if (error) return <p className="mt-3 text-xs text-red-500">{error}</p>;
  if (!clientSecret) return <p className="mt-3 text-sm text-slate-500">Loading secure card form…</p>;

  return (
    <div className="mt-4 rounded-xl border border-purple-200 bg-purple-50/40 p-4">
      <Elements stripe={stripePromise} options={{ clientSecret, appearance: stripeAppearance }}>
        <AddCardInner onClose={onClose} />
      </Elements>
    </div>
  );
}

function AddCardInner({ onClose }: { onClose: () => void }) {
  const stripe = useStripe();
  const elements = useElements();
  const router = useRouter();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    if (!stripe || !elements) return;
    setSaving(true);
    setError(null);
    // Cards only, so no redirect methods; 3DS opens Stripe.js's in-page modal.
    const result = await stripe.confirmSetup({
      elements,
      confirmParams: { return_url: window.location.href },
      redirect: "if_required",
    });
    if (result.error) {
      setError(result.error.message ?? "Card could not be saved");
      setSaving(false);
      return;
    }
    const data = await post("/api/billing/default-payment-method", {
      setup_intent_id: result.setupIntent.id,
    });
    if (!data.ok) {
      setError(data.error ?? "Card saved but could not be set as default");
      setSaving(false);
      return;
    }
    onClose();
    router.refresh();
  }

  return (
    <div>
      <PaymentElement options={{ terms: { card: "never" } }} />
      <div className="mt-3 flex items-center gap-3">
        <button className="btn btn-primary" onClick={save} disabled={saving || !stripe}>
          {saving ? "Saving card…" : "Save card"}
        </button>
        <button className="btn btn-ghost" onClick={onClose} disabled={saving}>
          Cancel
        </button>
      </div>
      {error && <p className="mt-2 text-xs text-red-500">{error}</p>}
      <p className="mt-2 text-xs text-slate-500">
        Card details go directly to Stripe — they never touch our servers.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Interval switch with proration preview
// ---------------------------------------------------------------------------

export function PlanIntervalSwitcher({ current }: { current: "monthly" | "annual" }) {
  const router = useRouter();
  const target = current === "monthly" ? "annual" : "monthly";
  const [preview, setPreview] = useState<IntervalPreview | null>(null);
  const [phase, setPhase] = useState<"idle" | "previewing" | "confirming">("idle");
  const [error, setError] = useState<string | null>(null);

  async function loadPreview() {
    setPhase("previewing");
    setError(null);
    const res = await fetch(`/api/billing/interval/preview?interval=${target}`);
    const data = await res.json();
    if (data.ok) setPreview(data.data);
    else setError(data.error ?? "Could not preview the change");
    setPhase("idle");
  }

  async function confirm() {
    if (!preview) return;
    setPhase("confirming");
    setError(null);
    const data = await post("/api/billing/interval", {
      interval: preview.interval,
      proration_date: preview.prorationDate,
    });
    if (!data.ok) {
      setError(data.error ?? "Could not change the plan");
      setPhase("idle");
      setPreview(null);
      return;
    }
    if (data.data?.requires_action && data.data.client_secret) {
      const stripe = await stripePromise;
      const sca = await stripe?.confirmCardPayment(data.data.client_secret);
      if (sca?.error) {
        setError(sca.error.message ?? "Your bank declined the confirmation");
        setPhase("idle");
        return;
      }
    }
    setPreview(null);
    setPhase("idle");
    router.refresh();
  }

  if (!preview) {
    return (
      <div>
        <button className="btn btn-ghost" onClick={loadPreview} disabled={phase !== "idle"}>
          {phase === "previewing"
            ? "Checking the numbers…"
            : target === "annual"
              ? "Switch to yearly billing"
              : "Switch to monthly billing"}
        </button>
        {error && <p className="mt-1 text-xs text-red-500">{error}</p>}
      </div>
    );
  }

  const renewal =
    preview.renewalAmountMinor !== null
      ? `${formatMinor(preview.renewalAmountMinor, asCurrency(preview.currency))}/${preview.interval === "annual" ? "yr" : "mo"}`
      : null;

  return (
    <div className="mt-2 rounded-xl border border-purple-200 bg-purple-50/40 p-4 text-sm">
      <p className="font-semibold text-slate-800">
        Switch to {preview.interval === "annual" ? "yearly" : "monthly"} billing
      </p>
      <ul className="mt-2 space-y-1 text-slate-700">
        {preview.trialing ? (
          <li>
            No charge today — you’re on the free trial. First charge{renewal ? ` of ${renewal}` : ""}
            {preview.newPeriodEnd ? ` on ${fmtDate(preview.newPeriodEnd)}` : " at trial end"}.
          </li>
        ) : preview.dueTodayMinor > 0 ? (
          <li>
            <span className="font-semibold">
              {formatMinor(preview.dueTodayMinor, asCurrency(preview.currency))}
            </span>{" "}
            charged today — the new period minus credit for unused time.
          </li>
        ) : (
          <li>
            No charge today.{" "}
            {preview.creditMinor > 0 && (
              <>
                <span className="font-semibold">
                  {formatMinor(preview.creditMinor, asCurrency(preview.currency))}
                </span>{" "}
                of unused time becomes account credit and pays future invoices.
              </>
            )}
          </li>
        )}
        {!preview.trialing && renewal && (
          <li>
            Then renews at {renewal}
            {preview.newPeriodEnd ? ` from ${fmtDate(preview.newPeriodEnd)}` : ""}.
          </li>
        )}
      </ul>
      <div className="mt-3 flex items-center gap-3">
        <button className="btn btn-primary" onClick={confirm} disabled={phase === "confirming"}>
          {phase === "confirming" ? "Applying…" : "Confirm switch"}
        </button>
        <button
          className="btn btn-ghost"
          onClick={() => setPreview(null)}
          disabled={phase === "confirming"}
        >
          Keep current billing
        </button>
      </div>
      {error && <p className="mt-2 text-xs text-red-500">{error}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Cancel / resume + dunning retry
// ---------------------------------------------------------------------------

const CANCEL_REASONS = [
  "Season finished",
  "Too expensive",
  "Missing a feature",
  "Switching tools",
  "Other",
] as const;

export function CancelSubscriptionButton({ periodEnd }: { periodEnd: string | null }) {
  const confirm = useConfirm();
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reasonRef = useRef<string>("");

  async function go() {
    reasonRef.current = "";
    const ok = await confirm({
      title: "Cancel your Pro subscription?",
      body: (
        <div className="space-y-3">
          <p>
            Pro stays active until{" "}
            <span className="font-semibold">{fmtDate(periodEnd) ?? "the end of the period"}</span>,
            then the club moves to Community. Nothing is deleted.
          </p>
          <label className="block text-xs font-medium text-slate-600">
            What made you cancel? (optional)
            <select
              className="select mt-1"
              defaultValue=""
              onChange={(e) => (reasonRef.current = e.target.value)}
            >
              <option value="">Choose a reason…</option>
              {CANCEL_REASONS.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </label>
        </div>
      ),
      confirmLabel: "Cancel at period end",
      tone: "danger",
    });
    if (!ok) return;
    setLoading(true);
    setError(null);
    const data = await post("/api/billing/cancel", {
      reason: reasonRef.current || undefined,
    });
    if (!data.ok) setError(data.error ?? "Something went wrong");
    setLoading(false);
    router.refresh();
  }

  return (
    <div>
      <button className="btn btn-ghost text-red-600" onClick={go} disabled={loading}>
        {loading ? "Cancelling…" : "Cancel subscription"}
      </button>
      {error && <p className="mt-1 text-xs text-red-500">{error}</p>}
    </div>
  );
}

export function ResumeSubscriptionButton() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function go() {
    setLoading(true);
    setError(null);
    const data = await post("/api/billing/cancel", { resume: true });
    if (!data.ok) setError(data.error ?? "Something went wrong");
    setLoading(false);
    router.refresh();
  }

  return (
    <div>
      <button className="btn btn-primary" onClick={go} disabled={loading}>
        {loading ? "Resuming…" : "Keep Pro"}
      </button>
      {error && <p className="mt-1 text-xs text-red-500">{error}</p>}
    </div>
  );
}

/** Dunning recovery: pay the open invoice with the fixed card, in-page SCA if
 *  the bank asks for it. */
export function RetryPaymentButton() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function go() {
    setLoading(true);
    setError(null);
    const data = await post("/api/billing/retry-invoice");
    if (!data.ok) {
      setError(data.error ?? "Payment failed");
      setLoading(false);
      return;
    }
    if (data.data?.requires_action && data.data.client_secret) {
      const stripe = await stripePromise;
      const sca = await stripe?.confirmCardPayment(data.data.client_secret);
      if (sca?.error) {
        setError(sca.error.message ?? "Your bank declined the confirmation");
        setLoading(false);
        return;
      }
    }
    setLoading(false);
    router.refresh();
  }

  return (
    <div>
      <button className="btn btn-primary" onClick={go} disabled={loading}>
        {loading ? "Paying…" : "Retry payment"}
      </button>
      {error && <p className="mt-1 text-xs text-red-500">{error}</p>}
    </div>
  );
}
