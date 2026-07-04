import "server-only";
import type postgres from "postgres";
import {
  foldMatch,
  type EventEnvelope,
  type MatchOutcome,
  type ScoreSummary,
} from "@seazn/engine/core";
import { resolveModule } from "./registry";
import { loadLineupPair } from "./lineups";

type Tx = postgres.TransactionSql;

export interface FoldedFixture {
  fixtureId: string;
  lastSeq: number;
  state: unknown;
  summary: ScoreSummary;
  outcome: MatchOutcome | null;
}

interface FixtureRow {
  division_id: string;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
}
interface DivisionRow {
  config: unknown;
  sport_key: string;
  module_version: string;
}
interface EventRow {
  id: string;
  seq: number;
  type: string;
  payload: unknown;
  recorded_at: Date;
  recorded_by: string | null;
  voids_event_id: string | null;
}

// Load a fixture's full ledger and fold it through the pinned module — the pure
// rebuild of match_state from score_events (spec 02 §6: MatchState is a
// disposable cache = fold(events)). Returns null for a fixture with no events
// (nothing to derive). Shared by rebuildState + verifyStateConsistency.
export async function foldFixture(tx: Tx, fixtureId: string): Promise<FoldedFixture | null> {
  const [fixture] = await tx<FixtureRow[]>`
    select division_id, home_entrant_id, away_entrant_id from fixtures where id = ${fixtureId}
  `;
  if (!fixture) return null;

  const events = await tx<EventRow[]>`
    select id, seq, type, payload, recorded_at, recorded_by, voids_event_id
    from score_events where fixture_id = ${fixtureId} order by seq
  `;
  if (events.length === 0) return null;

  const [division] = await tx<DivisionRow[]>`
    select config, sport_key, module_version from divisions where id = ${fixture.division_id}
  `;
  if (!division) return null;

  if (!fixture.home_entrant_id || !fixture.away_entrant_id) {
    throw new Error(`fixture ${fixtureId} has events but an unassigned entrant`);
  }

  const sportModule = resolveModule(division.sport_key, division.module_version);
  const lineups = await loadLineupPair(
    tx,
    fixtureId,
    fixture.home_entrant_id,
    fixture.away_entrant_id,
  );

  const envelopes: EventEnvelope[] = events.map((r) => ({
    id: r.id,
    fixtureId,
    seq: r.seq,
    type: r.type,
    payload: r.payload,
    recordedAt: r.recorded_at.toISOString(),
    recordedBy: r.recorded_by,
    ...(r.voids_event_id ? { voids: r.voids_event_id } : {}),
  }));

  const state = foldMatch(sportModule, division.config, lineups, envelopes);
  return {
    fixtureId,
    lastSeq: events[events.length - 1].seq,
    state,
    summary: sportModule.summary(state),
    outcome: sportModule.outcome(state),
  };
}
