import { sql } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { handler } from "@/lib/http";
import { NextResponse } from "next/server";

/** GDPR data export — returns all data associated with the authenticated user. */
export async function GET() {
  return handler(async () => {
    const user = await requireUser();

    const [profile] = await sql<{
      id: string; display_name: string; email: string; avatar_url: string | null; created_at: string;
    }[]>`
      select id, display_name, email, avatar_url, created_at
      from users where id = ${user.id}`;

    const orgs = await sql<{ id: string; name: string; slug: string; role: string; joined_at: string }[]>`
      select o.id, o.name, o.slug, m.role, m.created_at as joined_at
      from org_members m join organizations o on o.id = m.org_id
      where m.user_id = ${user.id}`;

    // v1 `tournaments` died at the PROMPT-15 cutover; competitions carry the
    // created_by association now.
    const competitions = await sql<{ id: string; name: string; created_at: string }[]>`
      select id, name, created_at from competitions
      where created_by = ${user.id} order by created_at desc`;

    const export_data = {
      exported_at: new Date().toISOString(),
      profile,
      organizations: orgs,
      competitions_created: competitions,
    };

    return new NextResponse(JSON.stringify(export_data, null, 2), {
      headers: {
        "Content-Type": "application/json",
        "Content-Disposition": `attachment; filename="seazn-data-export-${user.id}.json"`,
      },
    });
  });
}
