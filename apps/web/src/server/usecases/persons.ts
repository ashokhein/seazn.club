import "server-only";
// Person use-cases (doc 08 §3): org-wide people registry, per-sport profiles,
// merge (dedupe). DOB/consent live here and are NEVER exposed publicly — the
// public read model goes through the consent-filtered views only.
import { withTenant } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import type { AuthCtx } from "@/server/api-v1/auth";
import { page, type ListQuery, type Page } from "@/server/api-v1/http";
import type { CreatePerson, PatchPerson, PutProfile } from "@/server/api-v1/schemas";

export interface PersonRow {
  id: string;
  full_name: string;
  dob: string | null;
  gender: string | null;
  consent: unknown;
  external_ref: string | null;
  created_at: string;
}

const COLS = ["id", "full_name", "dob", "gender", "consent", "external_ref", "created_at"] as const;

export async function listPersons(auth: AuthCtx, query: ListQuery): Promise<Page<PersonRow>> {
  return withTenant(auth.orgId, async (tx) => {
    const rows = query.cursor
      ? await tx<PersonRow[]>`
          select ${tx(COLS)} from persons
          where (created_at, id) > (${query.cursor.createdAt}, ${query.cursor.id})
          order by created_at, id limit ${query.limit + 1}`
      : await tx<PersonRow[]>`
          select ${tx(COLS)} from persons order by created_at, id limit ${query.limit + 1}`;
    return page(rows, query.limit);
  });
}

export async function createPerson(auth: AuthCtx, input: CreatePerson): Promise<PersonRow> {
  return withTenant(auth.orgId, async (tx) => {
    const [row] = await tx<PersonRow[]>`
      insert into persons (org_id, full_name, dob, gender, consent, external_ref)
      values (${auth.orgId}, ${input.full_name}, ${input.dob ?? null}, ${input.gender ?? null},
              ${tx.json(input.consent as never)}, ${input.external_ref ?? null})
      returning ${tx(COLS)}`;
    return row;
  });
}

export async function getPerson(auth: AuthCtx, id: string): Promise<PersonRow> {
  return withTenant(auth.orgId, async (tx) => {
    const [row] = await tx<PersonRow[]>`select ${tx(COLS)} from persons where id = ${id}`;
    if (!row) throw new HttpError(404, "person not found");
    return row;
  });
}

export async function patchPerson(auth: AuthCtx, id: string, patch: PatchPerson): Promise<PersonRow> {
  return withTenant(auth.orgId, async (tx) => {
    const cols = Object.keys(patch);
    const values = { ...patch, ...(patch.consent ? { consent: tx.json(patch.consent as never) } : {}) };
    const [row] = await tx<PersonRow[]>`
      update persons set ${tx(values as never, ...(cols as never[]))}
      where id = ${id} returning ${tx(COLS)}`;
    if (!row) throw new HttpError(404, "person not found");
    return row;
  });
}

/**
 * Merge `duplicateId` into `id` (dedupe, doc 08 §3): repoint memberships,
 * lineups and profiles, then delete the duplicate. Score events reference
 * users, not persons — untouched.
 */
export async function mergePersons(
  auth: AuthCtx,
  id: string,
  duplicateId: string,
): Promise<PersonRow> {
  if (id === duplicateId) throw new HttpError(422, "cannot merge a person into itself");
  return withTenant(auth.orgId, async (tx) => {
    const [target] = await tx<PersonRow[]>`select ${tx(COLS)} from persons where id = ${id}`;
    if (!target) throw new HttpError(404, "person not found");
    const [dup] = await tx`select 1 from persons where id = ${duplicateId}`;
    if (!dup) throw new HttpError(404, "duplicate person not found");

    // Repoint where the target isn't already present; drop the remainder.
    await tx`
      update entrant_members set person_id = ${id}
      where person_id = ${duplicateId}
        and entrant_id not in (select entrant_id from entrant_members where person_id = ${id})`;
    await tx`delete from entrant_members where person_id = ${duplicateId}`;
    await tx`
      update lineups set person_id = ${id}
      where person_id = ${duplicateId}
        and (fixture_id, entrant_id) not in
            (select fixture_id, entrant_id from lineups where person_id = ${id})`;
    await tx`delete from lineups where person_id = ${duplicateId}`;
    await tx`
      update player_profiles set person_id = ${id}
      where person_id = ${duplicateId}
        and sport_key not in (select sport_key from player_profiles where person_id = ${id})`;
    await tx`delete from player_profiles where person_id = ${duplicateId}`;
    await tx`delete from persons where id = ${duplicateId}`;
    return target;
  });
}

export async function getProfile(auth: AuthCtx, personId: string, sportKey: string): Promise<unknown> {
  return withTenant(auth.orgId, async (tx) => {
    const [row] = await tx<{ attributes: unknown }[]>`
      select attributes from player_profiles
      where person_id = ${personId} and sport_key = ${sportKey}`;
    if (!row) throw new HttpError(404, "profile not found");
    return { person_id: personId, sport_key: sportKey, attributes: row.attributes };
  });
}

export async function putProfile(
  auth: AuthCtx,
  personId: string,
  sportKey: string,
  input: PutProfile,
): Promise<unknown> {
  return withTenant(auth.orgId, async (tx) => {
    const [person] = await tx`select 1 from persons where id = ${personId}`;
    if (!person) throw new HttpError(404, "person not found");
    const [sport] = await tx`select 1 from sports where key = ${sportKey}`;
    if (!sport) throw new HttpError(422, `unknown sport '${sportKey}'`);
    await tx`
      insert into player_profiles (person_id, sport_key, attributes, org_id)
      values (${personId}, ${sportKey}, ${tx.json(input.attributes as never)}, ${auth.orgId})
      on conflict (person_id, sport_key)
      do update set attributes = excluded.attributes`;
    return { person_id: personId, sport_key: sportKey, attributes: input.attributes };
  });
}
