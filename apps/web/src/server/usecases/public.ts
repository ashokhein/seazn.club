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
import { maskDisplayName, resolveNameDisplay } from "@/lib/name-display";

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
    const entrants = await sql<
      { kind: string; display_name: string; members: { name?: string | null }[] | null }[]
    >`
      select id, kind, display_name, seed, status, members
      from public_entrants_v where division_id = ${division.id}
      order by seed nulls last, display_name`;
    // Youth privacy (v3/11 gap 8): person-shaped names mask to "Arun K."
    // when the division resolves first_initial. Team names are not personal
    // and pass through; member names (already consent-gated) mask too. The
    // standings/schedule pages join names from this payload, so masking here
    // covers every public dashboard surface.
    const [priv] = await sql<{ youth: boolean; player_name_display: string | null }[]>`
      select youth, player_name_display from divisions where id = ${division.id}`;
    const mode = resolveNameDisplay(priv?.player_name_display ?? null, priv?.youth ?? false);
    const masked =
      mode === "full"
        ? entrants
        : entrants.map((e) => ({
            ...e,
            display_name:
              e.kind === "team" ? e.display_name : maskDisplayName(e.display_name, mode),
            members: (e.members ?? [])?.map((m) => ({
              ...m,
              name: m.name ? maskDisplayName(m.name, mode) : m.name,
            })),
          }));
    return { division_id: division.id, entrants: masked };
  });
}

// ---------------------------------------------------------------------------
// Discovery directory (doc 15 §4, PROMPT-19). One SELECT on public_discovery_v
// — the view already applies consent (no person data), opt-in, block, org
// status and the quality floor. Redis 30 s in front; the route adds
// s-maxage=60. Anonymous homepage traffic never touches hot tenant paths.
// ---------------------------------------------------------------------------

export interface DiscoveryEntry {
  id: string;
  name: string;
  slug: string;
  starts_on: string | null;
  ends_on: string | null;
  status: string;
  city: string | null;
  country: string | null;
  tagline: string | null;
  hero_image_path: string | null;
  featured: boolean;
  org_name: string;
  org_slug: string;
  sports: string[] | null;
  entrant_count: number;
  in_play_count: number;
  next_fixture_at: string | null;
}

export interface DiscoveryQuery {
  sport?: string;
  country?: string;
  status?: "live" | "upcoming";
  q?: string;
  offset?: number;
  limit?: number;
}

const DISCOVERY_MAX_LIMIT = 48;

/** Doc 15 §3 default ordering: featured row first, then in-play, then start-
 *  date proximity; ties by entrant count. Offset paging (rank order is not
 *  keyset-able); the route wraps the offset in the opaque cursor. */
export async function discoveryList(
  query: DiscoveryQuery,
): Promise<{ items: DiscoveryEntry[]; nextOffset: number | null }> {
  const limit = Math.min(Math.max(query.limit ?? 24, 1), DISCOVERY_MAX_LIMIT);
  const offset = Math.max(query.offset ?? 0, 0);
  const key =
    `pub:v1:discovery:${query.sport ?? ""}:${query.country ?? ""}:` +
    `${query.status ?? ""}:${query.q ?? ""}:${offset}:${limit}`;
  return cached(key, async () => {
    const rows = await sql<DiscoveryEntry[]>`
      select * from public_discovery_v
      where true
        ${query.sport ? sql`and ${query.sport} = any(sports)` : sql``}
        ${query.country ? sql`and lower(country) = lower(${query.country})` : sql``}
        ${query.q ? sql`and (name ilike ${"%" + query.q + "%"} or org_name ilike ${"%" + query.q + "%"})` : sql``}
        ${
          query.status === "live"
            ? sql`and in_play_count > 0`
            : query.status === "upcoming"
              ? sql`and in_play_count = 0
                    and (starts_on >= current_date or next_fixture_at is not null)`
              : sql``
        }
      order by featured desc,
               (in_play_count > 0) desc,
               abs(extract(epoch from (coalesce(starts_on, current_date + 3650)::timestamp - now()))) asc,
               entrant_count desc, id
      limit ${limit + 1} offset ${offset}`;
    const items = rows.slice(0, limit);
    return { items, nextOffset: rows.length > limit ? offset + limit : null };
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
