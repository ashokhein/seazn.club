"use client";

// Discovery curation actions (doc 15 §3, PROMPT-19): feature (Pro-eligible
// only) and block, both with a required reason → staff_audit_log.
import { useState } from "react";
import { useRouter } from "next/navigation";

export function AdminDiscoveryActions({
  competitionId,
  featured,
  blocked,
  featureEligible,
}: {
  competitionId: string;
  featured: boolean;
  blocked: boolean;
  featureEligible: boolean;
}) {
  const router = useRouter();
  const [reason, setReason] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function act(action: "feature" | "unfeature" | "block" | "unblock") {
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`/api/admin/competitions/${competitionId}/discovery`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, reason }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error ?? "Failed");
      }
      setReason("");
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <input
        type="text"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="Reason (required)"
        className="w-40 rounded border border-slate-600 bg-slate-700 px-2 py-1 text-xs text-white placeholder:text-slate-500"
      />
      <button
        onClick={() => act(featured ? "unfeature" : "feature")}
        disabled={!reason || loading || (!featured && !featureEligible)}
        title={!featureEligible && !featured ? "Pro orgs only (doc 15 §3)" : undefined}
        className="rounded bg-amber-700 px-2 py-1 text-xs text-white hover:bg-amber-600 disabled:opacity-40"
      >
        {featured ? "Unfeature" : "Feature"}
      </button>
      <button
        onClick={() => act(blocked ? "unblock" : "block")}
        disabled={!reason || loading}
        className={`rounded px-2 py-1 text-xs text-white disabled:opacity-40 ${
          blocked ? "bg-emerald-700 hover:bg-emerald-600" : "bg-red-800 hover:bg-red-700"
        }`}
      >
        {blocked ? "Unblock" : "Block"}
      </button>
      {error && <span className="text-xs text-red-400">{error}</span>}
    </div>
  );
}
