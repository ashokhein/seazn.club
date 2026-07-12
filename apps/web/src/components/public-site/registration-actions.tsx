"use client";

// Registrant self-service actions (token-authenticated): pay a due entry fee
// (fresh or waitlist-promoted registrations) and withdraw.
import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiV1 } from "@/lib/client-v1";
import { useConfirm } from "@/components/ui/confirm-provider";
import { msg } from "@/lib/messages";

export function RegistrationActions({
  registrationId,
  token,
  status,
  paymentDue,
  payLabel,
}: {
  registrationId: string;
  token: string;
  status: string;
  paymentDue: boolean;
  payLabel?: string;
}) {
  const router = useRouter();
  const confirmDialog = useConfirm();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function pay() {
    setBusy(true);
    setError(null);
    try {
      const { checkout_url } = await apiV1<{ checkout_url: string }>(
        `/api/v1/public/registrations/${registrationId}/checkout`,
        { method: "POST", json: { token } },
      );
      window.location.assign(checkout_url);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Payment failed to start");
      setBusy(false);
    }
  }

  async function withdraw() {
    const ok = await confirmDialog({
      title: msg("confirm.withdrawOwnRegistration.title"),
      body: msg("confirm.withdrawOwnRegistration.body"),
      confirmLabel: msg("confirm.withdrawOwnRegistration.label"),
      tone: "danger",
    });
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      await apiV1(`/api/v1/public/registrations/${registrationId}/withdraw`, {
        method: "POST",
        json: { token },
      });
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Withdraw failed");
    } finally {
      setBusy(false);
    }
  }

  if (status === "withdrawn" || status === "expired") return null;

  return (
    <>
      {paymentDue && (
        <button
          type="button"
          disabled={busy}
          onClick={pay}
          className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-50"
        >
          {payLabel ?? "Pay entry fee"}
        </button>
      )}
      <button
        type="button"
        disabled={busy}
        onClick={withdraw}
        className="rounded-md border border-red-200 px-4 py-2 text-sm text-red-600 hover:border-red-400 disabled:opacity-50"
      >
        Withdraw
      </button>
      {error && <p className="w-full text-sm text-red-600">{error}</p>}
    </>
  );
}
