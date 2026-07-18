import "server-only";
// Club use-cases (Jul3/01 §2, §5, §6): CRUD, the club detail (teams across
// divisions), and bulk logo assignment with content-hash dedupe. Clubs are the
// Pro `clubs.hierarchy` layer; a club's logo/colours cascade to child teams
// via team_display_v — never copied.
import { createHash } from "node:crypto";
import type postgres from "postgres";
import { withTenant } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { requireFeature, withinLimit, PaymentRequiredError } from "@/lib/entitlements";
import { supabaseAdmin } from "@/lib/supabase-admin";
import type { AuthCtx } from "@/server/api-v1/auth";
import { slugify, uniqueSlug } from "@/server/usecases/slugs";
import { fold } from "@seazn/engine/import";

export interface ClubRow {
  id: string;
  name: string;
  short_name: string | null;
  logo_path: string | null;
  colors: unknown;
  external_ref: string | null;
  slug: string | null;
  home_ground: string | null;
  website: string | null;
  notes: string | null;
  created_at: string;
}

const COLS = [
  "id", "name", "short_name", "logo_path", "colors", "external_ref",
  "slug", "home_ground", "website", "notes", "created_at",
] as const;

export async function listClubs(auth: AuthCtx): Promise<ClubRow[]> {
  return withTenant(auth.orgId, (tx) => tx<ClubRow[]>`
    select ${tx(COLS)} from clubs order by name, id`);
}

export interface CreateClubInput {
  name: string;
  short_name?: string;
  colors?: unknown;
  external_ref?: string;
  home_ground?: string;
  website?: string;
  notes?: string;
}

export async function createClub(auth: AuthCtx, input: CreateClubInput): Promise<ClubRow> {
  await requireFeature(auth.orgId, "clubs.hierarchy");
  const [{ n }] = await withTenant(auth.orgId, (tx) =>
    tx<{ n: number }[]>`select count(*)::int as n from clubs`);
  const cap = await withinLimit(auth.orgId, "clubs.max", n + 1);
  if (!cap.ok) throw new PaymentRequiredError("clubs.max");
  return withTenant(auth.orgId, async (tx) => {
    try {
      const slug = await uniqueSlug(slugify(input.name), async (s) => {
        const [hit] = await tx`select 1 from clubs where slug = ${s}`;
        return !!hit;
      });
      const [row] = await tx<ClubRow[]>`
        insert into clubs (org_id, name, short_name, colors, external_ref,
                           slug, home_ground, website, notes)
        values (${auth.orgId}, ${input.name}, ${input.short_name ?? null},
                ${input.colors === undefined ? null : tx.json(input.colors as never)},
                ${input.external_ref ?? null},
                ${slug}, ${input.home_ground ?? null},
                ${input.website ?? null}, ${input.notes ?? null})
        returning ${tx(COLS)}`;
      return row!;
    } catch (err) {
      if ((err as { code?: string }).code === "23505") {
        throw new HttpError(409, `a club named '${input.name}' already exists`);
      }
      throw err;
    }
  });
}

/** Club detail: the club plus its teams and where they are entered
 *  ("club → subcategories" view, Jul3/01 §8). */
export async function getClub(
  auth: AuthCtx,
  id: string,
): Promise<ClubRow & { teams: unknown[]; contacts: ClubContactRow[] }> {
  return withTenant(auth.orgId, async (tx) => {
    const [club] = await tx<ClubRow[]>`select ${tx(COLS)} from clubs where id = ${id}`;
    if (!club) throw new HttpError(404, "club not found");
    const teams = await tx<Record<string, unknown>[]>`
      select t.id, t.name, t.short_name,
             coalesce(t.logo_path, ${club.logo_path}) as logo_path,
             coalesce((select jsonb_agg(jsonb_build_object(
                        'division_id', e.division_id, 'entrant_id', e.id,
                        'division_name', d.name, 'competition_id', d.competition_id)
                       order by d.name)
                       from entrants e join divisions d on d.id = e.division_id
                       where e.team_id = t.id), '[]'::jsonb) as entries
      from teams t where t.club_id = ${id}
      order by t.name, t.id`;
    const contacts = await tx<ClubContactRow[]>`
      select ${tx(CONTACT_COLS)} from club_contacts where club_id = ${id}
      order by is_primary desc, role_key, full_name`;
    return { ...club, teams, contacts };
  });
}

export interface PatchClubInput {
  name?: string;
  short_name?: string | null;
  colors?: unknown;
  external_ref?: string | null;
  logo_path?: string | null;
  slug?: string | null;
  home_ground?: string | null;
  website?: string | null;
  notes?: string | null;
}

export async function patchClub(auth: AuthCtx, id: string, patch: PatchClubInput): Promise<ClubRow> {
  await requireFeature(auth.orgId, "clubs.hierarchy");
  return withTenant(auth.orgId, async (tx) => {
    // Re-slug only on an explicit `slug` set — a rename keeps the public URL
    // stable (W2 adds slug_history if we ever auto-rename).
    if (patch.slug !== undefined && patch.slug !== null) {
      patch.slug = slugify(patch.slug);
      const [dup] = await tx`select 1 from clubs where slug = ${patch.slug} and id <> ${id}`;
      if (dup) throw new HttpError(409, `slug '${patch.slug}' is taken — try '${patch.slug}-2'`);
    }
    const cols = Object.keys(patch);
    if (cols.length === 0) {
      const [row] = await tx<ClubRow[]>`select ${tx(COLS)} from clubs where id = ${id}`;
      if (!row) throw new HttpError(404, "club not found");
      return row;
    }
    const [row] = await tx<ClubRow[]>`
      update clubs set ${tx(patch as never, ...(cols as never[]))}
      where id = ${id} returning ${tx(COLS)}`;
    if (!row) throw new HttpError(404, "club not found");
    return row;
  });
}

export async function deleteClub(auth: AuthCtx, id: string): Promise<void> {
  await requireFeature(auth.orgId, "clubs.hierarchy");
  return withTenant(auth.orgId, async (tx) => {
    // teams.club_id is ON DELETE SET NULL — teams survive, badge falls back
    const [row] = await tx<{ id: string }[]>`delete from clubs where id = ${id} returning id`;
    if (!row) throw new HttpError(404, "club not found");
  });
}

// ---------------------------------------------------------------------------
// Club contacts (W1 §4.2/§5.2): FA officer model. is_primary is unique per
// club — setting it clears the previous primary in the same transaction.
// user_id/claimed_at are W3 claim-rail hooks (read-only here).
// ---------------------------------------------------------------------------

export interface ClubContactRow {
  id: string; club_id: string; role_key: string; full_name: string;
  email: string | null; phone: string | null; is_primary: boolean;
  user_id: string | null; claimed_at: string | null; created_at: string;
}
const CONTACT_COLS = ["id", "club_id", "role_key", "full_name", "email", "phone",
  "is_primary", "user_id", "claimed_at", "created_at"] as const;

async function assertClub(tx: postgres.TransactionSql, clubId: string) {
  const [c] = await tx`select 1 from clubs where id = ${clubId}`;
  if (!c) throw new HttpError(404, "club not found");
}

export async function listClubContacts(auth: AuthCtx, clubId: string): Promise<ClubContactRow[]> {
  return withTenant(auth.orgId, async (tx) => {
    await assertClub(tx, clubId);
    return tx<ClubContactRow[]>`
      select ${tx(CONTACT_COLS)} from club_contacts
      where club_id = ${clubId}
      order by is_primary desc, role_key, full_name`;
  });
}

export interface ContactInput {
  role_key: string; full_name: string;
  email?: string | null; phone?: string | null; is_primary?: boolean;
}

export async function createClubContact(
  auth: AuthCtx, clubId: string, input: ContactInput,
): Promise<ClubContactRow> {
  return withTenant(auth.orgId, async (tx) => {
    await assertClub(tx, clubId);
    if (input.is_primary)
      await tx`update club_contacts set is_primary = false where club_id = ${clubId}`;
    const [row] = await tx<ClubContactRow[]>`
      insert into club_contacts (org_id, club_id, role_key, full_name, email, phone, is_primary)
      values (${auth.orgId}, ${clubId}, ${input.role_key}, ${input.full_name},
              ${input.email ?? null}, ${input.phone ?? null}, ${input.is_primary ?? false})
      returning ${tx(CONTACT_COLS)}`;
    return row!;
  });
}

export async function patchClubContact(
  auth: AuthCtx, clubId: string, contactId: string, patch: Partial<ContactInput>,
): Promise<ClubContactRow> {
  return withTenant(auth.orgId, async (tx) => {
    await assertClub(tx, clubId);
    if (patch.is_primary)
      await tx`update club_contacts set is_primary = false
               where club_id = ${clubId} and id <> ${contactId}`;
    const cols = Object.keys(patch);
    const [row] = cols.length === 0
      ? await tx<ClubContactRow[]>`
          select ${tx(CONTACT_COLS)} from club_contacts
          where id = ${contactId} and club_id = ${clubId}`
      : await tx<ClubContactRow[]>`
          update club_contacts set ${tx(patch as never, ...(cols as never[]))}
          where id = ${contactId} and club_id = ${clubId}
          returning ${tx(CONTACT_COLS)}`;
    if (!row) throw new HttpError(404, "contact not found");
    return row;
  });
}

export async function deleteClubContact(
  auth: AuthCtx, clubId: string, contactId: string,
): Promise<void> {
  return withTenant(auth.orgId, async (tx) => {
    const [row] = await tx<{ id: string }[]>`
      delete from club_contacts where id = ${contactId} and club_id = ${clubId} returning id`;
    if (!row) throw new HttpError(404, "contact not found");
  });
}

// ---------------------------------------------------------------------------
// Bulk logos (Jul3/01 §5): filename-stem match → manual re-map → any-order.
// ---------------------------------------------------------------------------

const LOGO_BUCKET = "assets";
const LOGO_MAX_BYTES = 2 * 1024 * 1024;
const LOGO_MIME = new Map([
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
  ["image/webp", "webp"],
  ["image/svg+xml", "svg"],
]);

export interface LogoFile {
  filename: string;
  contentType: string;
  bytes: Buffer;
}

export interface LogoAssignment {
  filename: string;
  clubId: string | null;
  clubName: string | null;
  matchedBy: "filename" | "manual" | "order" | null;
  logoPath: string | null;
}

/**
 * Bulk-assign N logo files to clubs (Jul3/01 §5). `mapping` is the manual
 * re-map (filename → clubId) from the preview UI; `assignRemaining` switches
 * on the any-order mode: unmatched files fill unlogo'd clubs in order.
 * Content-hash dedupe: identical bytes share one stored object; re-dropping
 * the same file for the same club is a no-op.
 */
export async function bulkAssignLogos(
  auth: AuthCtx,
  files: LogoFile[],
  mapping: Record<string, string>,
  assignRemaining: boolean,
): Promise<LogoAssignment[]> {
  await requireFeature(auth.orgId, "clubs.hierarchy");
  // Community may set one logo at a time; the multi-file drop is Pro.
  if (files.length > 1) await requireFeature(auth.orgId, "logos.bulk");
  for (const f of files) {
    if (!LOGO_MIME.has(f.contentType)) {
      throw new HttpError(422, `unsupported logo type '${f.contentType}' (${f.filename})`);
    }
    if (f.bytes.length > LOGO_MAX_BYTES) {
      throw new HttpError(422, `${f.filename} exceeds the 2 MB logo limit`);
    }
  }

  return withTenant(auth.orgId, async (tx) => {
    const clubs = await tx<{ id: string; name: string; short_name: string | null; logo_path: string | null }[]>`
      select id, name, short_name, logo_path from clubs order by name, id`;
    const byFold = new Map<string, (typeof clubs)[number]>();
    for (const c of clubs) {
      byFold.set(fold(c.name), c);
      if (c.short_name) byFold.set(fold(c.short_name), c);
    }
    const assignedClubIds = new Set<string>();
    const results: LogoAssignment[] = [];
    const pending: { file: LogoFile; club: (typeof clubs)[number]; matchedBy: "filename" | "manual" | "order" }[] = [];

    for (const file of files) {
      const manual = mapping[file.filename];
      const stem = file.filename.replace(/\.[^.]+$/, "");
      const club = manual
        ? clubs.find((c) => c.id === manual)
        : byFold.get(fold(stem));
      if (club && !assignedClubIds.has(club.id)) {
        assignedClubIds.add(club.id);
        pending.push({ file, club, matchedBy: manual ? "manual" : "filename" });
      } else if (manual && !club) {
        throw new HttpError(422, `unknown club id for ${file.filename}`);
      } else {
        results.push({
          filename: file.filename, clubId: null, clubName: null, matchedBy: null, logoPath: null,
        });
      }
    }
    if (assignRemaining) {
      // any-order mode (idea 25 Nov): fill unlogo'd clubs in name order
      const free = clubs.filter((c) => c.logo_path === null && !assignedClubIds.has(c.id));
      let i = 0;
      for (const r of results) {
        if (r.clubId === null && i < free.length) {
          const club = free[i++]!;
          const file = files.find((f) => f.filename === r.filename)!;
          assignedClubIds.add(club.id);
          pending.push({ file, club, matchedBy: "order" });
        }
      }
      // matched-by-order entries are rebuilt below; drop their placeholders
      for (const p of pending) {
        const idx = results.findIndex((r) => r.filename === p.file.filename && r.clubId === null);
        if (idx >= 0) results.splice(idx, 1);
      }
    }

    const sb = supabaseAdmin();
    for (const { file, club, matchedBy } of pending) {
      // content-hash dedupe (Jul3/01 §5): identical bytes → one object
      const hash = createHash("sha256").update(file.bytes).digest("hex").slice(0, 32);
      const ext = LOGO_MIME.get(file.contentType)!;
      const path = `orgs/${auth.orgId}/clubs/${hash}.${ext}`;
      const { error } = await sb.storage
        .from(LOGO_BUCKET)
        .upload(path, file.bytes, { contentType: file.contentType, upsert: true });
      if (error) throw new HttpError(502, `logo upload failed: ${error.message}`);
      await tx`update clubs set logo_path = ${path} where id = ${club.id}`;
      results.push({
        filename: file.filename, clubId: club.id, clubName: club.name, matchedBy, logoPath: path,
      });
    }
    return results;
  });
}

// ---------------------------------------------------------------------------
// Participants export (Jul3/01 §6): one sheet, club + division columns,
// empty-spot placeholder rows preserved (idea 30 Jan).
// ---------------------------------------------------------------------------

export interface ParticipantExportRow {
  club: string;
  team: string;
  division: string;
  entrant: string;
  player: string;
  squad_number: number | null;
  position: string;
  captain: boolean;
}

export async function participantRows(
  auth: AuthCtx,
  filter: { clubId?: string; divisionId?: string },
): Promise<ParticipantExportRow[]> {
  return withTenant(auth.orgId, (tx) => tx<ParticipantExportRow[]>`
    select coalesce(td.club_name, '')      as club,
           coalesce(td.name, '')           as team,
           d.name                          as division,
           e.display_name                  as entrant,
           coalesce(p.full_name, '')       as player,
           em.squad_number,
           coalesce(em.default_position_key, '') as position,
           coalesce(em.is_captain, false)  as captain
    from entrants e
    join divisions d on d.id = e.division_id
    left join team_display_v td on td.team_id = e.team_id
    left join entrant_members em on em.entrant_id = e.id
    left join persons p on p.id = em.person_id
    where e.status in ('registered','confirmed')
      ${filter.divisionId ? tx`and e.division_id = ${filter.divisionId}` : tx``}
      ${filter.clubId ? tx`and td.club_id = ${filter.clubId}` : tx``}
    order by club, team, division, e.display_name, em.squad_number nulls last, player`);
}
