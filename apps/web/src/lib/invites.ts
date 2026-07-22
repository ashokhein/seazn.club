import "server-only";
import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import type { OrgRole, ScorerScopeType } from "@/lib/types";

export interface InviteRow {
  id: string;
  org_id: string;
  org_name: string;
  role: OrgRole;
  /** Scorer invites (doc 13 §4): accept also creates this assignment. */
  default_scope: { type: ScorerScopeType; id: string } | null;
  /** Invite-by-email: personal — only the account with this address may
   *  accept (enforced in acceptInvite). Null for shareable links. */
  email: string | null;
  expires_at: string | null;
  max_uses: number;
  used_count: number;
  revoked: boolean;
}

/** Load an invite by token, joined with its org name. */
export async function loadInvite(token: string): Promise<InviteRow | null> {
  const rows = await sql<InviteRow[]>`
    select i.id, i.org_id, o.name as org_name, i.role, i.default_scope,
           i.email, i.expires_at, i.max_uses, i.used_count, i.revoked
    from org_invites i
    join organizations o on o.id = i.org_id
    where i.token = ${token} limit 1`;
  return rows[0] ?? null;
}

/** Stable reason an invite cannot be used (locale-agnostic), or null when valid.
 *  UI surfaces map the code to localized copy (`join.problem.<code>` in `ui`);
 *  API routes render it in English via inviteProblem(). */
export type InviteProblem = "revoked" | "expired" | "used";

const INVITE_PROBLEM_EN: Record<InviteProblem, string> = {
  revoked: "This invite has been revoked",
  expired: "This invite has expired",
  used: "This invite has already been used",
};

export function inviteProblemCode(invite: InviteRow): InviteProblem | null {
  if (invite.revoked) return "revoked";
  if (invite.expires_at && new Date(invite.expires_at).getTime() < Date.now())
    return "expired";
  if (invite.max_uses !== 0 && invite.used_count >= invite.max_uses) return "used";
  return null;
}

/** English reason string for API responses (programmatic, not user-facing UI). */
export function inviteProblem(invite: InviteRow): string | null {
  const code = inviteProblemCode(invite);
  return code ? INVITE_PROBLEM_EN[code] : null;
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
  // Email invites are personal: only the account with the invited address may
  // accept — anyone else who gets hold of the link is turned away, before any
  // membership/no-op logic runs.
  if (invite.email) {
    const [u] = await sql<{ email: string }[]>`
      select email from users where id = ${userId}`;
    if (!u || u.email.toLowerCase() !== invite.email.toLowerCase()) {
      throw new HttpError(403, "This invite was sent to a different email address");
    }
  }
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

/**
 * Post-accept landing (doc 13 §4): scorers — and a member who just gained a
 * scorer assignment — go to My matches; everyone else to the dashboard. Shared
 * by the logged-in accept route and the one-click claim route.
 */
export function inviteLanding(role: OrgRole, outcome: AcceptOutcome): string {
  return role === "scorer" || outcome === "scope_added" ? "/my-matches" : "/dashboard";
}

export type ClaimResult =
  | { needs_signin: true }
  | {
      needs_signin: false;
      user_id: string;
      org_id: string;
      org_name: string;
      role: OrgRole;
      outcome: AcceptOutcome;
    };

/**
 * DB core of the one-click email-invite accept (POST /api/invites/[token]/claim).
 * For an invitee whose account is NEW or UNVERIFIED it resolves/creates the
 * account, joins the org, and marks the address verified — the caller then mints
 * the session cookie. A VERIFIED account is refused (`needs_signin`) so a
 * forwarded invite can never take over a real account; the caller falls back to
 * normal sign-in. Shareable links (no bound email) are likewise not claimable
 * this way. Throws (HttpError) for a missing/expired/revoked/used invite — no
 * account is created in that case.
 */
export async function claimEmailInvite(token: string): Promise<ClaimResult> {
  const invite = await loadInvite(token);
  if (!invite) throw new HttpError(404, "Invite not found");
  const problem = inviteProblem(invite);
  if (problem) throw new HttpError(400, problem);
  // Shareable links carry no bound email — possession proves no inbox, so they
  // can never auto-login; the recipient signs in, then accepts.
  if (!invite.email) return { needs_signin: true };

  const [account] = await sql<{ id: string; email_verified: boolean }[]>`
    select id, email_verified from users
    where email = ${invite.email} and deleted_at is null limit 1`;
  // A verified account has protectable data: never hand a forwarded invite a
  // session to it. Sign-in-first is the only way in.
  if (account?.email_verified) return { needs_signin: true };

  const { resolveOrCreateUser } = await import("@/lib/users");
  const userId = account?.id ?? (await resolveOrCreateUser(invite.email));
  if (!userId) throw new HttpError(500, "Could not resolve the invited account");

  // Join first (grantInvite burns the single use); only then confirm the
  // address. If the join throws (e.g. a seat quota) no session is minted and the
  // account stays inert. acceptInvite's email-match check trivially holds — the
  // account was resolved BY the invited address.
  const outcome = await acceptInvite(invite, userId);
  await sql`update users set email_verified = true where id = ${userId}`;

  const { getOrgRole } = await import("@/lib/auth");
  const role = (await getOrgRole(invite.org_id, userId)) ?? invite.role;
  return {
    needs_signin: false,
    user_id: userId,
    org_id: invite.org_id,
    org_name: invite.org_name,
    role,
    outcome,
  };
}
