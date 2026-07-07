// Undo/redo over the division_events ledger (Jul3/03 §3) — pure. Undo never
// deletes rows: it returns an inverse event to APPEND plus a moved watermark;
// fold(events ≤ watermark) is always the current schedule state. Inverse and
// redo-copy events are ordinary registry events, so a later watermark jump
// over them composes correctly (apply ∘ invert = identity on the state).
import type {
  DivisionScheduleState,
  FixtureSnapshot,
  HistoryStep,
  LedgerEvent,
  Placement,
} from "./types.ts";
import { HistoryError, type ClearScope, type ClearableFixture } from "./types.ts";

type Payload = Record<string, unknown>;

interface Move {
  fixture: string;
  from: Placement & { locked?: boolean };
  to: Placement & { locked?: boolean };
}

// The ReversibleOp registry (Jul3/03 §3): every structural division_events
// type that participates in undo declares apply (fold) + invert (the undo
// event) + the fixtures its UNDO touches (results-guard input).
interface ReversibleOp {
  apply(state: DivisionScheduleState, payload: Payload): void;
  invert(payload: Payload): { type: string; payload: Payload };
  affected(payload: Payload): string[];
}

function fixtureState(state: DivisionScheduleState, id: string) {
  const existing = state.fixtures[id];
  if (existing) return existing;
  const fresh = { exists: true, at: null, court: null, locked: false };
  state.fixtures[id] = fresh;
  return fresh;
}

const movesOf = (p: Payload): Move[] => (p.moves as Move[] | undefined) ?? [];
const snapshotsOf = (p: Payload, key: string): FixtureSnapshot[] =>
  (p[key] as FixtureSnapshot[] | undefined) ?? [];

// Jul3/03 §3 — the registry. `schedule_applied`/`schedule_edited` are the
// PROMPT-17 events (payloads already carry from/to); the rest are introduced
// by this prompt.
export const REVERSIBLE: Record<string, ReversibleOp> = {
  schedule_applied: {
    apply(state, p) {
      for (const m of movesOf(p)) {
        const f = fixtureState(state, m.fixture);
        f.at = m.to.at;
        f.court = m.to.court;
      }
    },
    invert(p) {
      return {
        type: "schedule_applied",
        payload: {
          ...p,
          moves: movesOf(p).map((m) => ({ fixture: m.fixture, from: m.to, to: m.from })),
        },
      };
    },
    affected: (p) => movesOf(p).map((m) => m.fixture),
  },
  schedule_edited: {
    apply(state, p) {
      const m = p as unknown as Move & { fixture: string };
      const f = fixtureState(state, m.fixture);
      f.at = m.to.at;
      f.court = m.to.court;
      if (m.to.locked !== undefined) f.locked = m.to.locked;
    },
    invert(p) {
      const m = p as unknown as Move;
      return { type: "schedule_edited", payload: { ...p, from: m.to, to: m.from } };
    },
    affected: (p) => [(p as { fixture: string }).fixture],
  },
  schedule_cleared: {
    apply(state, p) {
      for (const s of snapshotsOf(p, "cleared")) {
        const f = fixtureState(state, s.id);
        f.at = null;
        f.court = null;
      }
    },
    invert(p) {
      return { type: "schedule_restored", payload: { restored: p.cleared } };
    },
    affected: (p) => snapshotsOf(p, "cleared").map((s) => s.id),
  },
  schedule_restored: {
    apply(state, p) {
      for (const s of snapshotsOf(p, "restored")) {
        const f = fixtureState(state, s.id);
        f.at = s.at ?? null;
        f.court = s.court ?? null;
      }
    },
    invert(p) {
      return { type: "schedule_cleared", payload: { cleared: p.restored } };
    },
    affected: (p) => snapshotsOf(p, "restored").map((s) => s.id),
  },
  fixtures_generated: {
    apply(state, p) {
      for (const id of (p.fixture_ids as string[] | undefined) ?? []) {
        fixtureState(state, id).exists = true;
      }
    },
    invert(p) {
      return {
        type: "fixtures_cleared",
        payload: {
          stage_id: p.stage_id,
          fixture_ids: p.fixture_ids,
          // full row snapshots ride along when present so a redo can
          // re-insert without re-running the generator
          ...(p.fixtures !== undefined ? { fixtures: p.fixtures } : {}),
        },
      };
    },
    affected: (p) => ((p.fixture_ids as string[] | undefined) ?? []),
  },
  fixtures_cleared: {
    apply(state, p) {
      for (const id of (p.fixture_ids as string[] | undefined) ?? []) {
        const f = fixtureState(state, id);
        f.exists = false;
        f.at = null;
        f.court = null;
      }
    },
    invert(p) {
      return {
        type: "fixtures_generated",
        payload: {
          stage_id: p.stage_id,
          fixture_ids: p.fixture_ids,
          ...(p.fixtures !== undefined ? { fixtures: p.fixtures } : {}),
        },
      };
    },
    affected: (p) => ((p.fixture_ids as string[] | undefined) ?? []),
  },
  pool_entrants_cleared: {
    apply(state, p) {
      for (const s of snapshotsOf(p, "fixtures")) {
        const f = fixtureState(state, s.id);
        f.exists = false;
        f.at = null;
        f.court = null;
      }
    },
    invert(p) {
      return {
        type: "pool_entrants_restored",
        payload: { pool_id: p.pool_id, fixtures: p.fixtures },
      };
    },
    affected: (p) => snapshotsOf(p, "fixtures").map((s) => s.id),
  },
  pool_entrants_restored: {
    apply(state, p) {
      for (const s of snapshotsOf(p, "fixtures")) {
        const f = fixtureState(state, s.id);
        f.exists = true;
        f.at = s.at ?? null;
        f.court = s.court ?? null;
      }
    },
    invert(p) {
      return {
        type: "pool_entrants_cleared",
        payload: { pool_id: p.pool_id, fixtures: p.fixtures },
      };
    },
    affected: (p) => snapshotsOf(p, "fixtures").map((s) => s.id),
  },
};

export function isReversible(type: string): boolean {
  return type in REVERSIBLE;
}

/** Effective watermark: null persisted = ledger head. */
export function effectiveWatermark(events: readonly LedgerEvent[], watermark: number | null): number {
  return watermark ?? (events.length > 0 ? events[events.length - 1]!.seq : 0);
}

/** fold(events ≤ watermark) → DivisionScheduleState (Jul3/03 §3). Inverse
 *  pairs inside the range cancel, so a watermark at head is always coherent. */
export function fold(events: readonly LedgerEvent[], watermark: number | null): DivisionScheduleState {
  const wm = effectiveWatermark(events, watermark);
  const state: DivisionScheduleState = { fixtures: {} };
  for (const e of events) {
    if (e.seq > wm) break;
    REVERSIBLE[e.type]?.apply(state, e.payload);
  }
  return state;
}

function aliveRegistryEvents(events: readonly LedgerEvent[], upTo: number): LedgerEvent[] {
  return events.filter((e) => e.seq <= upTo && isReversible(e.type));
}

// Results-guard (Jul3/03 §3): never silently discard a scoresheet — any
// undo/redo whose op touches a decided fixture is blocked.
function guard(op: ReversibleOp, payload: Payload, decided: ReadonlySet<string>): void {
  const hit = op.affected(payload).find((id) => decided.has(id));
  if (hit !== undefined) {
    throw new HistoryError(
      "UNDO_BLOCKED_HAS_RESULTS",
      `fixture ${hit} already has a result — force-clear results first`,
    );
  }
}

/**
 * undo (Jul3/03 §3): pure — returns the inverse event to append and the new
 * watermark. The ledger itself is never mutated (append-only; audit intact).
 */
export function undo(
  events: readonly LedgerEvent[],
  watermark: number | null,
  decidedFixtureIds: ReadonlySet<string>,
): HistoryStep {
  const wm = effectiveWatermark(events, watermark);
  const alive = aliveRegistryEvents(events, wm);
  const target = alive[alive.length - 1];
  if (!target) throw new HistoryError("NOTHING_TO_UNDO", "no reversible edits before the watermark");
  const op = REVERSIBLE[target.type]!;
  guard(op, target.payload, decidedFixtureIds);
  const inverse = op.invert(target.payload);
  return {
    event: { type: inverse.type, payload: { ...inverse.payload, __undo_of: target.seq } },
    newWatermark: alive[alive.length - 2]?.seq ?? 0,
  };
}

/**
 * redo (Jul3/03 §3): moves the watermark forward to the next ORIGINAL edit
 * (skipping inverse events and redo copies) and returns an audit copy to
 * append. Making a fresh edit after an undo bumps the watermark to head,
 * which leaves no original edits beyond it — the redo branch dies naturally
 * (linear, Word-like history; Jul3/03 §8).
 */
export function redo(
  events: readonly LedgerEvent[],
  watermark: number | null,
  decidedFixtureIds: ReadonlySet<string>,
): HistoryStep {
  const wm = effectiveWatermark(events, watermark);
  const next = events.find(
    (e) =>
      e.seq > wm &&
      isReversible(e.type) &&
      e.payload.__undo_of === undefined &&
      e.payload.__redo_of === undefined,
  );
  if (!next) throw new HistoryError("NOTHING_TO_REDO", "already at the newest edit");
  const op = REVERSIBLE[next.type]!;
  guard(op, next.payload, decidedFixtureIds);
  return {
    event: { type: next.type, payload: { ...next.payload, __redo_of: next.seq } },
    newWatermark: next.seq,
  };
}

/**
 * Scoped clear (Jul3/03 §5): pure — picks the fixtures the scope matches
 * (mirroring the generation filters), always skipping locked (default) and
 * decided rows, and returns the schedule_cleared event to append.
 */
export function clearSchedule(
  fixtures: readonly ClearableFixture[],
  scope: ClearScope,
): {
  event: { type: "schedule_cleared"; payload: Payload };
  cleared: string[];
  skipped: { locked: number; decided: number };
} {
  const skipped = { locked: 0, decided: 0 };
  const cleared: FixtureSnapshot[] = [];
  for (const f of fixtures) {
    if (scope.stageId !== undefined && f.stageId !== scope.stageId) continue;
    if (scope.poolIds !== undefined && (f.poolId === null || !scope.poolIds.includes(f.poolId))) continue;
    if (scope.rounds !== undefined && (f.roundNo === null || !scope.rounds.includes(f.roundNo))) continue;
    if (scope.courts !== undefined && (f.court === null || !scope.courts.includes(f.court))) continue;
    if (f.at === null && f.court === null) continue; // nothing to clear
    if (f.decided) {
      skipped.decided++;
      continue;
    }
    if (scope.excludeLocked && f.locked) {
      skipped.locked++;
      continue;
    }
    cleared.push({ id: f.id, at: f.at, court: f.court });
  }
  return {
    event: { type: "schedule_cleared", payload: { scope, cleared } },
    cleared: cleared.map((c) => c.id),
    skipped,
  };
}

/**
 * remove-teams-in-pool (Jul3/03 §5, 2 Jul): drops the pool's fixtures while
 * keeping pool + stage. Blocked if any pool fixture is decided.
 */
export function removeEntrantsFromPool(
  fixtures: readonly (ClearableFixture & { snapshot: FixtureSnapshot })[],
  poolId: string,
): { event: { type: "pool_entrants_cleared"; payload: Payload }; removed: string[] } {
  const inPool = fixtures.filter((f) => f.poolId === poolId);
  const decided = inPool.find((f) => f.decided);
  if (decided) {
    throw new HistoryError(
      "UNDO_BLOCKED_HAS_RESULTS",
      `fixture ${decided.id} in this pool already has a result`,
    );
  }
  return {
    event: {
      type: "pool_entrants_cleared",
      payload: { pool_id: poolId, fixtures: inPool.map((f) => f.snapshot) },
    },
    removed: inPool.map((f) => f.id),
  };
}
