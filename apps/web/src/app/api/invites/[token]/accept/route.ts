import { getOrgRole, requireUser, setActiveOrgId } from "@/lib/auth";
import { handler } from "@/lib/http";
import { acceptInvite, inviteLanding, inviteProblem, loadInvite } from "@/lib/invites";

/**
 * Join the inviting org with the embedded role (must be logged in).
 * Invites are additive (acceptInvite): a non-member joins with the invite's
 * role; a viewer/scorer accepting a scoped scorer invite keeps their role and
 * gains the assignment; an editor's own test scan is a no-op. Seat quotas
 * (doc 13 §5) bite inside grantInvite on the join path only.
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

    const outcome = await acceptInvite(invite, user.id);

    await setActiveOrgId(invite.org_id);
    const role = (await getOrgRole(invite.org_id, user.id)) ?? invite.role;
    // Scorer post-login landing (doc 13 §4): straight to My matches — and a
    // member who just gained an umpire assignment lands there too, on the
    // matches the invite was about.
    const landing = inviteLanding(role, outcome);
    return {
      org_id: invite.org_id,
      org_name: invite.org_name,
      role,
      outcome,
      landing,
    };
  });
}
