"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Re-freeze one fixture's config snapshot from live config (V347 escape hatch).
 *
 * Superadmin-only at the route; support staff can still read the page, so the
 * control is shown and the 403 explains itself rather than hiding a thing that
 * exists. The reason is mandatory because the discarded config survives only in
 * the audit row.
 */
export function ResnapshotForm({ fixtureId }: { fixtureId: string }) {
  const router = useRouter();
  const [reason, setReason] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function submit() {
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`/api/admin/fixtures/${fixtureId}/config-snapshot`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason }),
      });
      if (!res.ok) {
        const d = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(d.error ?? `Failed (${res.status})`);
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
        aria-label="Reason"
        data-testid="resnapshot-reason"
        className="min-w-0 flex-1 rounded border border-slate-600 bg-slate-700 px-2 py-1 text-xs text-white placeholder:text-slate-500"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="Why this fixture should re-read live config"
      />
      <button
        type="button"
        data-testid="resnapshot-submit"
        disabled={loading || reason.trim().length === 0}
        onClick={submit}
        className="rounded bg-purple-700 px-3 py-1 text-xs font-semibold text-white disabled:opacity-50"
      >
        {loading ? "Re-snapshotting…" : "Re-snapshot from live config"}
      </button>
      {error && (
        <span data-testid="resnapshot-error" className="w-full text-xs text-red-400">
          {error}
        </span>
      )}
    </div>
  );
}
