import { sql } from "@/lib/db";
import { getActiveOrgId, requireOrgRole, requireUser } from "@/lib/auth";
import { handler } from "@/lib/http";
import { EDITOR_ROLES, createSeasonSchema, type Season } from "@/lib/types";

/** List seasons within the current user's active organization. */
export async function GET() {
  return handler(async () => {
    await requireUser();
    const orgId = await getActiveOrgId();
    if (!orgId) return [] as Season[];
    return sql<Season[]>`
      select id, org_id, name, slug, created_at from seasons
      where org_id = ${orgId} order by created_at asc`;
  });
}

/** Create a season in the active org (editors only). */
export async function POST(req: Request) {
  return handler(async () => {
    const orgId = await getActiveOrgId();
    if (!orgId) throw new Error("Select or create an organization first");
    await requireOrgRole(orgId, EDITOR_ROLES);
    const { name, slug } = createSeasonSchema.parse(await req.json());
    const existing = await sql`
      select 1 from seasons where org_id = ${orgId} and slug = ${slug}`;
    if (existing.length)
      throw new Error("A season with that slug already exists");
    const [season] = await sql<Season[]>`
      insert into seasons (org_id, name, slug)
      values (${orgId}, ${name}, ${slug})
      returning id, org_id, name, slug, created_at`;
    return season;
  });
}
