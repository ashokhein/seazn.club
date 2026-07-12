export const dynamic = "force-dynamic";
// Competition-wide multi-division schedule board (doc 12 §2 / doc 06 §4.3):
// every division's fixtures on one grid, division-coloured cards. Pro only
// (doc 12 §5 — scheduling.multi_division).
import Link from "next/link";
import { requireCompetitionPage } from "@/server/page-auth";
import { routes } from "@/lib/routes";
import { getCompetition } from "@/server/usecases/competitions";
import { listDivisions } from "@/server/usecases/divisions";
import { listStages } from "@/server/usecases/stages";
import { listDivisionFixtures } from "@/server/usecases/fixtures";
import { listEntrants } from "@/server/usecases/entrants";
import { getScheduleSettings } from "@/server/usecases/schedule";
import { hasFeature } from "@/lib/entitlements";
import { withTenant } from "@/lib/db";
import { ScheduleBoard } from "@/components/v2/schedule-board";
import { feedLabels, type FeedRow } from "@/lib/schedule-board";
import { UpgradeGate } from "@/components/upgrade-gate";

export default async function CompetitionSchedulePage({
  params,
}: {
  params: Promise<{ orgSlug: string; compSlug: string }>;
}) {
  const { orgSlug, compSlug } = await params;
  const page = await requireCompetitionPage(orgSlug, compSlug, { tail: "/schedule" });
  const { auth, canEdit } = page;
  const id = page.competition.id;
  const competition = await getCompetition(auth, id);

  const multiAllowed = await hasFeature(auth.orgId, "scheduling.multi_division");
  if (!multiAllowed) {
    return (
      <>
        <main className="mx-auto max-w-3xl px-4 py-8">
          <h1 className="page-title mb-4">
            Competition schedule — {competition.name}
          </h1>
          <UpgradeGate feature="scheduling.multi_division" />
        </main>
      </>
    );
  }

  const divisions = await listDivisions(auth, id);
  // No divisions → nothing to schedule. Bail before the settings lookup, which
  // would otherwise be fed the competition id and 404 ("division not found").
  if (divisions.length === 0) {
    return (
      <>
        <main className="mx-auto max-w-3xl px-4 py-8">
          <h1 className="page-title mt-1 mb-4">
            Competition schedule — {competition.name}
          </h1>
          <div className="card p-6 text-sm text-slate-500">
            No divisions yet — the schedule board fills in once this competition
            has divisions with fixtures.{" "}
            {canEdit && !(competition.frozen ?? false) && (
              <Link
                href={routes.divisionNew(orgSlug, compSlug)}
                className="font-medium text-purple-600 hover:text-purple-700"
              >
                Add a division
              </Link>
            )}
          </div>
        </main>
      </>
    );
  }

  const [boardEditable, constraints] = await Promise.all([
    hasFeature(auth.orgId, "scheduling.board"),
    hasFeature(auth.orgId, "scheduling.constraints"),
  ]);
  const perDivision = await Promise.all(
    divisions.map(async (d) => ({
      division: d,
      stages: await listStages(auth, d.id),
      fixtures: await listDivisionFixtures(auth, d.id),
      entrants: await listEntrants(auth, d.id),
    })),
  );
  const feedRows = await withTenant(auth.orgId, (tx) =>
    tx<FeedRow[]>`
      select f.id, f.round_no, f.seq_in_round, f.winner_to_fixture, f.winner_to_slot,
             f.loser_to_fixture, f.loser_to_slot
      from fixtures f join divisions d on d.id = f.division_id
      where d.competition_id = ${id}`,
  );

  // Grid config: first division's settings, courts unioned across divisions.
  const settings = await getScheduleSettings(auth, divisions[0]?.id ?? id);
  const allCourts = [
    ...new Set(
      (
        await Promise.all(divisions.map((d) => getScheduleSettings(auth, d.id)))
      ).flatMap((s) => s.config.courts),
    ),
  ];

  const frozen = competition.frozen ?? false;

  return (
    <>
      <main className="mx-auto max-w-7xl px-4 py-8">
        <div className="mb-4">
          <h1 className="page-title mt-1">
            Competition schedule — {competition.name}
          </h1>
        </div>

        <ScheduleBoard
          divisions={perDivision.map(({ division }) => ({
            id: division.id,
            name: division.name,
            slug: division.slug,
            status: division.status,
            seq: Number(division.seq),
            schedule_locked: division.schedule_locked,
          }))}
          stages={perDivision.flatMap(({ division, stages }) =>
            stages.map((s) => ({
              id: s.id,
              division_id: division.id,
              seq: s.seq,
              kind: s.kind,
              name: `${division.name} · ${s.name}`,
              status: s.status,
            })),
          )}
          fixtures={perDivision.flatMap(({ fixtures }) => fixtures)}
          entrantNames={Object.fromEntries(
            perDivision.flatMap(({ entrants }) => entrants.map((e) => [e.id, e.display_name])),
          )}
          feedLabels={feedLabels(feedRows)}
          settings={{
            division_id: divisions[0]?.id ?? id,
            config: { ...settings.config, courts: allCourts.length > 0 ? allCourts : settings.config.courts },
            tz: settings.tz,
          }}
          canEdit={canEdit && !frozen && boardEditable}
          constraintsAllowed={constraints}
        />
      </main>
    </>
  );
}
