import "server-only";
// Team use-cases. Teams can be created via CSV import (Jul3/01 §6) or directly
// under a club (createTeam). listTeams exposes them for the "enroll an existing
// team" flow. Each team carries a persistent squad (team_members) managed in the
// club directory, used to auto-seed an entrant's roster on enrollment.
// Reads are ungated; create/edit (Pro club hierarchy) require clubs.hierarchy.
import { createHash } from "node:crypto";
import type postgres from "postgres";
import { withTenant } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { requireFeature } from "@/lib/entitlements";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { publicStorageUrl } from "@/lib/supabase-storage";
import { resolveEntrantBadge } from "@/lib/entrant-badge";
import type { z } from "zod";
import type { EntrantMemberInput } from "@/server/api-v1/schemas";
import type { AuthCtx } from "@/server/api-v1/auth";

type Tx = postgres.TransactionSql;
type MemberInput = z.infer<typeof EntrantMemberInput>;

export interface TeamListRow {
  id: string;
  name: string;
  short_name: string | null;
  club_id: string | null;
  club_name: string | null;
  club_short_name: string | null;
  logo_path: string | null;
  /** Most recently created entrant for this team, across all divisions — the
   *  default roster source when enrolling the team into a new division. */
  latest_entrant_id: string | null;
}

export async function listTeams(auth: AuthCtx): Promise<TeamListRow[]> {
  // team_display_v is a plain (non-security_invoker) view, so it does NOT
  // inherit the caller's RLS on `teams` — filter by org_id explicitly or it
  // leaks every org's teams. The entrants subquery reads `entrants` directly,
  // which IS RLS-scoped under withTenant.
  return withTenant(auth.orgId, (tx) => tx<TeamListRow[]>`
    select v.team_id as id, v.name, v.short_name, v.club_id,
           v.club_name, v.club_short_name, v.logo_path,
           (select e.id from entrants e
             where e.team_id = v.team_id
             order by e.created_at desc, e.id desc
             limit 1) as latest_entrant_id
    from team_display_v v
    where v.org_id = ${auth.orgId}
    order by v.name, v.team_id`);
}

export interface TeamRow {
  id: string;
  name: string;
  short_name: string | null;
  club_id: string | null;
}

export interface SquadMember {
  person_id: string;
  full_name: string;
  squad_number: number | null;
  default_position_key: string | null;
  is_captain: boolean;
  roles: string[];
}

/** Create a team under a club. Pro (clubs.hierarchy), mirroring club create. */
export async function createTeam(
  auth: AuthCtx,
  clubId: string,
  input: { name: string; short_name?: string | null },
): Promise<TeamRow> {
  await requireFeature(auth.orgId, "clubs.hierarchy");
  return withTenant(auth.orgId, async (tx) => {
    const [club] = await tx`select 1 from clubs where id = ${clubId}`;
    if (!club) throw new HttpError(404, "club not found");
    const [team] = await tx<TeamRow[]>`
      insert into teams (org_id, name, short_name, club_id)
      values (${auth.orgId}, ${input.name}, ${input.short_name ?? null}, ${clubId})
      returning id, name, short_name, club_id`;
    return team!;
  });
}

// ---------------------------------------------------------------------------
// Team logo (v3/03 §5): same pipeline as club badges — content-hash path in
// the public assets bucket, one object per unique bytes. Single-file, so it
// stays available on Community (like one-at-a-time club logos); teams fall
// back to their club badge via team_display_v when unset.
// ---------------------------------------------------------------------------

const LOGO_MAX_BYTES = 2 * 1024 * 1024;
const LOGO_MIME = new Map([
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
  ["image/webp", "webp"],
  ["image/svg+xml", "svg"],
]);

export async function setTeamLogo(
  auth: AuthCtx,
  teamId: string,
  file: { contentType: string; bytes: Buffer },
): Promise<{ logo_path: string }> {
  const ext = LOGO_MIME.get(file.contentType);
  if (!ext) throw new HttpError(422, `unsupported logo type '${file.contentType}'`);
  if (file.bytes.length > LOGO_MAX_BYTES) throw new HttpError(422, "logo exceeds the 2 MB limit");
  return withTenant(auth.orgId, async (tx) => {
    const [team] = await tx`select 1 from teams where id = ${teamId}`;
    if (!team) throw new HttpError(404, "team not found");
    const hash = createHash("sha256").update(file.bytes).digest("hex").slice(0, 32);
    const path = `orgs/${auth.orgId}/teams/${hash}.${ext}`;
    const { error } = await supabaseAdmin()
      .storage.from("assets")
      .upload(path, file.bytes, { contentType: file.contentType, upsert: true });
    if (error) throw new HttpError(502, `logo upload failed: ${error.message}`);
    await tx`update teams set logo_path = ${path} where id = ${teamId}`;
    return { logo_path: path };
  });
}

export async function removeTeamLogo(auth: AuthCtx, teamId: string): Promise<void> {
  await withTenant(auth.orgId, async (tx) => {
    const [team] = await tx`select 1 from teams where id = ${teamId}`;
    if (!team) throw new HttpError(404, "team not found");
    // Objects are content-hash shared across teams — clear the pointer only.
    await tx`update teams set logo_path = null where id = ${teamId}`;
  });
}

/** entrant_id → resolved badge URL for a division (team → club via
 *  team_display_v; null = fall through to monogram/initials in EntityLogo). */
export async function listEntrantLogoUrls(
  auth: AuthCtx,
  divisionId: string,
): Promise<Record<string, string | null>> {
  const rows = await withTenant(auth.orgId, (tx) =>
    tx<{ entrant_id: string; badge_url: string | null; logo_path: string | null }[]>`
      select e.id as entrant_id, e.badge_url, td.logo_path
      from entrants e
      left join team_display_v td on td.team_id = e.team_id and td.org_id = ${auth.orgId}
      where e.division_id = ${divisionId}`,
  );
  // PROMPT-60 precedence: the entrant's own badge beats the team logo.
  return Object.fromEntries(
    rows.map((r) => [
      r.entrant_id,
      resolveEntrantBadge({ badge_url: r.badge_url, team_logo_path: r.logo_path }),
    ]),
  );
}

/** Load a team's persistent squad (in the CreateEntrant member shape, minus
 *  full_name) — used to seed an entrant roster on enrollment. */
export async function loadTeamSquad(tx: Tx, teamId: string): Promise<MemberInput[]> {
  return tx<MemberInput[]>`
    select person_id, squad_number, default_position_key, is_captain, roles
    from team_members where team_id = ${teamId}`;
}

export async function getTeamSquad(
  auth: AuthCtx,
  teamId: string,
): Promise<TeamRow & { members: SquadMember[] }> {
  return withTenant(auth.orgId, async (tx) => {
    const [team] = await tx<TeamRow[]>`
      select id, name, short_name, club_id from teams where id = ${teamId}`;
    if (!team) throw new HttpError(404, "team not found");
    const members = await tx<SquadMember[]>`
      select tm.person_id, p.full_name, tm.squad_number, tm.default_position_key,
             tm.is_captain, tm.roles
      from team_members tm join persons p on p.id = tm.person_id
      where tm.team_id = ${teamId}
      order by tm.squad_number nulls last, p.full_name`;
    return { ...team, members };
  });
}

/** Full-replace a team's squad (like the entrant roster editor). Pro. */
export async function setTeamSquad(
  auth: AuthCtx,
  teamId: string,
  members: MemberInput[],
): Promise<TeamRow & { members: SquadMember[] }> {
  await requireFeature(auth.orgId, "clubs.hierarchy");
  await withTenant(auth.orgId, async (tx) => {
    const [team] = await tx`select 1 from teams where id = ${teamId}`;
    if (!team) throw new HttpError(404, "team not found");
    const ids = [...new Set(members.map((m) => m.person_id))];
    if (ids.length > 0) {
      const visible = await tx<{ id: string }[]>`select id from persons where id in ${tx(ids)}`;
      if (visible.length !== ids.length) {
        const seen = new Set(visible.map((r) => r.id));
        throw new HttpError(422, `unknown person(s): ${ids.filter((id) => !seen.has(id)).join(", ")}`);
      }
    }
    await tx`delete from team_members where team_id = ${teamId}`;
    for (const m of members) {
      await tx`
        insert into team_members (team_id, person_id, squad_number,
                                  default_position_key, is_captain, roles)
        values (${teamId}, ${m.person_id}, ${m.squad_number ?? null},
                ${m.default_position_key ?? null}, ${m.is_captain},
                ${tx.json(m.roles as never)})`;
    }
  });
  return getTeamSquad(auth, teamId);
}
