"use client";

// SPEC-3: the average renders as a scorebug chip — a big Barlow Condensed
// numeral over a small `avg · n` label, on a night tile (scoreboard vernacular,
// same family as the mark tiles). Pure + hook-free apart from the dict lookup,
// so it renders identically on the dark /me lane header and a light console
// card. Callers only mount it when there is a real average to show (the
// official-facing "collecting marks" copy below the ≥3 threshold is the lane's
// job, D4).
import { useMsg } from "@/components/i18n/dict-provider";

/** One-decimal average, e.g. 4.17 → "4.2", 5 → "5.0". */
export function formatAverage(average: number): string {
  return average.toFixed(1);
}

export function MarkBadge({
  average,
  count,
  className = "",
}: {
  average: number;
  count: number;
  className?: string;
}) {
  const msg = useMsg();
  return (
    <span
      data-testid="mark-badge"
      className={`inline-flex items-center gap-2 rounded-lg bg-slate-900 px-3 py-1.5 shadow-sm ${className}`}
    >
      <span className="app-display text-2xl font-bold leading-none tabular-nums text-lime-400">
        {formatAverage(average)}
      </span>
      <span className="text-[11px] font-medium uppercase tracking-wide text-cream/60">
        {msg("marks.badge.label", { count })}
      </span>
    </span>
  );
}
