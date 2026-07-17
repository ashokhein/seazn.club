import Link from "@/components/ui/console-link";
import { CircleUserRound, LayoutDashboard, Settings, Users } from "lucide-react";
import { HelpMenu } from "@/components/help-menu";
import { getActiveOrgId, getCurrentUser, getUserOrgs } from "@/lib/auth";
import { hasClaimedProfile } from "@/server/usecases/me";
import { routes } from "@/lib/routes";
import { needsTourAfterOnboarding } from "@/lib/activation";
import { EDITOR_ROLES } from "@/lib/types";
import { LogoutButton } from "@/components/logout-button";
import { ProductTour } from "@/components/product-tour";
import { hasAnyCompetitions } from "@/server/usecases/competitions";
import { resolveLocale } from "@/lib/resolve-locale";
import { getDictionary, t, type Dict } from "@/lib/i18n";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";

/** Plain tour-copy slice (keys `tour.*`) for the client ProductTour island —
 *  crosses the RSC boundary as serializable props. */
function tourDict(dict: Dict): Record<string, string> {
  return Object.fromEntries(
    Object.entries(dict)
      .filter(([k]) => k.startsWith("tour."))
      .map(([k, v]) => [k, String(v)]),
  );
}

function orgLogoUrl(org: { logo_storage_path: string | null; logo_url: string | null }): string | null {
  if (org.logo_storage_path && SUPABASE_URL)
    return `${SUPABASE_URL}/storage/v1/object/public/assets/${org.logo_storage_path}`;
  if (org.logo_url?.startsWith("https://")) return org.logo_url;
  return null;
}

export async function Nav() {
  // Console chrome locale (v5 i18n cycle 46): cookie → user → header → en. Nav
  // already reads cookies via getCurrentUser(), so it is dynamic regardless.
  const locale = await resolveLocale();
  const dict = await getDictionary(locale, "console");
  const user = await getCurrentUser();
  let activeOrg: {
    id: string;
    name: string;
    slug: string;
    role: string;
    logo_storage_path: string | null;
    logo_url: string | null;
  } | null = null;
  if (user) {
    const orgs = await getUserOrgs(user.id);
    if (orgs.length > 0) {
      const activeId = await getActiveOrgId();
      activeOrg = orgs.find((o) => o.id === activeId) ?? orgs[0];
    }
  }
  const logoUrl = activeOrg ? orgLogoUrl(activeOrg) : null;
  const isPlayer = !!user && (await hasClaimedProfile(user.id));
  // Tour targets editor flows (rename org, create competition) — viewers skip it.
  const canTour =
    !!user && !!activeOrg && (EDITOR_ROLES as readonly string[]).includes(activeOrg.role);
  // Sequence: the tour only auto-starts once onboarding is complete.
  const tourPending = canTour && (await needsTourAfterOnboarding(user!.id));
  // The tour's first step is a centered "welcome" card with no target — on a
  // brand-new org (zero competitions) it lands directly on top of the
  // org-home empty-state CTA it's meant to explain. That CTA already does the
  // tour's job there, so skip the auto-open until there's a competition to
  // walk through; the tour stays reachable manually (Settings ▸ Product tour).
  const tourReady =
    tourPending && activeOrg
      ? await hasAnyCompetitions({
          orgId: activeOrg.id,
          userId: user!.id,
          // Only orgId drives the tenant-scoped query below — role is unused.
          role: null,
          via: "session",
          keyId: null,
        })
      : false;

  return (
    // The gantry (floodlit-console spec §4): night chrome closed by the
    // sticky lime hairline — the one place the chrome touches the pitch.
    <header className="app-gantry sticky top-0 z-20">
      <div className="mx-auto flex max-w-6xl items-center gap-4 px-4 h-14">

        {/* Left: wordmark + org scorebug. logo-wide-night.png is the cream
            wordmark with the pitch line + ball — legible on night chrome. */}
        <Link href="/" className="flex shrink-0 items-center gap-2.5">
          {logoUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={logoUrl} alt={t(dict, "nav.orgLogoAlt")} className="h-7 w-7 rounded-md object-cover ring-1 ring-cream/20" />
          )}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo-wide-night.png" alt="Seazn Club" className="h-7 w-auto" />
        </Link>
        {user && activeOrg && (
          <span
            data-tour="org-chip"
            className="hidden items-center gap-1.5 rounded-full border border-cream/15 bg-cream/[0.07] px-3 py-1 text-xs font-medium text-cream/85 sm:flex"
          >
            <span className="h-1.5 w-1.5 rounded-full bg-lime-400" />
            {activeOrg.name}
          </span>
        )}

        {/* Spacer */}
        <div className="flex-1" />

        {/* Right: primary nav + user */}
        {user ? (
          <div className="flex items-center gap-1">
            <nav className="flex items-center gap-0.5">
              {/* Labels collapse to icons under `sm` — aria-label keeps the
                  accessible name (axe link-name, v3/11 gap 11). */}
              <Link
                href={activeOrg ? routes.orgHome(activeOrg.slug) : "/orgs/new"}
                aria-label={t(dict, "nav.dashboard")}
                className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium text-cream/85 transition-colors hover:bg-cream/10 hover:text-cream"
              >
                <LayoutDashboard className="h-4 w-4" strokeWidth={1.75} />
                <span className="hidden sm:inline">{t(dict, "nav.dashboard")}</span>
              </Link>
              <Link
                href="/directory"
                aria-label={t(dict, "nav.directory")}
                className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium text-cream/85 transition-colors hover:bg-cream/10 hover:text-cream"
              >
                <Users className="h-4 w-4" strokeWidth={1.75} />
                <span className="hidden sm:inline">{t(dict, "nav.directory")}</span>
              </Link>
              <Link
                href={activeOrg ? routes.orgSettings(activeOrg.slug) : "/orgs/new"}
                aria-label={t(dict, "nav.settings")}
                className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium text-cream/85 transition-colors hover:bg-cream/10 hover:text-cream"
              >
                <Settings className="h-4 w-4" strokeWidth={1.75} />
                <span className="hidden sm:inline">{t(dict, "nav.settings")}</span>
              </Link>
              {/* Dual-role seam (PROMPT-53): an organiser who is ALSO a
                  claimed player keeps a door to their own player home. */}
              {isPlayer && (
                <Link
                  href={routes.me()}
                  aria-label={t(dict, "nav.playerHome")}
                  className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium text-cream/85 transition-colors hover:bg-cream/10 hover:text-cream"
                >
                  <CircleUserRound className="h-4 w-4" strokeWidth={1.75} />
                  <span className="hidden sm:inline">{t(dict, "nav.playerHome")}</span>
                </Link>
              )}
            </nav>
            {/* The console "?" menu (v3/06 §3): closes on outside click/Esc. */}
            <HelpMenu
              labels={{
                menu: t(dict, "help.menu"),
                centre: t(dict, "help.centre"),
                developerDocs: t(dict, "help.developerDocs"),
                contactSupport: t(dict, "help.contactSupport"),
              }}
            />
            <span className="mx-1 hidden text-sm font-medium text-cream/85 sm:block">
              {user.display_name}
            </span>
            <LogoutButton label={t(dict, "nav.signOut")} />
          </div>
        ) : (
          <Link
            href="/login"
            className="btn bg-lime-400 font-semibold text-night hover:bg-lime-300"
          >
            {t(dict, "nav.signIn")}
          </Link>
        )}
      </div>
      {canTour && activeOrg && (
        <ProductTour autoStart={tourReady} orgSlug={activeOrg.slug} dict={tourDict(dict)} />
      )}
    </header>
  );
}
