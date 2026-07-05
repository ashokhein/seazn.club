export const dynamic = "force-dynamic";
// Fixture console (PROMPT-15 task 1): schedule, lineups, sport-shaped scoring
// pad, void/undo, finalize. Server shell — all interaction in FixtureConsole.
import Link from "next/link";
import { Nav } from "@/components/nav";
import { requireResourcePageAuth } from "@/server/page-auth";
import { getFixture, getFixtureState, getLineup, listEvents } from "@/server/usecases/fixtures";
import { getDivision } from "@/server/usecases/divisions";
import { getCompetition } from "@/server/usecases/competitions";
import { getEntrant } from "@/server/usecases/entrants";
import { resolveModule } from "@/server/engine-db";
import {
  FixtureConsole,
  type SideInfo,
  type LineupSlotIn,
} from "@/components/v2/fixture-console";

export default async function FixturePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const { auth, canScore } = await requireResourcePageAuth("fixture", id);
  const isScorer = auth.role === "scorer";
  const fixture = await getFixture(auth, id);
  const [division, state, events] = await Promise.all([
    getDivision(auth, fixture.division_id),
    getFixtureState(auth, id),
    listEvents(auth, id, 0),
  ]);
  const competition = await getCompetition(auth, division.competition_id);
  const sportModule = resolveModule(division.sport_key, division.module_version);

  async function side(entrantId: string | null): Promise<SideInfo | null> {
    if (!entrantId) return null;
    const [entrant, lineup] = await Promise.all([
      getEntrant(auth, entrantId),
      getLineup(auth, id, entrantId),
    ]);
    return {
      id: entrant.id,
      name: entrant.display_name,
      members: entrant.members as SideInfo["members"],
      lineup: lineup.slots as LineupSlotIn[],
    };
  }
  const [home, away] = await Promise.all([
    side(fixture.home_entrant_id),
    side(fixture.away_entrant_id),
  ]);

  return (
    <>
      {/* Scorers get the stripped courtside view (doc 13 §3): no org nav. */}
      {!isScorer && <Nav />}
      <main className="mx-auto max-w-5xl px-4 py-8">
        {isScorer ? (
          <p className="mb-4 text-xs text-slate-400">
            <Link href="/my-matches" className="hover:text-purple-600">
              ← My matches
            </Link>
            <span className="ml-2">
              {competition.name} · {division.name}
            </span>
          </p>
        ) : (
          <p className="mb-4 text-xs text-slate-400">
            <Link href="/dashboard" className="hover:text-purple-600">
              Competitions
            </Link>{" "}
            /{" "}
            <Link href={`/competitions/${competition.id}`} className="hover:text-purple-600">
              {competition.name}
            </Link>{" "}
            /{" "}
            <Link
              href={`/divisions/${division.id}?tab=fixtures`}
              className="hover:text-purple-600"
            >
              {division.name}
            </Link>
          </p>
        )}

        <FixtureConsole
          fixture={{
            id: fixture.id,
            status: fixture.status,
            scheduled_at: fixture.scheduled_at,
            venue: fixture.venue,
            court_label: fixture.court_label,
            round_no: fixture.round_no,
          }}
          sport={{
            key: division.sport_key,
            config: division.config as Record<string, unknown>,
            scorerLabel: sportModule.officialLabel.scorer,
            positionGroups: sportModule.positions.groups,
            roles: sportModule.positions.roles ?? [],
            lineupSize: sportModule.positions.lineup.size,
            fidelityTiers: sportModule.fidelityTiers,
          }}
          home={home}
          away={away}
          initialState={{
            status: state.status,
            last_seq: state.last_seq,
            summary: state.summary,
            state: state.state,
            outcome: state.outcome,
          }}
          initialEvents={events.map((e) => ({
            id: e.id,
            seq: e.seq,
            type: e.type,
            payload: e.payload,
            recorded_at: e.recorded_at,
            voids_event_id: e.voids_event_id,
          }))}
          canEdit={canScore && !(competition.frozen ?? false)}
        />
      </main>
    </>
  );
}
