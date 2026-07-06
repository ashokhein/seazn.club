// Division home (doc 09 §2): Schedule / Standings / Entrants tabs. Standings
// columns are driven by the pinned SportModule's MetricSpec[] — zero
// per-sport table components. Knockout stages render brackets; stepladder a
// ladder. Roster names are consent-filtered in the view (initials otherwise).
import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { resolveModule } from "@/server/engine-db";
import type { StandingsRow } from "@seazn/engine/competition";
import { getPublicDivision } from "@/server/public-site/data";
import { Tabs } from "@/components/public-site/tabs";
import { Schedule } from "@/components/public-site/schedule";
import { StandingsTable } from "@/components/public-site/standings-table";
import { Bracket } from "@/components/public-site/bracket";
import type { MetricSpecLike } from "@/lib/public-site";

export const revalidate = 30;

type Props = {
  params: Promise<{ orgSlug: string; competitionSlug: string; divisionSlug: string }>;
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { orgSlug, competitionSlug, divisionSlug } = await params;
  const data = await getPublicDivision(orgSlug, competitionSlug, divisionSlug);
  if (!data) return {};
  return {
    title: `${data.division.name} — ${data.competition.name}`,
    description: `Schedule, standings and entrants for ${data.division.name} at ${data.competition.name}`,
    ...(data.competition.visibility === "unlisted"
      ? { robots: { index: false, follow: false } }
      : {}),
  };
}

const BRACKET_KINDS = new Set(["knockout", "double_elim", "stepladder"]);

export default async function DivisionHomePage({ params }: Props) {
  const { orgSlug, competitionSlug, divisionSlug } = await params;
  const data = await getPublicDivision(orgSlug, competitionSlug, divisionSlug);
  if (!data) notFound();
  const { org, competition, division, stages, pools, fixtures, standings, entrants } = data;

  // MetricSpec[] + cascade from the division's PINNED module version.
  let metricSpecs: MetricSpecLike[] = [];
  let cascade: readonly string[] = [];
  try {
    const module_ = resolveModule(division.sport_key, division.module_version);
    metricSpecs = module_.metrics;
    cascade = division.tiebreakers ?? module_.defaultTiebreakers;
  } catch {
    // Unknown module version (e.g. retired build) — structural columns only.
  }

  const entrantNames = Object.fromEntries(entrants.map((e) => [e.id, e.display_name]));
  const basePath = `/${org.slug}/${competition.slug}/${division.slug}`;
  const poolName = new Map(pools.map((p) => [p.id, p.name]));
  const stageById = new Map(stages.map((s) => [s.id, s]));

  // Live stage first: the knockout that's underway reads before the finished
  // league table it qualified from.
  const stagesByRelevance = [...stages].sort(
    (a, b) =>
      (a.status === "complete" ? 1 : 0) - (b.status === "complete" ? 1 : 0) || a.seq - b.seq,
  );

  const standingsPanel = (
    <div className="space-y-8">
      {stagesByRelevance.map((stage) => {
        if (BRACKET_KINDS.has(stage.kind)) {
          const stageFixtures = fixtures.filter((f) => f.stage_id === stage.id);
          if (stageFixtures.length === 0) return null;
          return (
            <section key={stage.id}>
              <h3 className="mb-3 font-medium">{stage.name}</h3>
              <Bracket
                kind={stage.kind as "knockout" | "double_elim" | "stepladder"}
                fixtures={stageFixtures}
                entrantNames={entrantNames}
                fixtureHref={(id) => `${basePath}/fixtures/${id}`}
              />
            </section>
          );
        }
        const snapshots = standings
          .filter((s) => s.stage_id === stage.id)
          .sort((a, b) => (a.pool_id ?? "").localeCompare(b.pool_id ?? ""));
        if (snapshots.length === 0) return null;
        return (
          <section key={stage.id}>
            {snapshots.map((snap) => (
              <div key={snap.pool_id ?? "overall"} className="mb-6">
                <StandingsTable
                  rows={snap.rows as StandingsRow[]}
                  metricSpecs={metricSpecs}
                  cascade={cascade}
                  entrantNames={entrantNames}
                  caption={
                    snap.pool_id
                      ? `${stage.name} — ${poolName.get(snap.pool_id) ?? "Pool"}`
                      : stage.name
                  }
                />
              </div>
            ))}
          </section>
        );
      })}
      {standings.length === 0 && !stages.some((s) => BRACKET_KINDS.has(s.kind)) ? (
        <p className="text-sm text-zinc-500">Standings appear after the first results.</p>
      ) : null}
    </div>
  );

  const entrantsPanel = (
    <ul className="grid gap-3 sm:grid-cols-2">
      {entrants.map((e) => (
        <li key={e.id} className="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm">
          <p className="font-medium">
            {e.display_name}
            {e.seed ? <span className="ml-2 text-xs text-zinc-400">Seed {e.seed}</span> : null}
          </p>
          {e.members.length > 0 ? (
            <ul className="mt-2 space-y-1 text-sm text-zinc-600">
              {e.members.map((m, i) => (
                <li key={i} className="flex items-center gap-2">
                  {m.squad_number != null ? (
                    <span className="w-6 text-right text-xs tabular-nums text-zinc-400">
                      {m.squad_number}
                    </span>
                  ) : null}
                  {m.person_id ? (
                    <Link
                      href={`/${org.slug}/${competition.slug}/players/${m.person_id}`}
                      className="underline underline-offset-2"
                    >
                      {m.name}
                    </Link>
                  ) : (
                    // No public-name consent: initials, no link (doc 06 §4.7).
                    <span>{m.name}</span>
                  )}
                  {m.position ? (
                    <span className="text-xs text-zinc-400">{m.position}</span>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
        </li>
      ))}
      {entrants.length === 0 ? (
        <p className="text-sm text-zinc-500">No entrants yet.</p>
      ) : null}
    </ul>
  );

  return (
    <div>
      <nav className="mb-4 text-xs text-zinc-500">
        <Link href={`/${org.slug}`} className="underline">
          {org.name}
        </Link>{" "}
        /{" "}
        <Link href={`/${org.slug}/${competition.slug}`} className="underline">
          {competition.name}
        </Link>
      </nav>
      <h1 className="mb-2 text-3xl font-bold tracking-tight">{division.name}</h1>
      <p className="mb-6 flex flex-wrap items-center gap-2 text-xs text-zinc-500">
        <span className="font-medium text-zinc-600">
          {division.sport_name ?? division.sport_key}
        </span>
        <span className="rounded-full bg-purple-50 px-2 py-0.5 uppercase text-purple-700">
          {division.variant_key}
        </span>
        {stages.map((s) => (
          <span
            key={s.id}
            className={`rounded-full px-2 py-0.5 ${
              s.status === "complete"
                ? "bg-emerald-50 text-emerald-700"
                : "bg-zinc-100 text-zinc-600"
            }`}
          >
            {stageById.get(s.id)?.name}
            {s.status === "complete" ? " ✓" : ""}
          </span>
        ))}
      </p>

      <Tabs labels={["Schedule", "Standings", "Entrants"]}>
        {[
          <Schedule
            key="schedule"
            fixtures={fixtures}
            entrantNames={entrantNames}
            divisionPath={basePath}
          />,
          standingsPanel,
          entrantsPanel,
        ]}
      </Tabs>
    </div>
  );
}
