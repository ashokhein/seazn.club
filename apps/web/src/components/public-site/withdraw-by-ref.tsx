"use client";

// Self-withdraw from /r/[ref] (v3/05 §3). The ref is a lookup, not auth —
// the emailed token rides along and the server re-checks it.
import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiV1 } from "@/lib/client-v1";
import { useConfirm } from "@/components/ui/confirm-provider";
import { useMsg } from "@/components/i18n/dict-provider";

export function WithdrawByRef({ refCode, token }: { refCode: string; token: string }) {
  const msg = useMsg();
  const router = useRouter();
  const confirmDialog = useConfirm();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      await apiV1(`/api/v1/public/registrations/by-ref/${encodeURIComponent(refCode)}/withdraw`, {
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

  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        disabled={busy}
        onClick={() => void withdraw()}
        className="rounded-md border border-red-200 px-4 py-2 text-sm text-red-600 hover:border-red-400 disabled:opacity-50"
      >
        {busy ? "Withdrawing…" : "Withdraw my entry"}
      </button>
      {error && <span className="text-xs text-red-600">{error}</span>}
    </span>
  );
}
