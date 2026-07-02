import crypto from "node:crypto";
import { sql } from "@/lib/db";
import { requireOrgRole } from "@/lib/auth";
import { handler } from "@/lib/http";
import {
  EDITOR_ROLES,
  createInviteSchema,
  type OrgInvite,
} from "@/lib/types";

/** List invite links for an org (editors only). */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return handler(async () => {
    const { id } = await params;
    await requireOrgRole(id, EDITOR_ROLES);
    return sql<OrgInvite[]>`
      select id, org_id, role, token, expires_at, max_uses, used_count,
             revoked, created_at
      from org_invites
      where org_id = ${id}
      order by created_at desc`;
  });
}

/** Create a shareable invite link (editors only). */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return handler(async () => {
    const { id } = await params;
    const { user } = await requireOrgRole(id, EDITOR_ROLES);
    const { role, max_uses } = createInviteSchema.parse(await req.json());

    const token = crypto.randomBytes(24).toString("base64url");
    // Invite links are short-lived: valid for one hour from creation.
    const INVITE_TTL_MS = 60 * 60 * 1000;
    const expiresAt = new Date(Date.now() + INVITE_TTL_MS).toISOString();

    const [invite] = await sql<OrgInvite[]>`
      insert into org_invites
        (org_id, role, token, created_by, expires_at, max_uses)
      values
        (${id}, ${role}, ${token}, ${user.id}, ${expiresAt}, ${max_uses})
      returning id, org_id, role, token, expires_at, max_uses, used_count,
                revoked, created_at`;
    return invite;
  });
}
