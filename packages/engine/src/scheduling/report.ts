// Bulk shift + wait-time diagnostics (Jul3/04 §4) — pure transforms over an
// existing board. No wall-clock reads; times are epoch ms.
import type { Assignment } from "./calendar.ts";

const MS_PER_MIN = 60_000;

export interface ShiftableFixture {
  id: string;
  at: string | null; // ISO timestamp
  court: string | null;
  stageId?: string;
  divisionId?: string;
  poolId?: string;
  locked: boolean;
  decided: boolean;
}

export interface ShiftScope {
  stageId?: string;
  poolIds?: string[];
  courts?: string[];
  excludeLocked?: boolean; // default true
}

export interface ShiftMove {
  fixture: string;
  from: { at: string; court: string | null };
  to: { at: string; court: string | null };
}

/**
 * shiftSchedule (Jul3/04 §4, 10 Jun/5 Sep/26 Jun): move every scheduled
 * fixture in scope by deltaMinutes. Scope mirrors the scoped-clear filters
 * (Jul3/03 §5); locked (by default) and decided fixtures never move. Returns
 * the moves for a `schedule_shifted` ledger event — undoable via Jul3/03.
 */
export function shiftSchedule(
  fixtures: readonly ShiftableFixture[],
  scope: ShiftScope,
  deltaMinutes: number,
): { moves: ShiftMove[]; skipped: { locked: number; decided: number } } {
  const excludeLocked = scope.excludeLocked ?? true;
  const moves: ShiftMove[] = [];
  const skipped = { locked: 0, decided: 0 };
  for (const f of fixtures) {
    if (f.at === null) continue;
    if (scope.stageId !== undefined && f.stageId !== scope.stageId) continue;
    if (scope.poolIds !== undefined && (f.poolId === undefined || !scope.poolIds.includes(f.poolId))) continue;
    if (scope.courts !== undefined && (f.court === null || !scope.courts.includes(f.court))) continue;
    if (f.decided) {
      skipped.decided++;
      continue;
    }
    if (excludeLocked && f.locked) {
      skipped.locked++;
      continue;
    }
    const to = new Date(new Date(f.at).getTime() + deltaMinutes * MS_PER_MIN).toISOString();
    moves.push({ fixture: f.id, from: { at: f.at, court: f.court }, to: { at: to, court: f.court } });
  }
  return { moves, skipped };
}

export interface EntrantWaitReport {
  entrantId: string;
  fixtures: number;
  /** Minutes between consecutive fixtures (end → next start). */
  minGapMinutes: number | null;
  maxGapMinutes: number | null;
  /** Wait from the entrant's first involvement to its last game's start. */
  spanMinutes: number;
}

export interface ScheduleReport {
  perEntrant: EntrantWaitReport[];
  /** Worst waits first (16 Sep ask): the entrants an organiser should look at. */
  worst: EntrantWaitReport[];
}

/** scheduleReport (Jul3/04 §4, 16 Sep): min/max wait per entrant — a derived
 *  read model shown before publish; no schema. */
export function scheduleReport(assignments: readonly Assignment[]): ScheduleReport {
  const byEntrant = new Map<string, Assignment[]>();
  for (const a of assignments) {
    for (const e of a.entrants) {
      const list = byEntrant.get(e) ?? [];
      list.push(a);
      byEntrant.set(e, list);
    }
  }
  const perEntrant: EntrantWaitReport[] = [];
  for (const [entrantId, list] of byEntrant) {
    const sorted = [...list].sort((a, b) => a.startAt - b.startAt);
    let minGap: number | null = null;
    let maxGap: number | null = null;
    for (let i = 1; i < sorted.length; i++) {
      const gap = Math.round((sorted[i]!.startAt - sorted[i - 1]!.endAt) / MS_PER_MIN);
      if (minGap === null || gap < minGap) minGap = gap;
      if (maxGap === null || gap > maxGap) maxGap = gap;
    }
    perEntrant.push({
      entrantId,
      fixtures: sorted.length,
      minGapMinutes: minGap,
      maxGapMinutes: maxGap,
      spanMinutes: Math.round(
        (sorted[sorted.length - 1]!.startAt - sorted[0]!.startAt) / MS_PER_MIN,
      ),
    });
  }
  perEntrant.sort((a, b) => a.entrantId.localeCompare(b.entrantId));
  const worst = [...perEntrant]
    .filter((r) => r.maxGapMinutes !== null)
    .sort((a, b) => (b.maxGapMinutes ?? 0) - (a.maxGapMinutes ?? 0))
    .slice(0, 5);
  return { perEntrant, worst };
}
