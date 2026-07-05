import "server-only";
// Public dashboard read model (doc 09, PROMPT-12). Every query goes through
// the consent-filtered public_*_v views ONLY — no auth'd query path exists in
// these pages. Caching is Next's tag-based data cache (unstable_cache; this
// Next version's pre-cacheComponents model, see
// node_modules/next/dist/docs/01-app/02-guides/caching-without-cache-components.md):
// competition/division reads revalidate every 30 s, player reads every 300 s
// (doc 09 §3), and the same service-layer writes that publish realtime fire
// `revalidateTag('division:{id}')` for instant refresh (see usecases/scoring.ts).
import { unstable_cache } from "next/cache";
import { sql } from "@/lib/db";

export const REVALIDATE_FAST = 30; // competition / division / fixture pages
export const REVALIDATE_SLOW = 300; // entrant / player pages

export const divisionTag = (divisionId: string) => `division:${divisionId}`;
export const competitionTag = (competitionId: string) => `competition:${competitionId}`;
export const orgTag = (orgSlug: string) => `org-public:${orgSlug}`;

export type Visibility = "public" | "unlisted";

export interface PublicOrg {
  id: string;
  name: string;
  slug: string;
  branded: boolean; // Pro branding entitlement — removable platform footer
}

export interface PublicCompetition {
  id: string;
  org_id: string;
  name: string;
  slug: string;
  description: string | null;
  starts_on: string | null;
  ends_on: string | null;
  branding: Record<string, unknown>;
  status: string;
  visibility: Visibility;
}

export interface PublicDivision {
  id: string;
  competition_id: string;
  name: string;
  slug: string;
  sport_key: string;
  variant_key: string;
  status: string;
  module_version: string;
  tiebreakers: string[] | null; // override cascade; null = sport default
  sport_name: string | null;
  entrant_count: number;
}

export interface PublicFixture {
  id: string;
  division_id: string;
  stage_id: string;
  pool_id: string | null;
  round_no: number;
  seq_in_round: number;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  scheduled_at: string | null;
  venue: string | null;
  court_label: string | null;
  status: string;
  outcome: { kind?: string; winner?: string } | null;
  summary: { headline?: string; perSide?: { entrantId: string; line: string }[] } | null;
  last_seq: number | null;
}

export interface PublicStage {
  id: string;
  division_id: string;
  seq: number;
  kind: "league" | "group" | "swiss" | "knockout" | "double_elim" | "stepladder";
  name: string;
  status: string;
}

export interface PublicStandings {
  stage_id: string;
  pool_id: string | null;
  rows: StandingsSnapshotRow[];
  updated_at: string;
}

// The engine's StandingsRow as persisted in standings_snapshots (JSON).
export interface StandingsSnapshotRow {
  entrantId: string;
  played: number;
  won: number;
  drawn: number;
  lost: number;
  points: number;
  metrics: Record<string, number>;
  rank?: number;
  rankLocked?: boolean;
  tieBreak?: { key: string; with: string[] };
}

export interface PublicEntrantMember {
  name: string;
  photo: string | null;
  person_id: string | null; // null = no public-name consent, no player card
  squad_number: number | null;
  position: string | null;
}

export interface PublicEntrant {
  id: string;
  division_id: string;
  kind: string;
  display_name: string;
  seed: number | null;
  status: string;
  members: PublicEntrantMember[];
}

export interface PublicPlayer {
  id: string;
  org_id: string;
  name: string;
  photo: string | null;
}

async function loadOrg(orgSlug: string): Promise<PublicOrg | null> {
  const [row] = await sql<(PublicOrg & { branded: boolean })[]>`
    select o.id, o.name, o.slug, org_has_feature(o.id, 'branding') as branded
    from organizations o where o.slug = ${orgSlug} limit 1`;
  return row ?? null;
}

/** Org landing: the org + its `public` competitions (unlisted stays link-only). */
export async function getPublicOrg(orgSlug: string): Promise<{
  org: PublicOrg;
  competitions: PublicCompetition[];
} | null> {
  return unstable_cache(
    async () => {
      const org = await loadOrg(orgSlug);
      if (!org) return null;
      const competitions = await sql<PublicCompetition[]>`
        select id, org_id, name, slug, description, starts_on, ends_on, branding,
               status, visibility
        from public_competitions_v
        where org_id = ${org.id} and visibility = 'public'
        order by starts_on desc nulls last, created_at desc`;
      return { org, competitions };
    },
    ["pub-org", orgSlug],
    { tags: [orgTag(orgSlug)], revalidate: REVALIDATE_FAST },
  )();
}

/** Competition home: hero + divisions (+ live-now strip). */
export async function getPublicCompetition(
  orgSlug: string,
  compSlug: string,
): Promise<{
  org: PublicOrg;
  competition: PublicCompetition;
  divisions: PublicDivision[];
  liveNow: PublicFixture[];
} | null> {
  const shell = await unstable_cache(
    async () => {
      const org = await loadOrg(orgSlug);
      if (!org) return null;
      const [competition] = await sql<PublicCompetition[]>`
        select id, org_id, name, slug, description, starts_on, ends_on, branding,
               status, visibility
        from public_competitions_v
        where org_id = ${org.id} and slug = ${compSlug} limit 1`;
      if (!competition) return null;
      const divisions = await sql<PublicDivision[]>`
        select d.id, d.competition_id, d.name, d.slug, d.sport_key, d.variant_key,
               d.status, d.module_version, d.tiebreakers, s.name as sport_name,
               (select count(*)::int from public_entrants_v e
                 where e.division_id = d.id) as entrant_count
        from public_divisions_v d
        left join sports s on s.key = d.sport_key
        where d.competition_id = ${competition.id}
        order by d.created_at, d.id`;
      const liveNow = await sql<PublicFixture[]>`
        select f.id, f.division_id, f.stage_id, f.pool_id, f.round_no,
               f.seq_in_round, f.home_entrant_id, f.away_entrant_id,
               f.scheduled_at, f.venue, f.court_label, f.status, f.outcome,
               f.summary, f.last_seq
        from public_fixtures_v f
        join public_divisions_v d on d.id = f.division_id
        where d.competition_id = ${competition.id} and f.status = 'in_play'
        order by f.scheduled_at nulls last limit 12`;
      return { org, competition, divisions, liveNow };
    },
    ["pub-comp", orgSlug, compSlug],
    { tags: [orgTag(orgSlug)], revalidate: REVALIDATE_FAST },
  )();
  if (!shell) return null;
  return shell;
}

/** Division home: schedule + standings + entrants + stage skeleton. */
export async function getPublicDivision(
  orgSlug: string,
  compSlug: string,
  divSlug: string,
): Promise<{
  org: PublicOrg;
  competition: PublicCompetition;
  division: PublicDivision;
  stages: PublicStage[];
  pools: { id: string; stage_id: string; key: string; name: string }[];
  fixtures: PublicFixture[];
  standings: PublicStandings[];
  entrants: PublicEntrant[];
} | null> {
  const shell = await getPublicCompetition(orgSlug, compSlug);
  if (!shell) return null;
  const division = shell.divisions.find((d) => d.slug === divSlug);
  if (!division) return null;

  const detail = await unstable_cache(
    async () => {
      const stages = await sql<PublicStage[]>`
        select id, division_id, seq, kind, name, status
        from public_stages_v where division_id = ${division.id} order by seq`;
      const pools = await sql<{ id: string; stage_id: string; key: string; name: string }[]>`
        select p.id, p.stage_id, p.key, p.name
        from public_pools_v p
        join public_stages_v s on s.id = p.stage_id
        where s.division_id = ${division.id} order by p.key`;
      const fixtures = await sql<PublicFixture[]>`
        select id, division_id, stage_id, pool_id, round_no, seq_in_round,
               home_entrant_id, away_entrant_id, scheduled_at, venue, court_label,
               status, outcome, summary, last_seq
        from public_fixtures_v where division_id = ${division.id}
        order by round_no, seq_in_round`;
      const standings = await sql<PublicStandings[]>`
        select stage_id, pool_id, rows, updated_at
        from public_standings_v where division_id = ${division.id}`;
      const entrants = await sql<PublicEntrant[]>`
        select id, division_id, kind, display_name, seed, status, members
        from public_entrants_v where division_id = ${division.id}
        order by seed nulls last, display_name`;
      return { stages, pools, fixtures, standings, entrants };
    },
    ["pub-div", division.id],
    {
      tags: [divisionTag(division.id), competitionTag(division.competition_id)],
      revalidate: REVALIDATE_FAST,
    },
  )();

  return {
    org: shell.org,
    competition: shell.competition,
    division,
    ...detail,
  };
}

/** Live match page: one fixture + its division/competition context. */
export async function getPublicFixture(
  orgSlug: string,
  compSlug: string,
  divSlug: string,
  fixtureId: string,
): Promise<{
  org: PublicOrg;
  competition: PublicCompetition;
  division: PublicDivision;
  fixture: PublicFixture;
  entrantNames: Record<string, string>;
  realtime: boolean;
} | null> {
  if (!/^[0-9a-f-]{36}$/i.test(fixtureId)) return null;
  const shell = await getPublicCompetition(orgSlug, compSlug);
  if (!shell) return null;
  const division = shell.divisions.find((d) => d.slug === divSlug);
  if (!division) return null;

  const detail = await unstable_cache(
    async () => {
      const [fixture] = await sql<PublicFixture[]>`
        select id, division_id, stage_id, pool_id, round_no, seq_in_round,
               home_entrant_id, away_entrant_id, scheduled_at, venue, court_label,
               status, outcome, summary, last_seq
        from public_fixtures_v
        where id = ${fixtureId} and division_id = ${division.id} limit 1`;
      if (!fixture) return null;
      const names = await sql<{ id: string; display_name: string }[]>`
        select id, display_name from public_entrants_v
        where division_id = ${division.id}`;
      const [rt] = await sql<{ realtime: boolean }[]>`
        select org_has_feature(${shell.org.id}, 'realtime') as realtime`;
      return {
        fixture,
        entrantNames: Object.fromEntries(names.map((n) => [n.id, n.display_name])),
        realtime: rt?.realtime === true,
      };
    },
    ["pub-fixture", fixtureId],
    { tags: [divisionTag(division.id)], revalidate: REVALIDATE_FAST },
  )();
  if (!detail) return null;

  return { org: shell.org, competition: shell.competition, division, ...detail };
}

/** Player card (consent-gated: the view only contains consented persons). */
export async function getPublicPlayer(
  orgSlug: string,
  compSlug: string,
  personId: string,
): Promise<{
  org: PublicOrg;
  competition: PublicCompetition;
  player: PublicPlayer;
  memberships: { division_name: string; division_slug: string; entrant_name: string; squad_number: number | null; position: string | null }[];
} | null> {
  if (!/^[0-9a-f-]{36}$/i.test(personId)) return null;
  const shell = await getPublicCompetition(orgSlug, compSlug);
  if (!shell) return null;

  const detail = await unstable_cache(
    async () => {
      const [player] = await sql<PublicPlayer[]>`
        select id, org_id, name, photo from public_players_v
        where id = ${personId} and org_id = ${shell.org.id} limit 1`;
      if (!player) return null;
      // Memberships within THIS competition, via the consent-filtered members
      // payload (person_id present only with consent — same gate as the card).
      const memberships = await sql<
        { division_name: string; division_slug: string; entrant_name: string; squad_number: number | null; position: string | null }[]
      >`
        select d.name as division_name, d.slug as division_slug,
               e.display_name as entrant_name,
               (m->>'squad_number')::int as squad_number,
               m->>'position' as position
        from public_entrants_v e
        join public_divisions_v d on d.id = e.division_id
        cross join lateral jsonb_array_elements(e.members) m
        where d.competition_id = ${shell.competition.id}
          and m->>'person_id' = ${personId}`;
      return { player, memberships };
    },
    ["pub-player", shell.competition.id, personId],
    { tags: [competitionTag(shell.competition.id)], revalidate: REVALIDATE_SLOW },
  )();
  if (!detail) return null;

  return { org: shell.org, competition: shell.competition, ...detail };
}

/**
 * Realtime entitlement for a public fixture's org (token route, doc 09 §4).
 * Uncached-tagless: short TTL via unstable_cache keyed on fixture id.
 */
export async function fixtureRealtimeEligible(fixtureId: string): Promise<boolean> {
  if (!/^[0-9a-f-]{36}$/i.test(fixtureId)) return false;
  const [row] = await sql<{ realtime: boolean }[]>`
    select org_has_feature(c.org_id, 'realtime') as realtime
    from public_fixtures_v f
    join public_divisions_v d on d.id = f.division_id
    join public_competitions_v c on c.id = d.competition_id
    where f.id = ${fixtureId} limit 1`;
  return row?.realtime === true;
}

/** Sitemap source: every `public` competition with its division slugs. */
export async function listPublicSitemapEntries(): Promise<
  { orgSlug: string; compSlug: string; divisionSlugs: string[]; updated: string }[]
> {
  const rows = await sql<
    { org_slug: string; comp_slug: string; div_slug: string | null; created_at: string }[]
  >`
    select o.slug as org_slug, c.slug as comp_slug, d.slug as div_slug, c.created_at
    from public_competitions_v c
    join organizations o on o.id = c.org_id
    left join public_divisions_v d on d.competition_id = c.id
    where c.visibility = 'public'
    order by o.slug, c.slug`;
  const map = new Map<string, { orgSlug: string; compSlug: string; divisionSlugs: string[]; updated: string }>();
  for (const r of rows) {
    const key = `${r.org_slug}/${r.comp_slug}`;
    const entry = map.get(key) ?? {
      orgSlug: r.org_slug,
      compSlug: r.comp_slug,
      divisionSlugs: [],
      updated: r.created_at,
    };
    if (r.div_slug) entry.divisionSlugs.push(r.div_slug);
    map.set(key, entry);
  }
  return [...map.values()];
}
