import "server-only";
// Schedule undo/versioning use-cases (Jul3/03 §6): undo/redo/history,
// checkpoints + restore, scoped clear, remove-teams-in-pool. The pure
// mechanics live in @seazn/engine/history — this module appends the returned
// event under the division aggregate lock and syncs the fixture tables.
import type postgres from "postgres";
import { z } from "zod";
import {
  ClearScope,
  HistoryError,
  clearSchedule as engineClearSchedule,
  fold,
  isReversible,
  redo as engineRedo,
  removeEntrantsFromPool as engineRemovePool,
  undo as engineUndo,
  type ClearableFixture,
  type FixtureSnapshot,
  type LedgerEvent,
} from "@seazn/engine/history";
import { EngineError } from "@seazn/engine/core";
import { withTenant } from "@/lib/db";
import { HttpError, PaymentRequiredError } from "@/lib/errors";
import { requireFeature, withinLimit } from "@/lib/entitlements";
import type { AuthCtx } from "@/server/api-v1/auth";
import { generateStageFixtures } from "./stages";

type Tx = postgres.TransactionSql;

// EngineError codes for the doc 08 §1 map: 409 for stale clients, 422 rest.
function toEngineError(err: unknown): never {
  if (err instanceof HistoryError) {
    if (err.code === "UNDO_BLOCKED_HAS_RESULTS") {
      throw new EngineError("ALREADY_DECIDED", err.message, { code: err.code });
    }
    throw new HttpError(422, err.message);
  }
  throw err;
}

async function loadLedger(tx: Tx, divisionId: string): Promise<LedgerEvent[]> {
  const rows = await tx<{ seq: string | number; type: string; payload: Record<string, unknown> }[]>`
    select seq, type, payload from division_events
    where division_id = ${divisionId} order by seq`;
  return rows.map((r) => ({ seq: Number(r.seq), type: r.type, payload: r.payload }));
}

async function decidedFixtureIds(tx: Tx, divisionId: string): Promise<Set<string>> {
  const rows = await tx<{ id: string }[]>`
    select id from fixtures where division_id = ${divisionId} and status = 'decided'`;
  return new Set(rows.map((r) => r.id));
}

interface DivisionMeta {
  seq: number;
  edit_watermark: number | null;
}

async function divisionMeta(tx: Tx, divisionId: string): Promise<DivisionMeta> {
  const [row] = await tx<{ seq: number; edit_watermark: string | number | null }[]>`
    select seq, edit_watermark from divisions where id = ${divisionId}`;
  if (!row) throw new HttpError(404, "division not found");
  return {
    seq: Number(row.seq),
    edit_watermark: row.edit_watermark === null ? null : Number(row.edit_watermark),
  };
}

async function appendEvent(
  tx: Tx,
  divisionId: string,
  event: { type: string; payload: Record<string, unknown> },
  actorId: string | null,
): Promise<number> {
  const [{ seq: last }] = await tx<{ seq: number }[]>`
    select coalesce(max(seq), 0)::int as seq from division_events
    where division_id = ${divisionId}`;
  await tx`
    insert into division_events (division_id, seq, type, payload, actor_id)
    values (${divisionId}, ${last + 1}, ${event.type},
            ${tx.json(event.payload as never)}, ${actorId})`;
  return last + 1;
}

// Execute one history event against the fixture tables. Undo/redo of a
// fixtures_generated with no snapshots re-runs the deterministic generator.
async function execute(
  tx: Tx,
  divisionId: string,
  event: { type: string; payload: Record<string, unknown> },
): Promise<void> {
  const p = event.payload;
  switch (event.type) {
    case "schedule_applied":
    case "schedule_shifted": {
      const moves = (p.moves as { fixture: string; to: { at: string | null; court: string | null } }[]) ?? [];
      for (const m of moves) {
        await tx`update fixtures set scheduled_at = ${m.to.at}, court_label = ${m.to.court}
                 where id = ${m.fixture} and status <> 'decided'`;
      }
      break;
    }
    case "schedule_edited": {
      const to = p.to as { at: string | null; court: string | null; locked?: boolean };
      await tx`
        update fixtures set scheduled_at = ${to.at}, court_label = ${to.court},
                            schedule_locked = coalesce(${to.locked ?? null}, schedule_locked)
        where id = ${p.fixture as string} and status <> 'decided'`;
      break;
    }
    case "schedule_cleared": {
      for (const s of (p.cleared as FixtureSnapshot[]) ?? []) {
        await tx`update fixtures set scheduled_at = null, court_label = null
                 where id = ${s.id} and status <> 'decided'`;
      }
      break;
    }
    case "schedule_restored": {
      for (const s of (p.restored as FixtureSnapshot[]) ?? []) {
        await tx`update fixtures set scheduled_at = ${s.at ?? null}, court_label = ${s.court ?? null}
                 where id = ${s.id} and status <> 'decided'`;
      }
      break;
    }
    case "fixtures_cleared":
    case "pool_entrants_cleared": {
      const ids =
        event.type === "fixtures_cleared"
          ? ((p.fixture_ids as string[]) ?? [])
          : ((p.fixtures as FixtureSnapshot[]) ?? []).map((s) => s.id);
      if (ids.length > 0) {
        await tx`delete from fixtures where id in ${tx(ids)} and status <> 'decided'`;
      }
      break;
    }
    case "pool_entrants_restored": {
      for (const s of (p.fixtures as FixtureSnapshot[]) ?? []) {
        await tx`
          insert into fixtures (id, stage_id, division_id, pool_id, round_no, seq_in_round,
                                home_entrant_id, away_entrant_id, scheduled_at, court_label, status)
          values (${s.id}, ${s.stage_id!}, ${divisionId}, ${s.pool_id ?? null},
                  ${s.round_no ?? 1}, ${s.seq_in_round ?? 1}, ${s.home_entrant_id ?? null},
                  ${s.away_entrant_id ?? null}, ${s.at ?? null}, ${s.court ?? null}, 'scheduled')
          on conflict (id) do nothing`;
      }
      break;
    }
    case "fixtures_generated": {
      // Deterministic generator re-run (idempotent by ext_key) — marker set
      // by the caller; actual regeneration happens outside this tx.
      break;
    }
    default:
      throw new HttpError(500, `no executor for history event '${event.type}'`);
  }
}

export interface HistoryStepOut {
  watermark: number;
  seq: number;
  applied: { type: string };
  regenerate_stage_id?: string;
}

const StepInput = z.object({ expected_seq: z.number().int().optional() });
export { StepInput as HistoryStepInput };

async function step(
  auth: AuthCtx,
  divisionId: string,
  direction: "undo" | "redo",
  expectedSeq: number | undefined,
): Promise<HistoryStepOut> {
  const out = await withTenant(auth.orgId, async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext(${"division:" + divisionId}))`;
    const meta = await divisionMeta(tx, divisionId);
    // optimistic token (Jul3/03 §8): a stale client gets 409 + refetch
    if (expectedSeq !== undefined && expectedSeq !== meta.seq) {
      throw new EngineError("SEQ_CONFLICT", "division changed since you loaded it", {
        actualSeq: meta.seq,
      });
    }
    const ledger = await loadLedger(tx, divisionId);
    const decided = await decidedFixtureIds(tx, divisionId);
    let result;
    try {
      result =
        direction === "undo"
          ? engineUndo(ledger, meta.edit_watermark, decided)
          : engineRedo(ledger, meta.edit_watermark, decided);
    } catch (err) {
      toEngineError(err);
    }
    // Undoing a generation needs the row snapshots for redo — enrich before
    // the delete so the appended event is self-contained.
    if (result.event.type === "fixtures_cleared" && result.event.payload.fixtures === undefined) {
      const ids = (result.event.payload.fixture_ids as string[]) ?? [];
      if (ids.length > 0) {
        const rows = await tx<FixtureSnapshot[]>`
          select id, stage_id, pool_id, round_no, seq_in_round, home_entrant_id,
                 away_entrant_id, scheduled_at::text as at, court_label as court
          from fixtures where id in ${tx(ids)}`;
        result.event.payload.fixtures = rows;
      }
    }
    await execute(tx, divisionId, result.event);
    const seq = await appendEvent(tx, divisionId, result.event, auth.userId);
    await tx`update divisions set seq = ${seq}, edit_watermark = ${result.newWatermark}
             where id = ${divisionId}`;
    const regen =
      result.event.type === "fixtures_generated" && result.event.payload.fixtures === undefined
        ? ((result.event.payload.stage_id as string) ?? undefined)
        : undefined;
    // A fixtures_generated with snapshots re-inserts directly.
    if (result.event.type === "fixtures_generated" && result.event.payload.fixtures !== undefined) {
      for (const s of (result.event.payload.fixtures as FixtureSnapshot[]) ?? []) {
        await tx`
          insert into fixtures (id, stage_id, division_id, pool_id, round_no, seq_in_round,
                                home_entrant_id, away_entrant_id, scheduled_at, court_label, status)
          values (${s.id}, ${s.stage_id!}, ${divisionId}, ${s.pool_id ?? null},
                  ${s.round_no ?? 1}, ${s.seq_in_round ?? 1}, ${s.home_entrant_id ?? null},
                  ${s.away_entrant_id ?? null}, ${s.at ?? null}, ${s.court ?? null}, 'scheduled')
          on conflict (id) do nothing`;
      }
    }
    return {
      watermark: result.newWatermark,
      seq,
      applied: { type: result.event.type },
      ...(regen !== undefined ? { regenerate_stage_id: regen } : {}),
    };
  });
  // generator re-run outside the history tx (it takes its own division lock)
  if (out.regenerate_stage_id !== undefined) {
    await generateStageFixtures(auth, out.regenerate_stage_id);
  }
  return out;
}

export const undoDivision = (auth: AuthCtx, id: string, expectedSeq?: number) =>
  step(auth, id, "undo", expectedSeq);
export const redoDivision = (auth: AuthCtx, id: string, expectedSeq?: number) =>
  step(auth, id, "redo", expectedSeq);

export interface HistoryRow {
  seq: number;
  type: string;
  undoable: boolean;
  actor_id: string | null;
  created_at: string;
  undone: boolean;
}

/** GET /divisions/{id}/history — ledger slice, newest first. */
export async function divisionHistory(
  auth: AuthCtx,
  divisionId: string,
): Promise<{ watermark: number | null; seq: number; events: HistoryRow[] }> {
  return withTenant(auth.orgId, async (tx) => {
    const meta = await divisionMeta(tx, divisionId);
    const rows = await tx<{ seq: number; type: string; actor_id: string | null; created_at: string }[]>`
      select seq, type, actor_id, created_at from division_events
      where division_id = ${divisionId} order by seq desc limit 100`;
    const wm = meta.edit_watermark;
    return {
      watermark: wm,
      seq: meta.seq,
      events: rows.map((r) => ({
        seq: Number(r.seq),
        type: r.type,
        undoable: isReversible(r.type),
        actor_id: r.actor_id,
        created_at: r.created_at,
        undone: wm !== null && isReversible(r.type) && Number(r.seq) > wm,
      })),
    };
  });
}

// ---------------------------------------------------------------------------
// Checkpoints (Jul3/03 §2) — named save points; restore = undo to watermark.
// ---------------------------------------------------------------------------

export interface CheckpointRow {
  id: string;
  seq: number;
  label: string;
  created_at: string;
}

export async function listCheckpoints(auth: AuthCtx, divisionId: string): Promise<CheckpointRow[]> {
  return withTenant(auth.orgId, (tx) => tx<CheckpointRow[]>`
    select id, seq, label, created_at from division_checkpoints
    where division_id = ${divisionId} order by created_at desc`);
}

export async function createCheckpoint(
  auth: AuthCtx,
  divisionId: string,
  label: string,
): Promise<CheckpointRow> {
  return withTenant(auth.orgId, async (tx) => {
    const meta = await divisionMeta(tx, divisionId);
    // Jul3/03 §7 → V286: save points are a per-plan quota (community 1,
    // pro 5, pro_plus unlimited). schedule.versioning still gates scope locks.
    const [{ n }] = await tx<{ n: number }[]>`
      select count(*)::int as n from division_checkpoints where division_id = ${divisionId}`;
    const quota = await withinLimit(auth.orgId, "schedule.checkpoints.max", n + 1);
    if (!quota.ok) throw new PaymentRequiredError("schedule.checkpoints.max");
    const ledger = await loadLedger(tx, divisionId);
    const wm = meta.edit_watermark ?? (ledger[ledger.length - 1]?.seq ?? 0);
    const [row] = await tx<CheckpointRow[]>`
      insert into division_checkpoints (division_id, seq, label, created_by)
      values (${divisionId}, ${wm}, ${label}, ${auth.userId})
      returning id, seq, label, created_at`;
    return row!;
  });
}

/** POST /divisions/{id}/restore — undo repeatedly to the checkpoint's
 *  watermark (guarded by the same results-guard as single undo). */
export async function restoreCheckpoint(
  auth: AuthCtx,
  divisionId: string,
  checkpointId: string,
  confirm: boolean,
): Promise<{ watermark: number; steps: number }> {
  if (!confirm) throw new HttpError(422, "restore requires confirm: true");
  const target = await withTenant(auth.orgId, async (tx) => {
    const [cp] = await tx<{ seq: string | number }[]>`
      select seq from division_checkpoints
      where id = ${checkpointId} and division_id = ${divisionId}`;
    if (!cp) throw new HttpError(404, "checkpoint not found");
    return Number(cp.seq);
  });
  let steps = 0;
  // Each undo is its own single-writer append (concurrency-safe); stop once
  // the watermark reaches the checkpoint.
  for (let i = 0; i < 500; i++) {
    const meta = await withTenant(auth.orgId, (tx) => divisionMeta(tx, divisionId));
    const ledger = await withTenant(auth.orgId, (tx) => loadLedger(tx, divisionId));
    const wm = meta.edit_watermark ?? (ledger[ledger.length - 1]?.seq ?? 0);
    if (wm <= target) return { watermark: wm, steps };
    await undoDivision(auth, divisionId);
    steps++;
  }
  throw new HttpError(500, "restore did not converge");
}

// ---------------------------------------------------------------------------
// Scoped clear + remove-teams-in-pool (Jul3/03 §5)
// ---------------------------------------------------------------------------

export const ClearScheduleInput = z.object({
  division_id: z.string().uuid(),
  scope: ClearScope.default({ excludeLocked: true }),
  confirm: z.literal(true), // double-submit guard (Jul3/03 §6)
});
export type ClearScheduleInput = z.infer<typeof ClearScheduleInput>;

async function clearableFixtures(tx: Tx, divisionId: string): Promise<ClearableFixture[]> {
  const rows = await tx<{
    id: string; stage_id: string; pool_id: string | null; round_no: number | null;
    court_label: string | null; scheduled_at: string | null; schedule_locked: boolean; status: string;
  }[]>`
    select id, stage_id, pool_id, round_no, court_label, scheduled_at::text as scheduled_at,
           schedule_locked, status
    from fixtures where division_id = ${divisionId}`;
  return rows.map((f) => ({
    id: f.id,
    stageId: f.stage_id,
    poolId: f.pool_id,
    roundNo: f.round_no,
    court: f.court_label,
    at: f.scheduled_at,
    locked: f.schedule_locked,
    decided: f.status === "decided",
  }));
}

export async function clearScheduleScoped(
  auth: AuthCtx,
  input: ClearScheduleInput,
): Promise<{ cleared: number; skipped: { locked: number; decided: number }; seq: number }> {
  return withTenant(auth.orgId, async (tx) => {
    const divisionId = input.division_id;
    await tx`select pg_advisory_xact_lock(hashtext(${"division:" + divisionId}))`;
    const [division] = await tx`select 1 from divisions where id = ${divisionId}`;
    if (!division) throw new HttpError(404, "division not found");
    const fixtures = await clearableFixtures(tx, divisionId);
    const { event, cleared, skipped } = engineClearSchedule(fixtures, input.scope);
    if (cleared.length === 0) {
      const meta = await divisionMeta(tx, divisionId);
      return { cleared: 0, skipped, seq: meta.seq };
    }
    await execute(tx, divisionId, event);
    const seq = await appendEvent(tx, divisionId, event, auth.userId);
    await tx`update divisions set seq = ${seq}, edit_watermark = null
             where id = ${divisionId}`;
    return { cleared: cleared.length, skipped, seq };
  });
}

export async function clearPoolEntrants(
  auth: AuthCtx,
  poolId: string,
  confirm: boolean,
): Promise<{ removed: number; seq: number }> {
  if (!confirm) throw new HttpError(422, "clear-entrants requires confirm: true");
  return withTenant(auth.orgId, async (tx) => {
    const [pool] = await tx<{ stage_id: string; division_id: string }[]>`
      select p.stage_id, s.division_id from pools p join stages s on s.id = p.stage_id
      where p.id = ${poolId}`;
    if (!pool) throw new HttpError(404, "pool not found");
    const divisionId = pool.division_id;
    await tx`select pg_advisory_xact_lock(hashtext(${"division:" + divisionId}))`;
    const rows = await tx<{
      id: string; stage_id: string; pool_id: string | null; round_no: number | null;
      seq_in_round: number | null; home_entrant_id: string | null; away_entrant_id: string | null;
      court_label: string | null; scheduled_at: string | null; schedule_locked: boolean; status: string;
    }[]>`
      select id, stage_id, pool_id, round_no, seq_in_round, home_entrant_id, away_entrant_id,
             court_label, scheduled_at::text as scheduled_at, schedule_locked, status
      from fixtures where pool_id = ${poolId}`;
    let result;
    try {
      result = engineRemovePool(
        rows.map((f) => ({
          id: f.id,
          stageId: f.stage_id,
          poolId: f.pool_id,
          roundNo: f.round_no,
          court: f.court_label,
          at: f.scheduled_at,
          locked: f.schedule_locked,
          decided: f.status === "decided",
          snapshot: {
            id: f.id,
            stage_id: f.stage_id,
            pool_id: f.pool_id,
            round_no: f.round_no ?? undefined,
            seq_in_round: f.seq_in_round ?? undefined,
            home_entrant_id: f.home_entrant_id,
            away_entrant_id: f.away_entrant_id,
            at: f.scheduled_at,
            court: f.court_label,
          },
        })),
        poolId,
      );
    } catch (err) {
      toEngineError(err);
    }
    await execute(tx, divisionId, result.event);
    const seq = await appendEvent(tx, divisionId, result.event, auth.userId);
    await tx`update divisions set seq = ${seq}, edit_watermark = null
             where id = ${divisionId}`;
    return { removed: result.removed.length, seq };
  });
}

// ---------------------------------------------------------------------------
// Division schedule lock + scope locks (Jul3/03 §4)
// ---------------------------------------------------------------------------

export const LockInput = z.object({
  schedule_locked: z.boolean().optional(),
  locked_scopes: z
    .array(
      z.object({
        courts: z.array(z.string()).optional(),
        venues: z.array(z.string()).optional(),
        pool_ids: z.array(z.string()).optional(),
      }),
    )
    .optional(),
});
export type LockInput = z.infer<typeof LockInput>;

export async function setDivisionLocks(
  auth: AuthCtx,
  divisionId: string,
  input: LockInput,
): Promise<{ schedule_locked: boolean; locked_scopes: unknown }> {
  if (input.locked_scopes !== undefined && input.locked_scopes.length > 0) {
    // multi-site scope locking is the Pro layer (Jul3/03 §7)
    await requireFeature(auth.orgId, "schedule.versioning");
  }
  return withTenant(auth.orgId, async (tx) => {
    const [row] = await tx<{ schedule_locked: boolean; locked_scopes: unknown }[]>`
      update divisions set
        schedule_locked = coalesce(${input.schedule_locked ?? null}, schedule_locked),
        locked_scopes = coalesce(${input.locked_scopes ? tx.json(input.locked_scopes as never) : null}, locked_scopes)
      where id = ${divisionId}
      returning schedule_locked, locked_scopes`;
    if (!row) throw new HttpError(404, "division not found");
    return row;
  });
}

/** State the console renders after undo/redo: the fold at the watermark. */
export async function scheduleStateAt(
  auth: AuthCtx,
  divisionId: string,
): Promise<Record<string, { at: string | null; court: string | null }>> {
  return withTenant(auth.orgId, async (tx) => {
    const meta = await divisionMeta(tx, divisionId);
    const ledger = await loadLedger(tx, divisionId);
    const state = fold(ledger, meta.edit_watermark);
    const out: Record<string, { at: string | null; court: string | null }> = {};
    for (const [id, f] of Object.entries(state.fixtures)) {
      if (f.exists) out[id] = { at: f.at, court: f.court };
    }
    return out;
  });
}
