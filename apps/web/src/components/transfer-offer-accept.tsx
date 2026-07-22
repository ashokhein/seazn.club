"use client";

// The recipient's half of a billing-group handover (spec 2026-07-21 §Operations
// 3). The offer created a SetupIntent and this renders its card form: the
// recipient enters a card, confirmSetup attaches it, and only then does the
// accept route move the group — so a paying subscription never changes hands
// cardless. Backend proven in billing-group-accept-transfer.test.ts; this is
// the UI that was missing.
import { useState, type FormEvent } from "react";
import { Elements, PaymentElement, useElements, useStripe } from "@stripe/react-stripe-js";
import { stripePromise, stripeAppearance } from "@/lib/stripe-browser";
import { useMsg } from "@/components/i18n/dict-provider";

function AcceptForm({ setupIntentId, onDone }: { setupIntentId: string; onDone: () => void }) {
  const stripe = useStripe();
  const elements = useElements();
  const msg = useMsg();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!stripe || !elements) return;
    setBusy(true);
    setError(null);
    // Attach the card first; the transfer route re-checks succeeded server-side
    // and refuses a group that has nothing on file.
    const confirm = await stripe.confirmSetup({ elements, redirect: "if_required" });
    if (confirm.error) {
      setError(confirm.error.message ?? msg("billing.group.error"));
      setBusy(false);
      return;
    }
    const res = await fetch("/api/billing/group/transfer/accept", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ setup_intent_id: setupIntentId }),
    });
    const json = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    if (!res.ok || json.ok === false) {
      setError(json.error ?? msg("billing.group.error"));
      setBusy(false);
      return;
    }
    onDone();
  }

  return (
    <form onSubmit={submit} className="mt-3 flex flex-col gap-3">
      <PaymentElement />
      <button type="submit" disabled={busy || !stripe} className="btn btn-primary text-sm">
        {msg("billing.group.transfer.acceptConfirm")}
      </button>
      {error && (
        <p role="alert" className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </p>
      )}
    </form>
  );
}

export function TransferOfferAccept({
  clientSecret,
  setupIntentId,
  onDone,
}: {
  clientSecret: string;
  setupIntentId: string;
  onDone: () => void;
}) {
  return (
    <Elements stripe={stripePromise} options={{ clientSecret, appearance: stripeAppearance }}>
      <AcceptForm setupIntentId={setupIntentId} onDone={onDone} />
    </Elements>
  );
}
