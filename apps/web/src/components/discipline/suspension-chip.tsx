"use client";

// SPEC-1 entrant chip: a red card-glyph pill with the count of active
// suspensions among an entrant's members. Tapping it opens a popover naming
// names + matches left to serve. Console surface (organiser) — full names are
// fine here; public renderings pass consent-filtered names in.
import { useEffect, useRef, useState } from "react";
import { useMsg } from "@/components/i18n/dict-provider";
import { CardGlyph } from "./card-glyph";

export function SuspensionChip({
  suspensions,
}: {
  suspensions: { personName: string; remaining: number }[];
}) {
  const msg = useMsg();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);

  if (suspensions.length === 0) return null;

  return (
    <div ref={ref} className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={msg("disc.chip.aria", { n: suspensions.length })}
        data-testid="suspension-chip"
        className="inline-flex items-center gap-1 rounded-full bg-red-50 px-2 py-0.5 text-xs font-semibold text-red-600 ring-1 ring-inset ring-red-200 hover:bg-red-100"
      >
        <CardGlyph tone="red" className="h-3 w-2.5" />
        {suspensions.length}
      </button>
      {open && (
        <div className="card absolute right-0 z-20 mt-1 w-52 space-y-1 p-2 text-left shadow-lg">
          <p className="app-eyebrow text-slate-400">{msg("disc.chip.title")}</p>
          <ul className="space-y-1">
            {suspensions.map((s, i) => (
              <li key={i} className="flex items-center justify-between gap-2 text-xs text-slate-700">
                <span className="min-w-0 truncate">{s.personName}</span>
                <span className="shrink-0 text-slate-400">
                  {msg("disc.panel.remaining", { n: s.remaining })}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
