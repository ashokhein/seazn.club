import Link from "next/link";
import { LayoutDashboard, Settings, Users } from "lucide-react";
import { HelpMenu } from "@/components/help-menu";
import { getActiveOrgId, getCurrentUser, getUserOrgs } from "@/lib/auth";
import { routes } from "@/lib/routes";
import { needsTourAfterOnboarding } from "@/lib/activation";
import { EDITOR_ROLES } from "@/lib/types";
import { LogoutButton } from "@/components/logout-button";
import { ProductTour } from "@/components/product-tour";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";

function orgLogoUrl(org: { logo_storage_path: string | null; logo_url: string | null }): string | null {
  if (org.logo_storage_path && SUPABASE_URL)
    return `${SUPABASE_URL}/storage/v1/object/public/assets/${org.logo_storage_path}`;
  if (org.logo_url?.startsWith("https://")) return org.logo_url;
  return null;
}

export async function Nav() {
  const user = await getCurrentUser();
  let activeOrg: {
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
  // Tour targets editor flows (rename org, create competition) — viewers skip it.
  const canTour =
    !!user && !!activeOrg && (EDITOR_ROLES as readonly string[]).includes(activeOrg.role);
  // Sequence: the tour only auto-starts once onboarding is complete.
  const tourPending = canTour && (await needsTourAfterOnboarding(user!.id));

  return (
    // The gantry (floodlit-console spec §4): night chrome closed by the
    // sticky lime hairline — the one place the chrome touches the pitch.
    <header className="app-gantry sticky top-0 z-20">
      <div className="mx-auto flex max-w-6xl items-center gap-4 px-4 h-14">

        {/* Left: wordmark + org scorebug. The light logo image is illegible
            on night, so the wordmark goes condensed cream (same move as the
            marketing night nav). */}
        <Link href="/" className="flex shrink-0 items-center gap-2.5">
          {logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={logoUrl} alt="Org logo" className="h-7 w-7 rounded-md object-cover ring-1 ring-cream/20" />
          ) : (
            <span className="app-display text-lg font-bold leading-none text-cream">
              Seazn <span className="text-lime-400">Club</span>
            </span>
          )}
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
                aria-label="Dashboard"
                className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium text-cream/85 transition-colors hover:bg-cream/10 hover:text-cream"
              >
                <LayoutDashboard className="h-4 w-4" strokeWidth={1.75} />
                <span className="hidden sm:inline">Dashboard</span>
              </Link>
              <Link
                href="/directory"
                aria-label="Directory"
                className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium text-cream/85 transition-colors hover:bg-cream/10 hover:text-cream"
              >
                <Users className="h-4 w-4" strokeWidth={1.75} />
                <span className="hidden sm:inline">Directory</span>
              </Link>
              <Link
                href={activeOrg ? routes.orgSettings(activeOrg.slug) : "/orgs/new"}
                aria-label="Settings"
                className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium text-cream/85 transition-colors hover:bg-cream/10 hover:text-cream"
              >
                <Settings className="h-4 w-4" strokeWidth={1.75} />
                <span className="hidden sm:inline">Settings</span>
              </Link>
            </nav>
            {/* The console "?" menu (v3/06 §3): closes on outside click/Esc. */}
            <HelpMenu />
            <span className="mx-1 hidden text-sm font-medium text-cream/85 sm:block">
              {user.display_name}
            </span>
            <LogoutButton />
          </div>
        ) : (
          <Link
            href="/login"
            className="btn bg-lime-400 font-semibold text-night hover:bg-lime-300"
          >
            Sign in
          </Link>
        )}
      </div>
      {canTour && activeOrg && <ProductTour autoStart={tourPending} orgSlug={activeOrg.slug} />}
    </header>
  );
}
