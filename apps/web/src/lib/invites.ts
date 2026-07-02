import "server-only";
import { sql } from "@/lib/db";
import type { OrgRole } from "@/lib/types";

export interface InviteRow {
  id: string;
  org_id: string;
  org_name: string;
  role: OrgRole;
  expires_at: string | null;
  max_uses: number;
  used_count: number;
  revoked: boolean;
}

/** Load an invite by token, joined with its org name. */
export async function loadInvite(token: string): Promise<InviteRow | null> {
  const rows = await sql<InviteRow[]>`
    select i.id, i.org_id, o.name as org_name, i.role, i.expires_at,
           i.max_uses, i.used_count, i.revoked
    from org_invites i
    join organizations o on o.id = i.org_id
    where i.token = ${token} limit 1`;
  return rows[0] ?? null;
}

/** Returns a human reason the invite cannot be used, or null when valid. */
export function inviteProblem(invite: InviteRow): string | null {
  if (invite.revoked) return "This invite has been revoked";
  if (invite.expires_at && new Date(invite.expires_at).getTime() < Date.now())
    return "This invite has expired";
  if (invite.max_uses !== 0 && invite.used_count >= invite.max_uses)
    return "This invite has already been used";
  return null;
}
