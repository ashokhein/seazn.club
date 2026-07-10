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

export interface ResolvedEntity {
  id: string;
  name: string;
  slug: string;
}

export type Resolution = ResolvedEntity | { renamedTo: string } | null;

export const orgBySlug = cache(async (slug: string): Promise<Resolution> => {
  const [live] = await sql<ResolvedEntity[]>`
    select id, name, slug from organizations where slug = ${slug}`;
  if (live) return live;
  const [hist] = await sql<{ entity_id: string }[]>`
    select entity_id from slug_history
    where entity_type = 'org' and parent_id is null and old_slug = ${slug}`;
  if (!hist) return null;
  const [target] = await sql<{ slug: string }[]>`
    select slug from organizations where id = ${hist.entity_id}`;
  return target ? { renamedTo: target.slug } : null;
});

export const compBySlug = cache(
  async (orgId: string, slug: string): Promise<Resolution> => {
    const [live] = await sql<ResolvedEntity[]>`
      select id, name, slug from competitions
      where org_id = ${orgId} and slug = ${slug}`;
    if (live) return live;
    const [hist] = await sql<{ entity_id: string }[]>`
      select entity_id from slug_history
      where entity_type = 'competition' and parent_id = ${orgId} and old_slug = ${slug}`;
    if (!hist) return null;
    const [target] = await sql<{ slug: string }[]>`
      select slug from competitions where id = ${hist.entity_id} and org_id = ${orgId}`;
    return target ? { renamedTo: target.slug } : null;
  },
);

export const divBySlug = cache(
  async (competitionId: string, slug: string): Promise<Resolution> => {
    const [live] = await sql<ResolvedEntity[]>`
      select id, name, slug from divisions
      where competition_id = ${competitionId} and slug = ${slug}`;
    if (live) return live;
    const [hist] = await sql<{ entity_id: string }[]>`
      select entity_id from slug_history
      where entity_type = 'division' and parent_id = ${competitionId} and old_slug = ${slug}`;
    if (!hist) return null;
    const [target] = await sql<{ slug: string }[]>`
      select slug from divisions
      where id = ${hist.entity_id} and competition_id = ${competitionId}`;
    return target ? { renamedTo: target.slug } : null;
  },
);

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
