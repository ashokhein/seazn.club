"use client";

// Constraints v2 console (Jul3/04 §6): constraint editor, bulk time shift,
// and the pre-publish wait-time report.
import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiV1, ApiV1Error } from "@/lib/client-v1";
import { UpgradeGate } from "@/components/upgrade-gate";
import { useConfirm } from "@/components/ui/confirm-provider";
import { useMsg } from "@/components/i18n/dict-provider";

/** 625 → "10h 25m"; 45 → "45m". The raw minute dumps read like debug output. */
function fmtDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

interface Constraints {
  restMin?: number;
  noBackToBack?: boolean;
  fieldFairness?: "off" | "balance" | "rotate";
  parallelism?: "block" | "mixed";
  crossPersonClash?: "warn" | "hard";
  startWindows?: { target: { kind: string; id: string }; notBefore?: string; notAfter?: string }[];
}
interface Settings {
  division_id: string;
  config: Record<string, unknown> & { constraints?: Constraints };
  tz: string;
}
interface WaitRow {
  display_name: string;
  fixtures: number;
  minGapMinutes: number | null;
  maxGapMinutes: number | null;
  spanMinutes: number;
}

export function ConstraintsPanel({
  divisionId,
  initialSettings,
  canEdit,
}: {
  divisionId: string;
  initialSettings: Settings;
  canEdit: boolean;
}) {
  const msg = useMsg();
  const router = useRouter();
  const confirmDialog = useConfirm();
  const [error, setError] = useState<string | null>(null);
  const [paywallFeature, setPaywallFeature] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [constraints, setConstraints] = useState<Constraints>(
    initialSettings.config.constraints ?? {},
  );
  const [shiftMinutes, setShiftMinutes] = useState(15);
  const [report, setReport] = useState<{ worst: WaitRow[] } | null>(null);

  async function run(fn: () => Promise<unknown>, refresh = false) {
    setError(null);
    setPaywallFeature(null);
    setBusy(true);
    try {
      await fn();
      if (refresh) router.refresh();
    } catch (err) {
      if (err instanceof ApiV1Error && err.code === "PAYMENT_REQUIRED") {
        setPaywallFeature(String(err.extra.feature_key ?? ""));
      } else {
        setError(err instanceof Error ? err.message : "Failed");
      }
    } finally {
      setBusy(false);
    }
  }

  const save = (next: Constraints) =>
    run(async () => {
      const current = await apiV1<Settings>(`/api/v1/divisions/${divisionId}/schedule-settings`);
      await apiV1(`/api/v1/divisions/${divisionId}/schedule-settings`, {
        method: "PUT",
        json: { config: { ...current.config, constraints: next }, tz: current.tz },
      });
      setConstraints(next);
    }, true);

  return (
    <section className="mt-8 space-y-4" aria-label="Scheduling constraints">
      <h2 className="text-lg font-semibold tracking-tight text-slate-900">
        Constraints &amp; planning
      </h2>
      {paywallFeature && <UpgradeGate feature={paywallFeature} />}
      {error && <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>}

      <div className="grid gap-4 lg:grid-cols-2">
        {/* constraint editor */}
        <div className="card space-y-3 p-4">
          <h3 className="text-sm font-semibold text-slate-900">Constraints</h3>
          <label className="flex items-center gap-2 text-sm text-slate-600">
            <input
              type="checkbox"
              checked={constraints.crossPersonClash === "hard"}
              disabled={!canEdit || busy}
              onChange={(e) =>
                void save({ ...constraints, crossPersonClash: e.target.checked ? "hard" : "warn" })
              }
            />
            A player can never be in two matches at once (across divisions)
          </label>
          <label className="flex items-center gap-2 text-sm text-slate-600">
            <input
              type="checkbox"
              checked={constraints.noBackToBack === true}
              disabled={!canEdit || busy}
              onChange={(e) => void save({ ...constraints, noBackToBack: e.target.checked })}
            />
            At least one break between a team&apos;s matches
          </label>
          <label className="flex items-center gap-2 text-sm text-slate-600">
            Minimum rest
            <input
              type="number"
              min={0}
              className="input w-24"
              value={constraints.restMin ?? 0}
              disabled={!canEdit || busy}
              onChange={(e) =>
                void save({ ...constraints, restMin: Math.max(0, Number(e.target.value)) })
              }
            />
            minutes
          </label>
          <label className="flex items-center gap-2 text-sm text-slate-600">
            Field fairness
            <select
              className="input"
              value={constraints.fieldFairness ?? "off"}
              disabled={!canEdit || busy}
              onChange={(e) =>
                void save({
                  ...constraints,
                  fieldFairness: e.target.value as Constraints["fieldFairness"],
                })
              }
            >
              <option value="off">off</option>
              <option value="balance">balance courts</option>
              <option value="rotate">rotate every game</option>
            </select>
          </label>
          {(constraints.startWindows?.length ?? 0) > 0 && (
            <p className="text-xs text-slate-500">
              {constraints.startWindows!.length} start window(s) set.
            </p>
          )}
        </div>

        {/* bulk shift */}
        {canEdit && (
          <div className="card space-y-3 p-4">
            <h3 className="text-sm font-semibold text-slate-900">Bulk time shift</h3>
            <div className="flex items-center gap-2 text-sm text-slate-600">
              <input
                type="number"
                className="input w-24"
                value={shiftMinutes}
                onChange={(e) => setShiftMinutes(Number(e.target.value))}
                aria-label="Shift minutes"
              />
              minutes
              <button
                type="button"
                className="btn btn-primary px-3 py-1.5 text-xs"
                disabled={busy || shiftMinutes === 0}
                onClick={async () => {
                  // A whole-timetable move deserves a breath first (organiser
                  // ask) — and the honest promise that conflicts are fixable.
                  const ok = await confirmDialog({
                    title: msg("confirm.shiftAll.title", { minutes: shiftMinutes }),
                    body: msg("confirm.shiftAll.body"),
                    confirmLabel: msg("confirm.shiftAll.label"),
                  });
                  if (!ok) return;
                  void run(
                    () =>
                      apiV1("/api/v1/schedule/shift", {
                        method: "POST",
                        json: {
                          division_id: divisionId,
                          scope: { excludeLocked: true },
                          delta_minutes: shiftMinutes,
                        },
                      }),
                    true,
                  );
                }}
              >
                Shift everything
              </button>
            </div>
            <p className="text-xs text-slate-500">
              Locked and decided fixtures stay put. Undoable from the history panel.
            </p>
          </div>
        )}

        {/* wait report */}
        <div className="card space-y-3 p-4">
          <h3 className="text-sm font-semibold text-slate-900">Wait-time report</h3>
          <p className="text-xs text-slate-500">
            Who sits around the longest between their matches — worth a look before you publish.
          </p>
          <button
            type="button"
            className="btn btn-primary px-3 py-1.5 text-xs"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                setReport(await apiV1(`/api/v1/divisions/${divisionId}/schedule/report`));
              })
            }
          >
            {busy ? "Checking…" : "Check waits"}
          </button>
          {report &&
            (report.worst.length === 0 ? (
              <p className="text-sm text-slate-500">No multi-game waits yet.</p>
            ) : (
              <div className="scroll-x scroll-x-fade">
                <table className="w-full text-sm" aria-label="Longest waits between matches">
                  <thead>
                    <tr className="border-b border-slate-200 text-left text-xs tracking-wide text-slate-500 uppercase">
                      <th className="py-1.5 pr-3 font-medium">Entrant</th>
                      <th className="py-1.5 pr-3 font-medium">Games</th>
                      <th className="py-1.5 pr-3 font-medium">Longest wait</th>
                      <th className="py-1.5 font-medium">First to last</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.worst.map((r, i) => (
                      <tr key={r.display_name} className="border-b border-slate-100 last:border-0">
                        <td className="py-1.5 pr-3 font-medium text-slate-800">{r.display_name}</td>
                        <td className="py-1.5 pr-3 text-slate-600 tabular-nums">{r.fixtures}</td>
                        <td className="py-1.5 pr-3 tabular-nums">
                          <span
                            className={`rounded px-1.5 py-0.5 text-xs font-semibold ${
                              i === 0
                                ? "bg-red-100 text-red-700"
                                : (r.maxGapMinutes ?? 0) >= 120
                                  ? "bg-amber-100 text-amber-800"
                                  : "bg-slate-100 text-slate-600"
                            }`}
                          >
                            {fmtDuration(r.maxGapMinutes ?? 0)}
                          </span>
                        </td>
                        <td className="py-1.5 text-slate-600 tabular-nums">
                          {fmtDuration(r.spanMinutes)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="mt-2 text-xs text-slate-500">
                  Sorted worst-first. Tighten the gaps by re-flowing on the board, or raise min
                  rest and re-run.
                </p>
              </div>
            ))}
        </div>
      </div>
    </section>
  );
}
