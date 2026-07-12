import { getCurrentUser } from "@/lib/auth";
import { inviteProblem, loadInvite } from "@/lib/invites";
import { AuthForm } from "@/components/auth-form";
import { JoinInvite } from "@/components/join-invite";
import { NightStage } from "@/components/night-stage";

const ROLE_BLURB: Record<string, string> = {
  admin: "Admins can create and manage tournaments, results and members.",
  viewer: "Viewers get read-only access to the board.",
  owner: "Owners have full control of the organization.",
};

export default async function JoinPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const [user, invite] = await Promise.all([getCurrentUser(), loadInvite(token)]);
  const problem = invite ? inviteProblem(invite) : "Invite not found";

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
