import { sql } from "@/lib/db";
import { requireOrgRole } from "@/lib/auth";
import { handler } from "@/lib/http";
import { ORG_ROLES, type OrgMember } from "@/lib/types";

/** List members of an org (any member may view). */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return handler(async () => {
    const { id } = await params;
    await requireOrgRole(id, ORG_ROLES);
    return sql<OrgMember[]>`
      select m.user_id, u.email, u.display_name, u.avatar_url,
             m.role, m.created_at
      from org_members m
      join users u on u.id = m.user_id
      where m.org_id = ${id}
      order by
        case m.role when 'owner' then 0 when 'admin' then 1 else 2 end,
        m.created_at asc`;
  });
}
