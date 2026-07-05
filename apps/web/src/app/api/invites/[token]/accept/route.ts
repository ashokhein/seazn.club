import { getOrgRole, requireUser, setActiveOrgId } from "@/lib/auth";
import { handler } from "@/lib/http";
import { grantInvite, inviteProblem, loadInvite } from "@/lib/invites";

/**
 * Join the inviting org with the embedded role (must be logged in).
 * Seat quotas (doc 13 §5) bite inside grantInvite; a scorer invite with a
 * default_scope creates membership + assignment atomically (doc 13 §4).
 */
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
    if (!existing) await grantInvite(invite, user.id);

    await setActiveOrgId(invite.org_id);
    const role = existing ?? invite.role;
    return {
      org_id: invite.org_id,
      org_name: invite.org_name,
      role,
      // Scorer post-login landing (doc 13 §4): straight to My matches.
      landing: role === "scorer" ? "/my-matches" : "/dashboard",
    };
  });
}
