import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { sql } from "@/lib/db";
import { createSession, setActiveOrgId } from "@/lib/auth";

interface PageProps {
  searchParams: Promise<{ token?: string }>;
}

/**
 * Validates an impersonation token and creates a session for the target user.
 * The original staff session is replaced — opening in a new browser profile is recommended.
 */
export default async function ImpersonatePage({ searchParams }: PageProps) {
  const { token } = await searchParams;
  if (!token) redirect("/admin");

  const [row] = await sql<{
    id: string; actor_id: string; target_id: string; expires_at: string; ended_at: string | null;
  }[]>`
    select id, actor_id, target_id, expires_at, ended_at
    from impersonation_sessions where token = ${token} limit 1`;

  if (!row || row.ended_at || new Date(row.expires_at) < new Date()) {
    redirect("/admin?impersonate=invalid");
  }

  // Mark used
  await sql`update impersonation_sessions set ended_at = now() where id = ${row.id}`;

  // Create session as target user
  await createSession(row.target_id);

  // Readable (non-httpOnly) marker so client analytics skips capture while
  // staff impersonate — keeps impersonated activity out of real user data.
  // Cleared on the target user's next genuine login by the auth flow lifetime.
  const jar = await cookies();
  jar.set("seazn_no_analytics", "1", {
    httpOnly: false,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60, // matches the 1-hour impersonation token
  });

  // Set their first org as active
  const [firstOrg] = await sql<{ id: string }[]>`
    select org_id as id from org_members where user_id = ${row.target_id} limit 1`;
  if (firstOrg) await setActiveOrgId(firstOrg.id);

  redirect("/dashboard");
}
