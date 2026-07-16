// /discover/{sport} — per-sport discovery landing (doc 15 §2, PROMPT-19).
// Doubles as the "tournament software for {sport}" SEO page doc 06 wanted,
// now with a live directory underneath the copy.
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { MarketingShell } from "@/components/marketing/marketing-shell";
import { sql } from "@/lib/db";
import { getDiscoveryDirectory } from "@/server/public-site/discovery";
import { DiscoveryCard, sportEmoji } from "@/components/discovery-cards";
import { getDictionary, t, type Dict } from "@/lib/i18n";
import { hasLocale } from "@/lib/i18n-constants";
import { sportLabel } from "@/lib/scoring-vocab";
import { msgFor } from "@/lib/messages-i18n";

// Sport keys with bespoke SEO copy in the marketing catalog; others fall back
// to the generic block.
const SPORTS_WITH_COPY = new Set([
  "cricket", "football", "volleyball", "badminton", "tabletennis", "boardgame", "carrom",
]);

/** intro/detail for a sport — bespoke where we have it, generic otherwise. */
function sportCopy(d: Dict, sport: string, nameLower: string): { intro: string; detail: string } {
  if (SPORTS_WITH_COPY.has(sport)) {
    return {
      intro: t(d, `discover.sport.copy.${sport}.intro`),
      detail: t(d, `discover.sport.copy.${sport}.detail`),
    };
  }
  return {
    intro: t(d, "discover.sport.genericIntro", { nameLower }),
    detail: t(d, "discover.sport.genericDetail", { nameLower }),
  };
}

type Params = { lang: string; sport: string };

export async function generateMetadata({
  params,
}: {
  params: Promise<Params>;
}): Promise<Metadata> {
  const { lang, sport } = await params;
  const dbName = await sportName(sport);
  if (!hasLocale(lang) || !dbName) return {};
  const d = await getDictionary(lang, "marketing");
  const name = sportLabel(sport, (k) => msgFor(lang, k));
  const vars = { name, nameLower: name.toLowerCase() };
  return {
    title: t(d, "discover.sport.metaTitle", vars),
    description: SPORTS_WITH_COPY.has(sport)
      ? t(d, `discover.sport.copy.${sport}.intro`)
      : t(d, "discover.sport.metaDesc", vars),
    alternates: {
      canonical: `/${lang}/discover/${sport}`,
      languages: {
        ...Object.fromEntries(["en", "fr", "es", "nl"].map((l) => [l, `/${l}/discover/${sport}`])),
        "x-default": `/en/discover/${sport}`,
      },
    },
  };
}

async function sportName(key: string): Promise<string | null> {
  if (!/^[a-z0-9_-]{1,50}$/.test(key)) return null;
  try {
    const [row] = await sql<{ name: string }[]>`select name from sports where key = ${key}`;
    return row?.name ?? null;
  } catch {
    return null;
  }
}

export default async function DiscoverSportPage({ params }: { params: Promise<Params> }) {
  const { lang, sport } = await params;
  const dbName = await sportName(sport);
  if (!hasLocale(lang) || !dbName) notFound();
  const d = await getDictionary(lang, "marketing");
  const name = sportLabel(sport, (k) => msgFor(lang, k));
  const nameLower = name.toLowerCase();
  const copy = sportCopy(d, sport, nameLower);
  const entries = await getDiscoveryDirectory({ sport }).catch(() => []);
  const live = entries.filter((e) => e.in_play_count > 0);
  const upcoming = entries.filter((e) => e.in_play_count === 0);

  return (
    <>
      <MarketingShell lang={lang}>
      <main className="mx-auto max-w-5xl px-4 py-12">
        <p className="text-xs text-slate-400">
          <Link href={`/${lang}/discover`} className="hover:text-purple-600">
            {t(d, "discover.sport.breadcrumb")}
          </Link>{" "}
          / {name}
        </p>
        <h1 className="mt-2 mk-display text-4xl font-bold text-purple-950">
          {sportEmoji(sport)} {t(d, "discover.sport.h1", { name })}
        </h1>
        {/* SEO copy block (doc 15 §2: per-sport landing = acquisition page). */}
        <p className="mt-3 max-w-2xl text-lg text-slate-600">{copy.intro}</p>
        <p className="mt-2 max-w-2xl text-sm text-slate-500">{copy.detail}</p>
        <div className="mt-5 flex gap-3">
          <Link href="/login?tab=signup" className="btn btn-primary">
            {t(d, "discover.sport.runCta", { nameLower })} →
          </Link>
          <Link href={`/${lang}/pricing`} className="btn btn-ghost">
            {t(d, "discover.sport.pricing")}
          </Link>
        </div>

        {live.length > 0 && (
          <section className="mt-12">
            <h2 className="mb-4 text-lg font-bold text-purple-900">{t(d, "discover.sport.liveNow")}</h2>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {live.map((e) => (
                <DiscoveryCard key={e.id} entry={e} dict={d} lang={lang} withJsonLd />
              ))}
            </div>
          </section>
        )}

        {upcoming.length > 0 && (
          <section className="mt-12">
            <h2 className="mb-4 text-lg font-bold text-purple-900">{t(d, "discover.sport.upcoming")}</h2>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {upcoming.map((e) => (
                <DiscoveryCard key={e.id} entry={e} dict={d} lang={lang} withJsonLd />
              ))}
            </div>
          </section>
        )}

        {entries.length === 0 && (
          <p className="mt-12 text-sm text-slate-500">
            {t(d, "discover.sport.empty", { nameLower })}
          </p>
        )}
      </main>
      </MarketingShell>
    </>
  );
}
