import "server-only";
import crypto from "node:crypto";
import { sql } from "@/lib/db";

const TTL_HOURS = 24;

/** Issue a single-use email verification token for a user. */
export async function createVerificationToken(userId: string): Promise<string> {
  const token = crypto.randomBytes(24).toString("base64url");
  const expiresAt = new Date(Date.now() + TTL_HOURS * 3600_000).toISOString();
  await sql`
    insert into email_verifications (user_id, token, expires_at)
    values (${userId}, ${token}, ${expiresAt})`;
  return token;
}

/**
 * Consume a verification token: delete it and return the user id if it was
 * valid and unexpired, otherwise null.
 */
export async function consumeVerificationToken(
  token: string,
): Promise<string | null> {
  const rows = await sql<{ user_id: string; expires_at: string }[]>`
    select user_id, expires_at from email_verifications
    where token = ${token} limit 1`;
  const row = rows[0];
  if (!row) return null;
  await sql`delete from email_verifications where token = ${token}`;
  if (new Date(row.expires_at).getTime() < Date.now()) return null;
  return row.user_id;
}
