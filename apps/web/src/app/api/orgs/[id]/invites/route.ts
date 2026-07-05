import crypto from "node:crypto";
import { sql } from "@/lib/db";
import { requireOrgRole } from "@/lib/auth";
import { handler, HttpError } from "@/lib/http";
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
      select id, org_id, role, default_scope, token, expires_at, max_uses,
             used_count, revoked, created_at
      from org_invites
      where org_id = ${id}
      order by created_at desc`;
  });
}

// Scope type → table, for validating a scorer invite's default_scope target
// belongs to this org (doc 13 §4).
const SCOPE_TABLES = {
  competition: "competitions",
  division: "divisions",
  fixture: "fixtures",
} as const;

/** Create a shareable invite link (editors only). Scorer invites may carry a
 *  default_scope — accepting then creates the assignment too (doc 13 §4). */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return handler(async () => {
    const { id } = await params;
    const { user } = await requireOrgRole(id, EDITOR_ROLES);
    const { role, max_uses, default_scope } = createInviteSchema.parse(await req.json());

    if (default_scope && role !== "scorer") {
      throw new HttpError(400, "default_scope applies to scorer invites only");
    }
    if (default_scope) {
      const [target] = await sql<{ org_id: string }[]>`
        select org_id from ${sql(SCOPE_TABLES[default_scope.type])}
        where id = ${default_scope.id} limit 1`;
      if (!target || target.org_id !== id) {
        throw new HttpError(422, `${default_scope.type} not found in this organization`);
      }
    }

    const token = crypto.randomBytes(24).toString("base64url");
    // Invite links are short-lived: valid for one hour from creation.
    const INVITE_TTL_MS = 60 * 60 * 1000;
    const expiresAt = new Date(Date.now() + INVITE_TTL_MS).toISOString();

    const [invite] = await sql<OrgInvite[]>`
      insert into org_invites
        (org_id, role, default_scope, token, created_by, expires_at, max_uses)
      values
        (${id}, ${role}, ${default_scope ? sql.json(default_scope) : null}, ${token},
         ${user.id}, ${expiresAt}, ${max_uses})
      returning id, org_id, role, default_scope, token, expires_at, max_uses,
                used_count, revoked, created_at`;
    return invite;
  });
}
