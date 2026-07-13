"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/client";
import { routes } from "@/lib/routes";

/** Accept a claim the current (logged-in) user is viewing (PROMPT-53). */
export function ClaimAccept({ token, personName }: { token: string; personName: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function accept() {
    setError(null);
    setBusy(true);
    try {
      await api(`/api/claims/${token}/accept`, { method: "POST" });
      router.push(`${routes.me()}?claimed=1`);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to claim");
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <button onClick={accept} disabled={busy} className="btn btn-primary w-full py-2.5">
        {busy ? "Claiming…" : `This is me — claim ${personName}`}
      </button>
      {error && (
        <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>
      )}
    </div>
  );
}
