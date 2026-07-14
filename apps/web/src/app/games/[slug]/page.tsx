// /games/<slug> — game player page. Slim chrome (no marketing footer):
// header bar + full-height game area. Coming-soon games get a teaser panel.
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getGame } from "@/games/registry";
import { GamePlayer } from "./game-player";

type Params = { slug: string };

export async function generateMetadata({
  params,
}: {
  params: Promise<Params>;
}): Promise<Metadata> {
  const { slug } = await params;
  const game = getGame(slug);
  if (!game) return {};
  return {
    title: `${game.title} — play free | Seazn Club`,
    description: game.description,
    // Canonical always on the apex domain so games.seazn.club doesn't split SEO.
    alternates: { canonical: `https://seazn.club/games/${slug}` },
  };
}

export default async function GamePage({ params }: { params: Promise<Params> }) {
  const { slug } = await params;
  const game = getGame(slug);
  if (!game) notFound();

  return (
    <div className="flex min-h-dvh flex-col bg-white">
      <header className="flex items-center gap-3 border-b border-slate-200 px-4 py-2">
        <Link href="/games" className="text-sm font-medium text-purple-600 hover:text-purple-800">
          ← Games
        </Link>
        <span className="text-sm text-slate-300">|</span>
        <h1 className="mk-display text-base font-bold text-purple-950">{game.title}</h1>
      </header>
      <main className="min-h-0 flex-1">
        {game.status === "live" ? (
          <GamePlayer slug={game.slug} />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-4 py-16 text-center">
            <div className="text-6xl">{game.thumbnail}</div>
            <h2 className="mk-display text-2xl font-bold text-purple-950">
              {game.title} is coming soon
            </h2>
            <p className="max-w-md text-sm text-slate-500">{game.description}</p>
            <Link href="/games" className="btn btn-ghost mt-2">
              Browse other games
            </Link>
          </div>
        )}
      </main>
    </div>
  );
}
