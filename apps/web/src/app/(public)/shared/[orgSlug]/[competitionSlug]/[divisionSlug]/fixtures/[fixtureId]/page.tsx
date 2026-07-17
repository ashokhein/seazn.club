// Live match page (doc 09 §2): render-agnostic scoreboard from the fold
// cache's ScoreSummary, live via realtime push (Pro) or 15 s polling, with
// SportsEvent JSON-LD (doc 09 §3).
import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { getPublicFixture } from "@/server/public-site/data";
import { sportsEventJsonLd } from "@/lib/public-site";
import { publicThemeStyle } from "@/lib/public-theme";
import { LiveScore } from "@/components/public-site/live-score";
import { ShareButton } from "@/components/share-button";

export const revalidate = 30;

// ISR (task-8): empty-array generateStaticParams is required for on-demand
// ISR on a dynamic segment in this Next version — see generate-static-params.md.
export async function generateStaticParams() {
  return [];
}

type Props = {
  params: Promise<{
    orgSlug: string;
    competitionSlug: string;
    divisionSlug: string;
    fixtureId: string;
  }>;
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { orgSlug, competitionSlug, divisionSlug, fixtureId } = await params;
  const data = await getPublicFixture(orgSlug, competitionSlug, divisionSlug, fixtureId);
  if (!data) return {};
  const home = data.fixture.home_entrant_id
    ? (data.entrantNames[data.fixture.home_entrant_id] ?? "TBD")
    : "TBD";
  const away = data.fixture.away_entrant_id
    ? (data.entrantNames[data.fixture.away_entrant_id] ?? "TBD")
    : "TBD";
  return {
    title: `${home} vs ${away} — ${data.division.name}`,
    description: data.fixture.summary?.headline ?? `${home} vs ${away} at ${data.competition.name}`,
    ...(data.competition.visibility === "unlisted"
      ? { robots: { index: false, follow: false } }
      : {}),
  };
}

export default async function FixturePage({ params }: Props) {
  const { orgSlug, competitionSlug, divisionSlug, fixtureId } = await params;
  const data = await getPublicFixture(orgSlug, competitionSlug, divisionSlug, fixtureId);
  if (!data) notFound();
  const { org, competition, division, fixture, entrantNames, realtime } = data;

  const home = fixture.home_entrant_id ? (entrantNames[fixture.home_entrant_id] ?? "TBD") : "TBD";
  const away = fixture.away_entrant_id ? (entrantNames[fixture.away_entrant_id] ?? "TBD") : "TBD";
  const basePath = `/shared/${org.slug}/${competition.slug}/${division.slug}`;

  const jsonLd = sportsEventJsonLd({
    name: `${home} vs ${away} — ${division.name}, ${competition.name}`,
    ...(fixture.scheduled_at ? { startDate: fixture.scheduled_at } : {}),
    ...(fixture.venue ? { location: fixture.venue } : {}),
    url: `https://seazn.club${basePath}/fixtures/${fixture.id}`,
    homeTeam: home,
    awayTeam: away,
    eventStatus:
      fixture.status === "cancelled"
        ? "EventCancelled"
        : fixture.status === "finalized" || fixture.status === "decided"
          ? "EventCompleted"
          : "EventScheduled",
  });

  return (
    <div style={publicThemeStyle(competition.branding)}>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd }} />
      <nav className="mb-4 text-xs text-ink-muted">
        <Link
          href={`/shared/${org.slug}/${competition.slug}`}
          className="hover:text-accent-strong hover:underline"
        >
          {competition.name}
        </Link>{" "}
        /{" "}
        <Link href={basePath} className="hover:text-accent-strong hover:underline">
          {division.name}
        </Link>
      </nav>

      <div className="mb-1 flex flex-wrap items-start justify-between gap-3">
        <h1 className="font-display text-2xl font-semibold text-ink">
          {home} <span className="text-ink-muted">vs</span> {away}
        </h1>
        {/* One-tap share (v3/10 #2) — the message reads like a human wrote it. */}
        <ShareButton
          title={`${home} vs ${away}`}
          text={
            fixture.status === "decided" || fixture.status === "finalized"
              ? `${home} vs ${away} — ${fixture.summary?.headline ?? "full-time"} (${division.name}, ${competition.name})`
              : `${home} vs ${away} — ${division.name}, ${competition.name}. Follow it live:`
          }
          url={`${basePath}/fixtures/${fixture.id}`}
        />
      </div>
      <p className="mb-4 text-sm text-ink-muted">
        {fixtureSubheading(fixture.status, fixture.scheduled_at)}
        {fixture.venue ? ` · ${fixture.venue}` : ""}
        {fixture.court_label ? ` · ${fixture.court_label}` : ""}
      </p>

      <LiveScore
        fixtureId={fixture.id}
        initial={{ status: fixture.status, summary: fixture.summary, outcome: fixture.outcome }}
        realtime={realtime}
        entrantNames={entrantNames}
        sportKey={division.sport_key}
      />
    </div>
  );
}

/**
 * "Time TBD" only makes sense pre-match — a live fixture with no
 * scheduled_at (started ad hoc) should say so instead of implying it
 * hasn't started, which contradicts the LIVE scorebug right below it.
 */
export function fixtureSubheading(
  status: string,
  scheduledAt: string | null | undefined,
): string {
  if (scheduledAt) {
    return new Date(scheduledAt).toLocaleString("en-GB", {
      weekday: "long",
      day: "numeric",
      month: "long",
      hour: "2-digit",
      minute: "2-digit",
    });
  }
  return status === "in_play" ? "Live" : "Time TBD";
}
