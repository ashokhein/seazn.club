import "server-only";
import { randomUUID } from "node:crypto";
import { withTenant } from "@/lib/db";
import {
  EngineError,
  foldMatch,
  resolveVoids,
  type EventEnvelope,
  type MatchOutcome,
  type ScoreSummary,
  type StageKind,
} from "@seazn/engine/core";
import { resolveModule } from "./registry";
import { loadLineupPair } from "./lineups";
import { stageScopedCfg } from "./stage-cfg";
import { captureServer } from "@/lib/posthog-server";
import { EVENTS } from "@/lib/analytics-events";

// What a caller supplies; persistence stamps id/seq/recordedAt (spec 03 §2 —
// ids/time are injected). `id`/`recordedAt` are accepted for test determinism.
export interface AppendInput {
  type: string;
  payload: unknown;
  recordedBy?: string | null;
  /** Device-link attribution (doc 13 §7): set when the event arrived via a
   *  dl_ token. Rides OUTSIDE the hash-chain canonical. */
  deviceLinkId?: string | null;
  voids?: string;
  id?: string;
  recordedAt?: string;
}

export interface AppendResult {
  seq: number;
  event: EventEnvelope;
  state: unknown;
  summary: ScoreSummary;
  outcome: MatchOutcome | null;
  status: string;
}

interface FixtureRow {
  id: string;
  division_id: string;
  stage_id: string;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  status: string;
  outcome: unknown;
}
interface StageRow {
  kind: string;
  config: Record<string, unknown> | null;
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

// Terminal DB statuses that lock the ledger against further appends.
const LOCKED = new Set(["finalized", "cancelled"]);

// Map the folded ledger onto the fixtures.status enum. Derived from the
// ACTIVE (void-resolved) events, not from event-type transitions: a void can
// erase core.start / core.forfeit / core.abandon / the deciding event, and the
// status must follow the fold or the console dead-ends (v3/09 §2 — the cricket
// "undo made scoring disappear" regression was status=in_play with the fold
// back in the pre phase, so neither the Start button nor the pad rendered).
function nextStatus(
  candidateType: string,
  outcome: MatchOutcome | null,
  active: readonly EventEnvelope[],
): string {
  if (candidateType === "core.finalize") return "finalized";
  const has = (type: string) => active.some((event) => event.type === type);
  // Abandon first: cricket abandon folds to a no_result OUTCOME, but the
  // fixture status stays "abandoned" (replay policy owns it from here).
  if (has("core.abandon")) return "abandoned";
  if (outcome !== null) return has("core.forfeit") ? "forfeited" : "decided";
  return has("core.start") ? "in_play" : "scheduled";
}

/**
 * Append one event to a fixture's ledger (spec 03 §5). Within a tenant tx:
 * advisory-lock the fixture → optimistic seq check (409 on mismatch) → load
 * state + tail events → fold-validate through the pinned module (invalid event
 * never enters the ledger) → insert event (org_id + hash chain filled by
 * triggers) → upsert match_state → write fixtures.outcome+status on decision →
 * NOTIFY after commit.
 *
 * @throws EngineError('SEQ_CONFLICT') on a stale expectedSeq (→ HTTP 409).
 * @throws EngineError(...) from the module on an invalid event (→ 422).
 */
export async function appendEvent(
  orgId: string,
  fixtureId: string,
  expectedSeq: number,
  input: AppendInput,
): Promise<AppendResult> {
  // Activation funnel (feature 1): the first time a fixture yields a result is
  // the "aha" moment. The tx returns whether this append crossed that line;
  // capture happens OUTSIDE the tx (below) so a PostHog flush never touches the
  // write path.
  type FirstResult = { distinctId: string; sportKey: string; status: string };
  const { appended, firstResult } = await withTenant<{
    appended: AppendResult;
    firstResult: FirstResult | null;
  }>(orgId, async (tx) => {
    // Serialise all appends to this fixture (spec 02 §8 — fixture is the write
    // aggregate). The lock is held to commit, so a concurrent appender blocks,
    // then re-reads the committed max seq and 409s.
    await tx`select pg_advisory_xact_lock(hashtext(${"fixture:" + fixtureId}))`;

    const [fixture] = await tx<FixtureRow[]>`
      select id, division_id, stage_id, home_entrant_id, away_entrant_id, status, outcome
      from fixtures where id = ${fixtureId}
    `;
    if (!fixture) {
      throw new EngineError("INVALID_EVENT", `fixture ${fixtureId} not found`, { fixtureId });
    }
    if (LOCKED.has(fixture.status)) {
      throw new EngineError("ALREADY_DECIDED", `fixture ${fixtureId} is ${fixture.status}`, {
        fixtureId,
        status: fixture.status,
      });
    }
    if (!fixture.home_entrant_id || !fixture.away_entrant_id) {
      throw new EngineError("WRONG_PHASE", "fixture has an unassigned entrant (bye/TBD)", {
        fixtureId,
      });
    }

    const [division] = await tx<DivisionRow[]>`
      select config, sport_key, module_version from divisions where id = ${fixture.division_id}
    `;
    if (!division) {
      throw new EngineError("CONFIG_INVALID", "division not found for fixture", { fixtureId });
    }
    const sportModule = resolveModule(division.sport_key, division.module_version);
    // The fixture's stage kind gates draw finalization (PROMPT-61); its config
    // may carry stage-scoped decider overrides.
    const [stage] = await tx<StageRow[]>`
      select kind, config from stages where id = ${fixture.stage_id}
    `;

    // Optimistic concurrency: the client's expectedSeq must equal the current
    // ledger tip. Gapless seq is assigned here, under the lock (doc 07 note 3).
    const [{ seq: lastSeq }] = await tx<{ seq: number }[]>`
      select coalesce(max(seq), 0)::int as seq from score_events where fixture_id = ${fixtureId}
    `;
    if (lastSeq !== expectedSeq) {
      throw new EngineError(
        "SEQ_CONFLICT",
        `expected seq ${expectedSeq} but ledger is at ${lastSeq}`,
        { fixtureId, expectedSeq, actualSeq: lastSeq },
      );
    }

    const priorRows = await tx<EventRow[]>`
      select id, seq, type, payload, recorded_at, recorded_by, voids_event_id
      from score_events where fixture_id = ${fixtureId} order by seq
    `;
    const prior: EventEnvelope[] = priorRows.map((r) => ({
      id: r.id,
      fixtureId,
      seq: r.seq,
      type: r.type,
      payload: r.payload,
      recordedAt: r.recorded_at.toISOString(),
      recordedBy: r.recorded_by,
      ...(r.voids_event_id ? { voids: r.voids_event_id } : {}),
    }));

    const candidate: EventEnvelope = {
      id: input.id ?? randomUUID(),
      fixtureId,
      seq: expectedSeq + 1,
      type: input.type,
      payload: input.payload,
      recordedAt: input.recordedAt ?? new Date().toISOString(),
      recordedBy: input.recordedBy ?? null,
      ...(input.voids ? { voids: input.voids } : {}),
    };

    const lineups = await loadLineupPair(
      tx,
      fixtureId,
      fixture.home_entrant_id,
      fixture.away_entrant_id,
    );

    // Fold-validate the full stream INCLUDING the candidate. A throwing module
    // (invalid event, already-decided, …) aborts the tx before any insert, so
    // the ledger only ever holds valid events (spec 03 §2 guarantee 2).
    const stream = [...prior, candidate];
    const cfg = stageScopedCfg(division.config, stage?.config);
    const state = foldMatch(sportModule, cfg, lineups, stream);
    const summary = sportModule.summary(state);
    const outcome = sportModule.outcome(state);
    const active = resolveVoids(stream);

    // PROMPT-61: a stage that cannot end level refuses to finalize a draw —
    // the throw aborts the tx before insert, so the bracket never silently
    // stalls on an outcome with no winner to advance.
    if (
      outcome !== null &&
      (outcome as { kind?: string }).kind === "draw" &&
      stage !== undefined &&
      !sportModule.supportsDraws(cfg as never, stage.kind as StageKind)
    ) {
      throw new EngineError(
        "DRAW_NOT_ALLOWED",
        "this stage cannot end level — decide it by extra time or a shootout",
        { fixtureId, stage: stage.kind },
      );
    }

    await tx`
      insert into score_events (id, fixture_id, seq, type, payload, recorded_by, recorded_at, voids_event_id, device_link_id)
      values (${candidate.id}, ${fixtureId}, ${candidate.seq}, ${candidate.type},
              ${tx.json(candidate.payload as never)}, ${candidate.recordedBy},
              ${candidate.recordedAt}, ${candidate.voids ?? null}, ${input.deviceLinkId ?? null})
    `;

    await tx`
      insert into match_states (fixture_id, last_seq, state, summary)
      values (${fixtureId}, ${candidate.seq}, ${tx.json(state as never)}, ${tx.json(summary as never)})
      on conflict (fixture_id) do update set
        last_seq = excluded.last_seq, state = excluded.state,
        summary = excluded.summary, updated_at = now()
    `;

    const status = nextStatus(candidate.type, outcome, active);
    // Fire once, on the transition from no-result to a decided result.
    const firstResult: FirstResult | null =
      fixture.outcome === null && outcome !== null
        ? { distinctId: candidate.recordedBy ?? `org:${orgId}`, sportKey: division.sport_key, status }
        : null;
    // Also rewrite when a void erased a previously-stored outcome — otherwise
    // fixtures.outcome would go stale against the fold (doc 08 §4 undo).
    if (status !== fixture.status || outcome !== null || fixture.outcome !== null) {
      await tx`
        update fixtures set
          status = ${status},
          outcome = ${outcome === null ? null : tx.json(outcome as never)}
        where id = ${fixtureId}
      `;
    }

    // Delivered to LISTEN'ers on commit (Postgres queues NOTIFY until commit) —
    // the "publish after commit" of spec 03 §5, dependency-free.
    await tx`select pg_notify('fixture_events', ${JSON.stringify({
      fixtureId,
      seq: candidate.seq,
      status,
    })})`;

    return {
      appended: { seq: candidate.seq, event: candidate, state, summary, outcome, status },
      firstResult,
    };
  });

  if (firstResult) {
    await captureServer({
      event: EVENTS.RESULT_ENTERED,
      distinctId: firstResult.distinctId,
      orgId,
      properties: { sport_key: firstResult.sportKey, status: firstResult.status, fixture_id: fixtureId },
    });
  }
  return appended;
}
