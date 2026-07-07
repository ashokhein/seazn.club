"use client";

// Constraints v2 console (Jul3/04 §6): constraint editor, AI prose box
// (propose-only — parsed constraints shown for approval, never auto-applied),
// bulk time shift, and the pre-publish wait-time report.
import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiV1, ApiV1Error } from "@/lib/client-v1";
import { UpgradeGate } from "@/components/upgrade-gate";

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
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [paywallFeature, setPaywallFeature] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [constraints, setConstraints] = useState<Constraints>(
    initialSettings.config.constraints ?? {},
  );
  const [prose, setProse] = useState("");
  const [proposal, setProposal] = useState<{
    constraints: Constraints;
    unresolved: { kind: string; name: string }[];
  } | null>(null);
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
      setProposal(null);
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

        {/* AI prose box */}
        {canEdit && (
          <div className="card space-y-3 p-4">
            <h3 className="text-sm font-semibold text-slate-900">Describe your constraints</h3>
            <textarea
              className="input h-20 w-full"
              placeholder='e.g. "no player plays two teams at once, at least one break between games, U8 starts at 09:00"'
              value={prose}
              onChange={(e) => setProse(e.target.value)}
            />
            <button
              type="button"
              className="btn"
              disabled={busy || prose.trim().length < 3}
              onClick={() =>
                void run(async () => {
                  const out = await apiV1<{
                    constraints: Constraints;
                    unresolved: { kind: string; name: string }[];
                  }>(`/api/v1/divisions/${divisionId}/schedule/ai-constraints`, {
                    method: "POST",
                    json: { prose },
                  });
                  setProposal(out);
                })
              }
            >
              Parse with AI
            </button>
            {proposal && (
              <div className="space-y-2 rounded-md bg-slate-50 p-3 text-sm">
                <pre className="overflow-x-auto text-xs text-slate-700">
                  {JSON.stringify(proposal.constraints, null, 2)}
                </pre>
                {proposal.unresolved.length > 0 && (
                  <p className="text-xs text-amber-700">
                    Couldn&apos;t match:{" "}
                    {proposal.unresolved.map((u) => `${u.kind} "${u.name}"`).join(", ")}
                  </p>
                )}
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={busy}
                  onClick={() => void save(proposal.constraints)}
                >
                  Apply these constraints
                </button>
                <p className="text-xs text-slate-500">
                  The AI only proposes — nothing changes until you apply, and the schedule
                  itself always comes from the solver.
                </p>
              </div>
            )}
          </div>
        )}

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
                className="btn"
                disabled={busy || shiftMinutes === 0}
                onClick={() =>
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
                  )
                }
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
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                setReport(await apiV1(`/api/v1/divisions/${divisionId}/schedule/report`));
              })
            }
          >
            Check waits
          </button>
          {report &&
            (report.worst.length === 0 ? (
              <p className="text-sm text-slate-500">No multi-game waits yet.</p>
            ) : (
              <ul className="space-y-1 text-sm text-slate-700">
                {report.worst.map((r) => (
                  <li key={r.display_name} className="flex items-center gap-2">
                    <span className="font-medium">{r.display_name}</span>
                    <span className="text-slate-500">
                      longest wait {r.maxGapMinutes} min · {r.fixtures} games ·{" "}
                      {r.spanMinutes} min span
                    </span>
                  </li>
                ))}
              </ul>
            ))}
        </div>
      </div>
    </section>
  );
}
