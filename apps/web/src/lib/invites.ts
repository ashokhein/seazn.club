import "server-only";
import { sql } from "@/lib/db";
import type { OrgRole, ScorerScopeType } from "@/lib/types";

export interface InviteRow {
  id: string;
  org_id: string;
  org_name: string;
  role: OrgRole;
  /** Scorer invites (doc 13 §4): accept also creates this assignment. */
  default_scope: { type: ScorerScopeType; id: string } | null;
  expires_at: string | null;
  max_uses: number;
  used_count: number;
  revoked: boolean;
}

/** Load an invite by token, joined with its org name. */
export async function loadInvite(token: string): Promise<InviteRow | null> {
  const rows = await sql<InviteRow[]>`
    select i.id, i.org_id, o.name as org_name, i.role, i.default_scope,
           i.expires_at, i.max_uses, i.used_count, i.revoked
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

/**
 * Membership grant for an accepted invite (doc 13 §4/§5): seat quota counted
 * in the same tx as the insert (members.max for owner/admin/viewer,
 * scorers.max for scorer — separate pools), and a scorer invite's
 * default_scope becomes an assignment atomically. No-op when already a member.
 */
export async function grantInvite(invite: InviteRow, userId: string): Promise<void> {
  const { getLimit } = await import("@/lib/entitlements");
  const { PaymentRequiredError } = await import("@/lib/errors");
  const quotaKey = invite.role === "scorer" ? "scorers.max" : "members.max";
  const limit = await getLimit(invite.org_id, quotaKey);
  await sql.begin(async (tx) => {
    // Serialise seat changes per org (FOR UPDATE on the org row), then count.
    await tx`select 1 from organizations where id = ${invite.org_id} for update`;
    const [{ n }] = invite.role === "scorer"
      ? await tx<{ n: number }[]>`
          select count(*)::int as n from org_members
          where org_id = ${invite.org_id} and role = 'scorer'`
      : await tx<{ n: number }[]>`
          select count(*)::int as n from org_members
          where org_id = ${invite.org_id} and role <> 'scorer'`;
    if (limit !== null && n + 1 > limit) throw new PaymentRequiredError(quotaKey);
    await tx`
      insert into org_members (org_id, user_id, role)
      values (${invite.org_id}, ${userId}, ${invite.role})
      on conflict (org_id, user_id) do nothing`;
    if (invite.role === "scorer" && invite.default_scope) {
      await tx`
        insert into scorer_assignments (org_id, user_id, scope_type, scope_id, created_by)
        values (${invite.org_id}, ${userId}, ${invite.default_scope.type},
                ${invite.default_scope.id}, null)
        on conflict (org_id, user_id, scope_type, scope_id) do nothing`;
    }
    // Consume one use atomically.
    await tx`
      update org_invites set used_count = used_count + 1
      where id = ${invite.id}`;
  });
  const { invalidateUserOrgs } = await import("@/lib/auth");
  await invalidateUserOrgs(userId);
}

export type AcceptOutcome = "joined" | "scope_added" | "already_member";

/**
 * Accept an invite for a (possibly already-member) user. Invites are
 * additive and never change an existing role:
 *  - not a member → grantInvite (join with the invite's role + assignment);
 *  - viewer/scorer × a scoped scorer invite → the assignment is added on top
 *    of their current role (the umpire-QR-at-courtside case) and a use is
 *    consumed — no seat charged, their existing seat already counts;
 *  - anything else (owner/admin scanning their own QR, role invites to
 *    members) → no-op, and the use is NOT burnt.
 */
export async function acceptInvite(invite: InviteRow, userId: string): Promise<AcceptOutcome> {
  const { getOrgRole } = await import("@/lib/auth");
  const existing = await getOrgRole(invite.org_id, userId);
  if (!existing) {
    await grantInvite(invite, userId);
    return "joined";
  }
  const scope = invite.default_scope;
  const additive =
    invite.role === "scorer" && scope !== null &&
    (existing === "viewer" || existing === "scorer");
  if (!additive) return "already_member";
  await sql.begin(async (tx) => {
    await tx`
      insert into scorer_assignments (org_id, user_id, scope_type, scope_id, created_by)
      values (${invite.org_id}, ${userId}, ${scope.type}, ${scope.id}, null)
      on conflict (org_id, user_id, scope_type, scope_id) do nothing`;
    await tx`
      update org_invites set used_count = used_count + 1
      where id = ${invite.id}`;
  });
  return "scope_added";
}
