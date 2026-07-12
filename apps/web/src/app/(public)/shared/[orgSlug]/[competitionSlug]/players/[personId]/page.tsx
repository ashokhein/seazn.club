// Player card (doc 09 §2, doc 06 §4.7): consent-gated — public_players_v only
// contains persons with public_name consent, so anyone else 404s here. Photo
// only with photo consent; DOB is never in any public payload.
import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { getPublicPlayer } from "@/server/public-site/data";

export const revalidate = 300; // doc 09 §3: entrant/player pages revalidate 300

type Props = {
  params: Promise<{ orgSlug: string; competitionSlug: string; personId: string }>;
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { orgSlug, competitionSlug, personId } = await params;
  const data = await getPublicPlayer(orgSlug, competitionSlug, personId);
  if (!data) return {};
  return {
    title: `${data.player.name} — ${data.competition.name}`,
    ...(data.competition.visibility === "unlisted"
      ? { robots: { index: false, follow: false } }
      : {}),
  };
}

export default async function PlayerCardPage({ params }: Props) {
  const { orgSlug, competitionSlug, personId } = await params;
  const data = await getPublicPlayer(orgSlug, competitionSlug, personId);
  if (!data) notFound();
  const { org, competition, player, memberships } = data;

  return (
    <div>
      <nav className="mb-4 text-xs text-ink-muted">
        <Link
          href={`/shared/${org.slug}/${competition.slug}`}
          className="hover:text-accent-strong hover:underline"
        >
          {competition.name}
        </Link>
      </nav>
      <div className="flex items-start gap-4">
        {player.photo ? (
          // arbitrary-host avatar — not in remotePatterns, stays <img>
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={player.photo}
            alt={player.name}
            className="h-24 w-24 rounded-xl object-cover shadow-sm"
          />
        ) : (
          <div
            aria-hidden
            className="flex h-24 w-24 items-center justify-center rounded-xl bg-accent-soft font-display text-3xl font-bold text-accent-strong"
          >
            {player.name
              .split(/\s+/)
              .map((w) => w[0])
              .slice(0, 2)
              .join("")}
          </div>
        )}
        <div>
          <h1 className="font-display text-3xl font-bold uppercase leading-none tracking-tight text-ink">
            {player.name}
          </h1>
          <p className="mt-1 text-sm text-ink-muted">{org.name}</p>
        </div>
      </div>

      <section className="mt-6">
        <h2 className="mb-2 font-display text-sm font-semibold uppercase tracking-[0.18em] text-ink-muted">
          In this competition
        </h2>
        {memberships.length === 0 ? (
          <p className="text-sm text-ink-muted">No current squad entries.</p>
        ) : (
          <ul className="space-y-2">
            {memberships.map((m, i) => (
              <li
                key={i}
                className="rounded-xl border border-zinc-200/80 bg-surface p-3 text-sm shadow-sm"
              >
                <Link
                  href={`/shared/${org.slug}/${competition.slug}/${m.division_slug}`}
                  className="font-medium text-accent-strong underline decoration-accent-line underline-offset-2 hover:decoration-accent"
                >
                  {m.division_name}
                </Link>{" "}
                — {m.entrant_name}
                {m.squad_number != null ? ` · #${m.squad_number}` : ""}
                {m.position ? ` · ${m.position}` : ""}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
