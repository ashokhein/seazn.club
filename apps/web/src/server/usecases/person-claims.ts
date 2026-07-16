import "server-only";
// Player-account claims (PROMPT-53, doc 16 §1.3): an organiser invites a
// person to claim their row; the token holder links persons.user_id to their
// login. Tokens are random secrets hashed at rest (device-links pattern);
// resolution runs on the superuser connection because the claimant is not an
// org member. Claim rows are never deleted — claimed_at/revoked_at/invited_by
// are the audit trail for claim and staff unlink.
import { createHash, randomBytes } from "node:crypto";
import { sql, withTenant } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import type { AuthCtx } from "@/server/api-v1/auth";

export const CLAIM_PREFIX = "pc_";
const CLAIM_DAYS = 14;

export function hashClaimToken(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

/** Mint a new claim secret. Shown once; only the sha256 is stored. */
export function mintClaimSecret(): string {
  return CLAIM_PREFIX + randomBytes(32).toString("base64url");
}

export interface ClaimRow {
  id: string;
  person_id: string;
  email: string;
  invited_by: string | null;
  expires_at: string;
  claimed_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

const COLS = [
  "id", "person_id", "email", "invited_by", "expires_at",
  "claimed_at", "revoked_at", "created_at",
] as const;

function requireSessionEditor(auth: AuthCtx): void {
  // Claim invites mint a login capability — session editors only, never an
  // API key or device link (same rule as device-links minting).
  if (auth.via !== "session" || !auth.userId) {
    throw new HttpError(403, "Claim invites can only be managed with a session login");
  }
}

/**
 * Invite a person to claim their profile. One open claim per person: minting
 * revokes any prior open invite. Secret returned exactly once.
 */
export async function createClaimInvite(
  auth: AuthCtx,
  personId: string,
  email: string,
): Promise<ClaimRow & { secret: string; person_name: string; org_name: string }> {
  requireSessionEditor(auth);
  const secret = mintClaimSecret();
  const row = await withTenant(auth.orgId, async (tx) => {
    const [person] = await tx<{ id: string; full_name: string; user_id: string | null }[]>`
      select id, full_name, user_id from persons where id = ${personId}`;
    if (!person) throw new HttpError(404, "person not found");
    if (person.user_id) {
      throw new HttpError(409, "This profile is already claimed", "ALREADY_CLAIMED");
    }
    const [org] = await tx<{ name: string }[]>`
      select name from organizations where id = ${auth.orgId}`;
    await tx`
      update person_claims set revoked_at = now()
      where person_id = ${personId} and claimed_at is null and revoked_at is null`;
    const [created] = await tx<ClaimRow[]>`
      insert into person_claims (org_id, person_id, email, token_hash, invited_by, expires_at)
      values (${auth.orgId}, ${personId}, ${email}, ${hashClaimToken(secret)},
              ${auth.userId}, now() + ${`${CLAIM_DAYS} days`}::interval)
      returning ${tx(COLS)}`;
    return { ...created, person_name: person.full_name, org_name: org?.name ?? "" };
  });
  return { ...row, secret };
}

/** Revoke the person's open invite, if any (idempotent). */
export async function revokeClaimInvite(auth: AuthCtx, personId: string): Promise<ClaimRow | null> {
  requireSessionEditor(auth);
  return withTenant(auth.orgId, async (tx) => {
    const [row] = await tx<ClaimRow[]>`
      update person_claims set revoked_at = now()
      where person_id = ${personId} and claimed_at is null and revoked_at is null
      returning ${tx(COLS)}`;
    return row ?? null;
  });
}

/** The person's open invite (organiser console; no secret — it showed once). */
export async function getOpenClaim(auth: AuthCtx, personId: string): Promise<ClaimRow | null> {
  return withTenant(auth.orgId, async (tx) => {
    const [row] = await tx<ClaimRow[]>`
      select ${tx(COLS)} from person_claims
      where person_id = ${personId} and claimed_at is null and revoked_at is null
      order by created_at desc limit 1`;
    return row ?? null;
  });
}

export interface ResolvedClaim {
  id: string;
  org_id: string;
  org_name: string;
  person_id: string;
  person_name: string;
  email: string;
  /** The person is on the officials roster (v11) — the claim page swaps to
   *  officiating copy; the claim mechanics are identical. */
  is_official: boolean;
}

/**
 * Resolve a pc_ token for the /claim page. Distinct error codes so the page
 * can render each dead-end with its own copy: CLAIM_INVALID / CLAIM_REVOKED /
 * CLAIM_EXPIRED / CLAIM_CLAIMED.
 */
export async function resolveClaimToken(token: string): Promise<ResolvedClaim> {
  const [claim] = await sql<
    (ResolvedClaim & {
      expires_at: string;
      claimed_at: string | null;
      revoked_at: string | null;
      user_id: string | null;
    })[]
  >`
    select pc.id, pc.org_id, o.name as org_name, pc.person_id,
           p.full_name as person_name, pc.email,
           exists(select 1 from officials off where off.person_id = pc.person_id)
             as is_official,
           pc.expires_at, pc.claimed_at, pc.revoked_at, p.user_id
    from person_claims pc
    join persons p on p.id = pc.person_id
    join organizations o on o.id = pc.org_id
    where pc.token_hash = ${hashClaimToken(token)} limit 1`;
  if (!claim) throw new HttpError(401, "This claim link is not valid", "CLAIM_INVALID");
  if (claim.claimed_at || claim.user_id) {
    throw new HttpError(409, "This profile has already been claimed", "CLAIM_CLAIMED");
  }
  if (claim.revoked_at) {
    throw new HttpError(401, "This invite was withdrawn — ask the organiser for a new one", "CLAIM_REVOKED");
  }
  if (new Date(claim.expires_at).getTime() <= Date.now()) {
    throw new HttpError(401, "This invite has expired — ask the organiser for a new one", "CLAIM_EXPIRED");
  }
  return {
    id: claim.id,
    org_id: claim.org_id,
    org_name: claim.org_name,
    person_id: claim.person_id,
    person_name: claim.person_name,
    email: claim.email,
    is_official: claim.is_official,
  };
}

/**
 * Link the person to the logged-in user. Strict email match (owner decision
 * 2026-07-13): only an account signed in with the INVITED address may accept —
 * the emailed link alone is not enough. Transactional: the person row is
 * locked so two racing accepts can't both win; the loser gets CLAIM_CLAIMED.
 */
export async function claimPerson(
  token: string,
  userId: string,
  userEmail: string,
): Promise<ResolvedClaim> {
  const claim = await resolveClaimToken(token);
  if (claim.email.toLowerCase() !== userEmail.toLowerCase()) {
    throw new HttpError(
      403,
      `This invite was sent to ${claim.email} — sign in with that address to claim it`,
      "CLAIM_EMAIL_MISMATCH",
    );
  }
  await sql.begin(async (tx) => {
    const [updated] = await tx<{ id: string }[]>`
      update persons set user_id = ${userId}
      where id = ${claim.person_id} and user_id is null
      returning id`;
    if (!updated) {
      throw new HttpError(409, "This profile has already been claimed", "CLAIM_CLAIMED");
    }
    await tx`
      update person_claims set claimed_at = now()
      where id = ${claim.id} and claimed_at is null`;
  });
  return claim;
}

/**
 * Staff unlink: detach the login and close every live claim row. The claimed
 * row keeps claimed_at AND gains revoked_at — that pair is the unlink audit.
 */
export async function unlinkPerson(auth: AuthCtx, personId: string): Promise<void> {
  requireSessionEditor(auth);
  await withTenant(auth.orgId, async (tx) => {
    const [person] = await tx<{ id: string }[]>`
      select id from persons where id = ${personId}`;
    if (!person) throw new HttpError(404, "person not found");
    await tx`update persons set user_id = null where id = ${personId}`;
    await tx`
      update person_claims set revoked_at = now()
      where person_id = ${personId} and revoked_at is null`;
  });
}
