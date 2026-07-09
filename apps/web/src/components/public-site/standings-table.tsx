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
  // Podium chips are fixed vocabulary (gold/silver/bronze) — deliberately NOT
  // org-themeable, so a red-branded org still reads gold as first place.
  const medal: Record<number, string> = {
    1: "bg-amber-300 text-amber-950",
    2: "bg-slate-300 text-slate-900",
    3: "bg-orange-300 text-orange-950",
  };
  // Fixed-size cell for every rank so podium chips and plain numbers line up.
  const rankChip = (rank: number | undefined) => (
    <span
      className={`inline-flex h-5 w-5 items-center justify-center rounded-full font-display text-[12px] font-bold ${
        rank && medal[rank] ? medal[rank] : "text-ink-muted"
      }`}
    >
      {rank}
    </span>
  );

  return (
    <div className="overflow-x-auto rounded-xl border border-zinc-200/80 bg-surface shadow-sm">
      <table className="w-full text-sm">
        {caption ? (
          <caption className="px-4 pb-1 pt-3 text-left font-display text-lg font-semibold text-ink">
            {caption}
          </caption>
        ) : null}
        <thead>
          <tr className="border-b border-zinc-200 text-left text-[11px] uppercase tracking-wider text-ink-muted">
            <th scope="col" className="w-12 py-2.5 pl-4 pr-2 font-semibold">#</th>
            <th scope="col" className="py-2.5 pr-3 font-semibold">Team</th>
            {columns.map((col) => (
              <th key={col.key} scope="col" className="px-2.5 py-2.5 text-right font-semibold last:pr-4">
                {col.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {ranked.map((row) => (
            <tr
              key={row.entrantId}
              className={`border-b border-zinc-100 last:border-0 ${
                row.rank === 1 ? "bg-amber-50/60" : ""
              }`}
            >
              <td className="py-2.5 pl-4 pr-2 tabular-nums">
                {row.tieBreak ? (
                  <details className="relative inline-block">
                    <summary className="inline-flex cursor-help list-none items-start whitespace-nowrap">
                      {rankChip(row.rank)}
                      <span className="text-[10px] text-accent">*</span>
                    </summary>
                    <p
                      role="tooltip"
                      className="absolute left-0 z-10 mt-1 w-56 rounded-lg border border-zinc-200 bg-surface p-2 text-xs text-zinc-700 shadow-lg"
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
              <th scope="row" className="py-2.5 pr-3 text-left font-medium text-ink">
                {entrantNames[row.entrantId] ?? row.entrantId}
              </th>
              {columns.map((col) => (
                <td
                  key={col.key}
                  className={`px-2.5 py-2.5 text-right tabular-nums last:pr-4 ${
                    col.key === "points"
                      ? "font-display text-base font-bold text-accent-strong"
                      : "text-zinc-600"
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
