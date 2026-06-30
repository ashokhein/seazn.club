import Link from "next/link";
import { getActiveOrgId, getCurrentUser, getUserOrgs } from "@/lib/auth";
import { LogoutButton } from "@/components/logout-button";

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
    <header className="sticky top-0 z-20 border-b border-purple-100 bg-white/80 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
        <Link href="/" className="flex items-center gap-2">
          {logoUrl ? (
            <>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={logoUrl} alt="Org logo" className="h-8 w-8 rounded-lg object-cover" />
              <span className="text-lg font-semibold tracking-tight text-purple-900">Seazn Club</span>
            </>
          ) : (
            // eslint-disable-next-line @next/next/no-img-element
            <img src="/logo-wide.png" alt="Seazn Club" className="h-9 w-auto" />
          )}
        </Link>
        {user ? (
          <div className="flex items-center gap-3">
            {activeOrg && (
              <span className="hidden max-w-[160px] truncate rounded-full bg-purple-50 px-3 py-1 text-xs font-medium text-purple-700 sm:inline">
                {activeOrg.name}
              </span>
            )}
            <span className="hidden text-sm text-slate-500 sm:inline">
              {user.display_name}
            </span>
            <Link
              href="/dashboard"
              className="rounded-lg px-3 py-1.5 text-sm text-purple-700 transition hover:bg-purple-50"
            >
              Dashboard
            </Link>
            {activeOrg && (
              <Link
                href="/settings"
                className="rounded-lg px-3 py-1.5 text-sm text-purple-700 transition hover:bg-purple-50"
              >
                Settings
              </Link>
            )}
            <LogoutButton />
          </div>
        ) : (
          <Link href="/login" className="btn btn-primary">
            Sign in
          </Link>
        )}
      </div>
    </header>
  );
}
