"use client";

// "How this works →" (v3/06 §4): the format explainer as a slide-over, so
// organisers understand a format without leaving the wizard. Same gallery
// content as /help/formats/<family>, live example through the same
// format-preview endpoint the wizard already uses.
import Link from "@/components/ui/console-link";
import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { formatFamily, FormatDiagram } from "@/config/format-gallery";
import { FormatPreviewView } from "@/components/format-preview-view";
import type { PreviewPhase } from "@/server/usecases/stages";
import { apiV1 } from "@/lib/client-v1";

export function FormatExplainerPanel({
  familySlug,
  onClose,
}: {
  familySlug: string;
  onClose: () => void;
}) {
  const family = formatFamily(familySlug);
  const [phases, setPhases] = useState<PreviewPhase[] | null>(null);

  useEffect(() => {
    if (!family) return;
    let alive = true;
    apiV1<{ phases: PreviewPhase[] }>("/api/v1/format-preview", {
      method: "POST",
      json: { count: 8, stages: family.cannedStages },
    })
      .then((r) => {
        if (alive) setPhases(r.phases);
      })
      .catch(() => {
        if (alive) setPhases([]);
      });
    return () => {
      alive = false;
    };
  }, [family]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (!family) return null;

  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label={`How ${family.title} works`}>
      <button
        type="button"
        aria-label="Close explainer"
        onClick={onClose}
        className="absolute inset-0 bg-purple-950/30 backdrop-blur-sm"
      />
      <aside className="relative flex h-full w-full max-w-lg flex-col overflow-y-auto bg-white shadow-2xl">
        <div className="sticky top-0 flex items-start justify-between gap-3 border-b border-purple-100 bg-white/95 px-5 py-4 backdrop-blur">
          <div>
            <p className="font-mono text-[10px] uppercase tracking-[0.25em] text-purple-600">
              How this works
            </p>
            <h2 className="mt-0.5 font-display text-xl font-semibold text-slate-900">
              {family.title}
            </h2>
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="grid h-8 w-8 shrink-0 place-items-center rounded-md text-slate-400 transition hover:bg-purple-50 hover:text-purple-700"
          >
            <X className="h-4 w-4" strokeWidth={2} />
          </button>
        </div>

        <div className="space-y-5 px-5 py-5">
          <div className="rounded-2xl border border-purple-100 bg-purple-50/40 p-4">
            <FormatDiagram slug={family.slug} />
          </div>
          <p className="text-sm font-medium text-slate-800">{family.tagline}</p>
          {family.body.map((p, i) => (
            <p key={i} className="text-sm leading-relaxed text-slate-600">
              {p}
            </p>
          ))}
          <div className="rounded-xl bg-purple-50/60 p-3 text-sm text-slate-600">
            <span className="font-semibold text-slate-800">Trade-off: </span>
            {family.tradeoff}
          </div>

          <div>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-400">
              Live example — 8 entrants
            </h3>
            {phases === null ? (
              <p className="text-sm text-slate-400">Generating…</p>
            ) : (
              <FormatPreviewView phases={phases} />
            )}
          </div>

          <Link
            href={`/help/formats/${family.slug}`}
            target="_blank"
            className="inline-block text-sm font-medium text-purple-700 underline"
          >
            Full guide in the help centre →
          </Link>
        </div>
      </aside>
    </div>
  );
}
