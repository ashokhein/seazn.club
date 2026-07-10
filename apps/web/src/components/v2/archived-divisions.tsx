"use client";

// Archived divisions (v3/09 §4) — the restore surface in competition
// settings. Restore un-archives (quota re-checked server-side, 402 on
// overflow); purge hard-deletes after the 30-day cool-off with a typed-name
// confirm stating exactly what dies.
import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiV1, ApiV1Error } from "@/lib/client-v1";
import { ConfirmDialog } from "@/components/v2/confirm-dialog";
import { UpgradeGate } from "@/components/upgrade-gate";

export interface ArchivedDivisionLite {
  id: string;
  name: string;
  sport_key: string;
  archived_at: string;
}

const PURGE_COOL_OFF_DAYS = 30;

export function ArchivedDivisions({
  divisions,
  canEdit,
}: {
  divisions: ArchivedDivisionLite[];
  canEdit: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [paywallFeature, setPaywallFeature] = useState<string | null>(null);
  const [purging, setPurging] = useState<ArchivedDivisionLite | null>(null);
  // Stable per mount — cool-off is measured in days, render-time drift is noise.
  const [now] = useState(() => Date.now());

  if (divisions.length === 0) return null;

  async function restore(id: string) {
    setBusy(true);
    setError(null);
    setPaywallFeature(null);
    try {
      await apiV1(`/api/v1/divisions/${id}/archive`, { method: "DELETE" });
      router.refresh();
    } catch (err) {
      if (err instanceof ApiV1Error && err.code === "PAYMENT_REQUIRED") {
        setPaywallFeature(String(err.extra.feature_key ?? ""));
      } else {
        setError(err instanceof Error ? err.message : "Restore failed");
      }
    } finally {
      setBusy(false);
    }
  }

  async function purge(id: string) {
    setBusy(true);
    setError(null);
    try {
      await apiV1(`/api/v1/divisions/${id}`, { method: "DELETE" });
      setPurging(null);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Purge failed");
      setPurging(null);
    } finally {
      setBusy(false);
    }
  }

  const purgeReadyAt = (archivedAt: string) =>
    new Date(new Date(archivedAt).getTime() + PURGE_COOL_OFF_DAYS * 24 * 60 * 60 * 1000);

  return (
    <section className="card mt-6 p-5" data-testid="archived-divisions">
      <h2 className="text-sm font-semibold text-slate-700">Archived divisions</h2>
      <p className="mt-1 text-xs text-slate-500">
        Hidden from your console and the public site; they don’t count against your plan.
        Restore brings everything back exactly as it was.
      </p>
      {error && (
        <p className="mt-2 rounded-md bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>
      )}
      {paywallFeature && (
        <div className="mt-2">
          <UpgradeGate feature={paywallFeature} />
        </div>
      )}
      <ul className="mt-3 divide-y divide-slate-100">
        {divisions.map((d) => {
          const purgeReady = purgeReadyAt(d.archived_at).getTime() <= now;
          return (
            <li key={d.id} className="flex items-center gap-3 py-2 text-sm">
              <span className="min-w-0 flex-1 truncate text-slate-700">{d.name}</span>
              <span className="chip">{d.sport_key}</span>
              <span className="shrink-0 text-xs text-slate-400">
                archived {new Date(d.archived_at).toLocaleDateString()}
              </span>
              {canEdit && (
                <>
                  <button
                    type="button"
                    className="btn btn-ghost text-xs"
                    disabled={busy}
                    onClick={() => void restore(d.id)}
                  >
                    Restore
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost text-xs text-red-500"
                    disabled={busy || !purgeReady}
                    title={
                      purgeReady
                        ? "Permanently delete this archived division"
                        : `Purge unlocks ${purgeReadyAt(d.archived_at).toLocaleDateString()} (30-day cool-off)`
                    }
                    onClick={() => setPurging(d)}
                  >
                    Purge…
                  </button>
                </>
              )}
            </li>
          );
        })}
      </ul>

      <ConfirmDialog
        open={purging !== null}
        title={`Purge ${purging?.name ?? ""}?`}
        confirmLabel="Purge permanently"
        typedName={purging?.name ?? ""}
        busy={busy}
        onConfirm={() => purging && void purge(purging.id)}
        onCancel={() => setPurging(null)}
      >
        <p>
          <strong>Destroyed:</strong> the division with every stage, fixture, result and
          entrant entry — including recorded scores.
        </p>
        <p>
          <strong>Kept:</strong> people, teams and clubs at the organisation level.
        </p>
        <p>This cannot be undone.</p>
      </ConfirmDialog>
    </section>
  );
}
