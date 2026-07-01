import Link from "next/link";
import { LayoutDashboard, Settings, LogOut, ChevronDown } from "lucide-react";
import { getActiveOrgId, getCurrentUser, getUserOrgs } from "@/lib/auth";
import { LogoutButton } from "@/components/logout-button";
import { OrgSwitcher } from "@/components/org-switcher";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";

function orgLogoUrl(org: { logo_storage_path: string | null; logo_url: string | null }): string | null {
  if (org.logo_storage_path && SUPABASE_URL)
    return `${SUPABASE_URL}/storage/v1/object/public/assets/${org.logo_storage_path}`;
  if (org.logo_url?.startsWith("https://")) return org.logo_url;
  return null;
}

export async function Nav() {
  const user = await getCurrentUser();
  let activeOrg: { name: string; logo_storage_path: string | null; logo_url: string | null } | null = null;
  if (user) {
    const orgs = await getUserOrgs(user.id);
    if (orgs.length > 0) {
      const activeId = await getActiveOrgId();
      activeOrg = orgs.find((o) => o.id === activeId) ?? orgs[0];
    }
  }
  const logoUrl = activeOrg ? orgLogoUrl(activeOrg) : null;

  return (
    <header className="sticky top-0 z-20 border-b border-slate-200 bg-white/95 backdrop-blur supports-[backdrop-filter]:bg-white/80">
      <div className="mx-auto flex max-w-6xl items-center gap-6 px-4 h-14">

        {/* Logo */}
        <Link href="/" className="flex shrink-0 items-center gap-2.5 mr-2">
          {logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={logoUrl} alt="Org logo" className="h-7 w-7 rounded-md object-cover ring-1 ring-slate-200" />
          ) : (
            // eslint-disable-next-line @next/next/no-img-element
            <img src="/logo-wide.png" alt="Seazn Club" className="h-8 w-auto" />
          )}
        </Link>

        {/* Primary nav */}
        {user && (
          <nav className="flex items-center gap-0.5">
            <Link
              href="/dashboard"
              className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium text-slate-600 transition-colors hover:bg-slate-100 hover:text-slate-900"
            >
              <LayoutDashboard className="h-4 w-4" strokeWidth={1.75} />
              Dashboard
            </Link>
            <Link
              href="/settings"
              className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium text-slate-600 transition-colors hover:bg-slate-100 hover:text-slate-900"
            >
              <Settings className="h-4 w-4" strokeWidth={1.75} />
              Settings
            </Link>
          </nav>
        )}

        {/* Spacer */}
        <div className="flex-1" />

        {/* Right side */}
        {user ? (
          <div className="flex items-center gap-2">
            {/* Org pill */}
            {activeOrg && (
              <span className="hidden items-center gap-1.5 rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs font-medium text-slate-600 sm:flex">
                <span className="h-1.5 w-1.5 rounded-full bg-purple-500" />
                {activeOrg.name}
              </span>
            )}
            {/* User */}
            <span className="hidden text-sm font-medium text-slate-700 sm:block">
              {user.display_name}
            </span>
            <LogoutButton />
          </div>
        ) : (
          <Link href="/login" className="btn btn-primary">Sign in</Link>
        )}
      </div>
    </header>
  );
}
