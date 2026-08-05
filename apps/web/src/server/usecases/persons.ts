import "server-only";
// Person use-cases (doc 08 §3): org-wide people registry, per-sport profiles,
// merge (dedupe). DOB/consent live here and are NEVER exposed publicly — the
// public read model goes through the consent-filtered views only.
import { createHash } from "node:crypto";
import { withTenant } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { supabaseAdmin } from "@/lib/supabase-admin";
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
  photo_path: string | null;
  /** Set once a player has claimed this row (PROMPT-53). */
  user_id: string | null;
  created_at: string;
  /** listPersons only: an open, unexpired claim invite exists. */
  claim_pending?: boolean;
}

const COLS = ["id", "full_name", "dob", "gender", "consent", "external_ref", "photo_path", "user_id", "created_at"] as const;

// #404: `merged_into is null` on every read below is load-bearing, not defensive.
// An absorbed person is TOMBSTONED rather than deleted (six dependent tables are
// `on delete cascade`), so the row is still there and still passes RLS. Nothing
// in the type system catches a read that forgets the filter — a tombstone that
// leaks back into a list, a lookup or a guard is offered to the organiser as a
// live person and can be rostered, suspended, claimed or edited all over again.
// The merge history (person-merge.ts) is the one read that must see them.

// Player photos ride the same public 'assets' bucket as club badges; the
// public_photo consent flag gates display, not upload.
const PHOTO_BUCKET = "assets";
const PHOTO_MIME = new Map<string, string>([
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
  ["image/webp", "webp"],
]);

export async function listPersons(auth: AuthCtx, query: ListQuery): Promise<Page<PersonRow>> {
  return withTenant(auth.orgId, async (tx) => {
    // claim_pending drives the console's invite → pending → claimed states
    // (PROMPT-53) — computed on the list read only.
    const rows = query.cursor
      ? await tx<PersonRow[]>`
          select ${tx(COLS)},
                 exists(select 1 from person_claims pc
                        where pc.person_id = persons.id and pc.claimed_at is null
                          and pc.revoked_at is null and pc.expires_at > now()) as claim_pending
          from persons
          where merged_into is null
            and (created_at, id) > (${query.cursor.createdAt}, ${query.cursor.id})
          order by created_at, id limit ${query.limit + 1}`
      : await tx<PersonRow[]>`
          select ${tx(COLS)},
                 exists(select 1 from person_claims pc
                        where pc.person_id = persons.id and pc.claimed_at is null
                          and pc.revoked_at is null and pc.expires_at > now()) as claim_pending
          from persons where merged_into is null
          order by created_at, id limit ${query.limit + 1}`;
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

export interface PhotoFile {
  contentType: string;
  bytes: Buffer;
}

/** The one place person-photo bytes reach storage (PROMPT-65 §2 shares it
 *  with the /me self-service route): MIME-check, content-hash path, upload.
 *  Returns the storage path to record on persons.photo_path. */
export async function uploadPersonPhotoBytes(orgId: string, file: PhotoFile): Promise<string> {
  const ext = PHOTO_MIME.get(file.contentType);
  if (!ext) throw new HttpError(415, `unsupported image type '${file.contentType}'`);
  const hash = createHash("sha256").update(file.bytes).digest("hex").slice(0, 32);
  const path = `orgs/${orgId}/persons/${hash}.${ext}`;
  const { error } = await supabaseAdmin()
    .storage.from(PHOTO_BUCKET)
    .upload(path, file.bytes, { contentType: file.contentType, upsert: true });
  if (error) throw new HttpError(502, `photo upload failed: ${error.message}`);
  return path;
}

/** Upload a player's photo to storage and record its path (content-hash
 *  dedupe, mirroring club badges). */
export async function setPersonPhoto(auth: AuthCtx, id: string, file: PhotoFile): Promise<PersonRow> {
  const path = await uploadPersonPhotoBytes(auth.orgId, file);
  return withTenant(auth.orgId, async (tx) => {
    const [person] = await tx<PersonRow[]>`
      select id from persons where id = ${id} and merged_into is null`;
    if (!person) throw new HttpError(404, "person not found");
    const [row] = await tx<PersonRow[]>`
      update persons set photo_path = ${path} where id = ${id} returning ${tx(COLS)}`;
    return row!;
  });
}

export async function getPerson(auth: AuthCtx, id: string): Promise<PersonRow> {
  return withTenant(auth.orgId, async (tx) => {
    const [row] = await tx<PersonRow[]>`
      select ${tx(COLS)} from persons where id = ${id} and merged_into is null`;
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
      where id = ${id} and merged_into is null returning ${tx(COLS)}`;
    if (!row) throw new HttpError(404, "person not found");
    return row;
  });
}

// The merge lives in person-merge.ts (#404). It used to end here with
// `delete from persons where id = duplicateId`, which cascade-destroyed the
// absorbed person's discipline history, stats, club membership, account claim
// and RSVPs; it now tombstones instead, and is reversible.

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
    const [person] = await tx`
      select 1 from persons where id = ${personId} and merged_into is null`;
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
