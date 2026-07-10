import "server-only";
// THE scoring path (doc 08 §4). Wraps the engine-db appendEvent adapter with:
// Redis idempotency (24 h — courtside retries on flaky Wi-Fi must be safe),
// per-fixture rate limiting, bracket slot progression, standings recompute,
// realtime publish and public-cache invalidation. undo = core.void through the
// same door.
import { sql, withTenant } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { cacheGet, cacheSet, cacheDelPattern } from "@/lib/cache";
import { rateLimit } from "@/lib/rate-limit";
import { requireFeature } from "@/lib/entitlements";
import { EngineError } from "@seazn/engine/core";
import { appendEvent, resolveModule } from "@/server/engine-db";
import { recomputeStandings } from "@/server/engine-db";
import { publishDivisionUpdate, publishFixtureUpdate } from "@/lib/realtime";
import {
  fireDivisionRevalidate,
  fireDiscoveryRevalidate,
  invalidateDiscoveryCache,
} from "@/server/public-site/revalidate";
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
  if (input.type === "core.void") await assertUndoTarget(auth, fixtureId, input);

  const result = await appendEvent(auth.orgId, fixtureId, input.expected_seq, {
    type: input.type,
    payload: input.payload,
    // Device links: recorded_by = issued_by (auth.userId carries the issuer,
    // doc 13 §7) + the device_link_id rider so the ledger distinguishes them.
    recordedBy: auth.userId,
    deviceLinkId: auth.deviceLinkId ?? null,
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
  // Discovery surfaces refresh on decided/void/start writes only — and only
  // when the competition is discoverable (doc 15 §2, checked inside).
  const movesDiscovery =
    result.outcome !== null || input.type === "core.void" || input.type === "core.start";
  void publishFixtureUpdate(fixtureId, "event");
  // Division-wide state_changed so multi-fixture listeners (slideshow) get
  // one channel per division instead of one per fixture.
  void sql<{ division_id: string }[]>`select division_id from fixtures where id = ${fixtureId}`
    .then(([row]) => row && publishDivisionUpdate(row.division_id, "score"))
    .catch(() => null);
  void invalidatePublicCache(auth.orgId, fixtureId, movesDiscovery);
  return out;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Undo with nothing to undo is a 409, never a crash (v3/09 §2): a missing /
// unknown / already-voided target answers CONFLICT before the fold would 422,
// so a double-tapped "Undo last" degrades to a calm "already undone".
async function assertUndoTarget(
  auth: AuthCtx,
  fixtureId: string,
  input: AppendEventRequest,
): Promise<void> {
  const eventId = (input.payload as { event_id?: unknown } | null)?.event_id;
  if (typeof eventId !== "string" || !UUID_RE.test(eventId)) {
    throw new HttpError(409, "Nothing to undo");
  }
  const [target] = await withTenant(auth.orgId, (tx) => tx<{ type: string; voided: boolean }[]>`
    select e.type,
           exists (select 1 from score_events v
                   where v.fixture_id = e.fixture_id and v.voids_event_id = e.id) as voided
    from score_events e
    where e.id = ${eventId} and e.fixture_id = ${fixtureId}`);
  if (!target) throw new HttpError(409, "Nothing to undo — that entry does not exist");
  if (target.voided) throw new HttpError(409, "Nothing to undo — that entry is already undone");
  if (target.type === "core.void") {
    throw new HttpError(409, "An undo cannot be undone — re-record the entry instead");
  }
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
      {
        sport_key: string;
        module_version: string;
        config: unknown;
        competition_id: string;
        division_status: string;
        fixture_status: string;
        scorer_can_finalize: boolean;
      }[]
    >`
      select d.sport_key, d.module_version, d.config, d.competition_id,
             d.status as division_status, f.status as fixture_status,
             d.scorer_can_finalize
      from fixtures f join divisions d on d.id = f.division_id
      where f.id = ${fixtureId}`;
    if (!row) return null;
    await assertCompetitionNotFrozen(auth.orgId, row.competition_id, tx);
    return row;
  });
  if (!ctx) return;

  // Doc 12 §1: scoring opens only after the explicit start action
  // (division_started). A published-but-unstarted timetable stays read-only.
  if (ctx.division_status === "setup" || ctx.division_status === "scheduled") {
    throw new EngineError("WRONG_PHASE", "division has not started — scoring is closed", {
      divisionStatus: ctx.division_status,
    });
  }

  // Device-link capabilities (doc 13 §7): strictly ⊂ scorer. Append + void
  // OWN-LINK events pre-finalize; finalizing needs a human with a name.
  if (auth.via === "device_link") {
    if (input.type === "core.finalize") {
      throw new HttpError(403, "Finalizing needs an organiser or scorer account");
    }
    if (input.type === "core.void") {
      if (ctx.fixture_status === "finalized") {
        throw new HttpError(403, "This fixture is finalized — ask the organiser");
      }
      const eventId = (input.payload as { event_id?: unknown } | null)?.event_id;
      const isUuid =
        typeof eventId === "string" &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(eventId);
      const [target] = isUuid
        ? await withTenant(auth.orgId, (tx) => tx<{ device_link_id: string | null }[]>`
            select device_link_id from score_events
            where id = ${eventId} and fixture_id = ${fixtureId}`)
        : [];
      if (!target || target.device_link_id !== auth.deviceLinkId) {
        throw new HttpError(403, "A device link can only undo its own events");
      }
    }
  }

  // Scorer capabilities (doc 13 §2): coverage was proven at the door
  // (requireFixtureActor → requireScorable); here the per-division config
  // gates apply. Finalize is config-gated; undo is own-fixture PRE-finalize
  // only — a finalized ledger is an editor's to reopen.
  if (auth.role === "scorer") {
    if (input.type === "core.finalize" && !ctx.scorer_can_finalize) {
      throw new HttpError(403, "Finalizing is restricted to organisers in this division");
    }
    if (input.type === "core.void" && ctx.fixture_status === "finalized") {
      throw new HttpError(403, "This fixture is finalized — ask an organiser to reopen it");
    }
  }

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
        ext_key: string | null;
        stage_config: Record<string, unknown>;
        division_id: string;
      }[]
    >`
      select f.stage_id, f.pool_id, f.winner_to_fixture, f.winner_to_slot,
             f.loser_to_fixture, f.loser_to_slot, s.kind, f.ext_key,
             s.config as stage_config, s.division_id
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
    // Placement games (Jul3/08 §4, 3 Jun/17 May): "winner of game X = 15th" —
    // the decided fixture writes rank locks via the Jul3/05 mechanism, never
    // alphabetical.
    const placements = (fixture.stage_config as { placements?: Record<string, [number, number]> })
      ?.placements;
    const place = fixture.ext_key !== null ? placements?.[fixture.ext_key] : undefined;
    if (place !== undefined && winner !== undefined && loser !== undefined) {
      const overrides =
        ((fixture.stage_config as { rank_overrides?: { entrant_id: string; rank: number }[] })
          .rank_overrides ?? []).filter((r) => r.entrant_id !== winner && r.entrant_id !== loser);
      overrides.push({ entrant_id: winner, rank: place[0] });
      overrides.push({ entrant_id: loser, rank: place[1] });
      await tx`
        update stages set config = ${tx.json({ ...(fixture.stage_config as object), rank_overrides: overrides } as never)}
        where id = ${fixture.stage_id}`;
    }
    // Ladder (Jul3/08 §6): the challenger taking the game takes the position.
    if (fixture.kind === "ladder" && winner !== undefined && loser !== undefined) {
      const cfg = fixture.stage_config as { ladder_order?: string[] };
      const order = [...(cfg.ladder_order ?? [])];
      const wi = order.indexOf(winner);
      const li = order.indexOf(loser);
      if (wi >= 0 && li >= 0 && wi > li) {
        [order[wi], order[li]] = [order[li]!, order[wi]!];
        await tx`
          update stages set config = ${tx.json({ ...(fixture.stage_config as object), ladder_order: order } as never)}
          where id = ${fixture.stage_id}`;
      }
    }
    return fixture;
  });
  if (context && TABLE_KINDS.has(context.kind)) {
    await recomputeStandings(auth.orgId, context.stage_id, context.pool_id ?? undefined);
  }
  // Auto-advance (Jul3/08 §5, 16 Sep): when the flag is on and the stage just
  // finished, progression fires without a button.
  if (context && o.kind !== undefined) {
    await maybeAutoAdvance(auth, context.stage_id, context.division_id);
  }
}

async function maybeAutoAdvance(auth: AuthCtx, stageId: string, divisionId: string): Promise<void> {
  const ready = await withTenant(auth.orgId, async (tx) => {
    const [division] = await tx<{ auto_progress: boolean }[]>`
      select auto_progress from divisions where id = ${divisionId}`;
    if (!division?.auto_progress) return false;
    const [stage] = await tx<{ status: string }[]>`
      select status from stages where id = ${stageId}`;
    if (stage?.status === "complete") return false;
    const [{ open }] = await tx<{ open: number }[]>`
      select count(*) filter (where status <> 'decided' and status <> 'forfeited')::int as open
      from fixtures where stage_id = ${stageId}`;
    return open === 0;
  });
  if (!ready) return;
  const { completeStage } = await import("./stages");
  try {
    await completeStage(auth, stageId);
    await withTenant(auth.orgId, async (tx) => {
      const [{ seq: last }] = await tx<{ seq: number }[]>`
        select coalesce(max(seq), 0)::int as seq from division_events
        where division_id = ${divisionId}`;
      await tx`
        insert into division_events (division_id, seq, type, payload, actor_id)
        values (${divisionId}, ${last + 1}, 'stage_auto_advanced',
                ${tx.json({ stage_id: stageId } as never)}, ${auth.userId})`;
      await tx`update divisions set seq = ${last + 1} where id = ${divisionId}`;
    });
  } catch {
    // not ready (e.g. lots pending) — the organiser completes manually
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
async function invalidatePublicCache(
  orgId: string,
  fixtureId: string,
  movesDiscovery = false,
): Promise<void> {
  const row = await withTenant(orgId, async (tx) => {
    const [r] = await tx<
      { division_id: string; competition_id: string; discoverable: boolean }[]
    >`
      select f.division_id, d.competition_id, c.discoverable
      from fixtures f
      join divisions d on d.id = f.division_id
      join competitions c on c.id = d.competition_id
      where f.id = ${fixtureId}`;
    return r ?? null;
  });
  await cacheDelPattern(`pub:v1:fixture:${fixtureId}`);
  if (row) {
    await cacheDelPattern(`pub:v1:div:${row.division_id}:*`);
    fireDivisionRevalidate(row.division_id, row.competition_id);
    // Cheap by design (doc 15 §2 / PROMPT-19 item 4): the `discovery` tag
    // fires only for discoverable competitions.
    if (movesDiscovery && row.discoverable) {
      await invalidateDiscoveryCache();
      fireDiscoveryRevalidate();
    }
  }
}
