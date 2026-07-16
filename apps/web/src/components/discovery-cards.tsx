// Discovery showcase cards & strips (doc 15 §2, PROMPT-19). Server-rendered
// presentational components shared by the home page, /discover and the
// per-sport pages. Everything here renders public_discovery_v data only —
// no person data ever reaches these props.
import Link from "next/link";
import type { DiscoveryEntry, DiscoveryLiveFixture } from "@/server/public-site/discovery";
import { t, type Dict } from "@/lib/i18n";
import type { Locale } from "@/lib/i18n-constants";

export const SPORT_EMOJI: Record<string, string> = {
  football: "⚽",
  cricket: "🏏",
  volleyball: "🏐",
  badminton: "🏸",
  tabletennis: "🏓",
  boardgame: "♟️",
  carrom: "🎯",
  generic: "🏅",
};

export function sportEmoji(key: string | null | undefined): string {
  return SPORT_EMOJI[key ?? "generic"] ?? "🏅";
}

function formatDates(startsOn: string | null, endsOn: string | null, lang: Locale): string | null {
  if (!startsOn) return null;
  const fmt = (d: string) =>
    new Date(`${d}T00:00:00Z`).toLocaleDateString(lang, {
      day: "numeric",
      month: "short",
      timeZone: "UTC",
    });
  return endsOn && endsOn !== startsOn ? `${fmt(startsOn)} – ${fmt(endsOn)}` : fmt(startsOn);
}

/** schema.org SportsEvent markup for a directory entry (doc 15 §2 SEO). */
function jsonLd(entry: DiscoveryEntry): string {
  return JSON.stringify({
    "@context": "https://schema.org",
    "@type": "SportsEvent",
    name: entry.name,
    ...(entry.starts_on ? { startDate: entry.starts_on } : {}),
    ...(entry.ends_on ? { endDate: entry.ends_on } : {}),
    ...(entry.city || entry.country
      ? {
          location: {
            "@type": "Place",
            name: [entry.city, entry.country].filter(Boolean).join(", "),
          },
        }
      : {}),
    organizer: { "@type": "Organization", name: entry.org_name },
    url: `https://seazn.club/shared/${entry.org_slug}/${entry.slug}`,
  });
}

/** "Live right now" strip (doc 15 §2) — renders nothing when empty. */
export function LiveNowStrip({
  fixtures,
  dict,
}: {
  fixtures: DiscoveryLiveFixture[];
  dict: Dict;
}) {
  if (fixtures.length === 0) return null;
  return (
    <section className="border-y border-purple-100 bg-white py-8">
      <div className="mx-auto max-w-5xl px-4">
        <h2 className="mb-4 flex items-center gap-2 text-lg font-bold text-purple-900">
          <span className="relative flex h-2.5 w-2.5">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-400 opacity-75" />
            <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-red-500" />
          </span>
          {t(dict, "discovery.liveNow")}
        </h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {fixtures.map((f) => (
            <Link
              key={f.id}
              href={`/shared/${f.org_slug}/${f.comp_slug}/${f.division_slug}/fixtures/${f.id}`}
              className="card block p-4 transition hover:border-purple-300 hover:shadow-md"
            >
              <p className="mb-1 flex items-center gap-2 text-xs text-slate-500">
                <span>{sportEmoji(f.sport_key)}</span>
                <span className="truncate">{f.competition_name}</span>
              </p>
              <p className="truncate text-sm font-semibold text-slate-800">
                {f.headline ?? t(dict, "discovery.inPlay")}
              </p>
            </Link>
          ))}
        </div>
      </div>
    </section>
  );
}

/** Discovery competition card (home "this week", /discover directory). */
export function DiscoveryCard({
  entry,
  dict,
  lang,
  withJsonLd = false,
}: {
  entry: DiscoveryEntry;
  dict: Dict;
  lang: Locale;
  withJsonLd?: boolean;
}) {
  const dates = formatDates(entry.starts_on, entry.ends_on, lang);
  const location = [entry.city, entry.country].filter(Boolean).join(", ");
  return (
    <Link
      href={`/shared/${entry.org_slug}/${entry.slug}`}
      className="card relative block overflow-hidden p-5 transition hover:border-purple-300 hover:shadow-md"
    >
      {withJsonLd && (
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd(entry) }} />
      )}
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-2xl">{sportEmoji(entry.sports?.[0])}</span>
        <span className="flex items-center gap-1">
          {entry.in_play_count > 0 && (
            <span className="rounded-full bg-red-100 px-2 py-0.5 text-[10px] font-semibold uppercase text-red-600">
              {t(dict, "discovery.badge.live")}
            </span>
          )}
          {entry.featured && (
            <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold uppercase text-amber-700">
              {t(dict, "discovery.badge.featured")}
            </span>
          )}
        </span>
      </div>
      <h3 className="truncate font-semibold text-slate-800">{entry.name}</h3>
      {/* tagline/hero only arrive from the view with `discovery.branding`. */}
      {entry.tagline && <p className="mt-0.5 truncate text-xs text-slate-500">{entry.tagline}</p>}
      <p className="mt-1 truncate text-xs text-slate-400">{t(dict, "discovery.by", { org: entry.org_name })}</p>
      <p className="mt-2 flex flex-wrap gap-x-3 text-xs text-slate-500">
        {dates && <span>📅 {dates}</span>}
        {location && <span>📍 {location}</span>}
        {entry.entrant_count > 0 && <span>👥 {entry.entrant_count}</span>}
      </p>
    </Link>
  );
}

/** "Happening this week" section (doc 15 §2) — renders nothing when empty. */
export function ThisWeekSection({
  entries,
  dict,
  lang,
}: {
  entries: DiscoveryEntry[];
  dict: Dict;
  lang: Locale;
}) {
  if (entries.length === 0) return null;
  return (
    <section className="mx-auto max-w-5xl px-4 py-12">
      <div className="mb-4 flex items-baseline justify-between">
        <h2 className="text-lg font-bold text-purple-900">{t(dict, "discovery.thisWeek")}</h2>
        <Link href={`/${lang}/discover`} className="text-sm text-purple-600 hover:underline">
          {t(dict, "discovery.exploreAll")}
        </Link>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {entries.map((e) => (
          <DiscoveryCard key={e.id} entry={e} dict={dict} lang={lang} />
        ))}
      </div>
    </section>
  );
}
