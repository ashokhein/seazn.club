import type { Metadata } from "next";
import Link from "next/link";
import { MarketingShell } from "@/components/marketing/marketing-shell";
import { SchedulingBoard } from "@/components/marketing/scheduling-board";
import { Reveal } from "@/components/marketing/reveal";

export const metadata: Metadata = {
  title: "Scheduling — Seazn Club",
  description:
    "Courts and time slots on one board. Drag fixtures in, catch clashes before they happen, publish to players in one click.",
};

const RUNDOWN = [
  { time: "08:40", what: "Build the board", how: "courts × slots — fixtures auto-fill, drag to taste" },
  { time: "08:55", what: "Clash caught", how: "one player in two places at 9:15 — flagged before you publish" },
  { time: "09:00", what: "Publish", how: "schedule goes live on your public page; players see their courts" },
  { time: "12:30", what: "Rain-delay reshuffle", how: "drag the afternoon 40 minutes right, republish" },
];

const KIT = [
  { label: "Print & noticeboard", body: "The same board exports to print and full-screen slideshow." },
  { label: "Scorer hand-off", body: "Courtside volunteers score from a device link — no accounts." },
  { label: "Live to players", body: "Every change republished to the public schedule instantly." },
];

export default function SchedulingPage() {
  return (
    <MarketingShell>
      <main className="bg-[var(--mk-light-warm)]">
        <section className="mx-auto max-w-4xl px-4 pb-14 pt-16">
          <h1 className="mk-display text-5xl font-bold text-purple-950">The board runs matchday</h1>
          <p className="mt-3 max-w-xl text-slate-600">
            Courts and time slots on one board — drag fixtures in, clashes flagged before they
            happen. Try it: the replay below hands over to you.
          </p>
          <div className="mt-8">
            <SchedulingBoard />
          </div>
        </section>

        <section className="mx-auto max-w-4xl px-4 pb-14">
          <h2 className="mk-display mb-6 text-3xl font-bold text-purple-950">Order of play</h2>
          <div className="border-l-2 border-purple-950 pl-5">
            {RUNDOWN.map((r) => (
              <Reveal
                key={r.time}
                className="flex items-baseline gap-4 border-b border-dashed border-[#e5decd] py-2.5"
              >
                <span className="mk-display min-w-14 text-lg font-bold tabular-nums text-[var(--mk-purple)]">
                  {r.time}
                </span>
                <span>
                  <span className="text-sm font-semibold text-slate-800">{r.what}</span>{" "}
                  <span className="text-sm text-slate-600">— {r.how}</span>
                </span>
              </Reveal>
            ))}
          </div>
        </section>

        <section className="mx-auto max-w-4xl px-4 pb-20">
          <div className="grid gap-4 sm:grid-cols-3">
            {KIT.map((k) => (
              <div key={k.label} className="card p-4 text-sm">
                <p className="mb-1 font-semibold text-slate-800">{k.label}</p>
                <p className="text-slate-500">{k.body}</p>
              </div>
            ))}
          </div>
          <p className="mt-10 text-center">
            <Link href="/start" className="btn btn-primary px-6 py-2.5 text-base">
              Run your matchday →
            </Link>
          </p>
        </section>
      </main>
    </MarketingShell>
  );
}
