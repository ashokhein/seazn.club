import Link from "next/link";
import { getActiveOrgId, getCurrentUser, getUserOrgs } from "@/lib/auth";
import { LogoutButton } from "@/components/logout-button";

export async function Nav() {
  const user = await getCurrentUser();
  let activeOrgName: string | null = null;
  if (user) {
    const orgs = await getUserOrgs(user.id);
    if (orgs.length > 0) {
      const activeId = await getActiveOrgId();
      activeOrgName = (orgs.find((o) => o.id === activeId) ?? orgs[0]).name;
    }
  }
  return (
    <header className="sticky top-0 z-20 border-b border-purple-100 bg-white/80 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
        <Link href="/" className="flex items-center gap-2">
          <span className="grid h-8 w-8 place-items-center rounded-lg bg-gradient-to-br from-purple-500 to-fuchsia-500 font-bold text-white">
            S
          </span>
          <span className="text-lg font-semibold tracking-tight text-purple-900">
            S.A.F.E Tournaments
          </span>
        </Link>
        {user ? (
          <div className="flex items-center gap-3">
            {activeOrgName && (
              <span className="hidden max-w-[160px] truncate rounded-full bg-purple-50 px-3 py-1 text-xs font-medium text-purple-700 sm:inline">
                {activeOrgName}
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
            {activeOrgName && (
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
