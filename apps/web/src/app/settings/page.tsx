export const dynamic = "force-dynamic";
import Link from "next/link";
import { redirect } from "next/navigation";
import {
  Building2, Users, CreditCard, UserCircle,
  Pencil, Image as ImageIcon, ArrowLeftRight,
  User, Mail, Download, ShieldOff, KeyRound, Compass, Banknote, Cookie,
  type LucideIcon,
} from "lucide-react";
import { getActiveOrgId, getCurrentUser, getUserOrgs } from "@/lib/auth";
import { sql } from "@/lib/db";
import { hasFeature } from "@/lib/entitlements";
import { EDITOR_ROLES, type OrgMember } from "@/lib/types";
import { Nav } from "@/components/nav";
import { OrgTeam } from "@/components/org-team";
import { OrgSwitcher } from "@/components/org-switcher";
import { OrgRename } from "@/components/org-rename";
import { OrgLogo } from "@/components/org-logo";
import { OrgPaymentInstructions } from "@/components/org-payment-instructions";
import {
  DisplayNameForm,
  ChangeEmailForm,
  LeaveOrgButton,
  TransferOwnerForm,
  DeleteAccountButton,
} from "@/components/account-actions";
import { ApiKeysPanel } from "@/components/api-keys";
import { CookieSettingsButton } from "@/components/cookie-settings-button";
import { TourReplayButton } from "@/components/tour-replay";
import { PlanBadge } from "@/components/plan-badge";

function SectionHeader({ icon: Icon, children, action }: {
  icon: LucideIcon;
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="mb-5 flex items-center justify-between gap-3">
      <div className="flex items-center gap-2">
        <Icon className="h-4 w-4 text-purple-500" strokeWidth={1.75} />
        <h2 className="text-sm font-semibold text-slate-800">{children}</h2>
      </div>
      {action}
    </div>
  );
}

function SubSection({ icon: Icon, label }: { icon: LucideIcon; label: string }) {
  return (
    <div className="mb-2 flex items-center gap-1.5">
      <Icon className="h-3.5 w-3.5 text-slate-400" strokeWidth={1.75} />
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">{label}</p>
    </div>
  );
}

const ROLE_BADGE: Record<string, string> = {
  owner: "bg-amber-100 text-amber-700",
  admin: "bg-purple-100 text-purple-700",
  viewer: "bg-slate-100 text-slate-600",
};

type Tab = "organization" | "team" | "api" | "account";

// Plan & billing lives at its own route (/settings/billing) — it owns the
// Stripe checkout-return reconciliation and portal flows — so it links out of
// the tabbed sidebar rather than rendering an inline panel here.
const NAV_ITEMS: { tab: Tab; label: string; icon: LucideIcon; href?: string }[] = [
  { tab: "organization",  label: "Organisation",   icon: Building2  },
  { tab: "team",          label: "Team",           icon: Users      },
  { tab: "api",           label: "Platform API",   icon: KeyRound   },
  { tab: "account",       label: "Account",        icon: UserCircle },
];

const BILLING_NAV = { label: "Plan & billing", icon: CreditCard, href: "/settings/billing" } as const;

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; email_change?: string }>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const orgs = await getUserOrgs(user.id);
  if (orgs.length === 0) redirect("/orgs/new");

  const activeId = await getActiveOrgId();
  const active = orgs.find((o) => o.id === activeId) ?? orgs[0];
  const canEdit = (EDITOR_ROLES as readonly string[]).includes(active.role);

  const { tab: rawTab, email_change } = await searchParams;
  const tab: Tab = (NAV_ITEMS.some((n) => n.tab === rawTab) ? rawTab : "organization") as Tab;

  // Per-tab lazy data loading
  const canBrand =
    tab === "organization" ? await hasFeature(active.id, "branding") : false;

  // Platform API tab (doc 10 §1): api.access = Pro, api.write = Business.
  let hasApiAccess = false;
  let hasApiWrite = false;
  if (tab === "api") {
    [hasApiAccess, hasApiWrite] = await Promise.all([
      hasFeature(active.id, "api.access"),
      hasFeature(active.id, "api.write"),
    ]);
  }

  // Account tab data
  const orgMembersMap = new Map<string, OrgMember[]>();
  if (tab === "account") {
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
  }

  const emailChangeMessage = email_change
    ? ({
        success: "Email address updated successfully.",
        invalid: "This confirmation link is invalid.",
        expired: "This confirmation link has expired. Please request a new one.",
        taken: "That email address is already in use by another account.",
        error: "Something went wrong. Please try again.",
      }[email_change] ?? null)
    : null;

  return (
    <>
      <Nav />
      <div className="mx-auto max-w-5xl px-4 py-8">
        <div className="flex gap-8">

          {/* ── Left sidebar ── */}
          <aside className="w-44 shrink-0">
            <p className="mb-3 px-3 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
              Settings
            </p>
            <nav className="space-y-0.5">
              {NAV_ITEMS.map(({ tab: t, label, icon: Icon }) => {
                const active = tab === t;
                return (
                  <Link
                    key={t}
                    href={`/settings?tab=${t}`}
                    className={`flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition ${
                      active
                        ? "bg-purple-100 font-medium text-purple-800"
                        : "text-slate-600 hover:bg-purple-50 hover:text-purple-700"
                    }`}
                  >
                    <Icon
                      className={`h-4 w-4 shrink-0 ${active ? "text-purple-600" : "text-slate-400"}`}
                      strokeWidth={1.75}
                    />
                    {label}
                  </Link>
                );
              })}
              {/* Plan & billing is its own route (owns Stripe reconciliation). */}
              <Link
                href={BILLING_NAV.href}
                className="flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-slate-600 transition hover:bg-purple-50 hover:text-purple-700"
              >
                <BILLING_NAV.icon className="h-4 w-4 shrink-0 text-slate-400" strokeWidth={1.75} />
                {BILLING_NAV.label}
              </Link>
            </nav>
            <div className="my-4 border-t border-purple-100" />
            <Link
              href="/dashboard"
              className="block rounded-lg px-3 py-2 text-sm text-slate-400 transition hover:bg-slate-50 hover:text-slate-600"
            >
              ← Dashboard
            </Link>
          </aside>

          {/* ── Panel ── */}
          <main className="min-w-0 flex-1">

            {/* ── ORGANISATION ── */}
            {tab === "organization" && (
              <section className="card p-6">
                <SectionHeader icon={Building2}>Organisation</SectionHeader>

                <div className="flex items-center gap-3">
                  <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-purple-500 to-fuchsia-500 text-lg font-bold text-white">
                    {active.name.charAt(0).toUpperCase()}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-slate-800">{active.name}</p>
                    <p className="truncate font-mono text-xs text-purple-400">{active.slug}</p>
                  </div>
                  <span className={`badge ${ROLE_BADGE[active.role]}`}>{active.role}</span>
                </div>

                {canEdit && (
                  <div className="mt-5 border-t border-slate-100 pt-5" data-tour="org-rename">
                    <SubSection icon={Pencil} label="Rename" />
                    <OrgRename orgId={active.id} initialName={active.name} />
                  </div>
                )}

                {canEdit && (
                  <div className="mt-5 border-t border-slate-100 pt-5">
                    <SubSection icon={ImageIcon} label="Logo" />
                    {canBrand ? (
                      <OrgLogo
                        orgId={active.id}
                        initialLogoUrl={
                          active.logo_storage_path
                            ? `${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/public/assets/${active.logo_storage_path}`
                            : (active.logo_url ?? null)
                        }
                      />
                    ) : (
                      <p className="flex items-center gap-2 text-sm text-slate-400">
                        <PlanBadge feature="branding" />
                        Org logo requires{" "}
                        <Link href="/settings/billing" className="text-purple-600 underline">
                          an upgrade
                        </Link>
                      </p>
                    )}
                  </div>
                )}

                {canEdit && (
                  <div className="mt-5 border-t border-slate-100 pt-5">
                    <SubSection icon={Banknote} label="Payment details" />
                    <OrgPaymentInstructions
                      orgId={active.id}
                      initialValue={active.payment_instructions}
                    />
                  </div>
                )}

                <div className="mt-5 border-t border-slate-100 pt-5">
                  <SubSection icon={ArrowLeftRight} label="Switch organisation" />
                  <OrgSwitcher orgs={orgs} activeId={active.id} />
                </div>

                {canEdit && (
                  <div className="mt-5 border-t border-slate-100 pt-5">
                    <SubSection icon={Compass} label="Product tour" />
                    <TourReplayButton />
                  </div>
                )}
              </section>
            )}

            {/* ── TEAM ── */}
            {tab === "team" && (
              <section className="card p-6">
                <SectionHeader icon={Users}>Team</SectionHeader>
                <OrgTeam orgId={active.id} role={active.role} currentUserId={user.id} />
              </section>
            )}

            {/* ── PLATFORM API ── */}
            {tab === "api" && (
              <section className="card p-6">
                <SectionHeader icon={KeyRound}>Platform API</SectionHeader>
                {!canEdit ? (
                  <p className="text-sm text-slate-400">
                    Only owners and admins can manage API keys.
                  </p>
                ) : hasApiAccess ? (
                  <ApiKeysPanel orgId={active.id} canWriteScope={hasApiWrite} />
                ) : (
                  <p className="flex items-center gap-2 text-sm text-slate-400">
                    <PlanBadge feature="api.access" />
                    Platform API keys require{" "}
                    <Link href="/settings/billing" className="text-purple-600 underline">
                      an upgrade
                    </Link>
                  </p>
                )}
              </section>
            )}

            {/* ── ACCOUNT ── */}
            {tab === "account" && (
              <div className="space-y-5">
                {emailChangeMessage && (
                  <div
                    className={`rounded-lg px-4 py-3 text-sm ${
                      email_change === "success"
                        ? "bg-emerald-50 text-emerald-700"
                        : "bg-red-50 text-red-700"
                    }`}
                  >
                    {emailChangeMessage}
                  </div>
                )}

                {/* Profile */}
                <section className="card space-y-2 p-5">
                  <SectionHeader icon={User}>Profile</SectionHeader>
                  <label className="block text-sm text-slate-500">Display name</label>
                  <DisplayNameForm currentName={user.display_name} />
                  <p className="text-sm text-slate-500">
                    Email: <span className="font-medium text-slate-700">{user.email}</span>
                  </p>
                  <p className="text-sm text-slate-500">
                    Account ID: <span className="font-mono text-xs text-purple-400">{user.id}</span>
                  </p>
                </section>

                {/* Change email */}
                <section className="card p-5">
                  <SectionHeader icon={Mail}>Change email</SectionHeader>
                  <ChangeEmailForm currentEmail={user.email} />
                </section>

                {/* Export */}
                <section className="card p-5">
                  <SectionHeader
                    icon={Download}
                    action={
                      <a href="/api/users/me/export" download className="btn btn-ghost text-xs">
                        Download JSON
                      </a>
                    }
                  >
                    Export your data
                  </SectionHeader>
                  <p className="text-sm text-slate-500">
                    Download a copy of your profile, organizations, and tournaments.
                  </p>
                </section>

                {/* Privacy & cookies — analytics consent can be changed/withdrawn here. */}
                <section className="card p-5">
                  <SectionHeader
                    icon={Cookie}
                    action={
                      <CookieSettingsButton className="btn btn-ghost text-xs">
                        Cookie settings
                      </CookieSettingsButton>
                    }
                  >
                    Privacy &amp; cookies
                  </SectionHeader>
                  <p className="text-sm text-slate-500">
                    Change or withdraw your consent for PostHog product analytics. See our{" "}
                    <Link href="/legal/cookie-policy" className="text-purple-600 underline">
                      cookie policy
                    </Link>
                    .
                  </p>
                </section>

                {/* Org actions */}
                {orgs.length > 0 && (
                  <section className="card p-5">
                    <SectionHeader icon={Building2}>Organizations</SectionHeader>
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
                  <div className="mb-4 flex items-center gap-2">
                    <ShieldOff className="h-4 w-4 text-red-400" strokeWidth={1.75} />
                    <h2 className="text-sm font-semibold text-red-600">Danger zone</h2>
                  </div>
                  <p className="mb-4 text-sm text-slate-500">
                    Deleting your account removes you from all organizations and schedules your
                    data for permanent erasure within 30 days.
                  </p>
                  <DeleteAccountButton />
                </section>
              </div>
            )}

          </main>
        </div>
      </div>
    </>
  );
}
