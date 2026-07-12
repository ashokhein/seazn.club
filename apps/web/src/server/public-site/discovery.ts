import "server-only";
// Discovery read model for the marketing surfaces (doc 15 §2, PROMPT-19).
// Server Components only; every query starts from public_discovery_v (the
// consent/opt-in/block/quality filter is structurally unavoidable) and joins
// public_*_v views for live fixture info. Cached under the shared `discovery`
// ISR tag — revalidated on opt-in/out, staff curation and fixture-decided
// writes of discoverable competitions (see revalidate.ts).
import { unstable_cache } from "next/cache";
import { sql } from "@/lib/db";
import { DISCOVERY_TAG, REVALIDATE_FAST } from "./data";
import type { DiscoveryEntry } from "@/server/usecases/public";

export type { DiscoveryEntry };

export interface DiscoveryLiveFixture {
  id: string;
  sport_key: string;
  headline: string | null;
  competition_name: string;
  org_slug: string;
  comp_slug: string;
  division_slug: string;
}

/** "Live right now" strip (doc 15 §2): up to ~6 in-play fixtures across all
 *  discoverable competitions. Summary comes from match_states via
 *  public_fixtures_v — render-agnostic score lines, never person data. */
export const getDiscoveryLive = unstable_cache(
  async (): Promise<DiscoveryLiveFixture[]> => {
    const rows = await sql<
      (Omit<DiscoveryLiveFixture, "headline"> & {
        summary: { headline?: string } | null;
      })[]
    >`
      select f.id, d.sport_key, f.summary,
             disc.name as competition_name, disc.org_slug,
             disc.slug as comp_slug, d.slug as division_slug
      from public_discovery_v disc
      join public_divisions_v d on d.competition_id = disc.id
      join public_fixtures_v f on f.division_id = d.id
      where f.status = 'in_play'
      order by f.scheduled_at nulls last, f.id
      limit 6`;
    return rows.map(({ summary, ...r }) => ({ ...r, headline: summary?.headline ?? null }));
  },
  ["discovery-live"],
  { tags: [DISCOVERY_TAG], revalidate: REVALIDATE_FAST },
);

/** The /live floodlit wall: every in-play fixture across discoverable
 *  competitions (same shape/filters as the strip, page-sized cap). The home
 *  ticker keeps its 6; this is where "all of it" lives. */
export const getDiscoveryLiveAll = unstable_cache(
  async (): Promise<DiscoveryLiveFixture[]> => {
    const rows = await sql<
      (Omit<DiscoveryLiveFixture, "headline"> & {
        summary: { headline?: string } | null;
      })[]
    >`
      select f.id, d.sport_key, f.summary,
             disc.name as competition_name, disc.org_slug,
             disc.slug as comp_slug, d.slug as division_slug
      from public_discovery_v disc
      join public_divisions_v d on d.competition_id = disc.id
      join public_fixtures_v f on f.division_id = d.id
      where f.status = 'in_play'
      order by f.scheduled_at nulls last, f.id
      limit 60`;
    return rows.map(({ summary, ...r }) => ({ ...r, headline: summary?.headline ?? null }));
  },
  ["discovery-live-all"],
  { tags: [DISCOVERY_TAG], revalidate: REVALIDATE_FAST },
);

/** "Happening this week" cards (doc 15 §2): upcoming discoverable
 *  competitions — starting within 7 days or with a scheduled fixture ahead. */
export const getDiscoveryThisWeek = unstable_cache(
  async (): Promise<DiscoveryEntry[]> => {
    return sql<DiscoveryEntry[]>`
      select * from public_discovery_v
      where in_play_count = 0
        and ((starts_on >= current_date and starts_on < current_date + 7)
          or (next_fixture_at is not null and next_fixture_at < now() + interval '7 days'))
      order by featured desc, coalesce(starts_on, current_date) asc,
               entrant_count desc, id
      limit 6`;
  },
  ["discovery-week"],
  { tags: [DISCOVERY_TAG], revalidate: REVALIDATE_FAST },
);

export interface DirectoryFilters {
  sport?: string;
  country?: string;
  status?: "live" | "upcoming";
  q?: string;
}

/** /discover directory (doc 15 §2): filterable, searchable, ordered per doc
 *  15 §3 (featured → in-play → start proximity → entrant count). */
export async function getDiscoveryDirectory(
  filters: DirectoryFilters,
  limit = 48,
): Promise<DiscoveryEntry[]> {
  return unstable_cache(
    async () => {
      return sql<DiscoveryEntry[]>`
        select * from public_discovery_v
        where true
          ${filters.sport ? sql`and ${filters.sport} = any(sports)` : sql``}
          ${filters.country ? sql`and lower(country) = lower(${filters.country})` : sql``}
          ${filters.q ? sql`and (name ilike ${"%" + filters.q + "%"} or org_name ilike ${"%" + filters.q + "%"})` : sql``}
          ${
            filters.status === "live"
              ? sql`and in_play_count > 0`
              : filters.status === "upcoming"
                ? sql`and in_play_count = 0
                      and (starts_on >= current_date or next_fixture_at is not null)`
                : sql``
          }
        order by featured desc,
                 (in_play_count > 0) desc,
                 abs(extract(epoch from (coalesce(starts_on, current_date + 3650)::timestamp - now()))) asc,
                 entrant_count desc, id
        limit ${limit}`;
    },
    [
      "discovery-dir",
      filters.sport ?? "",
      filters.country ?? "",
      filters.status ?? "",
      filters.q ?? "",
      String(limit),
    ],
    { tags: [DISCOVERY_TAG], revalidate: REVALIDATE_FAST },
  )();
}

/** Sports that currently have discoverable competitions (sitemap + /discover
 *  sport filter chips), joined to the catalog for display names. */
export const listDiscoverySports = unstable_cache(
  async (): Promise<{ key: string; name: string }[]> => {
    return sql<{ key: string; name: string }[]>`
      select s.key, s.name
      from sports s
      where s.key in (select unnest(sports) from public_discovery_v)
      order by s.name`;
  },
  ["discovery-sports"],
  { tags: [DISCOVERY_TAG], revalidate: REVALIDATE_FAST },
);
