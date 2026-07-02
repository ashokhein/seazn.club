import { handler } from "@/lib/http";
import { inviteProblem, loadInvite } from "@/lib/invites";
import type { InvitePreview } from "@/lib/types";

/** Public preview of an invite link (org name + role + validity). */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  return handler(async (): Promise<InvitePreview> => {
    const { token } = await params;
    const invite = await loadInvite(token);
    if (!invite) {
      return { org_name: "", role: "viewer", valid: false, reason: "Invite not found" };
    }
    const problem = inviteProblem(invite);
    return {
      org_name: invite.org_name,
      role: invite.role,
      valid: problem === null,
      reason: problem ?? undefined,
    };
  });
}
