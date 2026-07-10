import Link from "next/link";
import { LayoutDashboard, Settings, Users } from "lucide-react";
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
    <header className="sticky top-0 z-20 border-b border-slate-200 bg-white/95 backdrop-blur supports-[backdrop-filter]:bg-white/80">
      <div className="mx-auto flex max-w-6xl items-center gap-4 px-4 h-14">

        {/* Left: logo + org name */}
        <Link href="/" className="flex shrink-0 items-center gap-2.5">
          {logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={logoUrl} alt="Org logo" className="h-7 w-7 rounded-md object-cover ring-1 ring-slate-200" />
          ) : (
            // eslint-disable-next-line @next/next/no-img-element
            <img src="/logo-wide.png" alt="Seazn Club" className="h-8 w-auto" />
          )}
        </Link>
        {user && activeOrg && (
          <span
            data-tour="org-chip"
            className="hidden items-center gap-1.5 rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs font-medium text-slate-600 sm:flex"
          >
            <span className="h-1.5 w-1.5 rounded-full bg-purple-500" />
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
                className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium text-slate-600 transition-colors hover:bg-slate-100 hover:text-slate-900"
              >
                <LayoutDashboard className="h-4 w-4" strokeWidth={1.75} />
                <span className="hidden sm:inline">Dashboard</span>
              </Link>
              <Link
                href="/directory"
                aria-label="Directory"
                className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium text-slate-600 transition-colors hover:bg-slate-100 hover:text-slate-900"
              >
                <Users className="h-4 w-4" strokeWidth={1.75} />
                <span className="hidden sm:inline">Directory</span>
              </Link>
              <Link
                href={activeOrg ? routes.orgSettings(activeOrg.slug) : "/orgs/new"}
                aria-label="Settings"
                className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium text-slate-600 transition-colors hover:bg-slate-100 hover:text-slate-900"
              >
                <Settings className="h-4 w-4" strokeWidth={1.75} />
                <span className="hidden sm:inline">Settings</span>
              </Link>
            </nav>
            <span className="mx-1 hidden text-sm font-medium text-slate-700 sm:block">
              {user.display_name}
            </span>
            <LogoutButton />
          </div>
        ) : (
          <Link href="/login" className="btn btn-primary">Sign in</Link>
        )}
      </div>
      {canTour && <ProductTour autoStart={tourPending} />}
    </header>
  );
}
