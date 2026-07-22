import "server-only";
import { sql } from "@/lib/db";

/** Turn an email into a friendly default display name (the part before @). */
export function displayNameFromEmail(email: string): string {
  const local = email.split("@")[0] || "Member";
  const cleaned = local.replace(/[._-]+/g, " ").trim();
  return (
    cleaned
      .split(" ")
      .filter(Boolean)
      .map((w) => w[0].toUpperCase() + w.slice(1))
      .join(" ") || "Member"
  );
}

/**
 * Resolve the account for `email`, creating an inert one on first sight. The
 * account carries no session and stays unverified until an emailed link (magic
 * link or email invite) is opened, so a create is harmless — this is the shared
 * passwordless sign-up path.
 */
export async function resolveOrCreateUser(email: string): Promise<string | null> {
  const existing = await sql<{ id: string }[]>`
    select id from users where email = ${email} and deleted_at is null limit 1`;
  if (existing[0]) return existing[0].id;

  const created = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified)
    values (${email}, ${displayNameFromEmail(email)}, false)
    on conflict (email) do nothing
    returning id`;
  if (created[0]) return created[0].id;

  // Lost a create race (or the email is held by a soft-deleted row) — re-read.
  const again = await sql<{ id: string }[]>`
    select id from users where email = ${email} and deleted_at is null limit 1`;
  return again[0]?.id ?? null;
}
