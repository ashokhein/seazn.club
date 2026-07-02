export const dynamic = "force-dynamic";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Trophy, Calendar, Layers } from "lucide-react";
import {
  getActiveOrgId,
  getCurrentUser,
  getUserOrgs,
} from "@/lib/auth";
import { sql } from "@/lib/db";
import { Nav } from "@/components/nav";
import { BillingBanner } from "@/components/billing-banner";
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
        className="group flex items-center justify-between rounded-lg border border-slate-200 bg-white px-3.5 py-2.5 transition hover:border-purple-300 hover:shadow-sm"
      >
        <span className="min-w-0">
          <span className="block truncate text-sm font-medium text-slate-800 group-hover:text-purple-700">
            {t.name}
          </span>
          <span className="block text-xs text-slate-400">
            {t.sport} · {t.category}
          </span>
        </span>
        <span
          className={`ml-3 shrink-0 badge ${STATUS_STYLE[t.status] ?? STATUS_STYLE.setup}`}
        >
          {t.status}
        </span>
      </Link>
    </li>
  );

  return (
    <>
      <Nav />
      <BillingBanner orgId={active.id} />
      <main className="mx-auto max-w-6xl px-4 py-8">
        <div className="mb-8 flex flex-wrap items-start justify-between gap-4 border-b border-slate-100 pb-6">
          <div className="min-w-0">
            <div className="flex items-center gap-3">
              <h1 className="text-xl font-semibold tracking-tight text-slate-900">
                Tournaments
              </h1>
              <span className={`badge ${roleBadge(active.role)}`}>
                {active.role}
              </span>
            </div>
            <p className="mt-1 text-sm text-slate-500">
              {canEdit
                ? "Group by season, then spin up a tournament for any sport."
                : "You have view-only access to this board."}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {canEdit && <CreateSeasonForm />}
            {canEdit && (
              <Link href="/tournaments/new" className="btn btn-primary">
                + New Tournament
              </Link>
            )}
          </div>
        </div>

        {tournaments.length === 0 && seasons.length === 0 ? (
          canEdit ? (
            <div className="mt-12 flex flex-col items-center gap-6 text-center">
              <div className="grid h-16 w-16 place-items-center rounded-2xl bg-purple-100">
                <Trophy className="h-8 w-8 text-purple-500" strokeWidth={1.5} />
              </div>
              <div>
                <h2 className="text-xl font-semibold text-slate-800">
                  No tournaments yet
                </h2>
                <p className="mt-1 text-sm text-slate-500">
                  Create your first tournament in under a minute. Pick a sport,
                  add players, and you&apos;re live.
                </p>
              </div>
              <div className="flex flex-wrap justify-center gap-3">
                <Link href="/tournaments/new" className="btn btn-primary">
                  + New Tournament
                </Link>
                <Link
                  href="/settings"
                  className="btn btn-ghost border border-purple-200 text-purple-700"
                >
                  Customize sport presets
                </Link>
              </div>
              <p className="text-xs text-slate-400">
                Pro tip: you can also create a season first to group multiple
                tournaments together.
              </p>
            </div>
          ) : (
            <p className="text-sm text-slate-500">No tournaments yet.</p>
          )
        ) : (
          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {sections.map((s) => {
              const list = bySeason.get(s.id) ?? [];
              return (
                <section key={s.id} className="rounded-xl border border-slate-200 bg-white shadow-sm">
                  <div className="flex items-center justify-between gap-2 border-b border-slate-100 px-4 py-3">
                    <div className="flex items-center gap-2">
                      {s.id === NO_SEASON
                        ? <Layers className="h-4 w-4 shrink-0 text-slate-400" strokeWidth={1.75} />
                        : <Calendar className="h-4 w-4 shrink-0 text-purple-500" strokeWidth={1.75} />
                      }
                      <h2 className="text-sm font-semibold text-slate-700">{s.name}</h2>
                    </div>
                    {s.slug && (
                      <span className="font-mono text-[11px] text-slate-400">{s.slug}</span>
                    )}
                  </div>
                  <div className="p-3">
                    {list.length === 0 ? (
                      <p className="px-1 py-2 text-sm text-slate-400">No tournaments yet.</p>
                    ) : (
                      <ul className="space-y-1.5">{list.map(renderCard)}</ul>
                    )}
                  </div>
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
