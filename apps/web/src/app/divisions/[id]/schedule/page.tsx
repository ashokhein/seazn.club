export const dynamic = "force-dynamic";
// Drag-and-drop schedule board for one division (doc 12 §2, PROMPT-17).
// Community renders it view-only (doc 12 §5 — scheduling.board).
import Link from "next/link";
import { Nav } from "@/components/nav";
import { requireResourcePageAuth } from "@/server/page-auth";
import { getDivision } from "@/server/usecases/divisions";
import { getCompetition } from "@/server/usecases/competitions";
import { listStages } from "@/server/usecases/stages";
import { listDivisionFixtures } from "@/server/usecases/fixtures";
import { listEntrants } from "@/server/usecases/entrants";
import { getScheduleSettings } from "@/server/usecases/schedule";
import { hasFeature } from "@/lib/entitlements";
import { withTenant } from "@/lib/db";
import { ScheduleBoard } from "@/components/v2/schedule-board";
import { feedLabels, type FeedRow } from "@/lib/schedule-board";
import { UpgradeGate } from "@/components/upgrade-gate";

export default async function DivisionSchedulePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const { auth, canEdit } = await requireResourcePageAuth("division", id);
  const division = await getDivision(auth, id);
  const [competition, stages, fixtures, entrants, settings, boardEditable, constraints] =
    await Promise.all([
      getCompetition(auth, division.competition_id),
      listStages(auth, id),
      listDivisionFixtures(auth, id),
      listEntrants(auth, id),
      getScheduleSettings(auth, id),
      hasFeature(auth.orgId, "scheduling.board"),
      hasFeature(auth.orgId, "scheduling.constraints"),
    ]);

  // Feed wiring for TBD card labels ("Winner of R1 #2" — doc 12 §2).
  const feedRows = await withTenant(auth.orgId, (tx) =>
    tx<FeedRow[]>`
      select id, round_no, seq_in_round, winner_to_fixture, winner_to_slot,
             loser_to_fixture, loser_to_slot
      from fixtures where division_id = ${id}`,
  );

  const frozen = competition.frozen ?? false;
  const editable = canEdit && !frozen && boardEditable;

  return (
    <>
      <Nav />
      <main className="mx-auto max-w-7xl px-4 py-8">
        <div className="mb-4">
          <p className="text-xs text-slate-400">
            <Link href="/dashboard" className="hover:text-purple-600">Competitions</Link>
            {" / "}
            <Link href={`/competitions/${competition.id}`} className="hover:text-purple-600">
              {competition.name}
            </Link>
            {" / "}
            <Link href={`/divisions/${id}`} className="hover:text-purple-600">
              {division.name}
            </Link>
          </p>
          <div className="mt-1 flex flex-wrap items-center gap-3">
            <h1 className="text-xl font-semibold tracking-tight text-slate-900">
              Schedule — {division.name}
            </h1>
          </div>
        </div>

        {!boardEditable && canEdit && !frozen && (
          <div className="mb-4">
            <UpgradeGate feature="scheduling.board" compact />
          </div>
        )}

        <ScheduleBoard
          divisions={[{ id: division.id, name: division.name, status: division.status, color: "#7c3aed" }]}
          stages={stages.map((s) => ({ id: s.id, division_id: id, seq: s.seq, kind: s.kind, name: s.name, status: s.status }))}
          fixtures={fixtures}
          entrantNames={Object.fromEntries(entrants.map((e) => [e.id, e.display_name]))}
          feedLabels={feedLabels(feedRows)}
          settings={{ division_id: id, config: settings.config, tz: settings.tz }}
          canEdit={editable}
          constraintsAllowed={constraints}
        />
      </main>
    </>
  );
}
