"use client";

import Link from "next/link";
import { useMemo, useRef, useState } from "react";
import type { PreviewPhase } from "@/server/usecases/stages";
import {
  MARKETING_FORMATS,
  MARKETING_FORMAT_LABELS,
  type MarketingFormat,
} from "@/lib/marketing/format-preview";
import { clubNames } from "@/lib/marketing/club-names";
import { DrawRenderer } from "./draw-renderer";

/** The Draw (design/v3/12 §4.4): the visitor's first real interaction. SSR
 *  passes the default groups-knockout/8 draw so the section works without JS;
 *  control changes hit the public preview API (response is the { ok, data }
 *  envelope from lib/http). */
export function TheDraw({ initialPhases }: { initialPhases: PreviewPhase[] }) {
  const [format, setFormat] = useState<MarketingFormat>("groups-knockout");
  const [entrants, setEntrants] = useState(8);
  const [seed, setSeed] = useState(1);
  const [phases, setPhases] = useState(initialPhases);
  const [busy, setBusy] = useState(false);
  const reqId = useRef(0);

  const names = useMemo(() => clubNames(entrants, seed), [entrants, seed]);

  async function load(nextFormat: MarketingFormat, nextEntrants: number) {
    const id = ++reqId.current;
    setBusy(true);
    try {
      const res = await fetch("/api/public/format-preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ format: nextFormat, entrants: nextEntrants }),
      });
      if (!res.ok) return; // keep the last good draw
      const json = (await res.json()) as { ok: boolean; data: { phases: PreviewPhase[] } };
      if (json.ok && id === reqId.current) setPhases(json.data.phases);
    } catch {
      // network hiccough: last good draw stays on screen
    } finally {
      if (id === reqId.current) setBusy(false);
    }
  }

  const pick = (f: MarketingFormat) => {
    setFormat(f);
    void load(f, entrants);
  };
  const step = (delta: number) => {
    const n = Math.min(Math.max(entrants + delta, 4), 16);
    if (n === entrants) return;
    setEntrants(n);
    void load(format, n);
  };

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div
          role="radiogroup"
          aria-label="Format"
          className="flex flex-wrap rounded-xl border border-purple-200 bg-white p-1"
        >
          {MARKETING_FORMATS.map((f) => (
            <button
              key={f}
              role="radio"
              aria-checked={format === f}
              onClick={() => pick(f)}
              className={`mk-display rounded-lg px-3 py-1.5 text-sm font-semibold ${
                format === f ? "bg-[var(--mk-purple)] text-white" : "text-slate-600 hover:bg-purple-50"
              }`}
            >
              {MARKETING_FORMAT_LABELS[f]}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center rounded-xl border border-purple-200 bg-white">
            <button
              aria-label="Fewer entrants"
              onClick={() => step(-1)}
              className="px-3 py-1.5 text-lg text-purple-600"
            >
              −
            </button>
            <span aria-live="polite" className="mk-display w-16 text-center text-sm font-semibold text-slate-800">
              {entrants} teams
            </span>
            <button
              aria-label="More entrants"
              onClick={() => step(1)}
              className="px-3 py-1.5 text-lg text-purple-600"
            >
              +
            </button>
          </div>
          <button onClick={() => setSeed((s) => s + 1)} className="btn btn-ghost text-sm">
            ⟳ Shuffle names
          </button>
        </div>
      </div>

      <div aria-busy={busy}>
        <DrawRenderer phases={phases} names={names} />
      </div>

      <p className="mt-8 text-center">
        <Link
          data-testid="make-it-real"
          href={`/start?sport=Badminton&entrants=${entrants}&format=${format}`}
          className="btn btn-primary px-6 py-2.5 text-base"
        >
          Make it real →
        </Link>
      </p>
    </div>
  );
}
