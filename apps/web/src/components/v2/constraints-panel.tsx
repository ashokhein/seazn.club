"use client";

// Constraints v2 console (Jul3/04 §6): constraint editor, bulk time shift,
// and the pre-publish wait-time report.
import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiV1, ApiV1Error } from "@/lib/client-v1";
import { UpgradeGate } from "@/components/upgrade-gate";
import { useConfirm } from "@/components/ui/confirm-provider";
import { useMsg } from "@/components/i18n/dict-provider";
import { Tip } from "@/components/ui/tip";

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
        // No `tz` (V304): re-sending the RESOLVED zone would pin this
        // division to it and quietly break inheritance from the org. An
        // omitted tz leaves the stored value exactly as it is.
        json: { config: { ...current.config, constraints: next } },
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

      {/* VARIANT B — a rules sheet: each row states the rule in plain English
          on the left and puts its control on the right, so the column of
          controls scans top-to-bottom and new rules slot in without redesign. */}
      <div className="card divide-y divide-slate-100 p-0">
        <div className="px-4 py-3 sm:px-5">
          <h3 className="text-sm font-semibold text-slate-900">Scheduling rules</h3>
          <p className="mt-0.5 text-xs text-slate-500">
            Auto-schedule and AI Schedule both obey these; matches you place by hand are
            checked against them too.
          </p>
        </div>

        <label className="flex items-center justify-between gap-4 px-4 py-3 sm:px-5">
          <span className="min-w-0">
            <span className="block text-sm text-slate-800">
              A player is never in two matches at once
            </span>
            <span className="mt-0.5 block text-xs text-slate-400">
              Enforced across every division. Off, a double-booking is only a warning.
            </span>
          </span>
          <input
            type="checkbox"
            className="shrink-0"
            checked={constraints.crossPersonClash === "hard"}
            disabled={!canEdit || busy}
            onChange={(e) =>
              void save({ ...constraints, crossPersonClash: e.target.checked ? "hard" : "warn" })
            }
          />
        </label>

        <label className="flex items-center justify-between gap-4 px-4 py-3 sm:px-5">
          <span className="min-w-0">
            <span className="block text-sm text-slate-800">
              At least one break between a team&apos;s matches
            </span>
            <span className="mt-0.5 block text-xs text-slate-400">
              No entrant plays two rounds running.
            </span>
          </span>
          <input
            type="checkbox"
            className="shrink-0"
            checked={constraints.noBackToBack === true}
            disabled={!canEdit || busy}
            onChange={(e) => void save({ ...constraints, noBackToBack: e.target.checked })}
          />
        </label>

        <label className="flex flex-col items-start gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4 sm:px-5">
          <span className="min-w-0">
            <span className="block text-sm text-slate-800">Minimum rest</span>
            <span className="mt-0.5 block text-xs text-slate-400">
              Breathing room between one entrant&apos;s matches.
            </span>
          </span>
          <span className="flex shrink-0 items-center gap-2 text-sm text-slate-500">
            <input
              type="number"
              min={0}
              inputMode="numeric"
              className="input w-20 text-right"
              value={constraints.restMin ?? 0}
              disabled={!canEdit || busy}
              onChange={(e) =>
                void save({ ...constraints, restMin: Math.max(0, Number(e.target.value)) })
              }
            />
            min
          </span>
        </label>

        {/* Row, not <label>: the Tip is a <button>, and a button inside a label
            both pollutes the label's accessible name and re-targets clicks at
            the select. Same reason the history panel keeps its Tip outside the
            heading. */}
        <div className="flex flex-col items-start gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-3 sm:px-5">
          <span className="min-w-0">
            <label htmlFor="ff-select" className="block text-sm text-slate-800">
              Field fairness
            </label>
            <span className="mt-0.5 block text-xs text-slate-400">
              A tie-break between courts free at the same moment — never a delay.
            </span>
          </span>
          <span className="flex w-full items-center gap-2 sm:w-auto">
            <Tip id="schedule.field-fairness" className="shrink-0" small />
            <select
              id="ff-select"
              className="select w-full sm:w-44"
            value={constraints.fieldFairness ?? "off"}
            disabled={!canEdit || busy}
            onChange={(e) =>
              void save({
                ...constraints,
                fieldFairness: e.target.value as Constraints["fieldFairness"],
              })
            }
          >
              <option value="off">Off</option>
              <option value="balance">Balance courts</option>
              <option value="rotate">Rotate every game</option>
            </select>
          </span>
        </div>

        {(constraints.startWindows?.length ?? 0) > 0 && (
          <p className="px-4 py-3 text-xs text-slate-500 sm:px-5">
            {constraints.startWindows!.length} start window(s) set.
          </p>
        )}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
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
