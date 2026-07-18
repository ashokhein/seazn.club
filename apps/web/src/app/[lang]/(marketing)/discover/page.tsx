// /discover — the public tournament directory (doc 15 §2, PROMPT-19).
// Server Component on public_discovery_v only, cached under the `discovery`
// ISR tag. Filters travel as query params so the page stays cacheable per
// filter combination.
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { MarketingShell } from "@/components/marketing/marketing-shell";
import {
  getDiscoveryDirectory,
  listDiscoverySports,
} from "@/server/public-site/discovery";
import { DiscoveryCard, sportEmoji } from "@/components/discovery-cards";
import { getDictionary, t } from "@/lib/i18n";
import { plural } from "@/lib/i18n-runtime";
import { hasLocale } from "@/lib/i18n-constants";
import { sportLabel } from "@/lib/scoring-vocab";
import { msgFor } from "@/lib/messages-i18n";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ lang: string }>;
}): Promise<Metadata> {
  const { lang } = await params;
  if (!hasLocale(lang)) return {};
  const d = await getDictionary(lang, "marketing");
  return {
    title: t(d, "discover.meta.title"),
    description: t(d, "discover.meta.description"),
    alternates: {
      canonical: `/${lang}/discover`,
      languages: {
        ...Object.fromEntries(["en", "fr", "es", "nl"].map((l) => [l, `/${l}/discover`])),
        "x-default": "/en/discover",
      },
    },
  };
}

interface SearchParams {
  sport?: string;
  country?: string;
  status?: string;
  q?: string;
}

export default async function DiscoverPage({
  params,
  searchParams,
}: {
  params: Promise<{ lang: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const { lang } = await params;
  if (!hasLocale(lang)) notFound();
  const sp = await searchParams;
  const status: "live" | "upcoming" | undefined =
    sp.status === "live" || sp.status === "upcoming" ? sp.status : undefined;
  const filters = {
    sport: sp.sport || undefined,
    country: sp.country || undefined,
    status,
    q: sp.q || undefined,
  };
  const [d, entries, sports] = await Promise.all([
    getDictionary(lang, "marketing"),
    getDiscoveryDirectory(filters).catch(() => []),
    listDiscoverySports().catch(() => []),
  ]);

  return (
    <>
      <MarketingShell lang={lang}>
      <main className="mx-auto max-w-5xl px-4 py-12">
        <h1 className="mk-display text-4xl font-bold text-purple-950">
          {t(d, "discover.h1")}
        </h1>
        <p className="mt-2 max-w-xl text-slate-600">
          {t(d, "discover.subhead")}
        </p>
        {entries.length > 0 && (
          <p className="mt-2 flex items-center gap-2 text-sm font-semibold text-purple-700">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-400 opacity-75" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-red-500" />
            </span>
            {plural(
              d,
              "discover.liveCount",
              new Set(
                entries.filter((e) => e.in_play_count > 0).map((e) => e.org_slug),
              ).size,
              lang,
            )}
          </p>
        )}

        {/* Sport chips + status filter (plain links — cacheable). */}
        <div className="mt-6 flex flex-wrap items-center gap-2">
          <FilterChip href={`/${lang}/discover`} active={!filters.sport && !status} label={t(d, "discover.filter.all")} />
          {sports.map((s) => (
            <FilterChip
              key={s.key}
              href={`/${lang}/discover/${s.key}`}
              active={filters.sport === s.key}
              label={`${sportEmoji(s.key)} ${sportLabel(s.key, (k) => msgFor(lang, k))}`}
            />
          ))}
          <span className="mx-2 hidden h-4 w-px bg-slate-200 sm:block" />
          <FilterChip
            href={withParam(lang, filters, "status", "live")}
            active={status === "live"}
            label={t(d, "discover.filter.live")}
          />
          <FilterChip
            href={withParam(lang, filters, "status", "upcoming")}
            active={status === "upcoming"}
            label={t(d, "discover.filter.upcoming")}
          />
        </div>

        {/* Search (GET form — lands back here with ?q=). */}
        <form method="get" action={`/${lang}/discover`} className="mt-4 flex max-w-md gap-2">
          {filters.sport && <input type="hidden" name="sport" value={filters.sport} />}
          <input
            type="search"
            name="q"
            defaultValue={filters.q ?? ""}
            placeholder={t(d, "discover.searchPlaceholder")}
            className="input flex-1"
          />
          <button type="submit" className="btn btn-primary">
            {t(d, "discover.searchButton")}
          </button>
        </form>

        {entries.length === 0 ? (
          <div className="mt-16 text-center">
            <p className="text-slate-500">{t(d, "discover.empty")}</p>
            <Link
              href={`/${lang}/start?utm_source=discover&utm_medium=directory&utm_campaign=plg`}
              className="btn btn-primary mt-4 inline-flex"
            >
              {t(d, "discover.runYourOwn")} →
            </Link>
          </div>
        ) : (
          <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {entries.map((e) => (
              <DiscoveryCard key={e.id} entry={e} dict={d} lang={lang} withJsonLd />
            ))}
          </div>
        )}

        {/* Acquisition loop (doc 15): spectator → organiser. */}
        <section className="mt-16 rounded-xl bg-purple-900 p-8 text-center text-white">
          <h2 className="text-xl font-bold">{t(d, "discover.cta.title")}</h2>
          <p className="mt-1 text-sm text-purple-200">
            {t(d, "discover.cta.body")}
          </p>
          <Link
            href={`/${lang}/start?utm_source=discover&utm_medium=directory&utm_campaign=plg`}
            className="btn mt-4 inline-flex bg-white px-6 font-semibold text-purple-900 hover:bg-purple-50"
          >
            {t(d, "discover.cta.button")} →
          </Link>
        </section>
      </main>
      </MarketingShell>
    </>
  );
}

function withParam(lang: string, filters: SearchParams, key: string, value: string): string {
  const p = new URLSearchParams();
  if (filters.sport) p.set("sport", filters.sport);
  if (filters.q) p.set("q", filters.q);
  if (filters.country) p.set("country", filters.country);
  if (filters.status === value) p.delete(key);
  else p.set(key, value);
  const qs = p.toString();
  return qs ? `/${lang}/discover?${qs}` : `/${lang}/discover`;
}

function FilterChip({ href, active, label }: { href: string; active: boolean; label: string }) {
  return (
    <Link
      href={href}
      className={
        active
          ? "rounded-full bg-purple-600 px-3 py-1 text-xs font-medium text-white"
          : "chip hover:border-purple-300"
      }
    >
      {label}
    </Link>
  );
}
