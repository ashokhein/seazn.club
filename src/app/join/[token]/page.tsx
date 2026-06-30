import { getCurrentUser } from "@/lib/auth";
import { inviteProblem, loadInvite } from "@/lib/invites";
import { Nav } from "@/components/nav";
import { AuthForm } from "@/components/auth-form";
import { JoinInvite } from "@/components/join-invite";

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
    <>
      <Nav />
      <main className="mx-auto max-w-md px-4 py-10">
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
              <h1 className="text-2xl font-bold tracking-tight text-purple-900">
                Join {invite.org_name}
              </h1>
              <p className="mt-1 text-sm text-slate-500">
                You&apos;ve been invited as{" "}
                <span className="font-medium text-purple-700">{invite.role}</span>.{" "}
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
                <p className="mb-4 text-center text-sm text-slate-500">
                  Sign in or create an account to join.
                </p>
                <AuthForm next={`/join/${token}`} />
              </>
            )}
          </>
        )}
      </main>
    </>
  );
}
