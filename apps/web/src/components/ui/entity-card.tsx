// EntityCard (v3/03 §1) — the match-day card, v3's signature primitive.
// Broadcast-scorebug anatomy: glyph · name · status chip / meta line /
// "what's next" line / progress meter, with a 3px division-hue left border
// for cross-page wayfinding. Server-safe: interactivity (⋯ menu, view
// toggle) comes in as client children.
//
// v8: optional media identity — competitions wear a sport-tinted banner
// strip, divisions a 56px logo-or-monogram tile. Anatomy below is unchanged.
import Link from "@/components/ui/console-link";
import type { ReactNode } from "react";
import { msgFor } from "@/lib/messages-i18n";
import type { Locale } from "@/lib/i18n-constants";

export type CardMedia =
  | { kind: "banner"; emoji: string; tint: string }
  | { kind: "tile"; logoUrl: string | null; monogram: string; hue: string };

function MediaTile({ media }: { media: Extract<CardMedia, { kind: "tile" }> }) {
  return (
    <span
      aria-hidden
      data-testid="card-tile"
      className="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-lg"
      style={
        media.logoUrl
          ? undefined
          : { backgroundColor: `color-mix(in srgb, ${media.hue} 15%, white)`, color: media.hue }
      }
    >
      {media.logoUrl ? (
        // eslint-disable-next-line @next/next/no-img-element -- tenant-uploaded logo, remotePatterns unknown at build
        <img src={media.logoUrl} alt="" className="h-full w-full object-cover" />
      ) : (
        <span className="text-xl font-bold">{media.monogram}</span>
      )}
    </span>
  );
}

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
  media,
  locale = "en",
}: {
  href: string;
  /** Sport emoji / logo block, ~20px. Ignored when `media` is present. */
  glyph?: ReactNode;
  name: string;
  chip: ReactNode;
  /** Format · capacity line, e.g. "Knockout · 14/16 entrants". */
  meta?: string | null;
  /** "Arun vs Dev · Court 2 · 14:30" + whether it's live right now — null
   *  renders the quiet fallback. The "Next:"/"Now:" label is chosen and
   *  localized here, not baked into the string (see NextLine). */
  next?: { text: string; live: boolean } | null;
  progress?: { played: number; total: number } | null;
  /** Division hue border color; omit for competition cards (violet hairline). */
  accent?: string;
  /** Client overflow menu; rendered above the stretched link. */
  menu?: ReactNode;
  /** v8 identity: sport banner (competitions) or logo/monogram tile (divisions). */
  media?: CardMedia;
  /** Active locale for the built-in fallback copy; server callers pass it. */
  locale?: Locale;
}) {
  const banner = media?.kind === "banner" ? media : null;
  const tile = media?.kind === "tile" ? media : null;

  const body = (
    <div className={tile ? "min-w-0 flex-1" : undefined}>
      <div className="flex items-start gap-2">
        {!media && glyph && (
          <span aria-hidden className="mt-px shrink-0 text-base leading-5">
            {glyph}
          </span>
        )}
        {/* Stretched link: the whole card is the target, the name is the label. */}
        <h3 className="min-w-0 flex-1 text-sm font-semibold text-slate-800 group-hover:text-purple-700">
          <Link href={href} className="after:absolute after:inset-0 focus-visible:outline-none">
            <span className="block truncate" title={name}>{name}</span>
          </Link>
        </h3>
        {chip}
        {menu && <span className="relative z-10 -my-1 shrink-0">{menu}</span>}
      </div>
      {meta && <p className="ecard-meta mt-1 truncate text-xs text-slate-500" title={meta}>{meta}</p>}
      <p
        className="ecard-next mt-2 truncate text-xs text-slate-600"
        title={next ? next.text : undefined}
      >
        {next ? (
          <>
            <span className="font-medium text-purple-700">
              {msgFor(locale, next.live ? "card.next.live" : "card.next.upcoming")}
            </span>{" "}
            {next.text}
          </>
        ) : (
          <span className="text-slate-500">{msgFor(locale, "card.next.none")}</span>
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
              aria-label={msgFor(locale, "card.progress.played", {
                played: progress.played,
                total: progress.total,
              })}
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
              {msgFor(locale, "card.progress.played", {
                played: progress.played,
                total: progress.total,
              })}
            </span>
          </div>
        ) : (
          <span className="text-[11px] text-slate-500">{msgFor(locale, "card.progress.none")}</span>
        )}
      </div>
    </div>
  );

  return (
    <article
      className={`ecard group relative rounded-xl border border-slate-200 bg-white shadow-sm transition hover:border-purple-300 hover:shadow ${
        banner ? "" : "p-4"
      }`}
      style={accent ? { borderLeft: `3px solid ${accent}` } : undefined}
    >
      {banner && (
        <div
          aria-hidden
          data-testid="card-banner"
          // The rounding clip lives HERE, not on the article. `overflow-hidden`
          // up there also clipped the ⋯ menu, which opens downward and out of
          // the card — only the first two of its items were ever reachable on a
          // competition card. Nothing else needs the article to clip.
          className="flex h-12 items-center overflow-hidden rounded-t-xl px-4 sm:h-16"
          style={{
            background: `linear-gradient(135deg, ${banner.tint}33 0%, ${banner.tint}0a 70%, transparent)`,
          }}
        >
          <span className="text-3xl motion-safe:transition-transform motion-safe:group-hover:scale-105">
            {banner.emoji}
          </span>
        </div>
      )}
      {banner ? (
        <div className="p-4 pt-3">{body}</div>
      ) : tile ? (
        <div className="flex gap-3">
          <MediaTile media={tile} />
          {body}
        </div>
      ) : (
        body
      )}
    </article>
  );
}
