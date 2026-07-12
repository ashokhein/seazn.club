import "server-only";
// Slug-chain resolution for /o console URLs (PROMPT-30, v3/01 §2). Each level
// resolves live rows first; a miss falls back to slug_history so renamed
// slugs answer { renamedTo } and callers can permanent-redirect. React
// cache() dedupes lookups across layout + page within one request.
//
// Reads run like resourceOrg (api-v1/auth): plain `sql`, before any tenant
// context exists — slugs are public URL material, membership is enforced by
// the page-auth wrappers, and existence never leaks past them.
import { cache } from "react";
import { sql } from "@/lib/db";
import { routes } from "@/lib/routes";
import { cacheGet, cacheSet, cacheDelPattern } from "@/lib/cache";

// Read-through cache for LIVE slug rows only (v3 perf wave). Renames and
// misses always hit Postgres: they're rare, and the slug_history fallback is
// correctness-critical. TTL bounds staleness if an invalidation is missed;
// rename paths call invalidateSlugCache explicitly.
const SLUG_TTL_SECONDS = 60;
const slugKey = (
  kind: "org" | "competition" | "division",
  parentId: string | null,
  slug: string,
): string =>
  kind === "org" ? `slug:org:${slug}` : `slug:${kind === "competition" ? "comp" : "div"}:${parentId}:${slug}`;

/** Drop cached resolutions for the given slugs (old + new after a rename). */
export async function invalidateSlugCache(
  kind: "org" | "competition" | "division",
  parentId: string | null,
  ...slugs: (string | null | undefined)[]
): Promise<void> {
  await Promise.all(
    slugs.filter((s): s is string => Boolean(s)).map((s) => cacheDelPattern(slugKey(kind, parentId, s))),
  );
}

export interface ResolvedEntity {
  id: string;
  name: string;
  slug: string;
}

export type Resolution = ResolvedEntity | { renamedTo: string } | null;

// Each `xxxUncached` function holds the actual cache-aside + fallback logic
// and is exported so tests can assert it directly — React's cache() (below)
// memoizes per request, which would make a second same-args call in one test
// skip the body (and the Redis cache we're testing) entirely.
export async function orgBySlugUncached(slug: string): Promise<Resolution> {
  const key = slugKey("org", null, slug);
  const hit = await cacheGet<ResolvedEntity>(key);
  if (hit) return hit;
  const [live] = await sql<ResolvedEntity[]>`
    select id, name, slug from organizations where slug = ${slug}`;
  if (live) {
    await cacheSet(key, live, SLUG_TTL_SECONDS);
    return live;
  }
  const [hist] = await sql<{ entity_id: string }[]>`
    select entity_id from slug_history
    where entity_type = 'org' and parent_id is null and old_slug = ${slug}`;
  if (!hist) return null;
  const [target] = await sql<{ slug: string }[]>`
    select slug from organizations where id = ${hist.entity_id}`;
  return target ? { renamedTo: target.slug } : null;
}
export const orgBySlug = cache(orgBySlugUncached);

export async function compBySlugUncached(orgId: string, slug: string): Promise<Resolution> {
  const key = slugKey("competition", orgId, slug);
  const hit = await cacheGet<ResolvedEntity>(key);
  if (hit) return hit;
  const [live] = await sql<ResolvedEntity[]>`
    select id, name, slug from competitions
    where org_id = ${orgId} and slug = ${slug}`;
  if (live) {
    await cacheSet(key, live, SLUG_TTL_SECONDS);
    return live;
  }
  const [hist] = await sql<{ entity_id: string }[]>`
    select entity_id from slug_history
    where entity_type = 'competition' and parent_id = ${orgId} and old_slug = ${slug}`;
  if (!hist) return null;
  const [target] = await sql<{ slug: string }[]>`
    select slug from competitions where id = ${hist.entity_id} and org_id = ${orgId}`;
  return target ? { renamedTo: target.slug } : null;
}
export const compBySlug = cache(compBySlugUncached);

export async function divBySlugUncached(competitionId: string, slug: string): Promise<Resolution> {
  const key = slugKey("division", competitionId, slug);
  const hit = await cacheGet<ResolvedEntity>(key);
  if (hit) return hit;
  const [live] = await sql<ResolvedEntity[]>`
    select id, name, slug from divisions
    where competition_id = ${competitionId} and slug = ${slug}`;
  if (live) {
    await cacheSet(key, live, SLUG_TTL_SECONDS);
    return live;
  }
  const [hist] = await sql<{ entity_id: string }[]>`
    select entity_id from slug_history
    where entity_type = 'division' and parent_id = ${competitionId} and old_slug = ${slug}`;
  if (!hist) return null;
  const [target] = await sql<{ slug: string }[]>`
    select slug from divisions
    where id = ${hist.entity_id} and competition_id = ${competitionId}`;
  return target ? { renamedTo: target.slug } : null;
}
export const divBySlug = cache(divBySlugUncached);

export const fixtureByNo = cache(
  async (divisionId: string, no: number): Promise<{ id: string } | null> => {
    if (!Number.isInteger(no) || no < 1) return null;
    const [row] = await sql<{ id: string }[]>`
      select id from fixtures where division_id = ${divisionId} and fixture_no = ${no}`;
    return row ?? null;
  },
);

export interface BreadcrumbNames {
  /** compSlug → competition name */
  comps: Record<string, string>;
  /** `${compSlug}/${divSlug}` → division name */
  divs: Record<string, string>;
}

/** Everything the breadcrumb needs to label any path under one org — two
 *  queries at the org layout, zero per-page wiring (v3/01 §3). */
export const breadcrumbNames = cache(async (orgId: string): Promise<BreadcrumbNames> => {
  const comps = await sql<{ slug: string; name: string }[]>`
    select slug, name from competitions where org_id = ${orgId}`;
  const divs = await sql<{ comp_slug: string; slug: string; name: string }[]>`
    select c.slug as comp_slug, d.slug, d.name
    from divisions d join competitions c on c.id = d.competition_id
    where c.org_id = ${orgId}`;
  return {
    comps: Object.fromEntries(comps.map((c) => [c.slug, c.name])),
    divs: Object.fromEntries(divs.map((d) => [`${d.comp_slug}/${d.slug}`, d.name])),
  };
});

/** Public /shared fallback (v3/01 §2): a renamed slug's old URL 301s to the
 *  new one at the same depth. Returns null when nothing to redirect. */
export async function sharedRenameTarget(
  orgSlug: string,
  compSlug?: string,
  divSlug?: string,
): Promise<string | null> {
  const org = await orgBySlug(orgSlug);
  if (org && "renamedTo" in org) return routes.shared(org.renamedTo, compSlug, divSlug);
  if (!org || !compSlug) return null;
  const comp = await compBySlug(org.id, compSlug);
  if (comp && "renamedTo" in comp) return routes.shared(orgSlug, comp.renamedTo, divSlug);
  if (!comp || !divSlug) return null;
  const div = await divBySlug(comp.id, divSlug);
  if (div && "renamedTo" in div) return routes.shared(orgSlug, compSlug, div.renamedTo);
  return null;
}
