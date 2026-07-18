import type { Metadata } from "next";
import Link from "@/components/ui/console-link";
import { redirect, notFound } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { getDiscoveryLive, getDiscoveryThisWeek } from "@/server/public-site/discovery";
import { ThisWeekSection } from "@/components/discovery-cards";
import { StartFunnelForm } from "@/components/start-funnel-form";
import { MarketingShell } from "@/components/marketing/marketing-shell";
import { HeroVignette } from "@/components/marketing/hero-vignette";
import { LiveTicker } from "@/components/marketing/live-ticker";
import { TheDraw } from "@/components/marketing/the-draw";
import { MatchdayTools, AlsoInTheKit } from "@/components/marketing/matchday-tools";
import { MotifDivider } from "@/components/marketing/motif-divider";
import { TicketStubs } from "@/components/marketing/ticket-stubs";
import { marketingPreview } from "@/lib/marketing/format-preview";
import { preferredCurrency } from "@/lib/currency-server";
import { getDictionary, t } from "@/lib/i18n";
import { hasLocale } from "@/lib/i18n-constants";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ lang: string }>;
}): Promise<Metadata> {
  const { lang } = await params;
  if (!hasLocale(lang)) return {};
  const d = await getDictionary(lang, "marketing");
  return {
    title: t(d, "home.meta.title"),
    description: t(d, "home.meta.description"),
    alternates: {
      canonical: `/${lang}`,
      languages: {
        ...Object.fromEntries(["en", "fr", "es", "nl"].map((l) => [l, `/${l}`])),
        "x-default": "/en",
      },
    },
    openGraph: {
      title: t(d, "home.og.title"),
      description: t(d, "home.og.description"),
      url: "/",
      siteName: "Seazn Club",
      type: "website",
      // Explicit: in this Next build a page-level openGraph object replaces
      // the inherited one wholesale, dropping the root file-convention
      // opengraph-image (home shipped with no og:image at all).
      images: [{ url: "/opengraph-image", width: 1200, height: 630 }],
    },
  };
}

export default async function HomePage({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!hasLocale(lang)) notFound();

  const user = await getCurrentUser().catch(() => null);
  if (user) redirect("/dashboard");

  const d = await getDictionary(lang, "marketing");
  const audiences = [
    { key: "clubs", href: "/use-cases/clubs" },
    { key: "events", href: "/use-cases/events" },
    { key: "schools", href: "/use-cases/schools" },
  ] as const;

  // Fail-soft: DB may be unreachable at build (same contract as before).
  const [liveNow, thisWeek, currency] = await Promise.all([
    getDiscoveryLive().catch(() => []),
    getDiscoveryThisWeek().catch(() => []),
    preferredCurrency(null).catch(() => "usd" as const),
  ]);
  // SSR default draw = the configurator's no-JS fallback (design/v3/12 §4.4).
  const defaultDraw = marketingPreview("groups-knockout", 8);

  return (
    <MarketingShell variant="night-scroll" lang={lang}>
      <main>
        {/* Hero — stadium night. */}
        <section className="relative -mt-16 overflow-hidden bg-[linear-gradient(180deg,var(--mk-night-2),var(--mk-night))] pb-16 pt-28 text-[var(--mk-cream)]">
          <div
            aria-hidden
            className="pointer-events-none absolute -top-1/3 left-[-8%] h-[130%] w-[45%] rotate-12 bg-[radial-gradient(ellipse_at_top,rgba(163,230,53,0.10),transparent_65%)]"
          />
          <div
            aria-hidden
            className="pointer-events-none absolute -top-1/3 right-[-8%] h-[130%] w-[45%] -rotate-12 bg-[radial-gradient(ellipse_at_top,rgba(163,230,53,0.10),transparent_65%)]"
          />
          <div id="mk-hero-sentinel" aria-hidden className="absolute inset-x-0 top-0 h-[70%]" />
          <div className="relative mx-auto grid max-w-6xl items-center gap-10 px-4 lg:grid-cols-[1.1fr_0.9fr]">
            <div>
              <p className="mk-display text-xs font-semibold tracking-[0.22em] text-[var(--mk-lime)]">
                {t(d, "home.hero.eyebrow")}
              </p>
              <h1 className="mk-display mt-3 max-w-xl text-5xl font-bold leading-[0.95] sm:text-7xl">
                {t(d, "home.hero.title")}
              </h1>
              <p className="mt-4 max-w-md text-base text-[#b7aede]">{t(d, "home.hero.subhead")}</p>
              <div className="mt-8">
                <StartFunnelForm
                  variant="night"
                  labels={{
                    sport: t(d, "funnel.sport"),
                    entrants: t(d, "funnel.entrants"),
                    date: t(d, "funnel.date"),
                    submit: t(d, "funnel.submit"),
                  }}
                />
              </div>
              <p className="mt-4 text-xs text-[#8d7fc0]">
                {t(d, "home.hero.freeNote")}
                <Link href="/pricing" className="underline hover:text-[var(--mk-lime)]">
                  {t(d, "home.hero.upgradeLink")}
                </Link>
              </p>
            </div>
            <div className="w-full max-w-md justify-self-center">
              <HeroVignette />
            </div>
          </div>
        </section>

        <LiveTicker fixtures={liveNow} />

        {/* The Draw */}
        <section id="the-draw" className="bg-[var(--mk-light-violet)] py-20">
          <div className="mx-auto max-w-5xl px-4">
            <h2 className="mk-display mb-2 text-center text-4xl font-bold text-purple-950">
              {t(d, "home.draw.title")}
            </h2>
            <p className="mb-10 text-center text-slate-600">{t(d, "home.draw.subhead")}</p>
            <TheDraw initialPhases={defaultDraw} />
          </div>
        </section>

        <MotifDivider kind="shuttle" />

        {/* Matchday tools */}
        <section className="mx-auto max-w-5xl px-4 pb-20 pt-4">
          <h2 className="mk-display mb-2 text-center text-4xl font-bold text-purple-950">
            {t(d, "home.tools.title")}
          </h2>
          <p className="mb-10 text-center text-slate-600">{t(d, "home.tools.subhead")}</p>
          <MatchdayTools dict={d} />
          <div className="mt-12 border-t border-purple-100 pt-8">
            <AlsoInTheKit dict={d} />
          </div>
        </section>

        <MotifDivider kind="knight" />

        {/* Who plays here */}
        <section className="bg-[var(--mk-light-warm)] py-16">
          <div className="mx-auto max-w-5xl px-4">
            <h2 className="mk-display mb-8 text-center text-4xl font-bold text-purple-950">
              {t(d, "home.audiences.title")}
            </h2>
            <div className="grid gap-6 sm:grid-cols-3">
              {audiences.map((c) => (
                <Link
                  key={c.href}
                  href={c.href}
                  className="card block p-6 transition hover:border-purple-300 hover:shadow-md"
                >
                  <h3 className="mk-display mb-1 text-lg font-semibold text-slate-800">
                    {t(d, `home.audiences.${c.key}.title`)}
                  </h3>
                  <p className="text-sm text-slate-500">{t(d, `home.audiences.${c.key}.body`)}</p>
                  <p className="mt-3 text-xs font-semibold text-purple-600">
                    {t(d, "home.audiences.learnMore")}
                  </p>
                </Link>
              ))}
            </div>
          </div>
        </section>

        {/* Playing this week (collapses when empty) */}
        <ThisWeekSection entries={thisWeek} dict={d} lang={lang} />

        {/* Floodlit finale — pricing + CTA in one night block */}
        <section className="relative overflow-hidden bg-[linear-gradient(180deg,var(--mk-night-2),var(--mk-night))] py-20 text-center">
          <div
            aria-hidden
            className="pointer-events-none absolute -top-1/3 left-[-8%] h-[130%] w-[45%] rotate-12 bg-[radial-gradient(ellipse_at_top,rgba(163,230,53,0.08),transparent_65%)]"
          />
          <div className="relative mx-auto max-w-5xl px-4">
            <p className="mk-display text-xs font-semibold tracking-[0.22em] text-[var(--mk-lime)]">
              {t(d, "home.finale.eyebrow")}
            </p>
            <h2 className="mk-display mb-2 mt-3 text-5xl font-bold text-[var(--mk-cream)]">
              {t(d, "home.finale.title")}
            </h2>
            <p className="mb-10 text-sm text-[#b7aede]">{t(d, "home.finale.subhead")}</p>
            <TicketStubs currency={currency} />
            <div className="mt-10 flex flex-wrap items-center justify-center gap-4">
              <Link
                href="/start"
                className="mk-display rounded-xl bg-[var(--mk-lime)] px-8 py-3 text-base font-bold text-[var(--mk-night)]"
              >
                {t(d, "home.cta.start")}
              </Link>
              <Link
                href="/login?tab=signup"
                className="rounded-xl border border-[#4a3885] px-6 py-3 text-sm text-[var(--mk-cream)]"
              >
                {t(d, "home.cta.signup")}
              </Link>
            </div>
          </div>
        </section>
      </main>
    </MarketingShell>
  );
}
