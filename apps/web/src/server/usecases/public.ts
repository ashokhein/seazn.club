import "server-only";
// Public read model (doc 08 §3 public block, §6 caching). No auth: every query
// goes through the consent-filtered public_*_v views ONLY (superuser
// connection — the views themselves restrict to visibility='public' and strip
// person data per consent). Redis cache-aside in front; scoring writes
// invalidate the same keys they make stale.
import { sql } from "@/lib/db";
import { cacheGet, cacheSet } from "@/lib/cache";
import { HttpError } from "@/lib/errors";
import { rateLimit } from "@/lib/rate-limit";

// s-maxage=30 at the edge (doc 08 §6); Redis mirrors that window.
export const PUBLIC_CACHE_CONTROL = "public, s-maxage=30, stale-while-revalidate=300";
const TTL_SECONDS = 30;

/** Per-IP limit for unauthenticated reads (doc 08 §6: 60/min). */
export async function publicRateLimit(req: Request): Promise<void> {
  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    req.headers.get("x-real-ip") ??
    "unknown";
  await rateLimit(`pubv1:${ip}`, { max: 60, windowSeconds: 60 });
}

async function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
  const hit = await cacheGet<T>(key);
  if (hit !== null) return hit;
  const fresh = await load();
  await cacheSet(key, fresh, TTL_SECONDS);
  return fresh;
}

interface PublicCompetition {
  id: string;
  org_id: string;
  name: string;
  slug: string;
  description: string | null;
  starts_on: string | null;
  ends_on: string | null;
  branding: unknown;
  status: string;
}

async function findCompetition(orgSlug: string, slug: string): Promise<PublicCompetition> {
  const [row] = await sql<PublicCompetition[]>`
    select c.id, c.org_id, c.name, c.slug, c.description, c.starts_on, c.ends_on,
           c.branding, c.status
    from public_competitions_v c
    join organizations o on o.id = c.org_id
    where o.slug = ${orgSlug} and c.slug = ${slug} limit 1`;
  if (!row) throw new HttpError(404, "competition not found");
  return row;
}

async function findDivision(
  orgSlug: string,
  compSlug: string,
  divSlug: string,
): Promise<{ id: string; competition_id: string }> {
  const [row] = await sql<{ id: string; competition_id: string }[]>`
    select d.id, d.competition_id
    from public_divisions_v d
    join public_competitions_v c on c.id = d.competition_id
    join organizations o on o.id = c.org_id
    where o.slug = ${orgSlug} and c.slug = ${compSlug} and d.slug = ${divSlug} limit 1`;
  if (!row) throw new HttpError(404, "division not found");
  return row;
}

/** Competition landing: description + its divisions. */
export async function publicCompetition(orgSlug: string, slug: string): Promise<unknown> {
  return cached(`pub:v1:comp:${orgSlug}:${slug}`, async () => {
    const full = await findCompetition(orgSlug, slug);
    const competition = { ...full, org_id: undefined };
    const divisions = await sql`
      select id, name, slug, sport_key, variant_key, status
      from public_divisions_v where competition_id = ${competition.id}
      order by created_at, id`;
    return { ...competition, divisions };
  });
}

export async function publicSchedule(
  orgSlug: string,
  compSlug: string,
  divSlug: string,
): Promise<unknown> {
  const division = await findDivision(orgSlug, compSlug, divSlug);
  return cached(`pub:v1:div:${division.id}:schedule`, async () => {
    const fixtures = await sql`
      select id, stage_id, pool_id, round_no, seq_in_round, home_entrant_id,
             away_entrant_id, scheduled_at, venue, court_label, status, outcome, summary
      from public_fixtures_v where division_id = ${division.id}
      order by round_no, seq_in_round`;
    return { division_id: division.id, fixtures };
  });
}

export async function publicStandings(
  orgSlug: string,
  compSlug: string,
  divSlug: string,
): Promise<unknown> {
  const division = await findDivision(orgSlug, compSlug, divSlug);
  return cached(`pub:v1:div:${division.id}:standings`, async () => {
    const standings = await sql`
      select stage_id, pool_id, rows, updated_at
      from public_standings_v where division_id = ${division.id}`;
    return { division_id: division.id, standings };
  });
}

export async function publicEntrants(
  orgSlug: string,
  compSlug: string,
  divSlug: string,
): Promise<unknown> {
  const division = await findDivision(orgSlug, compSlug, divSlug);
  return cached(`pub:v1:div:${division.id}:entrants`, async () => {
    const entrants = await sql`
      select id, kind, display_name, seed, status, members
      from public_entrants_v where division_id = ${division.id}
      order by seed nulls last, display_name`;
    return { division_id: division.id, entrants };
  });
}

/** Live public fixture summary (the score widget). */
export async function publicFixture(fixtureId: string): Promise<unknown> {
  if (!/^[0-9a-f-]{36}$/i.test(fixtureId)) throw new HttpError(404, "fixture not found");
  return cached(`pub:v1:fixture:${fixtureId}`, async () => {
    const [row] = await sql`
      select id, division_id, stage_id, round_no, seq_in_round, home_entrant_id,
             away_entrant_id, scheduled_at, venue, court_label, status, outcome,
             summary, last_seq
      from public_fixtures_v where id = ${fixtureId} limit 1`;
    if (!row) throw new HttpError(404, "fixture not found");
    return row;
  });
}
