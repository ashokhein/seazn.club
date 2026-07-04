import "server-only";
// Competition use-cases (doc 08 §3). The service layer both /api/v1 routes and
// Server Components call — the only writer. Auth happens in the route (an
// AuthCtx proves it); tenancy is enforced by withTenant + RLS.
import { withTenant } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import type { AuthCtx } from "@/server/api-v1/auth";
import { page, type ListQuery, type Page } from "@/server/api-v1/http";
import type { CreateCompetition, PatchCompetition } from "@/server/api-v1/schemas";

export interface CompetitionRow {
  id: string;
  org_id: string;
  name: string;
  slug: string;
  description: string | null;
  starts_on: string | null;
  ends_on: string | null;
  visibility: string;
  branding: unknown;
  status: string;
  created_at: string;
}

const COLS = [
  "id", "org_id", "name", "slug", "description", "starts_on", "ends_on",
  "visibility", "branding", "status", "created_at",
] as const;

export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return slug || "untitled";
}

export async function listCompetitions(
  auth: AuthCtx,
  query: ListQuery,
): Promise<Page<CompetitionRow>> {
  return withTenant(auth.orgId, async (tx) => {
    const rows = query.cursor
      ? await tx<CompetitionRow[]>`
          select ${tx(COLS)} from competitions
          where (created_at, id) < (${query.cursor.createdAt}, ${query.cursor.id})
          order by created_at desc, id desc limit ${query.limit + 1}`
      : await tx<CompetitionRow[]>`
          select ${tx(COLS)} from competitions
          order by created_at desc, id desc limit ${query.limit + 1}`;
    return page(rows, query.limit);
  });
}

export async function createCompetition(
  auth: AuthCtx,
  input: CreateCompetition,
): Promise<CompetitionRow> {
  const slug = input.slug ?? slugify(input.name);
  return withTenant(auth.orgId, async (tx) => {
    const [existing] = await tx`select 1 from competitions where slug = ${slug}`;
    if (existing) throw new HttpError(409, `slug '${slug}' is already in use`);
    const [row] = await tx<CompetitionRow[]>`
      insert into competitions (org_id, name, slug, description, starts_on, ends_on,
                                visibility, branding, created_by)
      values (${auth.orgId}, ${input.name}, ${slug}, ${input.description ?? null},
              ${input.starts_on ?? null}, ${input.ends_on ?? null}, ${input.visibility},
              ${tx.json(input.branding as never)}, ${auth.userId})
      returning ${tx(COLS)}`;
    return row;
  });
}

export async function getCompetition(auth: AuthCtx, id: string): Promise<CompetitionRow> {
  return withTenant(auth.orgId, async (tx) => {
    const [row] = await tx<CompetitionRow[]>`
      select ${tx(COLS)} from competitions where id = ${id}`;
    if (!row) throw new HttpError(404, "competition not found");
    return row;
  });
}

export async function patchCompetition(
  auth: AuthCtx,
  id: string,
  patch: PatchCompetition,
): Promise<CompetitionRow> {
  return withTenant(auth.orgId, async (tx) => {
    if (patch.slug) {
      const [taken] = await tx`
        select 1 from competitions where slug = ${patch.slug} and id <> ${id}`;
      if (taken) throw new HttpError(409, `slug '${patch.slug}' is already in use`);
    }
    // postgres.js dynamic column helper: only the provided keys are updated.
    const cols = Object.keys(patch) as (keyof PatchCompetition)[];
    const values = { ...patch, ...(patch.branding ? { branding: tx.json(patch.branding as never) } : {}) };
    const [row] = await tx<CompetitionRow[]>`
      update competitions set ${tx(values as never, ...(cols as never[]))}
      where id = ${id} returning ${tx(COLS)}`;
    if (!row) throw new HttpError(404, "competition not found");
    return row;
  });
}

export async function deleteCompetition(auth: AuthCtx, id: string): Promise<void> {
  return withTenant(auth.orgId, async (tx) => {
    // Guard: no deleting a competition with recorded play (ledger is precious).
    const [scored] = await tx`
      select 1 from score_events e
      join fixtures f on f.id = e.fixture_id
      join divisions d on d.id = f.division_id
      where d.competition_id = ${id} limit 1`;
    if (scored) {
      throw new HttpError(409, "competition has recorded score events — archive it instead");
    }
    const deleted = await tx`delete from competitions where id = ${id} returning id`;
    if (deleted.length === 0) throw new HttpError(404, "competition not found");
  });
}
