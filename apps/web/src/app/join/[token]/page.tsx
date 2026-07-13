import { getCurrentUser, getOrgRole } from "@/lib/auth";
import { inviteProblem, loadInvite, type InviteRow } from "@/lib/invites";
import type { OrgRole } from "@/lib/types";
import { AuthForm } from "@/components/auth-form";
import { JoinInvite } from "@/components/join-invite";
import { NightStage } from "@/components/night-stage";

const ROLE_BLURB: Record<string, string> = {
  admin: "Admins can create and manage tournaments, results and members.",
  viewer: "Viewers get read-only access to the board.",
  owner: "Owners have full control of the organization.",
  scorer: "Scorers record results for the matches assigned to them.",
};

/** What accepting will do for someone who is ALREADY a member (invites are
 *  additive — they never change an existing role). */
function memberBlurb(invite: InviteRow, existing: OrgRole): string {
  const additive =
    invite.role === "scorer" &&
    invite.default_scope !== null &&
    (existing === "viewer" || existing === "scorer");
  if (additive) {
    return `You are already a ${existing} of this organization — accepting adds ` +
      "the invited matches to your scoring assignments. Your current access is unchanged.";
  }
  return `You are already ${existing === "admin" || existing === "owner" ? "an" : "a"} ` +
    `${existing} of this organization — accepting changes nothing.`;
}

export default async function JoinPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const [user, invite] = await Promise.all([getCurrentUser(), loadInvite(token)]);
  const problem = invite ? inviteProblem(invite) : "Invite not found";
  const existingRole =
    user && invite ? await getOrgRole(invite.org_id, user.id) : null;

  return (
    <NightStage maxW="max-w-md">
      {!invite || problem ? (
        <div className="card p-6 text-center">
          <h1 className="text-xl font-bold text-purple-900">Invite unavailable</h1>
          <p className="mt-2 text-sm text-slate-500">
            {problem ?? "This invite link is not valid."}
          </p>
        </div>
      ) : (
        <>
          <div className="mb-6 text-center">
            <h1 className="app-display text-3xl font-bold tracking-tight text-cream">
              Join {invite.org_name}
            </h1>
            <p className="mt-2 text-sm text-cream/70">
              You&apos;ve been invited as{" "}
              <span className="font-medium text-lime-400">{invite.role}</span>.{" "}
              {ROLE_BLURB[invite.role]}
            </p>
          </div>
          {user ? (
            <div className="card p-6">
              <p className="mb-4 text-sm text-slate-600">
                Signed in as{" "}
                <span className="font-medium text-purple-700">
                  {user.display_name}
                </span>
                .
              </p>
              {existingRole && (
                <p className="mb-4 rounded-md bg-purple-50 px-3 py-2 text-sm text-purple-800">
                  {memberBlurb(invite, existingRole)}
                </p>
              )}
              <JoinInvite token={token} />
            </div>
          ) : (
            <>
              <p className="mb-4 text-center text-sm text-cream/70">
                Sign in or create an account to join.
              </p>
              <AuthForm next={`/join/${token}`} />
            </>
          )}
        </>
      )}
    </NightStage>
  );
}
