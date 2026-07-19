export const dynamic = "force-dynamic";
import Link from "@/components/ui/console-link";
import {
  Building2, Users, CreditCard, UserCircle,
  Pencil, Image as ImageIcon, Palette,
  User, Mail, Download, ShieldOff, KeyRound, Compass, Banknote, BookOpen, Cookie, Handshake,
  Clock, Newspaper,
  type LucideIcon,
} from "lucide-react";
import { getUserOrgs } from "@/lib/auth";
import { requireOrgPage } from "@/server/page-auth";
import { routes } from "@/lib/routes";
import { sql } from "@/lib/db";
import { hasFeature } from "@/lib/entitlements";
import { type OrgMember } from "@/lib/types";
import { OrgTeam } from "@/components/org-team";
import { OrgSwitcher } from "@/components/org-switcher";
import { OrgRename } from "@/components/org-rename";
import { OrgLogo } from "@/components/org-logo";
import { OrgBrandColor } from "@/components/org-brand-color";
import { OrgAbout } from "@/components/org-about";
import { OrgSponsors } from "@/components/org-sponsors";
import { SponsorPackages } from "@/components/sponsor-packages";
import { listSponsorRows } from "@/server/usecases/sponsors";
import { listPosts, type OrgPost } from "@/server/usecases/org-posts";
import { NewsTab } from "@/components/news/news-tab";
import { resolveLocale } from "@/lib/resolve-locale";
import { getDictionary, t, type Dict } from "@/lib/i18n";
import {
  DisplayNameForm,
  ChangeEmailForm,
  LeaveOrgButton,
  TransferOwnerForm,
  DeleteAccountButton,
} from "@/components/account-actions";
import { ApiKeysPanel } from "@/components/api-keys";
import { TimezonePreference } from "@/components/timezone-preference";
import { LocalePreference } from "@/components/locale-preference";
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
      <Icon className="h-3.5 w-3.5 text-slate-500" strokeWidth={1.75} />
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</p>
    </div>
  );
}

const ROLE_BADGE: Record<string, string> = {
  owner: "bg-amber-100 text-amber-700",
  admin: "bg-purple-100 text-purple-700",
  viewer: "bg-slate-100 text-slate-600",
};

/** Localized role badge text (owner/admin/viewer/scorer). */
function roleLabel(dict: Dict, role: string): string {
  return t(dict, `role.${role}`);
}

type Tab = "organization" | "news" | "sponsors" | "team" | "api" | "account";

// Plan & billing lives at its own route (/settings/billing) — it owns the
// Stripe checkout-return reconciliation and portal flows — so it links out of
// the tabbed sidebar rather than rendering an inline panel here. `labelKey`
// is a ui-catalog key resolved per-request (t) so the nav localizes.
const NAV_ITEMS: { tab: Tab; labelKey: string; icon: LucideIcon; href?: string }[] = [
  { tab: "organization",  labelKey: "settings.nav.organization", icon: Building2  },
  { tab: "news",          labelKey: "news.tab",                  icon: Newspaper  },
  { tab: "sponsors",      labelKey: "sponsors.title",            icon: Handshake  },
  { tab: "team",          labelKey: "settings.nav.team",         icon: Users      },
  { tab: "api",           labelKey: "settings.nav.api",          icon: KeyRound   },
  { tab: "account",       labelKey: "settings.nav.account",      icon: UserCircle },
];

const BILLING_NAV = { labelKey: "payments.planBilling", icon: CreditCard } as const;
const CONNECT_NAV = { labelKey: "payments.title", icon: Banknote } as const;

export default async function SettingsPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string }>;
  searchParams: Promise<{ tab?: string; email_change?: string }>;
}) {
  const { orgSlug } = await params;
  const page = await requireOrgPage(orgSlug, { tail: "/settings" });
  const { user, org: active, canEdit, auth } = page;
  const orgs = await getUserOrgs(user.id);
  const locale = await resolveLocale();
  const dict = await getDictionary(locale, "ui");

  const { tab: rawTab, email_change } = await searchParams;
  const tab: Tab = (NAV_ITEMS.some((n) => n.tab === rawTab) ? rawTab : "organization") as Tab;

  // Per-tab lazy data loading
  const canBrand =
    tab === "organization" ? await hasFeature(active.id, "branding") : false;
  let orgAbout: string | null = null;
  if (tab === "organization") {
    const [row] = await sql<{ about: string | null }[]>`
      select about from organizations where id = ${active.id}`;
    orgAbout = row?.about ?? null;
  }

  // Sponsors tab (v10 PROMPT-56): table rows, not the branding blob. The
  // basic partner strip is free; tiers/per-competition scoping are Pro.
  let sponsorRows: Awaited<ReturnType<typeof listSponsorRows>> = [];
  let hasSponsorTiers = false;
  let hasSponsorMonetize = false;
  let sponsorCompetitions: { id: string; name: string }[] = [];
  if (tab === "sponsors") {
    sponsorRows = await listSponsorRows(active.id);
    hasSponsorTiers = await hasFeature(active.id, "sponsors.tiers");
    hasSponsorMonetize = await hasFeature(active.id, "sponsors.monetize");
    sponsorCompetitions = await sql<{ id: string; name: string }[]>`
      select id, name from competitions
      where org_id = ${active.id}
      order by created_at desc limit 100`;
  }

  // News tab (SPEC-2): the org's posts (drafts + published) + the competition
  // list for the composer's scope picker. Manual posts are free on every plan.
  let newsPosts: OrgPost[] = [];
  let newsCompetitions: { id: string; name: string }[] = [];
  if (tab === "news") {
    newsPosts = await listPosts(auth, active.id);
    newsCompetitions = await sql<{ id: string; name: string }[]>`
      select id, name from competitions
      where org_id = ${active.id}
      order by created_at desc limit 100`;
  }

  // Platform API tab: api.access = Pro. Scope choice (read/score/manage) is
  // the org's own call (v3/08 §2 — the above-Pro api.write rung is retired).
  let hasApiAccess = false;
  let pinnableCompetitions: { id: string; name: string }[] = [];
  if (tab === "api") {
    hasApiAccess = await hasFeature(active.id, "api.access");
    if (hasApiAccess) {
      pinnableCompetitions = await sql<{ id: string; name: string }[]>`
        select id, name from competitions
        where org_id = ${active.id}
        order by created_at desc limit 100`;
    }
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

  const emailChangeMessage =
    email_change &&
    ["success", "invalid", "expired", "taken", "error"].includes(email_change)
      ? t(dict, `settings.emailChange.${email_change}`)
      : null;

  return (
    <>
      <div className="mx-auto max-w-5xl px-4 py-4 md:py-8">
        <div className="flex flex-col gap-4 md:flex-row md:gap-8">

          {/* ── Sidebar on desktop; sticky scrollable tab row on phones
                 (v3/02 §3.1 — no more desktop-width rows in one long scroll). ── */}
          <aside className="w-full md:w-44 md:shrink-0">
            <p className="mb-3 hidden px-3 text-[11px] font-semibold uppercase tracking-wider text-slate-500 md:block">
              {t(dict, "settings.nav.title")}
            </p>
            {/* Sticky just below the gantry header (which is also sticky
                top:0) — pinning both to top:0 makes them compete for the
                same position and this row loses, scrolling fully out of
                view (02-console-org.md). */}
            <nav className="scroll-x scroll-x-fade sticky top-[var(--app-header-h)] z-30 -mx-4 flex gap-1 whitespace-nowrap bg-[var(--background)]/90 px-4 py-2 backdrop-blur md:static md:z-auto md:mx-0 md:block md:space-y-0.5 md:bg-transparent md:p-0 md:backdrop-blur-none">
              {NAV_ITEMS.map(({ tab: navTab, labelKey, icon: Icon }) => {
                const isActive = tab === navTab;
                return (
                  <Link
                    key={navTab}
                    href={routes.orgSettings(orgSlug, navTab)}
                    className={`flex shrink-0 items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition ${
                      isActive
                        ? "bg-purple-100 font-medium text-purple-800"
                        : "text-slate-600 hover:bg-purple-50 hover:text-purple-700"
                    }`}
                  >
                    <Icon
                      className={`h-4 w-4 shrink-0 ${isActive ? "text-purple-600" : "text-slate-500"}`}
                      strokeWidth={1.75}
                    />
                    {t(dict, labelKey)}
                  </Link>
                );
              })}
              {/* Connect + Plan & billing are their own routes (each owns a
                  Stripe reconcile-on-return round trip). */}
              <Link
                href={routes.connect(orgSlug)}
                className="flex shrink-0 items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-slate-600 transition hover:bg-purple-50 hover:text-purple-700"
              >
                <CONNECT_NAV.icon className="h-4 w-4 shrink-0 text-slate-500" strokeWidth={1.75} />
                {t(dict, CONNECT_NAV.labelKey)}
              </Link>
              <Link
                href={routes.billing(orgSlug)}
                className="flex shrink-0 items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-slate-600 transition hover:bg-purple-50 hover:text-purple-700"
              >
                <BILLING_NAV.icon className="h-4 w-4 shrink-0 text-slate-500" strokeWidth={1.75} />
                {t(dict, BILLING_NAV.labelKey)}
              </Link>
            </nav>
            <div className="my-4 hidden border-t border-purple-100 md:block" />
            <Link
              href={routes.orgHome(orgSlug)}
              className="hidden rounded-lg px-3 py-2 text-sm text-slate-500 transition hover:bg-slate-50 hover:text-slate-600 md:block"
            >
              ← {t(dict, "settings.nav.backToCompetitions")}
            </Link>
          </aside>

          {/* ── Panel ── */}
          <main className="min-w-0 flex-1">

            {/* ── ORGANISATION ── */}
            {tab === "organization" && (
              <section className="card p-6">
                <SectionHeader icon={Building2}>{t(dict, "settings.nav.organization")}</SectionHeader>

                <div className="flex items-center gap-3">
                  <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-purple-500 to-fuchsia-500 text-lg font-bold text-white">
                    {active.name.charAt(0).toUpperCase()}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-slate-800">{active.name}</p>
                    <p className="truncate font-mono text-xs text-purple-600">{active.slug}</p>
                  </div>
                  <span className={`badge ${ROLE_BADGE[active.role]}`}>{roleLabel(dict, active.role)}</span>
                  <OrgSwitcher orgs={orgs} activeId={active.id} />
                </div>

                {canEdit && (
                  <div className="mt-5 border-t border-slate-100 pt-5" data-tour="org-rename">
                    <SubSection icon={Pencil} label={t(dict, "settings.org.rename")} />
                    <OrgRename orgId={active.id} initialName={active.name} />
                  </div>
                )}

                {canEdit && (
                  <div className="mt-5 border-t border-slate-100 pt-5">
                    <SubSection icon={ImageIcon} label={t(dict, "settings.org.logo")} />
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
                      <p className="flex items-center gap-2 text-sm text-slate-500">
                        <PlanBadge feature="branding" />
                        {t(dict, "settings.upgrade.logo")}{" "}
                        <Link href={routes.billing(orgSlug)} className="text-purple-600 underline">
                          {t(dict, "settings.upgrade.link")}
                        </Link>
                      </p>
                    )}
                  </div>
                )}

                {canEdit && (
                  <div className="mt-5 border-t border-slate-100 pt-5">
                    <SubSection icon={Palette} label={t(dict, "settings.org.brandColor")} />
                    {canBrand ? (
                      <OrgBrandColor orgId={active.id} initialBranding={active.branding} />
                    ) : (
                      <p className="flex items-center gap-2 text-sm text-slate-500">
                        <PlanBadge feature="branding" />
                        {t(dict, "settings.upgrade.brandColor")}{" "}
                        <Link href={routes.billing(orgSlug)} className="text-purple-600 underline">
                          {t(dict, "settings.upgrade.link")}
                        </Link>
                      </p>
                    )}
                  </div>
                )}

                {canEdit && (
                  <div className="mt-5 border-t border-slate-100 pt-5">
                    <SubSection icon={BookOpen} label={t(dict, "settings.org.about")} />
                    <OrgAbout orgId={active.id} initialValue={orgAbout} branding={active.branding} />
                  </div>
                )}


                {canEdit && (
                  <div className="mt-5 border-t border-slate-100 pt-5">
                    <SubSection icon={Compass} label={t(dict, "settings.org.tour")} />
                    <TourReplayButton />
                  </div>
                )}
              </section>
            )}

            {/* ── NEWS ── */}
            {tab === "news" && (
              <section className="card p-6">
                <SectionHeader icon={Newspaper}>{t(dict, "news.tab")}</SectionHeader>
                <NewsTab
                  orgId={active.id}
                  orgSlug={active.slug}
                  posts={newsPosts}
                  competitions={newsCompetitions}
                  canEdit={canEdit}
                />
              </section>
            )}

            {/* ── SPONSORS ── */}
            {tab === "sponsors" && (
              <section className="card p-6">
                <SectionHeader icon={Handshake}>{t(dict, "sponsors.title")}</SectionHeader>
                <OrgSponsors
                  orgId={active.id}
                  initialSponsors={sponsorRows}
                  competitions={sponsorCompetitions}
                  hasTiers={hasSponsorTiers}
                  billingHref={routes.billing(orgSlug)}
                  canEdit={canEdit}
                />
                {canEdit && (
                  <div className="mt-6 border-t border-slate-100 pt-5">
                    <SubSection icon={Banknote} label={t(dict, "sponsors.sell.title")} />
                    <SponsorPackages
                      orgId={active.id}
                      competitions={sponsorCompetitions}
                      hasMonetize={hasSponsorMonetize}
                      billingHref={routes.billing(orgSlug)}
                    />
                  </div>
                )}
              </section>
            )}

            {tab === "team" && (
              <section className="card p-6">
                <SectionHeader icon={Users}>{t(dict, "settings.nav.team")}</SectionHeader>
                <OrgTeam orgId={active.id} role={active.role} currentUserId={user.id} />
              </section>
            )}

            {/* ── PLATFORM API ── */}
            {tab === "api" && (
              <section className="card p-6">
                <SectionHeader icon={KeyRound}>{t(dict, "settings.nav.api")}</SectionHeader>
                {!canEdit ? (
                  <p className="text-sm text-slate-500">
                    {t(dict, "settings.api.noAccess")}
                  </p>
                ) : hasApiAccess ? (
                  <ApiKeysPanel orgId={active.id} competitions={pinnableCompetitions} />
                ) : (
                  <p className="flex items-center gap-2 text-sm text-slate-500">
                    <PlanBadge feature="api.access" />
                    {t(dict, "settings.upgrade.api")}{" "}
                    <Link href={routes.billing(orgSlug)} className="text-purple-600 underline">
                      {t(dict, "settings.upgrade.link")}
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
                  <SectionHeader icon={User}>{t(dict, "settings.account.profile")}</SectionHeader>
                  <label className="block text-sm text-slate-500">{t(dict, "settings.account.displayName")}</label>
                  <DisplayNameForm currentName={user.display_name} />
                  <p className="text-sm text-slate-500">
                    {t(dict, "settings.account.emailLabel")}: <span className="font-medium text-slate-700">{user.email}</span>
                  </p>
                  <p className="text-sm text-slate-500">
                    {t(dict, "settings.account.accountId")}: <span className="font-mono text-xs text-purple-600">{user.id}</span>
                  </p>
                </section>

                {/* Preferences — timezone (spec 2026-07-14). Drives every
                    personal time + the local-time hint beside venue times. */}
                <section className="card p-5">
                  <SectionHeader icon={Clock}>{t(dict, "settings.account.preferences")}</SectionHeader>
                  <label className="mb-1 block text-sm text-slate-500">{t(dict, "settings.account.timezone")}</label>
                  <TimezonePreference current={user.timezone} />
                  <label className="mb-1 mt-5 block text-sm text-slate-500">{t(dict, "settings.account.language")}</label>
                  <LocalePreference current={user.locale} />
                </section>

                {/* Change email */}
                <section className="card p-5">
                  <SectionHeader icon={Mail}>{t(dict, "settings.account.changeEmail")}</SectionHeader>
                  <ChangeEmailForm currentEmail={user.email} />
                </section>

                {/* Export */}
                <section className="card p-5">
                  <SectionHeader
                    icon={Download}
                    action={
                      <a href="/api/users/me/export" download className="btn btn-ghost text-xs">
                        {t(dict, "settings.account.downloadJson")}
                      </a>
                    }
                  >
                    {t(dict, "settings.account.export")}
                  </SectionHeader>
                  <p className="text-sm text-slate-500">
                    {t(dict, "settings.account.exportDesc")}
                  </p>
                </section>

                {/* Privacy & cookies — analytics consent can be changed/withdrawn here. */}
                <section className="card p-5">
                  <SectionHeader
                    icon={Cookie}
                    action={
                      <CookieSettingsButton className="btn btn-ghost text-xs">
                        {t(dict, "settings.account.cookieSettings")}
                      </CookieSettingsButton>
                    }
                  >
                    {t(dict, "settings.account.privacy")}
                  </SectionHeader>
                  <p className="text-sm text-slate-500">
                    {t(dict, "settings.account.privacyDesc")}{" "}
                    <Link href="/legal/cookie-policy" className="text-purple-600 underline">
                      {t(dict, "settings.account.cookiePolicy")}
                    </Link>
                    .
                  </p>
                </section>

                {/* Org actions */}
                {orgs.length > 0 && (
                  <section className="card p-5">
                    <SectionHeader icon={Building2}>{t(dict, "settings.account.organizations")}</SectionHeader>
                    <div className="space-y-6">
                      {orgs.map((org) => {
                        const members = orgMembersMap.get(org.id) ?? [];
                        return (
                          <div key={org.id} className="space-y-3">
                            <div className="flex items-center justify-between">
                              <div>
                                <p className="font-medium text-slate-800">{org.name}</p>
                                <p className="text-xs text-slate-500 font-mono">{org.slug}</p>
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
                                {roleLabel(dict, org.role)}
                              </span>
                            </div>
                            {org.role === "owner" && members.length > 1 && (
                              <div className="pl-2 border-l-2 border-slate-100 space-y-1">
                                <p className="text-xs font-medium text-slate-500">{t(dict, "settings.account.transferOwnership")}</p>
                                <TransferOwnerForm orgId={org.id} members={members} />
                              </div>
                            )}
                            {org.role !== "owner" && (
                              <LeaveOrgButton orgId={org.id} orgName={org.name} />
                            )}
                            {org.role === "owner" && members.length === 1 && (
                              <p className="text-xs text-slate-500">
                                {t(dict, "settings.account.soleOwner")}
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
                    <h2 className="text-sm font-semibold text-red-600">{t(dict, "settings.account.dangerZone")}</h2>
                  </div>
                  <p className="mb-4 text-sm text-slate-500">
                    {t(dict, "settings.account.deleteDesc")}
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
