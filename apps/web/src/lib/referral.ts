import "server-only";
import { randomInt } from "node:crypto";
import { sql } from "@/lib/db";
// Referral attribution primitive (design/v17-pricing-entitlements/SPEC-5 §2,
// issue #267 Task 1 — FOUNDATION only). This module owns the shareable
// per-org code (`referral_code`, V332) and its resolver; the attribution
// flow (stamping `referred_by_org_id` at org creation, the self-referral
// guard, the cookie read/write) and the earn-credit grant it eventually
// feeds are later tasks. Deliberately a leaf module — no `lib/credits` or
// entitlements import, to avoid a cycle; the cookie NAME is exported here
// (a pure const) so a later task's cookie IO and this module agree on it
// without either importing `next/headers`.

/** Cookie name a later task sets when a visitor lands via `/refer/<code>`
 *  and reads at org-creation time to stamp `referred_by_org_id`. */
export const REFERRAL_COOKIE = "ref";

/** Length of a generated referral code. */
export const REFERRAL_CODE_LEN = 8;

/** URL-safe, unambiguous alphabet — excludes the 0/O/1/I/l look-alikes. This is
 *  deliberately its OWN alphabet, not `lib/ref-code.ts`'s: that primitive builds
 *  phone-quotable, checksummed registration refs (`SZ-XXXX-XXXX`), a different
 *  format for a different feature. Not cryptographic, just unguessable enough
 *  for a shareable marketing link. */
const REFERRAL_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

/** How many collision-retry attempts `getOrCreateReferralCode` makes before
 *  giving up (each retry regenerates a fresh random code, so the odds of
 *  exhausting this are astronomically small at this alphabet/length). */
const MAX_GENERATE_ATTEMPTS = 5;

/** Postgres "unique_violation" error code. */
const UNIQUE_VIOLATION = "23505";

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: string }).code === UNIQUE_VIOLATION
  );
}

/** A fresh, unguessable-enough referral code: `REFERRAL_CODE_LEN` characters
 *  drawn from `REFERRAL_ALPHABET`. Not persisted or checked for collision —
 *  callers (`getOrCreateReferralCode`) own uniqueness via the DB's partial
 *  unique index + retry. */
export function generateReferralCode(): string {
  let code = "";
  for (let i = 0; i < REFERRAL_CODE_LEN; i++) {
    code += REFERRAL_ALPHABET[randomInt(REFERRAL_ALPHABET.length)];
  }
  return code;
}

/**
 * The org's shareable referral code, generating + persisting one on first
 * call (SPEC-5 §2). Race-safe and never overwrites an existing code:
 *
 * 1. Read the current `referral_code` — if already set, return it
 *    immediately (no write).
 * 2. Otherwise generate a candidate and `update ... where id = $1 and
 *    referral_code is null returning referral_code`. Two outcomes:
 *    - 0 rows updated: a concurrent caller won the race and already set the
 *      row's code (or a prior partial run did) — re-select and return
 *      THEIRS, never overwrite it.
 *    - The update hits the OTHER org's partial-unique index (a rare
 *      alphabet collision, Postgres `23505`) — regenerate a fresh candidate
 *      and retry, up to `MAX_GENERATE_ATTEMPTS` times.
 */
export async function getOrCreateReferralCode(orgId: string): Promise<string> {
  const [existing] = await sql<{ referral_code: string | null }[]>`
    select referral_code from organizations where id = ${orgId}`;
  if (existing?.referral_code) return existing.referral_code;

  for (let attempt = 0; attempt < MAX_GENERATE_ATTEMPTS; attempt++) {
    const candidate = generateReferralCode();
    try {
      const [updated] = await sql<{ referral_code: string }[]>`
        update organizations set referral_code = ${candidate}
         where id = ${orgId} and referral_code is null
        returning referral_code`;
      if (updated) return updated.referral_code;

      // 0 rows updated: either the row doesn't exist, or a rival caller
      // already set a code first. Re-read and return theirs — never
      // overwrite an existing code.
      const [row] = await sql<{ referral_code: string | null }[]>`
        select referral_code from organizations where id = ${orgId}`;
      if (row?.referral_code) return row.referral_code;
      // No row (unknown orgId) and no code — nothing more this loop can do.
      throw new Error(`getOrCreateReferralCode: no organization ${orgId}`);
    } catch (err) {
      if (isUniqueViolation(err) && attempt < MAX_GENERATE_ATTEMPTS - 1) continue;
      throw err;
    }
  }
  throw new Error(`getOrCreateReferralCode: exhausted retries for org ${orgId}`);
}

/**
 * Resolve a shared referral code to its org + owner (for the self-referral
 * guard a later task adds: a code must not attribute an org to itself, nor
 * to another org owned by the same person/email). `null` when the code
 * matches no org. `ownerUserId`/`ownerEmail` are `null` when the org's
 * `created_by` user no longer exists (`on delete set null`).
 */
export async function resolveReferralCode(
  code: string,
): Promise<{ orgId: string; ownerUserId: string | null; ownerEmail: string | null } | null> {
  const [row] = await sql<
    { id: string; owner_user_id: string | null; owner_email: string | null }[]
  >`
    select o.id, o.created_by as owner_user_id, u.email as owner_email
      from organizations o
      left join users u on u.id = o.created_by
     where o.referral_code = ${code}`;
  if (!row) return null;
  return { orgId: row.id, ownerUserId: row.owner_user_id, ownerEmail: row.owner_email };
}
