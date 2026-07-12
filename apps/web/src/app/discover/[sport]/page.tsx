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

// SEO copy blocks per sport key. Keys match the engine sport catalog; a sport
// without bespoke copy gets the generic block with its display name.
const SPORT_COPY: Record<string, { intro: string; detail: string }> = {
  cricket: {
    intro: "Run cricket tournaments with ball-by-ball scoring, NRR standings and DLS support.",
    detail:
      "From tape-ball weekend cups to league seasons: T20/ODI-style variants, over-by-over scoring, net run rate computed for you, and live scorecards your players can share. Swiss, round-robin, groups and knockouts — all formats included.",
  },
  football: {
    intro: "Run football tournaments with live scores, group stages and knockout brackets.",
    detail:
      "Five-a-side nights, school cups, club leagues. Goal-by-goal timelines, W-D-L tables with goal difference, penalty shootouts, and shareable live pages for every match.",
  },
  volleyball: {
    intro: "Run volleyball tournaments with set-by-set scoring and ratio-based standings.",
    detail:
      "Indoor or beach: best-of sets, rally scoring, set and point ratios in the standings, and live set boxes spectators can follow from their phones.",
  },
  badminton: {
    intro: "Run badminton tournaments with rally scoring and instant draws.",
    detail:
      "Singles, doubles, club ladders. Rally-by-rally or quick winner entry, automatic draws for any entrant count, and live courtside scoreboards.",
  },
  tabletennis: {
    intro: "Run table tennis tournaments with game-by-game scoring and any format.",
    detail:
      "Office leagues to open championships: best-of games, group-to-knockout progressions, and standings that update the moment a result lands.",
  },
  boardgame: {
    intro: "Run chess and board game tournaments with Swiss pairings and tiebreak cascades.",
    detail:
      "Swiss rounds with Buchholz and Sonneborn-Berger computed for you, round-robin and knockout options, and live results your players can check between rounds.",
  },
  carrom: {
    intro: "Run carrom tournaments with board scoring and league or knockout play.",
    detail:
      "Club nights and community championships: board-by-board scoring, sport-correct standings, and live results on a shareable page.",
  },
};

type Params = { sport: string };

export async function generateMetadata({
  params,
}: {
  params: Promise<Params>;
}): Promise<Metadata> {
  const { sport } = await params;
  const name = await sportName(sport);
  if (!name) return {};
  const copy = SPORT_COPY[sport];
  return {
    title: `${name} tournament software — live ${name.toLowerCase()} tournaments | Seazn Club`,
    description:
      copy?.intro ??
      `Run ${name.toLowerCase()} tournaments in minutes and follow live ${name.toLowerCase()} competitions on Seazn Club.`,
    alternates: { canonical: `https://seazn.club/discover/${sport}` },
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
  const { sport } = await params;
  const name = await sportName(sport);
  if (!name) notFound();
  const copy = SPORT_COPY[sport] ?? {
    intro: `Run ${name.toLowerCase()} tournaments in minutes — any format, live scores included.`,
    detail: `Set up a ${name.toLowerCase()} competition in minutes: automatic draws for Swiss, round-robin, groups and knockouts, live scoring from any device, and standings that update themselves.`,
  };
  const entries = await getDiscoveryDirectory({ sport }).catch(() => []);
  const live = entries.filter((e) => e.in_play_count > 0);
  const upcoming = entries.filter((e) => e.in_play_count === 0);

  return (
    <>
      <MarketingShell>
      <main className="mx-auto max-w-5xl px-4 py-12">
        <p className="text-xs text-slate-400">
          <Link href="/discover" className="hover:text-purple-600">
            Discover
          </Link>{" "}
          / {name}
        </p>
        <h1 className="mt-2 text-3xl font-extrabold tracking-tight text-purple-950">
          {sportEmoji(sport)} {name} tournaments
        </h1>
        {/* SEO copy block (doc 15 §2: per-sport landing = acquisition page). */}
        <p className="mt-3 max-w-2xl text-lg text-slate-600">{copy.intro}</p>
        <p className="mt-2 max-w-2xl text-sm text-slate-500">{copy.detail}</p>
        <div className="mt-5 flex gap-3">
          <Link href="/login?tab=signup" className="btn btn-primary">
            Run a {name.toLowerCase()} tournament →
          </Link>
          <Link href="/pricing" className="btn btn-ghost">
            Pricing
          </Link>
        </div>

        {live.length > 0 && (
          <section className="mt-12">
            <h2 className="mb-4 text-lg font-bold text-purple-900">Live right now</h2>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {live.map((e) => (
                <DiscoveryCard key={e.id} entry={e} withJsonLd />
              ))}
            </div>
          </section>
        )}

        {upcoming.length > 0 && (
          <section className="mt-12">
            <h2 className="mb-4 text-lg font-bold text-purple-900">Upcoming & recent</h2>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {upcoming.map((e) => (
                <DiscoveryCard key={e.id} entry={e} withJsonLd />
              ))}
            </div>
          </section>
        )}

        {entries.length === 0 && (
          <p className="mt-12 text-sm text-slate-500">
            No public {name.toLowerCase()} tournaments right now — yours could be the first.
          </p>
        )}
      </main>
      </MarketingShell>
    </>
  );
}
