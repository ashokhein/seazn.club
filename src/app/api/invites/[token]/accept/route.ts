import { sql } from "@/lib/db";
import { getOrgRole, requireUser, setActiveOrgId } from "@/lib/auth";
import { handler } from "@/lib/http";
import { inviteProblem, loadInvite } from "@/lib/invites";

/** Join the inviting org with the embedded role (must be logged in). */
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  return handler(async () => {
    const user = await requireUser();
    const { token } = await params;

    const invite = await loadInvite(token);
    if (!invite) throw new Error("Invite not found");
    const problem = inviteProblem(invite);
    if (problem) throw new Error(problem);

    const existing = await getOrgRole(invite.org_id, user.id);
    if (!existing) {
      await sql.begin(async (tx) => {
        await tx`
          insert into org_members (org_id, user_id, role)
          values (${invite.org_id}, ${user.id}, ${invite.role})
          on conflict (org_id, user_id) do nothing`;
        // Consume one use atomically.
        await tx`
          update org_invites set used_count = used_count + 1
          where id = ${invite.id}`;
      });
    }

    await setActiveOrgId(invite.org_id);
    return { org_id: invite.org_id, org_name: invite.org_name, role: invite.role };
  });
}
