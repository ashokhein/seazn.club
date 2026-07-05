import "server-only";
// THE scoring path (doc 08 §4). Wraps the engine-db appendEvent adapter with:
// Redis idempotency (24 h — courtside retries on flaky Wi-Fi must be safe),
// per-fixture rate limiting, bracket slot progression, standings recompute,
// realtime publish and public-cache invalidation. undo = core.void through the
// same door.
import { withTenant } from "@/lib/db";
import { cacheGet, cacheSet, cacheDelPattern } from "@/lib/cache";
import { rateLimit } from "@/lib/rate-limit";
import { requireFeature } from "@/lib/entitlements";
import { appendEvent, resolveModule } from "@/server/engine-db";
import { recomputeStandings } from "@/server/engine-db";
import { publishFixtureUpdate } from "@/lib/realtime";
import { fireDivisionRevalidate } from "@/server/public-site/revalidate";
import type { AuthCtx } from "@/server/api-v1/auth";
import type { AppendEventRequest } from "@/server/api-v1/schemas";
import { assertCompetitionNotFrozen } from "./entitlement-freeze";
import { requiredFeatureForEvent } from "./fidelity";
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

  await assertEntitledToScore(auth, fixtureId, input);

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

// Entitlement gates at THE scoring door (doc 10 §2 rules 2 & 4):
//  - fidelity: the event-type → feature map derives from the pinned module's
//    own fidelityTiers declaration (doc 14 §4) — Tier 0/1 always passes, so a
//    downgraded org keeps coarse scoring;
//  - cricket.dls: a `cricket.revise` WITHOUT a manual target under a
//    dls-enabled config makes the fold compute a DLS target — Pro only. A
//    manual umpire target is always allowed;
//  - freeze: fixtures of an over-quota (frozen) competition are read-only.
// Unknown fixtures fall through — appendEvent owns that error.
async function assertEntitledToScore(
  auth: AuthCtx,
  fixtureId: string,
  input: AppendEventRequest,
): Promise<void> {
  const ctx = await withTenant(auth.orgId, async (tx) => {
    const [row] = await tx<
      { sport_key: string; module_version: string; config: unknown; competition_id: string }[]
    >`
      select d.sport_key, d.module_version, d.config, d.competition_id
      from fixtures f join divisions d on d.id = f.division_id
      where f.id = ${fixtureId}`;
    if (!row) return null;
    await assertCompetitionNotFrozen(auth.orgId, row.competition_id, tx);
    return row;
  });
  if (!ctx) return;

  const sportModule = resolveModule(ctx.sport_key, ctx.module_version);
  const feature = requiredFeatureForEvent(sportModule, input.type);
  if (feature) await requireFeature(auth.orgId, feature);

  if (input.type === "cricket.revise") {
    const manualTarget = (input.payload as { target?: unknown } | null)?.target !== undefined;
    const dlsEnabled =
      (ctx.config as { dls?: { enabled?: boolean } } | null)?.dls?.enabled === true;
    if (dlsEnabled && !manualTarget) await requireFeature(auth.orgId, "cricket.dls");
  }
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

// Public dashboards cache in two layers, both invalidated by exactly this
// write: Redis pub:v1:* (the /api/v1/public endpoints, doc 08 §6) and Next's
// ISR tag cache (the (public) pages, doc 09 §3 — same write that publishes
// realtime fires the tag).
async function invalidatePublicCache(orgId: string, fixtureId: string): Promise<void> {
  const row = await withTenant(orgId, async (tx) => {
    const [r] = await tx<{ division_id: string; competition_id: string }[]>`
      select f.division_id, d.competition_id
      from fixtures f join divisions d on d.id = f.division_id
      where f.id = ${fixtureId}`;
    return r ?? null;
  });
  await cacheDelPattern(`pub:v1:fixture:${fixtureId}`);
  if (row) {
    await cacheDelPattern(`pub:v1:div:${row.division_id}:*`);
    fireDivisionRevalidate(row.division_id, row.competition_id);
  }
}
