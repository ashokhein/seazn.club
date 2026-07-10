// EntityCard (v3/03 §1) — the match-day card, v3's signature primitive.
// Broadcast-scorebug anatomy: glyph · name · status chip / meta line /
// "what's next" line / progress meter, with a 3px division-hue left border
// for cross-page wayfinding. Server-safe: interactivity (⋯ menu, view
// toggle) comes in as client children.
import Link from "next/link";
import type { ReactNode } from "react";
import { msg } from "@/lib/messages";

export function EntityCard({
  href,
  glyph,
  name,
  chip,
  meta,
  next,
  progress,
  accent,
  menu,
}: {
  href: string;
  /** Sport emoji / logo block, ~20px. */
  glyph?: ReactNode;
  name: string;
  chip: ReactNode;
  /** Format · capacity line, e.g. "Knockout · 14/16 entrants". */
  meta?: string | null;
  /** "Next: Arun vs Dev · Court 2 · 14:30" — null renders the quiet fallback. */
  next?: string | null;
  progress?: { played: number; total: number } | null;
  /** Division hue border color; omit for competition cards (violet hairline). */
  accent?: string;
  /** Client overflow menu; rendered above the stretched link. */
  menu?: ReactNode;
}) {
  return (
    <article
      className="ecard group relative rounded-xl border border-slate-200 bg-white p-4 shadow-sm transition hover:border-purple-300 hover:shadow"
      style={accent ? { borderLeft: `3px solid ${accent}` } : undefined}
    >
      <div className="flex items-start gap-2">
        {glyph && (
          <span aria-hidden className="mt-px shrink-0 text-base leading-5">
            {glyph}
          </span>
        )}
        {/* Stretched link: the whole card is the target, the name is the label. */}
        <h3 className="min-w-0 flex-1 text-sm font-semibold text-slate-800 group-hover:text-purple-700">
          <Link href={href} className="after:absolute after:inset-0 focus-visible:outline-none">
            <span className="block truncate">{name}</span>
          </Link>
        </h3>
        {chip}
        {menu && <span className="relative z-10 -my-1 shrink-0">{menu}</span>}
      </div>
      {meta && <p className="ecard-meta mt-1 truncate text-xs text-slate-500">{meta}</p>}
      <p className="ecard-next mt-2 truncate text-xs text-slate-600">
        {next ? (
          <>
            <span className="font-medium text-purple-700">Next:</span> {next}
          </>
        ) : (
          <span className="text-slate-500">{msg("card.next.none")}</span>
        )}
      </p>
      <div className="ecard-progress mt-2">
        {progress && progress.total > 0 ? (
          <div className="flex items-center gap-2">
            <span
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={progress.total}
              aria-valuenow={progress.played}
              aria-label={`${progress.played} of ${progress.total} played`}
              className="h-1 w-16 shrink-0 overflow-hidden rounded-full bg-slate-100"
            >
              <span
                className="block h-full rounded-full"
                style={{
                  width: `${Math.round((progress.played / progress.total) * 100)}%`,
                  background: accent ?? "#7c3aed",
                }}
              />
            </span>
            <span className="text-[11px] tabular-nums text-slate-500">
              {progress.played} of {progress.total} played
            </span>
          </div>
        ) : (
          <span className="text-[11px] text-slate-500">{msg("card.progress.none")}</span>
        )}
      </div>
    </article>
  );
}
