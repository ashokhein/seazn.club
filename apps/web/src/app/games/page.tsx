// /games — Seazn Games listing. Cards come straight from the registry;
// coming-soon games render as non-clickable cards with a badge.
import type { Metadata } from "next";
import Link from "next/link";
import { MarketingShell } from "@/components/marketing/marketing-shell";
import { GAMES } from "@/games/registry";

export const metadata: Metadata = {
  title: "Games — free browser games | Seazn Club",
  description:
    "Play free browser games by Seazn Club. Learn-to-play quests and quick challenges — no install, no sign-up.",
  // Relative — resolved against the root layout's metadataBase.
  alternates: { canonical: "/games" },
};

export default function GamesPage() {
  return (
    <MarketingShell>
      <main className="mx-auto max-w-5xl px-4 py-12">
        <h1 className="mk-display text-4xl font-bold text-purple-950">Games</h1>
        <p className="mt-3 max-w-2xl text-lg text-slate-600">
          Free games in your browser — pick one and play. No install, no sign-up.
        </p>

        <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {GAMES.map((g) =>
            g.status === "live" ? (
              <Link
                key={g.slug}
                href={`/games/${g.slug}`}
                className="group rounded-2xl border border-slate-200 bg-white p-5 shadow-sm transition hover:border-purple-300 hover:shadow-md"
              >
                <div className="text-5xl">{g.thumbnail}</div>
                <h2 className="mk-display mt-3 text-xl font-bold text-purple-950 group-hover:text-purple-700">
                  {g.title}
                </h2>
                <p className="mt-1 text-sm text-slate-500">{g.tagline}</p>
                <span className="mt-3 inline-block text-sm font-medium text-purple-600">
                  Play →
                </span>
              </Link>
            ) : (
              <div
                key={g.slug}
                className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-5"
              >
                <div className="text-5xl opacity-60">{g.thumbnail}</div>
                <h2 className="mk-display mt-3 text-xl font-bold text-slate-500">{g.title}</h2>
                <p className="mt-1 text-sm text-slate-400">{g.tagline}</p>
                <span className="mt-3 inline-block rounded-full bg-slate-200 px-2.5 py-0.5 text-xs font-medium text-slate-600">
                  Coming soon
                </span>
              </div>
            ),
          )}
        </div>
      </main>
    </MarketingShell>
  );
}
