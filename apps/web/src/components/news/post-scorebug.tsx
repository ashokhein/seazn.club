// SPEC-2 signature element (PROMPT-83): a result post IS a scorebug. This one
// component feeds BOTH the feed card (size="card") and the post hero
// (size="hero") — the scoreline in huge condensed tabular numerals with the two
// crests, the exact live-wall grammar. A missing crest falls back to a monogram
// (never a grey placeholder). Pure/server-renderable (no client hooks): the one
// motion moment — digits settling on post-page load — is CSS only
// (`news-digit-settle`, disabled under prefers-reduced-motion in globals.css),
// switched on by the `animate` prop the post hero passes.
//
// SECURITY: `crest` is ALWAYS a pre-resolved public-storage URL (entrant badge
// via resolveEntrantBadge / publicStorageUrl) — callers never pass raw org
// input here, so the <img src> can't carry arbitrary/external/data: values.
import { crestMonogram, type EyebrowTone } from "@/lib/news-presentation";

const TONE_CLASS: Record<EyebrowTone, string> = {
  lime: "text-[#a3e635]", // pitch-line lime
  white: "text-court-ink",
  red: "text-[#ef4444]", // red-ball
  muted: "text-court-muted",
};

export interface ScorebugSide {
  name: string;
  crest?: string | null;
}

function Crest({ side, hero, align }: { side: ScorebugSide; hero: boolean; align: "start" | "end" }) {
  const box = hero ? "h-14 w-14 sm:h-16 sm:w-16 text-base" : "h-9 w-9 text-xs";
  return (
    <div
      className={`flex min-w-0 flex-col items-center gap-1.5 ${
        align === "start" ? "sm:items-start" : "sm:items-end"
      }`}
    >
      {side.crest ? (
        // eslint-disable-next-line @next/next/no-img-element -- resolved tenant crest (public storage URL)
        <img
          src={side.crest}
          alt=""
          className={`${box} shrink-0 rounded-full bg-white/10 object-cover`}
        />
      ) : (
        <span
          aria-hidden
          data-testid="crest-monogram"
          className={`${box} grid shrink-0 place-items-center rounded-full bg-accent font-display font-bold text-accent-ink`}
        >
          {crestMonogram(side.name)}
        </span>
      )}
      <span className="max-w-full truncate text-center text-[11px] font-medium uppercase tracking-wide text-court-muted">
        {side.name}
      </span>
    </div>
  );
}

export function PostScorebug({
  eyebrow,
  tone,
  home,
  away,
  homeScore,
  awayScore,
  size = "card",
  animate = false,
}: {
  /** Resolved kind label (page localizes it via the public dict). */
  eyebrow: string;
  tone: EyebrowTone;
  home: ScorebugSide;
  away: ScorebugSide;
  homeScore: string;
  awayScore: string;
  size?: "card" | "hero";
  /** Hero only: settle the digits on load (CSS, reduced-motion honored). */
  animate?: boolean;
}) {
  const hero = size === "hero";
  const digit = animate ? "news-digit-settle" : undefined;
  return (
    <div
      data-testid="post-scorebug"
      data-size={size}
      className={`relative flex flex-col overflow-hidden rounded-2xl bg-court text-court-ink ${
        hero ? "p-6 sm:p-8" : "p-4"
      }`}
    >
      <span aria-hidden className="absolute inset-x-0 top-0 h-1 bg-accent" />
      <span className={`text-[11px] font-semibold uppercase tracking-[0.22em] ${TONE_CLASS[tone]}`}>
        {eyebrow}
      </span>
      <div
        className={`mt-3 grid grid-cols-[1fr_auto_1fr] items-center ${hero ? "gap-3 sm:gap-6" : "gap-2"}`}
      >
        <Crest side={home} hero={hero} align="start" />
        <div
          data-testid="scoreline"
          className={`flex items-baseline justify-center gap-2 font-display font-bold leading-none tabular-nums ${
            hero ? "text-6xl sm:text-7xl" : "text-4xl"
          }`}
        >
          <span className={digit}>{homeScore}</span>
          <span aria-hidden className="text-court-muted">
            –
          </span>
          <span className={digit}>{awayScore}</span>
        </div>
        <Crest side={away} hero={hero} align="end" />
      </div>
    </div>
  );
}
