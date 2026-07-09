import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { MarketingNav } from "@/components/marketing-nav";
import { MarketingFooter } from "@/components/marketing-footer";
import { getDiscoveryLive, getDiscoveryThisWeek } from "@/server/public-site/discovery";
import { LiveNowStrip, ThisWeekSection } from "@/components/discovery-cards";

export const metadata: Metadata = {
  title: "Seazn Club — Run multi-sport community tournaments",
  description:
    "Leagues, groups, knockouts, swiss — run any format for any sport in minutes, with online registration and entry fees built in. Free for community clubs.",
  openGraph: {
    title: "Seazn Club",
    description: "Run multi-sport community tournaments from setup to trophy in minutes.",
    url: "https://seazn.club",
    siteName: "Seazn Club",
    type: "website",
  },
};

const SPORTS = ["Chess", "Carrom", "Football", "Cricket", "Volleyball", "Table Tennis", "Badminton", "Tennis"];

const FEATURES = [
  {
    icon: "⚡",
    title: "Any format",
    body: "Leagues, groups + knockout, swiss, double elimination, stepladders — mix formats across sports and divisions in one competition.",
  },
  {
    icon: "🏅",
    title: "Live standings",
    body: "Standings update the moment a result is recorded. Share the live view with players on any device.",
  },
  {
    icon: "📝",
    title: "Registration & entry fees",
    body: "Players sign up from your public page — capacity, waitlists and age-group eligibility handled. Charge entry fees straight to your club with Stripe.",
  },
  {
    icon: "👥",
    title: "Multi-role teams",
    body: "Owners, admins, viewers — plus scorer seats and hand-over device links for courtside volunteers.",
  },
  {
    icon: "🖨️",
    title: "Print & slideshow",
    body: "Bracket and standings export to print or full-screen slideshow — perfect for club noticeboards.",
  },
  {
    icon: "🔒",
    title: "Secure by default",
    body: "Every org is fully isolated. HSTS, CSRF protection, and per-tenant row-level security out of the box.",
  },
];

export default async function HomePage() {
  const user = await getCurrentUser().catch(() => null);
  if (user) redirect("/dashboard");

  // Discovery showcase (doc 15 §2): opt-in competitions only, via
  // public_discovery_v. Both sections collapse to nothing when empty — no
  // fake content, no layout shift. DB may be unreachable at build: fail soft.
  const [liveNow, thisWeek] = await Promise.all([
    getDiscoveryLive().catch(() => []),
    getDiscoveryThisWeek().catch(() => []),
  ]);

  return (
    <>
      <MarketingNav />
      <main>
        {/* Hero */}
        <section className="mx-auto max-w-5xl px-4 pb-20 pt-16 text-center sm:pt-24">
          {/* Brand logo */}
          <div className="mb-8 flex justify-center">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/logo-wide.png"
              alt="Seazn Club"
              className="h-16 w-auto sm:h-20"
              style={{ imageRendering: "auto" }}
            />
          </div>
          <div className="mb-4 inline-flex items-center gap-2 rounded-full bg-purple-100 px-3 py-1 text-xs font-medium text-purple-700">
            14-day Pro trial · No card required
          </div>
          <h1 className="mx-auto max-w-3xl text-4xl font-extrabold tracking-tight text-purple-950 sm:text-5xl lg:text-6xl">
            Run any tournament,{" "}
            <span className="text-purple-600">any sport</span>, in minutes
          </h1>
          <p className="mx-auto mt-5 max-w-xl text-lg text-slate-600">
            Swiss brackets, knockouts, round-robins, stepladders — Seazn Club
            handles the draw, standings, and results so you can
            focus on the game.
          </p>
          <div className="mt-8 flex flex-wrap justify-center gap-3">
            <Link href="/login?tab=signup" className="btn btn-primary px-6 py-3 text-base">
              Start free →
            </Link>
            <Link href="/pricing" className="btn btn-ghost px-6 py-3 text-base">
              See pricing
            </Link>
          </div>
          <p className="mt-4 text-xs text-slate-400">
            Free forever for small clubs · Upgrade when you need more
          </p>
        </section>

        {/* Live discoverable fixtures (collapses when empty) */}
        <LiveNowStrip fixtures={liveNow} />

        {/* Upcoming discoverable competitions (collapses when empty) */}
        <ThisWeekSection entries={thisWeek} />

        {/* Sports ticker */}
        <section className="border-y border-purple-100 bg-purple-50 py-4">
          <div className="mx-auto max-w-5xl px-4">
            <p className="mb-2 text-center text-xs font-semibold uppercase tracking-wider text-purple-400">
              Supported sports
            </p>
            <div className="flex flex-wrap justify-center gap-2">
              {SPORTS.map((s) => (
                <span key={s} className="chip">
                  {s}
                </span>
              ))}
              <span className="chip">+ any sport you add</span>
            </div>
          </div>
        </section>

        {/* Features */}
        <section className="mx-auto max-w-5xl px-4 py-20">
          <h2 className="mb-2 text-center text-3xl font-bold text-purple-900">
            Everything your club needs
          </h2>
          <p className="mb-12 text-center text-slate-500">
            Built for community clubs, academies, and school sports programs.
          </p>
          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map((f) => (
              <div key={f.title} className="card p-6">
                <div className="mb-3 text-3xl">{f.icon}</div>
                <h3 className="mb-1 font-semibold text-slate-800">{f.title}</h3>
                <p className="text-sm text-slate-500">{f.body}</p>
              </div>
            ))}
          </div>
        </section>

        {/* Social proof / use cases */}
        <section className="bg-purple-50 py-16">
          <div className="mx-auto max-w-5xl px-4">
            <h2 className="mb-10 text-center text-2xl font-bold text-purple-900">
              Who runs on Seazn Club?
            </h2>
            <div className="grid gap-6 sm:grid-cols-3">
              {[
                {
                  title: "Sports clubs & academies",
                  body: "Weekly round-robins, internal ladders, seasonal championships. One org, all your sports.",
                  href: "/use-cases/clubs",
                  icon: "🏢",
                },
                {
                  title: "One-day events",
                  body: "Open tournaments, charity cups, local derbies. Set up in 5 minutes, run all day smoothly.",
                  href: "/use-cases/events",
                  icon: "📅",
                },
                {
                  title: "Schools & youth programs",
                  body: "Inter-house competitions, lunchtime leagues, end-of-term championships. Kids love the live scoreboard.",
                  href: "/use-cases/schools",
                  icon: "🎓",
                },
              ].map((c) => (
                <Link
                  key={c.href}
                  href={c.href}
                  className="card block p-6 transition hover:border-purple-300 hover:shadow-md"
                >
                  <div className="mb-3 text-3xl">{c.icon}</div>
                  <h3 className="mb-1 font-semibold text-slate-800">{c.title}</h3>
                  <p className="text-sm text-slate-500">{c.body}</p>
                  <p className="mt-3 text-xs font-semibold text-purple-600">Learn more →</p>
                </Link>
              ))}
            </div>
          </div>
        </section>

        {/* Pricing teaser */}
        <section className="mx-auto max-w-3xl px-4 py-20 text-center">
          <h2 className="mb-3 text-3xl font-bold text-purple-900">
            Simple pricing
          </h2>
          <p className="mb-8 text-slate-500">
            Free for small clubs. Pro for clubs that need unlimited everything.
          </p>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="card p-6 text-left">
              <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-slate-400">
                Community
              </p>
              <p className="mb-3 text-3xl font-bold text-slate-900">Free</p>
              <ul className="space-y-2 text-sm text-slate-600">
                <li>✓ 2 active competitions</li>
                <li>✓ 16 entrants per division</li>
                <li>✓ Free-event registration</li>
                <li>✓ League, groups, knockout & swiss</li>
                <li>✓ Live standings & public page</li>
              </ul>
            </div>
            <div className="card border-purple-400 bg-purple-50 p-6 text-left">
              <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-purple-500">
                Pro
              </p>
              <p className="mb-3 text-3xl font-bold text-purple-900">
                $20<span className="text-base font-normal text-slate-500">/mo</span>
              </p>
              <ul className="space-y-2 text-sm text-slate-600">
                <li>✓ Unlimited competitions</li>
                <li>✓ Entry fees paid to your club</li>
                <li>✓ Realtime scoreboards</li>
                <li>✓ Ball-by-ball & rally scoring</li>
                <li>✓ 14-day free trial</li>
              </ul>
            </div>
          </div>
          <Link href="/pricing" className="mt-6 inline-flex text-sm text-purple-600 underline">
            Compare plans in detail →
          </Link>
        </section>

        {/* Final CTA */}
        <section className="bg-purple-900 py-16 text-center text-white">
          <h2 className="mb-3 text-3xl font-bold">Ready to run your first tournament?</h2>
          <p className="mb-8 text-purple-200">
            Free forever for small clubs. No credit card needed to start.
          </p>
          <Link href="/login?tab=signup" className="btn bg-white px-8 py-3 text-base font-semibold text-purple-900 hover:bg-purple-50">
            Create your free account →
          </Link>
        </section>
      </main>
      <MarketingFooter />
    </>
  );
}
