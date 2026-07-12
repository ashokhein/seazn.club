import type { Metadata } from "next";
import Link from "next/link";
import { MarketingShell } from "@/components/marketing/marketing-shell";

export const metadata: Metadata = {
  title: "For Sports Clubs & Academies — Seazn Club",
  description:
    "Run weekly round-robins, seasonal championships, and internal ladders across chess, carrom, badminton, and more — all in one platform.",
};

export default function ClubsPage() {
  return (
    <>
      <MarketingShell>
      <main>
        <section className="mx-auto max-w-4xl px-4 pb-16 pt-16">
          <div className="mk-display mb-4 inline-flex items-center gap-2 rounded-full bg-[var(--mk-lime)] px-3 py-1 text-xs font-semibold tracking-[0.14em] text-[var(--mk-night)]">
            Use case: Sports clubs
          </div>
          <h1 className="mk-display mb-4 text-5xl font-bold text-purple-950 sm:text-6xl">
            Built for sports clubs & academies
          </h1>
          <p className="mb-8 max-w-2xl text-lg text-slate-600">
            Whether you run weekly internal leagues or annual championships,
            Seazn Club handles the draw, standings, and results — so you can spend
            your time coaching, not counting points.
          </p>

          <div className="grid gap-6 sm:grid-cols-2">
            {[
              {
                icon: "🗓️",
                title: "Seasonal structure",
                body: "Group your tournaments into named seasons. Track cumulative performance across the year and compare results across different cohorts.",
              },
              {
                icon: "⚡",
                title: "Multiple formats",
                body: "Run a Swiss group stage into knockout final, or a pure round-robin points table. Mix formats across different age groups or skill levels.",
              },
              {
                icon: "👥",
                title: "Multiple staff, one org",
                body: "Add coaches as admins to create and manage tournaments. Invite parents and members as viewers to follow results in real time.",
              },
              {
                icon: "🏅",
                title: "Multi-sport support",
                body: "Chess, carrom, football, cricket, badminton, table tennis — configure custom scoring rules and clocks per sport with preset templates.",
              },
              {
                icon: "🖨️",
                title: "Print & display",
                body: "Export the bracket or standings to print for the noticeboard, or run the slideshow view on a club-room screen.",
              },
              {
                icon: "🔁",
                title: "Undo & corrections",
                body: "Results can be corrected before the next round. Undo tokens give you a safety net without disrupting the flow.",
              },
            ].map((f) => (
              <div key={f.title} className="card p-6">
                <div className="mb-3 text-3xl">{f.icon}</div>
                <h3 className="mb-1 font-semibold text-slate-800">{f.title}</h3>
                <p className="text-sm text-slate-500">{f.body}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="bg-purple-50 py-14 text-center">
          <h2 className="mb-3 text-2xl font-bold text-purple-900">
            Set up your club in under 5 minutes
          </h2>
          <p className="mb-6 text-slate-500">Free forever for small clubs.</p>
          <Link href="/login?tab=signup" className="btn btn-primary px-8 py-3 text-base">
            Start free →
          </Link>
        </section>
      </main>
      </MarketingShell>
    </>
  );
}
