import "server-only";
import type postgres from "postgres";
import {
  foldMatch,
  resolveVoids,
  type EventEnvelope,
  type MatchOutcome,
  type ScoreSummary,
} from "@seazn/engine/core";
import { resolveModule } from "./registry";
import { loadLineupPair } from "./lineups";
import { resolveFixtureCfg } from "./fixture-cfg";

type Tx = postgres.TransactionSql;

export interface FoldedFixture {
  fixtureId: string;
  lastSeq: number;
  state: unknown;
  summary: ScoreSummary;
  outcome: MatchOutcome | null;
  /** The void-resolved stream. `fixtures.status` is derived from WHICH events
   *  survive (`core.start`, `core.forfeit`, `core.abandon`), not from the fold,
   *  so any caller that re-derives the fixture row needs it — see
   *  `fixtureStatusFromFold` in `append-event.ts`. */
  active: readonly EventEnvelope[];
}

interface FixtureRow {
  division_id: string;
  stage_id: string;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  /** V347 — the resolved cfg this fixture was SCORED under; null before its
   *  first event. See `fixture-cfg.ts` for why it exists. */
  config_snapshot: unknown;
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
    select division_id, stage_id, home_entrant_id, away_entrant_id, config_snapshot
    from fixtures where id = ${fixtureId}
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

  // Exactly the cfg the write path used (V347): the snapshot frozen on the
  // first append, or — for a fixture with no snapshot yet — the same
  // stage-scoped decider overlay (PROMPT-61 §2). Read and write folds must stay
  // byte-consistent or verifyStateConsistency would flag phantom drift, which
  // is why BOTH go through `resolveFixtureCfg` rather than each building cfg
  // for themselves. The stage row is still loaded: it is the fallback input,
  // and every fixture written before V347 shipped takes that path.
  const [stage] = await tx<{ config: Record<string, unknown> | null }[]>`
    select config from stages where id = ${fixture.stage_id}
  `;
  const cfg = resolveFixtureCfg(fixture.config_snapshot, division.config, stage?.config);
  const state = foldMatch(sportModule, cfg, lineups, envelopes);
  return {
    fixtureId,
    lastSeq: events[events.length - 1].seq,
    state,
    summary: sportModule.summary(state),
    outcome: sportModule.outcome(state),
    active: resolveVoids(envelopes),
  };
}
