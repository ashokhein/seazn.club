"use client";

// "Process now" for a missed/stuck Stripe event on /admin/billing-events.
import { useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/client";

export function ProcessEventButton({ eventId }: { eventId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/admin/billing-events/${eventId}/process`, { method: "POST" });
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed");
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        disabled={busy}
        onClick={run}
        className="rounded-md border border-purple-500/60 px-2.5 py-1 text-xs font-medium text-purple-300 transition hover:bg-purple-500/10 disabled:opacity-50"
      >
        {busy ? "Processing…" : "Process now"}
      </button>
      {error && <span className="text-xs text-red-400">{error}</span>}
    </span>
  );
}
