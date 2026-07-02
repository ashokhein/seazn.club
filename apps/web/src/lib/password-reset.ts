import "server-only";
import crypto from "node:crypto";
import { sql } from "@/lib/db";
import { hashPassword } from "@/lib/auth";
import { HttpError } from "@/lib/errors";

const TTL_HOURS = 1;

export async function createPasswordResetToken(userId: string): Promise<string> {
  const token = crypto.randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + TTL_HOURS * 3_600_000).toISOString();
  // Invalidate any existing unused tokens for this user before creating a new one.
  await sql`delete from password_resets where user_id = ${userId} and used = false`;
  await sql`
    insert into password_resets (user_id, token, expires_at)
    values (${userId}, ${token}, ${expiresAt})`;
  return token;
}

/**
 * Validate the token, update the password, and mark the token as used.
 * Throws HttpError on invalid/expired token.
 */
export async function consumePasswordReset(
  token: string,
  newPassword: string,
): Promise<void> {
  await sql.begin(async (tx) => {
    const rows = await tx<{ id: string; user_id: string; expires_at: string; used: boolean }[]>`
      select id, user_id, expires_at, used
      from password_resets where token = ${token}
      for update limit 1`;

    const row = rows[0];
    if (!row || row.used || new Date(row.expires_at).getTime() < Date.now()) {
      throw new HttpError(400, "This reset link is invalid or has expired.");
    }

    const hash = await hashPassword(newPassword);
    await tx`update users set password_hash = ${hash} where id = ${row.user_id}`;
    await tx`update password_resets set used = true where id = ${row.id}`;
  });
}
