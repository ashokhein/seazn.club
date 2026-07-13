import { sql } from "@/lib/db";
import { requireOrgRole } from "@/lib/auth";
import { handler } from "@/lib/http";
import { baseUrl } from "@/lib/oauth";
import { sendInviteEmail } from "@/lib/email";
import { createInvite } from "@/server/usecases/invites";
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
      select id, org_id, role, default_scope, email, token, expires_at, max_uses,
             used_count, revoked, created_at
      from org_invites
      where org_id = ${id}
      order by created_at desc`;
  });
}

/** Create an invite (editors only): a shareable link, or — when `email` is
 *  present — a personal invite emailed to that address. Scorer invites may
 *  carry a default_scope: accepting then creates the assignment too
 *  (doc 13 §4). */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return handler(async () => {
    const { id } = await params;
    const { user } = await requireOrgRole(id, EDITOR_ROLES);
    const input = createInviteSchema.parse(await req.json());
    const invite = await createInvite(id, user.id, input);
    if (!invite.email) return invite;

    const [org] = await sql<{ name: string }[]>`
      select name from organizations where id = ${id}`;
    const email_sent = await sendInviteEmail(
      invite.email,
      org.name,
      `${baseUrl(req)}/join/${invite.token}`,
    );
    // email_sent=false (quota, blank RESEND key) is not an error: the UI
    // offers the personal link for manual sharing instead.
    return { ...invite, email_sent };
  });
}
