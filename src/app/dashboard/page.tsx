import Link from "next/link";
import { redirect } from "next/navigation";
import {
  getActiveOrgId,
  getCurrentUser,
  getUserOrgs,
} from "@/lib/auth";
import { sql } from "@/lib/db";
import { Nav } from "@/components/nav";
import { CreateSeasonForm } from "@/components/create-season-form";
import type { Season, Tournament } from "@/lib/types";

const STATUS_STYLE: Record<string, string> = {
  setup: "bg-slate-100 text-slate-600",
  group: "bg-sky-100 text-sky-700",
  knockout: "bg-amber-100 text-amber-700",
  final: "bg-amber-100 text-amber-700",
  completed: "bg-emerald-100 text-emerald-700",
};

const NO_SEASON = "__none__";

export default async function DashboardPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const orgs = await getUserOrgs(user.id);
  if (orgs.length === 0) redirect("/orgs/new");

  const activeId = await getActiveOrgId();
  const active = orgs.find((o) => o.id === activeId) ?? orgs[0];
  const canEdit = active.role === "owner" || active.role === "admin";

  const seasons = await sql<Season[]>`
    select id, org_id, name, slug, created_at from seasons
    where org_id = ${active.id} order by created_at asc`;
  const tournaments = await sql<Tournament[]>`
    select * from tournaments where org_id = ${active.id}
    order by created_at desc`;

  const bySeason = new Map<string, Tournament[]>();
  for (const t of tournaments) {
    const key = t.season_id ?? NO_SEASON;
    if (!bySeason.has(key)) bySeason.set(key, []);
    bySeason.get(key)!.push(t);
  }

  const sections: { id: string; name: string; slug: string | null }[] = [
    ...seasons.map((s) => ({ id: s.id, name: s.name, slug: s.slug })),
  ];
  if (bySeason.has(NO_SEASON))
    sections.push({ id: NO_SEASON, name: "No season", slug: null });

  const renderCard = (t: Tournament) => (
    <li key={t.id}>
      <Link
        href={`/tournaments/${t.id}`}
        className="flex items-center justify-between rounded-lg border border-purple-100 bg-white px-3 py-2 transition hover:border-purple-300 hover:shadow-sm"
      >
        <span>
          <span className="block text-sm font-medium text-slate-800">
            {t.name}
          </span>
          <span className="block text-xs text-slate-500">
            {t.sport} · {t.category} · {t.format.replace(/_/g, " ")}
          </span>
        </span>
        <span
          className={`badge ${STATUS_STYLE[t.status] ?? STATUS_STYLE.setup}`}
        >
          {t.status}
        </span>
      </Link>
    </li>
  );

  return (
    <>
      <Nav />
      <main className="mx-auto max-w-6xl px-4 py-8">
        <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-3">
              <h1 className="text-2xl font-bold tracking-tight text-purple-900">
                Tournaments
              </h1>
              <span className={`badge ${roleBadge(active.role)}`}>
                {active.role}
              </span>
            </div>
            <p className="text-sm text-slate-500">
              {canEdit
                ? "Group by season (optional), then spin up a tournament for any sport."
                : "You have view-only access to this board."}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {canEdit && <CreateSeasonForm />}
            {canEdit && (
              <Link href="/tournaments/new" className="btn btn-primary">
                + New tournament
              </Link>
            )}
          </div>
        </div>

        {tournaments.length === 0 && seasons.length === 0 ? (
          <p className="text-sm text-slate-500">
            {canEdit
              ? "Nothing yet — create your first tournament."
              : "No tournaments yet."}
          </p>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {sections.map((s) => {
              const list = bySeason.get(s.id) ?? [];
              return (
                <section key={s.id} className="card p-4">
                  <div className="mb-3 flex items-baseline justify-between">
                    <h2 className="text-lg font-semibold text-purple-900">
                      {s.name}
                    </h2>
                    {s.slug && (
                      <span className="font-mono text-xs text-purple-400">
                        {s.slug}
                      </span>
                    )}
                  </div>
                  {list.length === 0 ? (
                    <p className="text-sm text-slate-500">No tournaments yet.</p>
                  ) : (
                    <ul className="space-y-2">{list.map(renderCard)}</ul>
                  )}
                </section>
              );
            })}
          </div>
        )}
      </main>
    </>
  );
}

function roleBadge(role: string): string {
  if (role === "owner") return "bg-amber-100 text-amber-700";
  if (role === "admin") return "bg-purple-100 text-purple-700";
  return "bg-slate-100 text-slate-600";
}
