export const dynamic = "force-dynamic";
import Link from "next/link";
import { redirect } from "next/navigation";
import {
  Building2, Sliders, Users, CreditCard, UserCircle,
  Pencil, Image as ImageIcon, ArrowLeftRight, Zap, BarChart2,
  TrendingUp, User, Mail, Download, AlertTriangle, ShieldOff,
  type LucideIcon,
} from "lucide-react";
import { getActiveOrgId, getCurrentUser, getUserOrgs, requireOrgRole } from "@/lib/auth";
import { sql } from "@/lib/db";
import { listOrgSportPresets } from "@/lib/sport-presets";
import { hasFeature } from "@/lib/entitlements";
import { EDITOR_ROLES, ORG_ROLES, type OrgMember, type Subscription } from "@/lib/types";
import { Nav } from "@/components/nav";
import { BillingBanner } from "@/components/billing-banner";
import { OrgTeam } from "@/components/org-team";
import { OrgSwitcher } from "@/components/org-switcher";
import { OrgRename } from "@/components/org-rename";
import { OrgSportPresets } from "@/components/org-sport-presets";
import { OrgLogo } from "@/components/org-logo";
import { UpgradeButton, ManageBillingButton } from "@/components/billing-actions";
import {
  ChangeEmailForm,
  LeaveOrgButton,
  TransferOwnerForm,
  DeleteAccountButton,
} from "@/components/account-actions";

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

const STATUS_BADGE: Record<string, string> = {
  trialing: "bg-purple-100 text-purple-700",
  active: "bg-green-100 text-green-700",
  past_due: "bg-amber-100 text-amber-700",
  canceled: "bg-slate-100 text-slate-500",
  suspended: "bg-red-100 text-red-700",
};

function fmt(iso: string | null) {
  if (!iso) return null;
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function daysUntil(iso: string | null): number | null {
  if (!iso) return null;
  return Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000);
}

function UsageRow({
  label,
  current,
  limit,
  note,
}: {
  label: string;
  current: number | null;
  limit: number | null;
  note?: string;
}) {
  const unlimited = limit === null;
  const pct = unlimited || current === null ? null : Math.min((current / limit) * 100, 100);
  return (
    <div>
      <div className="flex justify-between text-sm">
        <span className="text-slate-600">
          {label}
          {note && <span className="ml-1 text-xs text-slate-400">({note})</span>}
        </span>
        <span className="font-medium text-slate-800">
          {current !== null ? `${current} / ` : ""}
          {unlimited ? "∞" : limit}
        </span>
      </div>
      {pct !== null && (
        <div className="mt-1 h-1.5 w-full rounded-full bg-slate-100">
          <div
            className={`h-1.5 rounded-full ${pct >= 90 ? "bg-amber-500" : "bg-purple-400"}`}
            style={{ width: `${pct}%` }}
          />
        </div>
      )}
    </div>
  );
}

type Tab = "organization" | "sport-presets" | "team" | "billing" | "account";

const NAV_ITEMS: { tab: Tab; label: string; icon: LucideIcon }[] = [
  { tab: "organization",  label: "Organisation",   icon: Building2    },
  { tab: "sport-presets", label: "Sport presets",  icon: Sliders      },
  { tab: "team",          label: "Team",           icon: Users        },
  { tab: "billing",       label: "Plan & billing", icon: CreditCard   },
  { tab: "account",       label: "Account",        icon: UserCircle   },
];

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
  const [sportPresets, canBrand] = await Promise.all([
    tab === "sport-presets" ? listOrgSportPresets(active.id) : Promise.resolve([]),
    tab === "organization"  ? hasFeature(active.id, "branding") : Promise.resolve(false),
  ]);

  // Billing tab data
  let sub: Subscription | undefined;
  let seasonsCount = 0;
  if (tab === "billing") {
    const { role } = await requireOrgRole(active.id, ORG_ROLES);
    void role; // only needed to confirm membership
    const [subRow] = await sql<Subscription[]>`select * from subscriptions where org_id = ${active.id}`;
    sub = subRow;
    const [{ cnt }] = await sql<{ cnt: number }[]>`
      select count(*)::int as cnt from seasons where org_id = ${active.id}`;
    seasonsCount = cnt;
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

  // Billing helpers
  const planKey = sub?.plan_key ?? "community";
  const subStatus = sub?.status ?? "active";
  const isPro = planKey === "pro";
  const isOwner = active.role === "owner";
  const hasStripeCustomer = !!sub?.stripe_customer_id;
  const trialDays = daysUntil(sub?.trial_end ?? null);

  return (
    <>
      <Nav />
      {tab === "billing" && <BillingBanner orgId={active.id} />}
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
                  <div className="mt-5 border-t border-slate-100 pt-5">
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
                      <p className="text-sm text-slate-400">
                        Org logo requires{" "}
                        <Link href="/settings?tab=billing" className="text-purple-600 underline">
                          Pro plan ✦
                        </Link>
                      </p>
                    )}
                  </div>
                )}

                <div className="mt-5 border-t border-slate-100 pt-5">
                  <SubSection icon={ArrowLeftRight} label="Switch organisation" />
                  <OrgSwitcher orgs={orgs} activeId={active.id} />
                </div>
              </section>
            )}

            {/* ── SPORT PRESETS ── */}
            {tab === "sport-presets" && (
              <section className="card p-6">
                <SectionHeader
                  icon={Sliders}
                  action={canEdit ? <span className="text-[11px] text-slate-400">Editors only</span> : undefined}
                >
                  Sport presets
                </SectionHeader>
                <OrgSportPresets
                  orgId={active.id}
                  initialPresets={sportPresets}
                  canEdit={canEdit}
                />
              </section>
            )}

            {/* ── TEAM ── */}
            {tab === "team" && (
              <section className="card p-6">
                <SectionHeader icon={Users}>Team</SectionHeader>
                <OrgTeam orgId={active.id} role={active.role} currentUserId={user.id} />
              </section>
            )}

            {/* ── BILLING ── */}
            {tab === "billing" && (
              <div className="space-y-5">
                {/* Current plan */}
                <section className="card p-5">
                  <SectionHeader icon={Zap}>Current plan</SectionHeader>
                  <div className="flex items-center justify-between gap-4">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="text-xl font-bold text-slate-800 capitalize">{planKey}</span>
                        <span className={`badge ${STATUS_BADGE[subStatus] ?? "bg-slate-100 text-slate-500"}`}>
                          {subStatus.replace("_", " ")}
                        </span>
                      </div>
                      {subStatus === "trialing" && trialDays !== null && (
                        <p className="mt-1 text-sm text-purple-600">
                          {trialDays > 0
                            ? `${trialDays} day${trialDays === 1 ? "" : "s"} remaining in trial`
                            : "Trial ended"}
                        </p>
                      )}
                      {sub?.current_period_end && subStatus === "active" && (
                        <p className="mt-1 text-sm text-slate-500">
                          {sub.cancel_at_period_end
                            ? `Cancels on ${fmt(sub.current_period_end)}`
                            : `Renews ${fmt(sub.current_period_end)}`}
                        </p>
                      )}
                    </div>
                    {isOwner && isPro && hasStripeCustomer && <ManageBillingButton />}
                  </div>
                </section>

                {/* Usage */}
                <section className="card p-5">
                  <SectionHeader icon={BarChart2}>Usage</SectionHeader>
                  <div className="space-y-3">
                    <UsageRow label="Seasons" current={seasonsCount} limit={isPro ? null : 5} />
                    <UsageRow label="Tournaments per season" current={null} limit={isPro ? null : 10} note="counted per season" />
                    <UsageRow label="Players per tournament" current={null} limit={isPro ? null : 32} />
                  </div>
                </section>

                {/* Upgrade */}
                {!isPro && isOwner && (
                  <section className="card p-5">
                    <SectionHeader icon={TrendingUp}>Upgrade to Pro</SectionHeader>
                    <div className="mb-5 grid grid-cols-2 gap-3 text-sm">
                      <div className="rounded-xl border border-slate-200 p-4">
                        <p className="mb-1 font-semibold text-slate-700">Community</p>
                        <p className="text-2xl font-bold text-slate-800">Free</p>
                        <ul className="mt-3 space-y-1 text-slate-500">
                          <li>✓ All formats</li>
                          <li>✓ 5 seasons</li>
                          <li>✓ 10 tournaments/season</li>
                          <li>✓ 32 players/tournament</li>
                          <li className="text-slate-300">✗ Branding</li>
                          <li className="text-slate-300">✗ Exports</li>
                          <li className="text-slate-300">✗ Realtime scoreboard</li>
                        </ul>
                      </div>
                      <div className="rounded-xl border-2 border-purple-500 bg-purple-50 p-4">
                        <p className="mb-1 font-semibold text-purple-700">Pro</p>
                        <p className="text-2xl font-bold text-slate-800">
                          $20<span className="text-base font-normal text-slate-500">/mo</span>
                        </p>
                        <ul className="mt-3 space-y-1 text-slate-700">
                          <li>✓ All formats</li>
                          <li>✓ Unlimited seasons</li>
                          <li>✓ Unlimited tournaments</li>
                          <li>✓ 256 players/tournament</li>
                          <li>✓ Custom branding</li>
                          <li>✓ CSV / PDF exports</li>
                          <li>✓ Realtime scoreboard</li>
                        </ul>
                      </div>
                    </div>
                    <p className="mb-4 text-xs text-slate-400">
                      14-day free trial · no card required · cancel anytime
                    </p>
                    <UpgradeButton interval="monthly" label="Start free trial — $20/mo" />
                  </section>
                )}
              </div>
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
                <section className="card space-y-1 p-5">
                  <SectionHeader icon={User}>Profile</SectionHeader>
                  <p className="text-sm text-slate-500">
                    Display name: <span className="font-medium text-slate-700">{user.display_name}</span>
                  </p>
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
