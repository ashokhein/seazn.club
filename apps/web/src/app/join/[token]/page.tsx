import { getCurrentUser, getOrgRole } from "@/lib/auth";
import { inviteProblem, loadInvite, type InviteRow } from "@/lib/invites";
import type { OrgRole } from "@/lib/types";
import { AuthForm } from "@/components/auth-form";
import { JoinInvite } from "@/components/join-invite";
import { NightStage } from "@/components/night-stage";
import { resolveLocale } from "@/lib/resolve-locale";
import { getDictionary, t, type Dict } from "@/lib/i18n";
import { DictProvider } from "@/components/i18n/dict-provider";

/** What accepting will do for someone who is ALREADY a member (invites are
 *  additive — they never change an existing role). */
function memberBlurb(dict: Dict, invite: InviteRow, existing: OrgRole): string {
  const additive =
    invite.role === "scorer" &&
    invite.default_scope !== null &&
    (existing === "viewer" || existing === "scorer");
  const key = additive ? "join.member.additive" : "join.member.noChange";
  return t(dict, key, { role: existing });
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const invite = await loadInvite(token);
  const title = invite
    ? `Join ${invite.org_name} on Seazn Club`
    : "Join a club on Seazn Club";
  return {
    title,
    description: invite
      ? `You've been invited as ${invite.role}. Accept your invite and get involved.`
      : "Accept your invite and get involved.",
    openGraph: { title },
    // Personal links in chat apps: no reason for this to be indexable.
    robots: { index: false },
  };
}

export default async function JoinPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const [user, invite] = await Promise.all([getCurrentUser(), loadInvite(token)]);
  const locale = await resolveLocale();
  const ui = await getDictionary(locale, "ui");
  const problem = invite ? inviteProblem(invite) : t(ui, "join.notFound");
  const existingRole =
    user && invite ? await getOrgRole(invite.org_id, user.id) : null;
  // Email invites are personal (acceptInvite enforces this server-side) —
  // tell a mismatched account before they hit the 403.
  const emailMismatch =
    !!user && !!invite?.email && user.email.toLowerCase() !== invite.email.toLowerCase();

  return (
    <NightStage maxW="max-w-md">
      <DictProvider dict={ui} locale={locale}>
      {!invite || problem ? (
        <div className="card p-6 text-center">
          <h1 className="text-xl font-bold text-purple-900">{t(ui, "join.unavailable")}</h1>
          <p className="mt-2 text-sm text-slate-500">
            {problem ?? t(ui, "join.invalidLink")}
          </p>
        </div>
      ) : (
        <>
          <div className="mb-6 text-center">
            <h1 className="app-display text-3xl font-bold tracking-tight text-cream">
              {t(ui, "join.title", { org: invite.org_name })}
            </h1>
            <p className="mt-2 text-sm text-cream/70">
              {t(ui, "join.invitedAs")}{" "}
              <span className="font-medium text-lime-400">{invite.role}</span>.{" "}
              {t(ui, `join.role.${invite.role}`)}
            </p>
          </div>
          {user ? (
            <div className="card p-6">
              <p className="mb-4 text-sm text-slate-600">
                {t(ui, "join.signedInAs", { name: user.display_name })}
              </p>
              {emailMismatch ? (
                <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800">
                  {t(ui, "join.emailMismatch", { inviteEmail: invite.email!, userEmail: user.email })}
                </p>
              ) : (
                <>
                  {existingRole && (
                    <p className="mb-4 rounded-md bg-purple-50 px-3 py-2 text-sm text-purple-800">
                      {memberBlurb(ui, invite, existingRole)}
                    </p>
                  )}
                  <JoinInvite token={token} />
                </>
              )}
            </div>
          ) : (
            <>
              <p className="mb-4 text-center text-sm text-cream/70">
                {t(ui, "join.signInPrompt")}
              </p>
              <AuthForm next={`/join/${token}`} />
            </>
          )}
        </>
      )}
      </DictProvider>
    </NightStage>
  );
}
