"use client";

// Recommendation strip (v3/06 §4): entrants + courts + hours → the 2–3
// formats that fit, each with its one-sentence trade-off. Pure function
// (lib/format-recommend), recomputed as the inputs change; picking one
// selects the matching template in the wizard.
import { useMemo, useState } from "react";
import { Lightbulb } from "lucide-react";
import { recommendFormats } from "@/lib/format-recommend";
import { useMsg } from "@/components/i18n/dict-provider";

export function FormatRecommendStrip({
  initialEntrants = 16,
  onPick,
}: {
  initialEntrants?: number;
  /** Gallery family slug → wizard template selection. */
  onPick?: (familySlug: string) => void;
}) {
  const msg = useMsg();
  const [entrants, setEntrants] = useState(initialEntrants);
  const [courts, setCourts] = useState(2);
  const [hours, setHours] = useState(4);

  const picks = useMemo(
    () => recommendFormats({ entrants, courts, hours }),
    [entrants, courts, hours],
  );

  const num = (v: string, lo: number, hi: number, fallback: number) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
  };

  return (
    <div className="rounded-xl border border-purple-100 bg-purple-50/40 p-4">
      <p className="flex items-center gap-1.5 text-sm font-medium text-slate-800">
        <Lightbulb className="h-4 w-4 text-purple-500" strokeWidth={1.75} />
        {msg("recommend.title")}
      </p>
      <div className="mt-2 flex flex-wrap items-end gap-3 text-sm">
        <label className="block">
          <span className="label">{msg("recommend.entrants")}</span>
          <input
            type="number" min={2} max={64} value={entrants}
            onChange={(e) => setEntrants(num(e.target.value, 2, 64, 16))}
            className="input w-20"
          />
        </label>
        <label className="block">
          <span className="label">{msg("recommend.courts")}</span>
          <input
            type="number" min={1} max={20} value={courts}
            onChange={(e) => setCourts(num(e.target.value, 1, 20, 2))}
            className="input w-20"
          />
        </label>
        <label className="block">
          <span className="label">{msg("recommend.hours")}</span>
          <input
            type="number" min={1} max={72} value={hours}
            onChange={(e) => setHours(num(e.target.value, 1, 72, 4))}
            className="input w-20"
          />
        </label>
      </div>
      <ol className="mt-3 space-y-1.5">
        {picks.map((p, i) => (
          <li key={p.slug}>
            <button
              type="button"
              onClick={() => onPick?.(p.slug)}
              className="group flex w-full items-baseline gap-2 rounded-lg px-2 py-1.5 text-left transition hover:bg-white"
            >
              <span className="shrink-0 font-mono text-xs text-purple-500">{i + 1}.</span>
              <span className="text-sm">
                <span className="font-semibold text-slate-800 group-hover:text-purple-800">
                  {p.title}
                </span>{" "}
                <span className="text-slate-500">{p.reason}</span>
              </span>
            </button>
          </li>
        ))}
      </ol>
    </div>
  );
}
