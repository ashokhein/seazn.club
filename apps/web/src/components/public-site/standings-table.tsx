// Server component: MetricSpec-driven standings table (doc 09 §2 — zero
// per-sport table code). Tie explanations render as a <details> popover from
// the snapshot's tieBreak trace: no client JS.
import {
  DERIVED_METRICS,
  derivedMetricText,
  tieBreakLabel,
  type StandingsRow,
} from "@seazn/engine/competition";
import type { TiebreakerKey } from "@seazn/engine/sport";
import {
  standingsColumns,
  formatMetric,
  type MetricSpecLike,
} from "@/lib/public-site";

interface Props {
  rows: StandingsRow[];
  metricSpecs: MetricSpecLike[];
  cascade: readonly string[];
  entrantNames: Record<string, string>;
  caption?: string;
}

export function StandingsTable({ rows, metricSpecs, cascade, entrantNames, caption }: Props) {
  const columns = standingsColumns(metricSpecs, cascade, rows, DERIVED_METRICS);
  const ranked = [...rows].sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99));
  // Small medal chips for the podium ranks — quick visual anchor on long tables.
  const medal: Record<number, string> = {
    1: "bg-amber-300 text-amber-950",
    2: "bg-slate-300 text-slate-900",
    3: "bg-orange-300 text-orange-950",
  };
  // Fixed-size cell for every rank so podium chips and plain numbers line up.
  const rankChip = (rank: number | undefined) => (
    <span
      className={`inline-flex h-5 w-5 items-center justify-center rounded-full text-[11px] font-bold ${
        rank && medal[rank] ? medal[rank] : "font-normal text-zinc-500"
      }`}
    >
      {rank}
    </span>
  );

  return (
    <div className="overflow-x-auto rounded-xl border border-purple-100 bg-white p-3 shadow-sm">
      <table className="w-full text-sm">
        {caption ? (
          <caption className="px-1 pb-3 pt-1 text-left text-base font-semibold text-zinc-800">
            {caption}
          </caption>
        ) : null}
        <thead>
          <tr className="border-b border-purple-100 text-left text-xs uppercase tracking-wide text-purple-700/70">
            <th scope="col" className="w-10 py-2 pr-2 font-semibold">#</th>
            <th scope="col" className="py-2 pr-3 font-semibold">Team</th>
            {columns.map((col) => (
              <th key={col.key} scope="col" className="py-2 px-2 text-right font-semibold">
                {col.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {ranked.map((row) => (
            <tr
              key={row.entrantId}
              className={`border-b border-purple-50 last:border-0 ${
                row.rank === 1 ? "bg-amber-50/60" : ""
              }`}
            >
              <td className="py-2 pr-2 tabular-nums text-zinc-500">
                {row.tieBreak ? (
                  <details className="relative inline-block">
                    <summary className="cursor-help list-none">
                      {rankChip(row.rank)}
                      <span className="align-super text-[10px] text-purple-400">*</span>
                    </summary>
                    <p
                      role="tooltip"
                      className="absolute left-0 z-10 mt-1 w-56 rounded border border-zinc-200 bg-white p-2 text-xs text-zinc-700 shadow-lg"
                    >
                      Level with{" "}
                      {row.tieBreak.with
                        .map((id) => entrantNames[id] ?? "another entrant")
                        .join(", ")}{" "}
                      — separated on <strong>{tieBreakLabel(row.tieBreak.key)}</strong>.
                    </p>
                  </details>
                ) : (
                  rankChip(row.rank)
                )}
              </td>
              <th scope="row" className="py-2 pr-3 text-left font-medium">
                {entrantNames[row.entrantId] ?? row.entrantId}
              </th>
              {columns.map((col) => (
                <td
                  key={col.key}
                  className={`py-2 px-2 text-right tabular-nums ${
                    col.key === "points" ? "font-bold text-purple-700" : ""
                  }`}
                >
                  {col.kind === "derived"
                    ? (derivedMetricText(row, col.key as TiebreakerKey) ?? "—")
                    : col.kind === "structural"
                      ? formatMetric(row[col.key as "played" | "won" | "drawn" | "lost" | "points"])
                      : formatMetric(row.metrics[col.key], col.decimals)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
