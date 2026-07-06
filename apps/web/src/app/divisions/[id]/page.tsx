export const dynamic = "force-dynamic";
// Division console (PROMPT-15 task 1): entrants & rosters, fixture console
// (per stage: generate/complete/schedule), standings with the cascade trace.
import Link from "next/link";
import { Nav } from "@/components/nav";
import { requireResourcePageAuth } from "@/server/page-auth";
import { getDivision } from "@/server/usecases/divisions";
import { getCompetition } from "@/server/usecases/competitions";
import { listStages, getStandings } from "@/server/usecases/stages";
import { listDivisionFixtures } from "@/server/usecases/fixtures";
import { listEntrants } from "@/server/usecases/entrants";
import { resolveModule } from "@/server/engine-db";
import { withTenant } from "@/lib/db";
import { EntrantsPanel } from "@/components/v2/entrants-panel";
import { StagesPanel } from "@/components/v2/stages-panel";
import { LaunchActions } from "@/components/v2/launch-actions";
import { InviteScorer } from "@/components/v2/invite-scorer";
import { StandingsTable } from "@/components/public-site/standings-table";
import { tieBreakLabel, type StandingsRow } from "@seazn/engine/competition";
import type { MetricSpecLike } from "@/lib/public-site";

const TABS = ["entrants", "fixtures", "standings"] as const;
type Tab = (typeof TABS)[number];
const TABLE_KINDS = new Set(["league", "group", "swiss"]);

export default async function DivisionPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const [{ id }, { tab: rawTab }] = await Promise.all([params, searchParams]);
  const tab: Tab = (TABS as readonly string[]).includes(rawTab ?? "")
    ? (rawTab as Tab)
    : "entrants";

  const { auth, canEdit } = await requireResourcePageAuth("division", id);
  const division = await getDivision(auth, id);
  const [competition, stages, fixtures, entrants] = await Promise.all([
    getCompetition(auth, division.competition_id),
    listStages(auth, id),
    listDivisionFixtures(auth, id),
    listEntrants(auth, id),
  ]);
  const sportModule = resolveModule(division.sport_key, division.module_version);
  const entrantNames = Object.fromEntries(entrants.map((e) => [e.id, e.display_name]));
  const cascade = division.tiebreakers ?? sportModule.defaultTiebreakers;

  // Standings per table stage (+ per pool), with pool labels.
  const tableStages = stages.filter((s) => TABLE_KINDS.has(s.kind));
  const standings =
    tab === "standings"
      ? await Promise.all(
          tableStages.map(async (stage) => {
            const pools = await withTenant(auth.orgId, (tx) =>
              tx<{ id: string; key: string; name: string }[]>`
                select id, key, name from pools where stage_id = ${stage.id} order by key`,
            );
            const tables =
              pools.length > 0
                ? await Promise.all(
                    pools.map(async (p) => ({
                      caption: `${stage.name} — ${p.name}`,
                      snap: await getStandings(auth, stage.id, p.id),
                    })),
                  )
                : [{ caption: stage.name, snap: await getStandings(auth, stage.id) }];
            return { stage, tables };
          }),
        )
      : [];

  const frozen = competition.frozen ?? false;
  const editable = canEdit && !frozen;

  return (
    <>
      <Nav />
      <main className="mx-auto max-w-6xl px-4 py-8">
        <div className="mb-6">
          <p className="text-xs text-slate-400">
            <Link href="/dashboard" className="hover:text-purple-600">
              Competitions
            </Link>{" "}
            /{" "}
            <Link
              href={`/competitions/${competition.id}`}
              className="hover:text-purple-600"
            >
              {competition.name}
            </Link>
          </p>
          <div className="mt-1 flex flex-wrap items-center gap-3">
            <h1 className="text-xl font-semibold tracking-tight text-slate-900">
              {division.name}
            </h1>
            <span className="chip">
              {division.sport_key} · {division.variant_key}
            </span>
            <span className={`badge ${divisionStatusStyle(division.status)}`}>
              {division.status}
            </span>
            {frozen && <span className="badge bg-sky-100 text-sky-700">read-only</span>}
            <div className="flex-1" />
            <Link href={`/divisions/${id}/slideshow`} target="_blank" className="btn btn-ghost">
              Slideshow ↗
            </Link>
            <Link href={`/divisions/${id}/registrations`} className="btn btn-ghost">
              Registrations
            </Link>
            {editable && (
              <InviteScorer
                orgId={auth.orgId}
                divisionId={id}
                officialLabel={sportModule.officialLabel.scorer}
              />
            )}
            <LaunchActions divisionId={id} status={division.status} canEdit={editable} />
          </div>
        </div>

        <nav className="mb-6 flex gap-1 border-b border-slate-200">
          {TABS.map((t) => (
            <Link
              key={t}
              href={`/divisions/${id}?tab=${t}`}
              className={`border-b-2 px-4 py-2 text-sm font-medium capitalize transition ${
                tab === t
                  ? "border-purple-600 text-purple-700"
                  : "border-transparent text-slate-500 hover:text-slate-800"
              }`}
            >
              {t}
            </Link>
          ))}
        </nav>

        {tab === "entrants" && (
          <EntrantsPanel
            divisionId={id}
            entrants={entrants}
            canEdit={editable}
            positionGroups={sportModule.positions.groups}
            roles={sportModule.positions.roles ?? []}
            eligibility={division.eligibility as Record<string, unknown>[]}
          />
        )}

        {tab === "fixtures" && (
          <StagesPanel
            divisionId={id}
            stages={stages}
            fixtures={fixtures}
            entrantNames={entrantNames}
            canEdit={editable}
          />
        )}

        {tab === "standings" && (
          <div className="space-y-8">
            {standings.length === 0 && (
              <p className="text-sm text-slate-500">
                No table stages in this division — standings apply to league, group
                and swiss stages.
              </p>
            )}
            {standings.map(({ stage, tables }) => (
              <section key={stage.id} className="card p-5">
                {tables.map(({ caption, snap }) => (
                  <div key={caption} className="mb-6 last:mb-0">
                    <StandingsTable
                      rows={snap.rows as StandingsRow[]}
                      metricSpecs={sportModule.metrics as MetricSpecLike[]}
                      cascade={cascade}
                      entrantNames={entrantNames}
                      caption={caption}
                    />
                  </div>
                ))}
                {/* Cascade trace (doc 05 §4): the exact tie-break order in force. */}
                <p className="mt-3 border-t border-slate-100 pt-3 text-xs text-slate-400">
                  Tie-break cascade:{" "}
                  {cascade.map((key, i) => (
                    <span key={key}>
                      {i > 0 && " → "}
                      <span className="text-slate-500">{tieBreakLabel(key)}</span>
                    </span>
                  ))}
                  {division.tiebreakers ? " (division override)" : " (sport default)"}
                </p>
              </section>
            ))}
          </div>
        )}
      </main>
    </>
  );
}

function divisionStatusStyle(status: string): string {
  if (status === "active") return "bg-amber-100 text-amber-700";
  if (status === "scheduled") return "bg-sky-100 text-sky-700";
  if (status === "completed") return "bg-emerald-100 text-emerald-700";
  return "bg-slate-100 text-slate-600";
}
