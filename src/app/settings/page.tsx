import Link from "next/link";
import { redirect } from "next/navigation";
import { getActiveOrgId, getCurrentUser, getUserOrgs } from "@/lib/auth";
import { listOrgSportPresets } from "@/lib/sport-presets";
import { EDITOR_ROLES } from "@/lib/types";
import { Nav } from "@/components/nav";
import { OrgTeam } from "@/components/org-team";
import { OrgSwitcher } from "@/components/org-switcher";
import { OrgRename } from "@/components/org-rename";
import { OrgSportPresets } from "@/components/org-sport-presets";

const ROLE_BADGE: Record<string, string> = {
  owner: "bg-amber-100 text-amber-700",
  admin: "bg-purple-100 text-purple-700",
  viewer: "bg-slate-100 text-slate-600",
};

export default async function SettingsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const orgs = await getUserOrgs(user.id);
  if (orgs.length === 0) redirect("/orgs/new");

  const activeId = await getActiveOrgId();
  const active = orgs.find((o) => o.id === activeId) ?? orgs[0];
  const canEdit = (EDITOR_ROLES as readonly string[]).includes(active.role);
  const sportPresets = await listOrgSportPresets(active.id);

  return (
    <>
      <Nav />
      <main className="mx-auto max-w-3xl px-4 py-8">
        <div className="mb-6 flex items-center justify-between">
          <h1 className="text-2xl font-bold tracking-tight text-purple-900">
            Settings
          </h1>
          <Link href="/dashboard" className="btn btn-ghost">
            ← Back
          </Link>
        </div>

        {/* Organization */}
        <section className="card mb-6 space-y-4 p-5">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-purple-400">
            Organization
          </h2>
          <div className="flex items-center gap-3">
            <span className="grid h-11 w-11 place-items-center rounded-xl bg-gradient-to-br from-purple-500 to-fuchsia-500 text-lg font-bold text-white">
              {active.name.charAt(0).toUpperCase()}
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-lg font-semibold text-slate-800">
                {active.name}
              </p>
              <p className="truncate font-mono text-xs text-purple-400">
                ID: {active.slug}
              </p>
            </div>
            <span className={`badge ${ROLE_BADGE[active.role]}`}>
              {active.role}
            </span>
          </div>

          {canEdit && (
            <OrgRename orgId={active.id} initialName={active.name} />
          )}

          <OrgSwitcher orgs={orgs} activeId={active.id} />
        </section>

        {/* Sport presets */}
        <section className="card mb-6 p-5">
          <div className="mb-3 flex items-center justify-between gap-2">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-purple-400">
              Sport presets
            </h2>
            {canEdit && (
              <span className="text-[11px] text-slate-400">Editors only</span>
            )}
          </div>
          <OrgSportPresets
            orgId={active.id}
            initialPresets={sportPresets}
            canEdit={canEdit}
          />
        </section>

        {/* Team */}
        <section className="card p-5">
          <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-purple-400">
            Team
          </h2>
          <OrgTeam orgId={active.id} role={active.role} currentUserId={user.id} />
        </section>
      </main>
    </>
  );
}
