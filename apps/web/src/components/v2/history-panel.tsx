"use client";

// Schedule history console (Jul3/03 §6): undo/redo buttons, history list,
// named checkpoints + restore, division freeze/scope locks, and the guarded
// "danger zone" clear — deliberately at the bottom, away from Schedule
// controls (18 May ask).
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { apiV1, ApiV1Error } from "@/lib/client-v1";
import { UpgradeGate } from "@/components/upgrade-gate";
import { useConfirm } from "@/components/ui/confirm-provider";
import { Tip } from "@/components/ui/tip";
import { useMsg } from "@/components/i18n/dict-provider";

interface HistoryRow {
  seq: number;
  type: string;
  undoable: boolean;
  created_at: string;
  undone: boolean;
}
interface HistoryOut {
  watermark: number | null;
  seq: number;
  events: HistoryRow[];
}
interface Checkpoint {
  id: string;
  seq: number;
  label: string;
  /** V303 — "ai" anchors are created by the AI accept flow and exempt from the
   *  organiser's save-point quota. */
  kind?: "manual" | "ai";
  /** Every AI anchor except the newest. Struck through, still restorable. */
  superseded?: boolean;
  created_at: string;
}

const TYPE_LABELS: Record<string, string> = {
  schedule_applied: "Schedule applied",
  schedule_edited: "Fixture moved",
  schedule_cleared: "Schedule cleared",
  schedule_restored: "Schedule restored",
  fixtures_generated: "Fixtures generated",
  fixtures_cleared: "Fixtures removed",
  pool_entrants_cleared: "Pool emptied",
  pool_entrants_restored: "Pool restored",
  officials_assigned: "Officials assigned",
  participants_imported: "Participants imported",
  schedule_published: "Schedule published",
  division_started: "Division started",
};

export function HistoryPanel({
  divisionId,
  scheduleLocked,
  canEdit,
}: {
  divisionId: string;
  scheduleLocked: boolean;
  canEdit: boolean;
}) {
  const msg = useMsg();
  const router = useRouter();
  const confirmDialog = useConfirm();
  const [history, setHistory] = useState<HistoryOut | null>(null);
  const [checkpoints, setCheckpoints] = useState<Checkpoint[]>([]);
  const [label, setLabel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [paywallFeature, setPaywallFeature] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [h, cps] = await Promise.all([
        apiV1<HistoryOut>(`/api/v1/divisions/${divisionId}/history`),
        apiV1<Checkpoint[]>(`/api/v1/divisions/${divisionId}/checkpoints`),
      ]);
      setHistory(h);
      setCheckpoints(cps);
    } catch {
      /* panel stays empty */
    }
  }, [divisionId]);

  useEffect(() => {
    // microtask defer keeps setState out of the synchronous effect body
    const t = setTimeout(() => void load(), 0);
    return () => clearTimeout(t);
  }, [load]);

  async function run(fn: () => Promise<unknown>) {
    setError(null);
    setPaywallFeature(null);
    setBusy(true);
    try {
      await fn();
      await load();
      router.refresh();
    } catch (err) {
      if (err instanceof ApiV1Error && err.code === "PAYMENT_REQUIRED") {
        setPaywallFeature(String(err.extra.feature_key ?? ""));
      } else if (err instanceof ApiV1Error && err.code === "SEQ_CONFLICT") {
        setError("Someone else edited this division — reloaded the latest state.");
        await load();
      } else {
        setError(err instanceof Error ? err.message : "Failed");
      }
    } finally {
      setBusy(false);
    }
  }

  const step = (direction: "undo" | "redo") =>
    run(() =>
      apiV1(`/api/v1/divisions/${divisionId}/${direction}`, {
        method: "POST",
        json: { expected_seq: history?.seq },
      }),
    );

  return (
    <section className="mt-8 space-y-4" aria-label="Schedule history">
      <div className="flex flex-wrap items-center gap-2">
        {/* Tip sits OUTSIDE the h2 — inside it would pollute the heading's
            accessible name ("History About: …"). */}
        <div className="flex items-center gap-1.5">
          <h2 className="text-lg font-semibold tracking-tight text-slate-900">History</h2>
          <Tip id="schedule.undo-watermark" />
        </div>
        {canEdit && (
          <>
            <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void step("undo")}>
              ↩ Undo
            </button>
            <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void step("redo")}>
              ↪ Redo
            </button>
            <label className="ml-auto flex items-center gap-2 text-sm text-slate-600">
              <input
                type="checkbox"
                checked={scheduleLocked}
                disabled={busy}
                onChange={(e) =>
                  void run(() =>
                    apiV1(`/api/v1/divisions/${divisionId}/locks`, {
                      method: "PATCH",
                      json: { schedule_locked: e.target.checked },
                    }),
                  )
                }
              />
              Freeze whole schedule
            </label>
          </>
        )}
      </div>

      {paywallFeature && <UpgradeGate feature={paywallFeature} />}
      {error && <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>}

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="card p-4">
          <h3 className="mb-2 text-sm font-semibold text-slate-900">Recent edits</h3>
          {!history || history.events.length === 0 ? (
            <p className="text-sm text-slate-500">Nothing yet.</p>
          ) : (
            <ol className="space-y-1 text-sm">
              {history.events.slice(0, 12).map((e) => (
                <li
                  key={e.seq}
                  className={`flex items-center gap-2 ${e.undone ? "text-slate-400 line-through" : "text-slate-700"}`}
                >
                  <span className="font-mono text-xs text-slate-400">#{e.seq}</span>
                  {TYPE_LABELS[e.type] ?? e.type}
                  {!e.undoable && <span className="text-xs text-slate-400">(not undoable)</span>}
                  <time className="ml-auto text-xs text-slate-400">
                    {new Date(e.created_at).toLocaleTimeString()}
                  </time>
                </li>
              ))}
            </ol>
          )}
        </div>

        <div className="card space-y-2 p-4">
          {/* Tip beside, not inside, the heading (accessible-name hygiene). */}
          <div className="flex items-center gap-1.5">
            <h3 className="text-sm font-semibold text-slate-900">Save points</h3>
            <Tip id="schedule.save-points" />
          </div>
          {canEdit && (
            <form
              className="flex items-end gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (!label.trim()) return;
                void run(async () => {
                  await apiV1(`/api/v1/divisions/${divisionId}/checkpoints`, {
                    method: "POST",
                    json: { label: label.trim() },
                  });
                  setLabel("");
                });
              }}
            >
              <input
                className="input"
                placeholder="e.g. before rain reshuffle"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                aria-label="Save point label"
              />
              <button type="submit" className="btn btn-primary" disabled={busy}>Save point</button>
            </form>
          )}
          {checkpoints.length === 0 ? (
            <p className="text-sm text-slate-500">No save points yet.</p>
          ) : (
            <ul className="space-y-1 text-sm">
              {checkpoints.map((cp) => (
                <li
                  key={cp.id}
                  className={`flex items-center gap-2 ${cp.superseded ? "text-slate-400" : "text-slate-700"}`}
                >
                  {/* Superseded AI anchors are struck, not hidden or disabled:
                      the ledger can rewind to any watermark, so jumping back
                      two AI runs stays available — it is just no longer the
                      one Undo targets. */}
                  <span className={cp.superseded ? "line-through" : undefined}>{cp.label}</span>
                  {cp.kind === "ai" && !cp.superseded && (
                    <span className="rounded bg-purple-100 px-1.5 py-0.5 text-[10px] font-medium text-purple-700 dark:bg-purple-950 dark:text-purple-300">
                      {msg("history.checkpoint.latestAi")}
                    </span>
                  )}
                  <time className="text-xs text-slate-400">
                    {new Date(cp.created_at).toLocaleString()}
                  </time>
                  {canEdit && (
                    <button
                      type="button"
                      className="ml-auto text-xs text-purple-600 hover:underline"
                      disabled={busy}
                      onClick={async () => {
                        const ok = await confirmDialog({
                          title: msg("confirm.restoreCheckpoint.title"),
                          body: msg("confirm.restoreCheckpoint.body", { name: cp.label }),
                          confirmLabel: msg("confirm.restoreCheckpoint.label"),
                        });
                        if (!ok) return;
                        void run(() =>
                          apiV1(`/api/v1/divisions/${divisionId}/restore`, {
                            method: "POST",
                            json: { checkpoint_id: cp.id, confirm: true },
                          }),
                        );
                      }}
                    >
                      Restore
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {canEdit && (
        <div className="card border-red-100 p-4">
          <h3 className="text-sm font-semibold text-red-700">Danger zone</h3>
          <p className="mt-1 text-xs text-slate-500">
            Clears timetable slots only — locked and decided fixtures always survive, and
            the action is undoable above.
          </p>
          <button
            type="button"
            className="btn mt-2 border-red-200 text-red-700 hover:bg-red-50"
            disabled={busy}
            onClick={async () => {
              const ok = await confirmDialog({
                title: msg("confirm.clearSlots.title"),
                body: msg("confirm.clearSlots.body"),
                confirmLabel: msg("confirm.clearSlots.label"),
                tone: "danger",
              });
              if (!ok) return;
              void run(() =>
                apiV1("/api/v1/schedule/clear", {
                  method: "POST",
                  json: { division_id: divisionId, scope: { excludeLocked: true }, confirm: true },
                }),
              );
            }}
          >
            Clear schedule…
          </button>
        </div>
      )}
    </section>
  );
}
