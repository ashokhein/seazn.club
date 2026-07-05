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

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        {caption ? <caption className="pb-2 text-left font-medium">{caption}</caption> : null}
        <thead>
          <tr className="border-b border-zinc-200 text-left text-xs uppercase tracking-wide text-zinc-500">
            <th scope="col" className="py-2 pr-2 font-medium">#</th>
            <th scope="col" className="py-2 pr-3 font-medium">Team</th>
            {columns.map((col) => (
              <th key={col.key} scope="col" className="py-2 px-2 text-right font-medium">
                {col.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {ranked.map((row) => (
            <tr key={row.entrantId} className="border-b border-zinc-100">
              <td className="py-2 pr-2 tabular-nums text-zinc-500">
                {row.tieBreak ? (
                  <details className="relative inline-block">
                    <summary className="cursor-help list-none underline decoration-dotted underline-offset-2">
                      {row.rank}
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
                  row.rank
                )}
              </td>
              <th scope="row" className="py-2 pr-3 text-left font-medium">
                {entrantNames[row.entrantId] ?? row.entrantId}
              </th>
              {columns.map((col) => (
                <td key={col.key} className="py-2 px-2 text-right tabular-nums">
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
