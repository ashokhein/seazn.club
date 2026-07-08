import "server-only";
import crypto from "node:crypto";
import { sql } from "@/lib/db";

// Short TTL: a login link is a live credential, so it should not linger.
const TTL_MINUTES = 15;

/** Issue a single-use passwordless sign-in token for a user. */
export async function createLoginLink(userId: string): Promise<string> {
  const token = crypto.randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + TTL_MINUTES * 60_000).toISOString();
  // Only one live link per user — invalidate any earlier unused ones.
  await sql`delete from login_links where user_id = ${userId} and used = false`;
  await sql`
    insert into login_links (user_id, token, expires_at)
    values (${userId}, ${token}, ${expiresAt})`;
  return token;
}

/**
 * Consume a login token: mark it used and return the user id if it was valid
 * and unexpired, otherwise null. Clicking the link proves email ownership, so
 * the account is marked verified in the same transaction.
 */
export async function consumeLoginLink(token: string): Promise<string | null> {
  return sql.begin(async (tx) => {
    const rows = await tx<{ id: string; user_id: string; expires_at: string; used: boolean }[]>`
      select id, user_id, expires_at, used
      from login_links where token = ${token}
      for update limit 1`;
    const row = rows[0];
    if (!row || row.used || new Date(row.expires_at).getTime() < Date.now()) {
      return null;
    }
    await tx`update login_links set used = true where id = ${row.id}`;
    await tx`update users set email_verified = true where id = ${row.user_id}`;
    return row.user_id;
  });
}
