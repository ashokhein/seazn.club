"use client";

import { useState } from "react";
import { useMsg } from "@/components/i18n/dict-provider";
import { useRouter } from "next/navigation";
import { api } from "@/lib/client";

/** Accept an invite the current (logged-in) user is viewing. */
export function JoinInvite({ token }: { token: string }) {
  const msg = useMsg();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function join() {
    setError(null);
    setBusy(true);
    try {
      const out = await api<{ landing?: string }>(`/api/invites/${token}/accept`, {
        method: "POST",
      });
      // Scorers land on their console, not the org dashboard (doc 13 §4).
      router.push(out.landing ?? "/dashboard");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : msg("join.failed"));
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <button
        onClick={join}
        disabled={busy}
        className="btn btn-primary w-full py-2.5"
      >
        {busy ? msg("join.joining") : msg("join.joinOrg")}
      </button>
      {error && (
        <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-600">
          {error}
        </p>
      )}
    </div>
  );
}
