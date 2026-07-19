export const dynamic = "force-dynamic";
// Fixture console (PROMPT-15 task 1): schedule, lineups, sport-shaped scoring
// pad, void/undo, finalize. Server shell — all interaction in FixtureConsole.
import Link from "@/components/ui/console-link";
import { notFound } from "next/navigation";
import { requireFixturePage } from "@/server/page-auth";
import {
  eventRecorderNames,
  getFixture,
  getFixtureState,
  getLineup,
  listEvents,
} from "@/server/usecases/fixtures";
import { getDivision } from "@/server/usecases/divisions";
import { getScheduleSettings } from "@/server/usecases/schedule";
import { getCompetition } from "@/server/usecases/competitions";
import { getEntrant } from "@/server/usecases/entrants";
import { resolveModule } from "@/server/engine-db";
import {
  FixtureConsole,
  type SideInfo,
  type LineupSlotIn,
} from "@/components/v2/fixture-console";
import { DeviceLinkPanel } from "@/components/v2/device-link-panel";
import { listFixtureAvailability } from "@/server/usecases/me";
import { CheckinQr } from "@/components/v2/checkin-qr";
import { FixtureOfficialsStrip } from "@/components/v2/fixture-officials-strip";
import { AuditStrip } from "@/components/v2/audit-strip";
import { hasFeature } from "@/lib/entitlements";
import { suspensionsForFixture } from "@/server/usecases/discipline";
import { sql } from "@/lib/db";

export default async function FixturePage({
  params,
}: {
  params: Promise<{ orgSlug: string; compSlug: string; divSlug: string; no: string }>;
}) {
  const { orgSlug, compSlug, divSlug, no } = await params;
  const fixtureNo = Number(no);
  if (!Number.isInteger(fixtureNo) || fixtureNo < 1) notFound();
  const page = await requireFixturePage(orgSlug, compSlug, divSlug, fixtureNo);
  const { auth, canScore, canEdit } = page;
  const id = page.fixtureId;
  // Scorer-role members and viewers scoring via assignment share the umpire
  // chrome (My-matches breadcrumb); editors keep the organiser surface.
  const isScorer = canScore && !canEdit;
  const fixture = await getFixture(auth, id);
  const [division, state, events, recorderNames, availability, schedule] = await Promise.all([
    getDivision(auth, fixture.division_id),
    getFixtureState(auth, id),
    listEvents(auth, id, 0),
    eventRecorderNames(auth, id),
    listFixtureAvailability(auth, id),
    getScheduleSettings(auth, fixture.division_id),
  ]);
  const competition = await getCompetition(auth, division.competition_id);
  const sportModule = resolveModule(division.sport_key, division.module_version);

  // PROMPT-63 §4: ledger-integrity strip (organiser surface, once events
  // exist). The verifier is the V226 DB function; download is Pro-gated.
  let audit: { verified: boolean; tamperedSeq: number | null; entitled: boolean } | null = null;
  if (canEdit && events.length > 0) {
    const [[{ bad }], entitled] = await Promise.all([
      sql<{ bad: string | null }[]>`select verify_score_events_chain(${id})::text as bad`,
      hasFeature(auth.orgId, "scoring.audit_export", division.competition_id),
    ]);
    let tamperedSeq: number | null = null;
    if (bad !== null) {
      const [row] = await sql<{ seq: number }[]>`select seq from score_events where id = ${bad}`;
      tamperedSeq = row?.seq ?? null;
    }
    audit = { verified: bad === null, tamperedSeq, entitled };
  }

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
  // SPEC-1: active suspensions among this fixture's entrants, joined into the
  // pad bootstrap (no client fetch). Returns [] when the org isn't entitled.
  const activeSuspensions = await suspensionsForFixture(auth, fixture.division_id, [
    fixture.home_entrant_id,
    fixture.away_entrant_id,
  ]);

  return (
    <>
      <main className="mx-auto max-w-5xl px-4 py-8">
        {isScorer && (
          <p className="mb-4 text-xs text-slate-400">
            <Link href="/my-matches" className="hover:text-purple-600">
              ← My matches
            </Link>
            <span className="ml-2">
              {competition.name} · {division.name}
            </span>
          </p>
        )}

        {/* Player self-check-in QR (PROMPT-53) — top of the match panel, and
            only BEFORE the match starts (owner feedback 2026-07-13): check-in
            is an arrival tool, once play begins it's just noise. */}
        {!isScorer &&
          canScore &&
          !(competition.frozen ?? false) &&
          fixture.status === "scheduled" && (
            <div className="mb-3 flex justify-end">
              <CheckinQr fixtureId={fixture.id} />
            </div>
          )}

        {/* Assigned-officials strip (design v11 §D2): organiser surface only —
            a red "Declined" badge is the cue to re-pick. */}
        {canEdit && Array.isArray(fixture.officials) && (
          <FixtureOfficialsStrip officials={fixture.officials as never} />
        )}

        <FixtureConsole
          fixture={{
            id: fixture.id,
            status: fixture.status,
            scheduled_at: fixture.scheduled_at,
            scheduled_tz: schedule.tz,
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
            recorded_by: e.recorded_by,
            voids_event_id: e.voids_event_id,
            device_link_id: e.device_link_id,
          }))}
          canEdit={canScore && !(competition.frozen ?? false)}
          recorderNames={recorderNames}
          availability={availability}
          activeSuspensions={activeSuspensions}
          publicPath={
            // Share needs a page strangers can open (v3/10 #2) — private
            // competitions have none.
            competition.visibility !== "private"
              ? `/shared/${orgSlug}/${competition.slug}/${division.slug}/fixtures/${fixture.id}`
              : null
          }
        />

        {audit !== null && (
          <AuditStrip
            fixtureId={fixture.id}
            verified={audit.verified}
            tamperedSeq={audit.tamperedSeq}
            entitled={audit.entitled}
          />
        )}

        {/* Day-of device link (doc 13 §7): editors only — scorers never mint. */}
        {canEdit &&
          !(competition.frozen ?? false) &&
          fixture.status !== "finalized" &&
          fixture.status !== "cancelled" && (
            <div className="mt-6">
              <DeviceLinkPanel
                fixtureId={fixture.id}
                scorerLabel={sportModule.officialLabel.scorer}
              />
            </div>
          )}
      </main>
    </>
  );
}
