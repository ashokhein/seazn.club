"use client";

// SPEC-1 design direction: served progress is match PIPS, never a percent bar.
// One pip per match of the ban, filled once served (● ● ○). Reuses the scorebug
// dot idiom. The pips are decorative; the container carries an accessible label
// ("2 of 3 matches served") so screen readers get the count, not a row of dots.
import { useMsg } from "@/components/i18n/dict-provider";

export function ServePips({
  served,
  total,
  className = "",
}: {
  served: number;
  total: number;
  className?: string;
}) {
  const msg = useMsg();
  const filled = Math.max(0, Math.min(served, total));
  return (
    <span
      role="img"
      aria-label={msg("disc.pips.label", { served: filled, total })}
      className={`inline-flex items-center gap-1 ${className}`}
    >
      {Array.from({ length: total }, (_, i) => (
        <span
          key={i}
          aria-hidden
          data-filled={i < filled ? "1" : "0"}
          className={`h-2 w-2 rounded-full ${i < filled ? "bg-lime-400" : "bg-slate-600 ring-1 ring-inset ring-slate-500"}`}
        />
      ))}
    </span>
  );
}
