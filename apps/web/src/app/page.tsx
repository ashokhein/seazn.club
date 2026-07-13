import type { Metadata } from "next";
import Link from "@/components/ui/console-link";
import { redirect } from "next/navigation";
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

export const metadata: Metadata = {
  title: "Seazn Club — Run multi-sport community tournaments",
  description:
    "Leagues, groups, knockouts — run any format for any sport in minutes, with online registration and entry fees built in. Free for community clubs.",
  openGraph: {
    title: "Seazn Club",
    description: "Run multi-sport community tournaments from setup to trophy in minutes.",
    url: "https://seazn.club",
    siteName: "Seazn Club",
    type: "website",
  },
};

const AUDIENCES = [
  {
    title: "Sports clubs & academies",
    body: "Weekly round-robins, internal ladders, seasonal championships. One org, all your sports.",
    href: "/use-cases/clubs",
  },
  {
    title: "One-day events",
    body: "Open tournaments, charity cups, local derbies. Set up in 5 minutes, run all day smoothly.",
    href: "/use-cases/events",
  },
  {
    title: "Schools & youth programs",
    body: "Inter-house competitions, lunchtime leagues, end-of-term championships. Kids love the live scoreboard.",
    href: "/use-cases/schools",
  },
];

export default async function HomePage() {
  const user = await getCurrentUser().catch(() => null);
  if (user) redirect("/dashboard");

  // Fail-soft: DB may be unreachable at build (same contract as before).
  const [liveNow, thisWeek, currency] = await Promise.all([
    getDiscoveryLive().catch(() => []),
    getDiscoveryThisWeek().catch(() => []),
    preferredCurrency(null).catch(() => "usd" as const),
  ]);
  // SSR default draw = the configurator's no-JS fallback (design/v3/12 §4.4).
  const defaultDraw = marketingPreview("groups-knockout", 8);

  return (
    <MarketingShell variant="night-scroll">
      <main>
        {/* Hero — stadium night. The nav is sticky (in flow), so pull the
            night slab up behind it with -mt so the transparent nav floats
            over the floodlights. */}
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
                FREE FOR COMMUNITY CLUBS
              </p>
              <h1 className="mk-display mt-3 max-w-xl text-5xl font-bold leading-[0.95] sm:text-7xl">
                Any sport. Live in minutes.
              </h1>
              <p className="mt-4 max-w-md text-base text-[#b7aede]">
                Cricket, football, badminton, chess — name the sport and the field, Seazn Club
                draws the fixtures and puts your scoreboard live.
              </p>
              <div className="mt-8">
                <StartFunnelForm variant="night" />
              </div>
              <p className="mt-4 text-xs text-[#8d7fc0]">
                Free forever for small clubs ·{" "}
                <Link href="/pricing" className="underline hover:text-[var(--mk-lime)]">
                  Upgrade a single event or go Pro
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
              The Draw
            </h2>
            <p className="mb-10 text-center text-slate-600">
              Pick a format, set the field — the real fixture engine draws it. No account needed.
            </p>
            <TheDraw initialPhases={defaultDraw} />
          </div>
        </section>

        <MotifDivider kind="shuttle" />

        {/* Matchday tools */}
        <section className="mx-auto max-w-5xl px-4 pb-20 pt-4">
          <h2 className="mk-display mb-2 text-center text-4xl font-bold text-purple-950">
            Matchday tools
          </h2>
          <p className="mb-10 text-center text-slate-600">
            The three jobs every organiser runs on the day.
          </p>
          <MatchdayTools />
          <div className="mt-12 border-t border-purple-100 pt-8">
            <AlsoInTheKit />
          </div>
        </section>

        <MotifDivider kind="knight" />

        {/* Who plays here */}
        <section className="bg-[var(--mk-light-warm)] py-16">
          <div className="mx-auto max-w-5xl px-4">
            <h2 className="mk-display mb-8 text-center text-4xl font-bold text-purple-950">
              Who plays here
            </h2>
            <div className="grid gap-6 sm:grid-cols-3">
              {AUDIENCES.map((c) => (
                <Link
                  key={c.href}
                  href={c.href}
                  className="card block p-6 transition hover:border-purple-300 hover:shadow-md"
                >
                  <h3 className="mk-display mb-1 text-lg font-semibold text-slate-800">{c.title}</h3>
                  <p className="text-sm text-slate-500">{c.body}</p>
                  <p className="mt-3 text-xs font-semibold text-purple-600">Learn more →</p>
                </Link>
              ))}
            </div>
          </div>
        </section>

        {/* Playing this week (collapses when empty) */}
        <ThisWeekSection entries={thisWeek} />

        {/* Floodlit finale — pricing + CTA in one night block */}
        <section className="relative overflow-hidden bg-[linear-gradient(180deg,var(--mk-night-2),var(--mk-night))] py-20 text-center">
          <div
            aria-hidden
            className="pointer-events-none absolute -top-1/3 left-[-8%] h-[130%] w-[45%] rotate-12 bg-[radial-gradient(ellipse_at_top,rgba(163,230,53,0.08),transparent_65%)]"
          />
          <div className="relative mx-auto max-w-5xl px-4">
            <p className="mk-display text-xs font-semibold tracking-[0.22em] text-[var(--mk-lime)]">
              FULL TIME · PICK YOUR SEASON
            </p>
            <h2 className="mk-display mb-2 mt-3 text-5xl font-bold text-[var(--mk-cream)]">
              Pick your season
            </h2>
            <p className="mb-10 text-sm text-[#b7aede]">
              Free for community clubs. One pass for the big day. Pro for the whole year.
            </p>
            <TicketStubs currency={currency} />
            <div className="mt-10 flex flex-wrap items-center justify-center gap-4">
              <Link
                href="/start"
                className="mk-display rounded-xl bg-[var(--mk-lime)] px-8 py-3 text-base font-bold text-[var(--mk-night)]"
              >
                Start your tournament →
              </Link>
              <Link
                href="/login?tab=signup"
                className="rounded-xl border border-[#4a3885] px-6 py-3 text-sm text-[var(--mk-cream)]"
              >
                Create free account
              </Link>
            </div>
          </div>
        </section>
      </main>
    </MarketingShell>
  );
}
