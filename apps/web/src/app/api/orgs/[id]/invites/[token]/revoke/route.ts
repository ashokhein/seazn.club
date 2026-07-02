import { sql } from "@/lib/db";
import { requireOrgRole } from "@/lib/auth";
import { handler } from "@/lib/http";
import { EDITOR_ROLES } from "@/lib/types";

/** Revoke an invite link so it can no longer be used (editors only). */
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string; token: string }> },
) {
  return handler(async () => {
    const { id, token } = await params;
    await requireOrgRole(id, EDITOR_ROLES);
    await sql`
      update org_invites set revoked = true
      where org_id = ${id} and token = ${token}`;
    return { ok: true };
  });
}
