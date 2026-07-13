"use client";

// Player-stats leaderboard (Jul3/07 §6): sortable table off the stats fold.
// Shows "requires detailed scoring" instead of wrong zeros for coarse
// scoring, and the upgrade gate on a non-Pro org (stats.player).
import { useCallback, useEffect, useState } from "react";
import { apiV1, ApiV1Error } from "@/lib/client-v1";
import { UpgradeGate } from "@/components/upgrade-gate";

interface Metric {
  key: string;
  label: string;
}
interface Row {
  person_id: string;
  full_name: string;
  squad_number: number | null;
  entrant: string | null;
  stats: Record<string, number>;
}
interface Board {
  metrics: Metric[];
  rows: Row[];
  requires_detailed_scoring: boolean;
}

export function StatsPanel({ divisionId }: { divisionId: string }) {
  const [board, setBoard] = useState<Board | null>(null);
  const [metric, setMetric] = useState<string | null>(null);
  const [sort, setSort] = useState<"desc" | "asc">("desc");
  const [view, setView] = useState<"all" | "discipline">("all");
  const [error, setError] = useState<string | null>(null);
  const [paywall, setPaywall] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setPaywall(null);
    try {
      const q = new URLSearchParams();
      if (metric) q.set("metric", metric);
      q.set("sort", sort);
      const data = await apiV1<Board>(`/api/v1/divisions/${divisionId}/stats/players?${q}`);
      setBoard(data);
      if (metric === null && data.metrics[0]) setMetric(data.metrics[0].key);
    } catch (err) {
      if (err instanceof ApiV1Error && err.code === "PAYMENT_REQUIRED") {
        setPaywall(String(err.extra.feature_key ?? "stats.player"));
      } else {
        setError(err instanceof Error ? err.message : "Failed");
      }
    } finally {
      setLoading(false);
    }
  }, [divisionId, metric, sort]);

  useEffect(() => {
    const t = setTimeout(() => void load(), 0);
    return () => clearTimeout(t);
  }, [load]);

  if (paywall) return <UpgradeGate feature={paywall} />;
  if (error) return <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>;
  if (loading && !board) return <p className="text-sm text-slate-500">Loading stats…</p>;
  if (!board) return null;

  if (board.requires_detailed_scoring) {
    return (
      <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-700">
        Player stats require detailed (ball-by-ball / event) scoring — this division was
        scored at result level only, so per-player numbers aren&apos;t available.
      </p>
    );
  }
  if (board.rows.length === 0) {
    return <p className="text-sm text-slate-500">No player stats recorded yet.</p>;
  }

  // Discipline report (v6/00 §5): the same board narrowed to the penalty/
  // card columns — a PIM leaderboard for ice hockey, a card list for FIH.
  const isDisciplineKey = (key: string) =>
    key === "pim" || key.startsWith("pen_") || key.endsWith("_cards");
  const disciplineCols = board.metrics.filter((m) => isDisciplineKey(m.key));
  const showDiscipline = view === "discipline" && disciplineCols.length > 0;
  const cols = showDiscipline ? disciplineCols : board.metrics;
  return (
    <div className="space-y-3">
      {disciplineCols.length > 0 && (
        <div className="flex gap-1 text-xs">
          {(["all", "discipline"] as const).map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => {
                setView(v);
                if (v === "discipline") {
                  const preferred =
                    disciplineCols.find((m) => m.key === "pim") ?? disciplineCols[0];
                  if (preferred) setMetric(preferred.key);
                }
              }}
              className={`rounded-full px-3 py-1 ${view === v ? "bg-purple-100 text-purple-700" : "text-slate-500 hover:bg-slate-100"}`}
            >
              {v === "all" ? "All stats" : "Discipline"}
            </button>
          ))}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2 text-sm text-slate-600">
        <span>Sort by</span>
        <select
          className="input"
          value={metric ?? ""}
          onChange={(e) => setMetric(e.target.value)}
          aria-label="Sort metric"
        >
          {cols.map((m) => (
            <option key={m.key} value={m.key}>{m.label}</option>
          ))}
        </select>
        <button
          type="button"
          className="btn"
          onClick={() => setSort((s) => (s === "desc" ? "asc" : "desc"))}
        >
          {sort === "desc" ? "↓ high to low" : "↑ low to high"}
        </button>
      </div>

      <div className="card overflow-x-auto">
        <table className="table">
          <thead>
            <tr>
              <th className="px-4 py-2 text-left">#</th>
              <th className="px-4 py-2 text-left">Player</th>
              <th className="px-4 py-2 text-left">Team</th>
              {cols.map((m) => (
                <th
                  key={m.key}
                  className={`px-4 py-2 text-right ${m.key === metric ? "text-purple-700" : ""}`}
                >
                  {m.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {board.rows.map((r, i) => (
              <tr key={r.person_id} className="border-t border-slate-100">
                <td className="px-4 py-2 text-sm text-slate-400">{i + 1}</td>
                <td className="px-4 py-2 text-sm font-medium text-slate-900">
                  {r.squad_number !== null && (
                    <span className="mr-1 text-slate-400">#{r.squad_number}</span>
                  )}
                  {r.full_name}
                </td>
                <td className="px-4 py-2 text-sm text-slate-500">{r.entrant ?? "—"}</td>
                {cols.map((m) => (
                  <td
                    key={m.key}
                    className={`px-4 py-2 text-right text-sm ${m.key === metric ? "font-semibold text-purple-700" : "text-slate-700"}`}
                  >
                    {r.stats[m.key] ?? 0}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
