import "server-only";
// Embed data door (v3/10 #4): resolve a division ID to its public payload,
// honouring visibility (private → not_found — embeds must never become a
// side door) and the Pro embeds entitlement. Reads the SAME public_*_v views
// as the dashboard, but directly (no unstable_cache) — the /embed pages are
// ISR-cached themselves, and staying cache-free keeps this testable with
// plain Postgres. The outcome enum keeps failure modes explicit.
import { sql } from "@/lib/db";
import { hasFeature } from "@/lib/entitlements";
import { resolveSponsors, type ResolvedSponsor } from "@/server/usecases/sponsors";
import type {
  PublicCompetition,
  PublicDivision,
  PublicEntrant,
  PublicFixture,
  PublicStage,
  PublicStandings,
} from "@/server/public-site/data";

export interface EmbedPayload {
  org: { id: string; slug: string; name: string };
  competition: PublicCompetition;
  division: PublicDivision;
  stages: PublicStage[];
  pools: { id: string; stage_id: string; key: string; name: string }[];
  fixtures: PublicFixture[];
  standings: PublicStandings[];
  entrants: PublicEntrant[];
  /** Sponsor rows (v10) — data only; embed RENDERING of sponsors is v12. */
  sponsors: ResolvedSponsor[];
  /** Venue zone (schedule_settings.tz; UTC if unset) for schedule display. */
  tz: string;
}

export type EmbedResolution =
  | { ok: false; reason: "not_found" | "not_entitled" }
  | { ok: true; data: EmbedPayload };

const iso = <T extends { scheduled_at: unknown }>(f: T): T => ({
  ...f,
  scheduled_at: f.scheduled_at ? new Date(f.scheduled_at as string).toISOString() : null,
});

export async function embedDivisionData(divisionId: string): Promise<EmbedResolution> {
  if (!/^[0-9a-f-]{36}$/i.test(divisionId)) return { ok: false, reason: "not_found" };

  // public_divisions_v enforces visibility (private → no row) and hides
  // archived divisions — exactly the dashboard's rules.
  const [division] = await sql<PublicDivision[]>`
    select d.id, d.competition_id, d.name, d.slug, d.description,
           d.sport_key, d.variant_key, d.status, d.module_version, d.tiebreakers,
           s.name as sport_name, 0 as entrant_count
    from public_divisions_v d
    left join sports s on s.key = d.sport_key
    where d.id = ${divisionId}`;
  if (!division) return { ok: false, reason: "not_found" };

  const [competition] = await sql<(PublicCompetition & { org_id: string })[]>`
    select id, org_id, name, slug, description, starts_on, ends_on, branding,
           status, visibility
    from public_competitions_v where id = ${division.competition_id}`;
  if (!competition) return { ok: false, reason: "not_found" };

  if (!(await hasFeature(competition.org_id, "embeds.enabled"))) {
    return { ok: false, reason: "not_entitled" };
  }

  const [org] = await sql<{ id: string; slug: string; name: string }[]>`
    select id, slug, name from organizations where id = ${competition.org_id}`;
  if (!org) return { ok: false, reason: "not_found" };

  const [stages, pools, fixtures, standings, entrants, ssRows] = await Promise.all([
    sql<PublicStage[]>`
      select id, division_id, seq, kind, name, status
      from public_stages_v where division_id = ${divisionId} order by seq`,
    sql<{ id: string; stage_id: string; key: string; name: string }[]>`
      select p.id, p.stage_id, p.key, p.name
      from public_pools_v p
      join public_stages_v s on s.id = p.stage_id
      where s.division_id = ${divisionId} order by p.key`,
    sql<PublicFixture[]>`
      select id, division_id, stage_id, pool_id, round_no, seq_in_round,
             home_entrant_id, away_entrant_id, scheduled_at, venue, court_label,
             status, outcome, summary, last_seq
      from public_fixtures_v where division_id = ${divisionId}
      order by round_no, seq_in_round`.then((rows) => rows.map(iso)),
    sql<PublicStandings[]>`
      select stage_id, pool_id, rows, updated_at
      from public_standings_v where division_id = ${divisionId}`,
    sql<PublicEntrant[]>`
      select id, division_id, kind, display_name, seed, status, members, team_display, badge_url
      from public_entrants_v where division_id = ${divisionId}
      order by seed nulls last, display_name`,
    sql<{ tz: string }[]>`
      select tz from schedule_settings where division_id = ${divisionId}`,
  ]);

  return {
    ok: true,
    data: {
      org, competition, division, stages, pools, fixtures, standings, entrants,
      sponsors: await resolveSponsors(org.id, competition.id),
      tz: ssRows[0]?.tz ?? "UTC",
    },
  };
}
