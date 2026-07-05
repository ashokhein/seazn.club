export const dynamic = "force-dynamic";
// Competition overview: settings + division list (PROMPT-15 task 1).
import Link from "next/link";
import { Nav } from "@/components/nav";
import { requireResourcePageAuth } from "@/server/page-auth";
import { getCompetition } from "@/server/usecases/competitions";
import { listDivisions } from "@/server/usecases/divisions";
import { CompetitionSettings } from "@/components/v2/competition-settings";
import { sql } from "@/lib/db";

export default async function CompetitionPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const { auth, org, canEdit } = await requireResourcePageAuth("competition", id);
  const [competition, divisions, [orgRow]] = await Promise.all([
    getCompetition(auth, id),
    listDivisions(auth, id),
    sql<{ slug: string }[]>`select slug from organizations where id = ${auth.orgId}`,
  ]);
  const publicPath =
    competition.visibility !== "private" && orgRow
      ? `/${orgRow.slug}/${competition.slug}`
      : null;

  return (
    <>
      <Nav />
      <main className="mx-auto max-w-6xl px-4 py-8">
        <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="text-xs text-slate-400">
              <Link href="/dashboard" className="hover:text-purple-600">
                Competitions
              </Link>{" "}
              / {org.name}
            </p>
            <h1 className="mt-1 truncate text-xl font-semibold tracking-tight text-slate-900">
              {competition.name}
            </h1>
          </div>
          {publicPath && (
            <Link href={publicPath} className="btn btn-ghost" target="_blank">
              View public page ↗
            </Link>
          )}
        </div>

        <div className="grid gap-6 lg:grid-cols-[1fr_340px]">
          <section>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-slate-700">Divisions</h2>
              {canEdit && !competition.frozen && (
                <Link
                  href={`/competitions/${competition.id}/divisions/new`}
                  className="btn btn-primary"
                >
                  + Add division
                </Link>
              )}
            </div>
            {divisions.length === 0 ? (
              <div className="card p-6 text-sm text-slate-500">
                No divisions yet. A division picks the sport, its variant and
                format — entrants and fixtures live inside it.
              </div>
            ) : (
              <ul className="space-y-2">
                {divisions.map((d) => (
                  <li key={d.id}>
                    <Link
                      href={`/divisions/${d.id}`}
                      className="group flex items-center justify-between rounded-xl border border-slate-200 bg-white px-4 py-3 shadow-sm transition hover:border-purple-300"
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium text-slate-800 group-hover:text-purple-700">
                          {d.name}
                        </span>
                        <span className="mt-0.5 block text-xs text-slate-400">
                          {d.sport_key} · {d.variant_key} · module v{d.module_version}
                        </span>
                      </span>
                      <span className={`badge ${statusStyle(d.status)}`}>{d.status}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <aside>
            <CompetitionSettings
              competition={{
                id: competition.id,
                name: competition.name,
                slug: competition.slug,
                description: competition.description,
                starts_on: competition.starts_on,
                ends_on: competition.ends_on,
                visibility: competition.visibility,
                status: competition.status,
                frozen: competition.frozen ?? false,
              }}
              canEdit={canEdit}
            />
          </aside>
        </div>
      </main>
    </>
  );
}

function statusStyle(status: string): string {
  if (status === "active") return "bg-amber-100 text-amber-700";
  if (status === "completed") return "bg-emerald-100 text-emerald-700";
  return "bg-slate-100 text-slate-600";
}
