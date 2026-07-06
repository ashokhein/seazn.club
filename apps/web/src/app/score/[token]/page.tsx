export const dynamic = "force-dynamic";
// /score/{token} — the account-less courtside pad (doc 13 §7, PROMPT-21).
// No session: the token IS the credential. The server resolves it once to
// render the shell; every scoring call from the client re-presents it as
// `Authorization: Bearer dl_…`. The token lives in this tab only — never
// localStorage.
import { resolveDeviceLinkToken } from "@/server/usecases/device-links";
import { getFixtureState, listEvents } from "@/server/usecases/fixtures";
import { getEntrant } from "@/server/usecases/entrants";
import { withTenant } from "@/lib/db";
import { resolveModule } from "@/server/engine-db";
import { HttpError } from "@/lib/errors";
import type { AuthCtx } from "@/server/api-v1/auth";
import {
  DeviceScorePad,
  type PadSideInfo,
} from "@/components/v2/device-score-pad";

export default async function ScorePadPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;

  let link;
  try {
    link = await resolveDeviceLinkToken(token);
  } catch (err) {
    // Expired / revoked / unknown → the doc 13 §7 dead-end screen.
    const message =
      err instanceof HttpError && err.code !== "LINK_INVALID"
        ? err.message
        : "This scoring link is not valid.";
    return <DeadLink message={message} />;
  }

  // Server-trusted read context: this page IS the device-link surface, so it
  // loads exactly what the pad shows — fixture state, events, sides, sport.
  // The HTTP restrictions (fixtures.ts rejectDeviceLink) target the API
  // surface; this read runs in trusted server code, RLS-bounded to the org.
  const read: AuthCtx = {
    orgId: link.org_id,
    via: "session",
    userId: link.issued_by,
    role: "admin",
    keyId: null,
  };

  const fixture = await withTenant(link.org_id, async (tx) => {
    const [row] = await tx<
      {
        id: string;
        round_no: number;
        venue: string | null;
        court_label: string | null;
        scheduled_at: string | null;
        home_entrant_id: string | null;
        away_entrant_id: string | null;
        sport_key: string;
        module_version: string;
        config: unknown;
        competition_name: string;
        division_name: string;
      }[]
    >`
      select f.id, f.round_no, f.venue, f.court_label, f.scheduled_at,
             f.home_entrant_id, f.away_entrant_id,
             d.sport_key, d.module_version, d.config,
             c.name as competition_name, d.name as division_name
      from fixtures f
      join divisions d on d.id = f.division_id
      join competitions c on c.id = d.competition_id
      where f.id = ${link.fixture_id}`;
    return row ?? null;
  });
  if (!fixture) return <DeadLink message="This fixture no longer exists." />;

  const sportModule = resolveModule(fixture.sport_key, fixture.module_version);
  const [state, events] = await Promise.all([
    getFixtureState(read, fixture.id),
    listEvents(read, fixture.id, 0),
  ]);

  async function side(entrantId: string | null): Promise<PadSideInfo | null> {
    if (!entrantId) return null;
    const entrant = await getEntrant(read, entrantId);
    return {
      id: entrant.id,
      name: entrant.display_name,
      members: entrant.members as PadSideInfo["members"],
      lineup: [],
    };
  }
  const [home, away] = await Promise.all([
    side(fixture.home_entrant_id),
    side(fixture.away_entrant_id),
  ]);

  return (
    <main className="mx-auto max-w-2xl px-4 py-6">
      <DeviceScorePad
        token={token}
        deviceLinkId={link.id}
        fixture={{
          id: fixture.id,
          round_no: fixture.round_no,
          venue: fixture.venue,
          court_label: fixture.court_label,
          competition_name: fixture.competition_name,
          division_name: fixture.division_name,
        }}
        sport={{
          key: fixture.sport_key,
          config: fixture.config as Record<string, unknown>,
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
          device_link_id: e.device_link_id,
        }))}
      />
    </main>
  );
}

function DeadLink({ message }: { message: string }) {
  return (
    <main className="mx-auto flex min-h-[60vh] max-w-md flex-col items-center justify-center px-4 text-center">
      <p className="text-4xl">⏱️</p>
      <h1 className="mt-3 text-lg font-semibold text-slate-800">{message}</h1>
      <p className="mt-2 text-sm text-slate-500">
        Ask the organiser to hand you a fresh link.
      </p>
    </main>
  );
}
