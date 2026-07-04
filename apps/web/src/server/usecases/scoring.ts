import "server-only";
// THE scoring path (doc 08 §4). Wraps the engine-db appendEvent adapter with:
// Redis idempotency (24 h — courtside retries on flaky Wi-Fi must be safe),
// per-fixture rate limiting, bracket slot progression, standings recompute,
// realtime publish and public-cache invalidation. undo = core.void through the
// same door.
import { withTenant } from "@/lib/db";
import { cacheGet, cacheSet, cacheDelPattern } from "@/lib/cache";
import { rateLimit } from "@/lib/rate-limit";
import { appendEvent } from "@/server/engine-db";
import { recomputeStandings } from "@/server/engine-db";
import { publishFixtureUpdate } from "@/lib/realtime";
import type { AuthCtx } from "@/server/api-v1/auth";
import type { AppendEventRequest } from "@/server/api-v1/schemas";
import { fillSlot } from "./stages";

export interface ScoreOutcome {
  seq: number;
  state_summary: unknown;
  outcome: unknown;
  status: string;
}

const IDEM_TTL_SECONDS = 24 * 60 * 60; // doc 08 §4
const idemKey = (fixtureId: string, key: string) => `idemv1:${fixtureId}:${key}`;

// One scorer's cadence (doc 08 §6).
const SCORING_LIMIT = { max: 10, windowSeconds: 1 };

const TABLE_KINDS = new Set(["league", "group", "swiss"]);

/**
 * Append one score event. 201-shape on success; EngineError SEQ_CONFLICT →
 * 409 (v1 kernel maps it); module rejection → 422, nothing persisted.
 */
export async function scoreEvent(
  auth: AuthCtx,
  fixtureId: string,
  input: AppendEventRequest,
): Promise<ScoreOutcome> {
  await rateLimit(`scorev1:${fixtureId}`, SCORING_LIMIT);

  const cacheKey = input.idempotency_key ? idemKey(fixtureId, input.idempotency_key) : null;
  if (cacheKey) {
    const replay = await cacheGet<ScoreOutcome>(cacheKey);
    if (replay) return replay; // retried request: same answer, no double write
  }

  const result = await appendEvent(auth.orgId, fixtureId, input.expected_seq, {
    type: input.type,
    payload: input.payload,
    recordedBy: auth.userId,
    ...(input.type === "core.void" &&
    typeof (input.payload as { event_id?: unknown })?.event_id === "string"
      ? { voids: (input.payload as { event_id: string }).event_id }
      : {}),
  });

  const out: ScoreOutcome = {
    seq: result.seq,
    state_summary: result.summary,
    outcome: result.outcome,
    status: result.status,
  };

  // A decision (or a void that may have erased one) moves brackets/standings.
  if (result.outcome !== null || input.type === "core.void") {
    await onDecided(auth, fixtureId, result.outcome);
  }

  if (cacheKey) await cacheSet(cacheKey, out, IDEM_TTL_SECONDS);
  // After commit (doc 08 §4): realtime + public cache, both fire-and-forget.
  void publishFixtureUpdate(fixtureId, "event");
  void invalidatePublicCache(auth.orgId, fixtureId);
  return out;
}

// A decided fixture feeds brackets (winner_to/loser_to slots) and refreshes
// the table-stage standings snapshot.
async function onDecided(auth: AuthCtx, fixtureId: string, outcome: unknown): Promise<void> {
  // outcome may be null here (a void erased the decision) — recompute only.
  const o = (outcome ?? {}) as { kind?: string; winner?: string; loser?: string };
  const context = await withTenant(auth.orgId, async (tx) => {
    const [fixture] = await tx<
      {
        stage_id: string;
        pool_id: string | null;
        winner_to_fixture: string | null;
        winner_to_slot: number | null;
        loser_to_fixture: string | null;
        loser_to_slot: number | null;
        kind: string;
      }[]
    >`
      select f.stage_id, f.pool_id, f.winner_to_fixture, f.winner_to_slot,
             f.loser_to_fixture, f.loser_to_slot, s.kind
      from fixtures f join stages s on s.id = f.stage_id
      where f.id = ${fixtureId}`;
    if (!fixture) return null;
    const winner = o.kind === "win" || o.kind === "award" ? o.winner : undefined;
    const loser = o.kind === "win" ? o.loser : undefined;
    if (winner && fixture.winner_to_fixture && fixture.winner_to_slot) {
      await fillSlot(tx, fixture.winner_to_fixture, fixture.winner_to_slot, winner);
    }
    if (loser && fixture.loser_to_fixture && fixture.loser_to_slot) {
      await fillSlot(tx, fixture.loser_to_fixture, fixture.loser_to_slot, loser);
    }
    return fixture;
  });
  if (context && TABLE_KINDS.has(context.kind)) {
    await recomputeStandings(auth.orgId, context.stage_id, context.pool_id ?? undefined);
  }
}

/** Finalize: lock the ledger via core.finalize (same path, same audit). */
export async function finalizeFixture(
  auth: AuthCtx,
  fixtureId: string,
  expectedSeq: number,
): Promise<ScoreOutcome> {
  return scoreEvent(auth, fixtureId, {
    expected_seq: expectedSeq,
    type: "core.finalize",
    payload: {},
  });
}

// Public dashboards cache under pub:v1:* (doc 08 §6) — a scoring write is
// exactly what invalidates them.
async function invalidatePublicCache(orgId: string, fixtureId: string): Promise<void> {
  const divisionId = await withTenant(orgId, async (tx) => {
    const [row] = await tx<{ division_id: string }[]>`
      select division_id from fixtures where id = ${fixtureId}`;
    return row?.division_id ?? null;
  });
  await cacheDelPattern(`pub:v1:fixture:${fixtureId}`);
  if (divisionId) await cacheDelPattern(`pub:v1:div:${divisionId}:*`);
}
