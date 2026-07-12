import type { Metadata } from "next";
import Link from "next/link";
import { MarketingShell } from "@/components/marketing/marketing-shell";

export const metadata: Metadata = {
  title: "For Tournaments & Events — Seazn Club",
  description:
    "One-day open tournaments, charity cups, local derbies. Set up in 5 minutes and run all day without a hitch.",
};

export default function EventsPage() {
  return (
    <>
      <MarketingShell>
      <main>
        <section className="mx-auto max-w-4xl px-4 pb-16 pt-16">
          <div className="mb-4">
            <Link href="/" className="text-sm text-purple-600 hover:underline">
              ← Back
            </Link>
          </div>
          <div className="mb-4 inline-flex items-center gap-2 rounded-full bg-purple-100 px-3 py-1 text-xs font-medium text-purple-700">
            Use case: Tournaments & events
          </div>
          <h1 className="mb-4 text-4xl font-extrabold tracking-tight text-purple-950 sm:text-5xl">
            One-day tournaments, stress-free
          </h1>
          <p className="mb-8 max-w-2xl text-lg text-slate-600">
            Open tournaments, charity cups, corporate events — set up the draw
            in five minutes before doors open, then record results from any
            device throughout the day.
          </p>

          <div className="grid gap-6 sm:grid-cols-2">
            {[
              {
                icon: "🚀",
                title: "Ready before kickoff",
                body: "Add players, choose format (Swiss, Knockout, or both), configure rounds, and you're live. Takes under 5 minutes for 32 entrants.",
              },
              {
                icon: "📱",
                title: "Record results on any device",
                body: "Results are recorded from any phone or tablet. The bracket and standings update instantly for everyone watching.",
              },
              {
                icon: "🎯",
                title: "Handles odd numbers",
                body: "Byes, walkovers, and odd player counts are managed automatically. No manual bracket editing required.",
              },
              {
                icon: "🏆",
                title: "From group stage to final",
                body: "Swiss Knockout format runs a round-robin group stage then auto-seeds into a knockout bracket — ideal for open events.",
              },
              {
                icon: "📊",
                title: "Live slideshow",
                body: "Project the live standings or current bracket on a screen for spectators. Full-screen, auto-updating, no login needed on the display device.",
              },
              {
                icon: "🖨️",
                title: "Print the results",
                body: "Print the final standings and bracket to hand out to participants or post on the venue board.",
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
            Run your next event without the spreadsheet
          </h2>
          <p className="mb-6 text-slate-500">Free for up to 32 players.</p>
          <Link href="/login?tab=signup" className="btn btn-primary px-8 py-3 text-base">
            Start free →
          </Link>
        </section>
      </main>
      </MarketingShell>
    </>
  );
}
