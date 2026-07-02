"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function AdminOrgActions({
  orgId,
  currentStatus,
  currentPlan,
}: {
  orgId: string;
  currentStatus: string;
  currentPlan: string;
}) {
  const router = useRouter();
  const [loading, setLoading] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [trialDays, setTrialDays] = useState("14");
  const [suspendReason, setSuspendReason] = useState("");

  async function post(path: string, body: Record<string, unknown>) {
    setLoading(path);
    setError("");
    try {
      const res = await fetch(`/api/admin/orgs/${orgId}/${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error ?? "Failed");
      }
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error");
    } finally {
      setLoading(null);
    }
  }

  return (
    <div className="space-y-3">
      {/* Grant trial */}
      <div className="space-y-1">
        <p className="text-xs text-slate-500">Extend trial</p>
        <div className="flex gap-2">
          <input
            type="number"
            value={trialDays}
            onChange={(e) => setTrialDays(e.target.value)}
            className="w-16 rounded border border-slate-600 bg-slate-700 px-2 py-1 text-sm text-white"
            min={1}
            max={365}
          />
          <span className="text-xs text-slate-400 self-center">days</span>
          <button
            onClick={() => post("grant-trial", { days: Number(trialDays) })}
            disabled={loading === "grant-trial"}
            className="rounded bg-purple-700 px-3 py-1 text-xs text-white hover:bg-purple-600 disabled:opacity-50"
          >
            {loading === "grant-trial" ? "…" : "Grant"}
          </button>
        </div>
      </div>

      {/* Suspend / reactivate */}
      <div className="space-y-1">
        <p className="text-xs text-slate-500">
          {currentStatus === "suspended" ? "Reactivate org" : "Suspend org (superadmin)"}
        </p>
        <input
          type="text"
          value={suspendReason}
          onChange={(e) => setSuspendReason(e.target.value)}
          placeholder="Reason (required)"
          className="w-full rounded border border-slate-600 bg-slate-700 px-2 py-1 text-xs text-white placeholder:text-slate-500"
        />
        <button
          onClick={() =>
            post("suspend", {
              action: currentStatus === "suspended" ? "reactivate" : "suspend",
              reason: suspendReason,
            })
          }
          disabled={!suspendReason || loading === "suspend"}
          className={`rounded px-3 py-1 text-xs text-white disabled:opacity-50 ${
            currentStatus === "suspended"
              ? "bg-emerald-700 hover:bg-emerald-600"
              : "bg-red-800 hover:bg-red-700"
          }`}
        >
          {loading === "suspend"
            ? "…"
            : currentStatus === "suspended"
              ? "Reactivate"
              : "Suspend"}
        </button>
      </div>

      {error && <p className="text-xs text-red-400">{error}</p>}
    </div>
  );
}
