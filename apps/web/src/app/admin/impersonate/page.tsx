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

  // Set their first org as active
  const [firstOrg] = await sql<{ id: string }[]>`
    select org_id as id from org_members where user_id = ${row.target_id} limit 1`;
  if (firstOrg) await setActiveOrgId(firstOrg.id);

  redirect("/dashboard");
}
