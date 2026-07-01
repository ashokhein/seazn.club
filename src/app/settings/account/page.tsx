export const dynamic = "force-dynamic";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser, getUserOrgs, getActiveOrgId } from "@/lib/auth";
import { sql } from "@/lib/db";
import { Nav } from "@/components/nav";
import {
  ChangeEmailForm,
  LeaveOrgButton,
  TransferOwnerForm,
  DeleteAccountButton,
} from "@/components/account-actions";
import type { OrgMember } from "@/lib/types";

interface PageProps {
  searchParams: Promise<{ email_change?: string }>;
}

export default async function AccountSettingsPage({ searchParams }: PageProps) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const { email_change } = await searchParams;

  const orgs = await getUserOrgs(user.id);
  const activeId = await getActiveOrgId();

  // Load members for each org where user is owner (for transfer-owner UI)
  const orgMembersMap = new Map<string, OrgMember[]>();
  for (const org of orgs) {
    if (org.role === "owner") {
      const members = await sql<OrgMember[]>`
        select m.user_id, u.email, u.display_name, u.avatar_url, m.role, m.created_at
        from org_members m join users u on u.id = m.user_id
        where m.org_id = ${org.id}
        order by m.created_at asc`;
      orgMembersMap.set(org.id, members);
    }
  }

  const emailChangeMessage = email_change
    ? {
        success: "Email address updated successfully.",
        invalid: "This confirmation link is invalid.",
        expired: "This confirmation link has expired. Please request a new one.",
        taken: "That email address is already in use by another account.",
        error: "Something went wrong. Please try again.",
      }[email_change] ?? null
    : null;

  return (
    <>
      <Nav />
      <main className="mx-auto max-w-3xl px-4 py-8">
        <div className="mb-6 flex items-center justify-between">
          <h1 className="text-2xl font-bold tracking-tight text-purple-900">
            Account
          </h1>
          <Link href="/settings" className="btn btn-ghost">
            ← Settings
          </Link>
        </div>

        {emailChangeMessage && (
          <div
            className={`mb-6 rounded-lg px-4 py-3 text-sm ${
              email_change === "success"
                ? "bg-emerald-50 text-emerald-700"
                : "bg-red-50 text-red-700"
            }`}
          >
            {emailChangeMessage}
          </div>
        )}

        {/* Profile */}
        <section className="card mb-6 space-y-1 p-5">
          <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-purple-400">
            Profile
          </h2>
          <p className="text-sm text-slate-500">
            Display name:{" "}
            <span className="font-medium text-slate-700">{user.display_name}</span>
          </p>
          <p className="text-sm text-slate-500">
            Account ID:{" "}
            <span className="font-mono text-xs text-purple-400">{user.id}</span>
          </p>
        </section>

        {/* Change email */}
        <section className="card mb-6 p-5">
          <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-purple-400">
            Change email
          </h2>
          <ChangeEmailForm currentEmail={user.email} />
        </section>

        {/* Export data */}
        <section className="card mb-6 p-5">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-xs font-semibold uppercase tracking-wide text-purple-400">
                Export your data
              </h2>
              <p className="mt-1 text-sm text-slate-500">
                Download a copy of your profile, organizations, and tournaments.
              </p>
            </div>
            <a
              href="/api/users/me/export"
              download
              className="btn btn-ghost text-sm"
            >
              Download JSON
            </a>
          </div>
        </section>

        {/* Per-org actions */}
        {orgs.length > 0 && (
          <section className="card mb-6 p-5">
            <h2 className="mb-4 text-xs font-semibold uppercase tracking-wide text-purple-400">
              Organizations
            </h2>
            <div className="space-y-6">
              {orgs.map((org) => {
                const members = orgMembersMap.get(org.id) ?? [];
                return (
                  <div key={org.id} className="space-y-3">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="font-medium text-slate-800">{org.name}</p>
                        <p className="text-xs text-slate-400 font-mono">{org.slug}</p>
                      </div>
                      <span
                        className={`badge text-xs ${
                          org.role === "owner"
                            ? "bg-amber-100 text-amber-700"
                            : org.role === "admin"
                              ? "bg-purple-100 text-purple-700"
                              : "bg-slate-100 text-slate-600"
                        }`}
                      >
                        {org.role}
                      </span>
                    </div>

                    {org.role === "owner" && members.length > 1 && (
                      <div className="pl-2 border-l-2 border-slate-100 space-y-1">
                        <p className="text-xs font-medium text-slate-500">Transfer ownership</p>
                        <TransferOwnerForm orgId={org.id} members={members} />
                      </div>
                    )}

                    {org.role !== "owner" && (
                      <LeaveOrgButton orgId={org.id} orgName={org.name} />
                    )}

                    {org.role === "owner" && members.length === 1 && (
                      <p className="text-xs text-slate-400">
                        Sole owner — invite others before you can transfer or leave.
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        )}

        {/* Danger zone */}
        <section className="card border-red-100 p-5">
          <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-red-400">
            Danger zone
          </h2>
          <p className="mb-4 text-sm text-slate-500">
            Deleting your account removes you from all organizations and schedules your
            data for permanent erasure within 30 days.
          </p>
          <DeleteAccountButton />
        </section>
      </main>
    </>
  );
}
