// Pure helpers for the schedule board (doc 12 §2). Isomorphic — used by the
// server page (feed labels) and the client board (grid math); unit-testable
// without React or a DB.

export interface FeedRow {
  id: string;
  round_no: number;
  seq_in_round: number;
  winner_to_fixture: string | null;
  winner_to_slot: number | null;
  loser_to_fixture: string | null;
  loser_to_slot: number | null;
}

export interface FeedLabelPair {
  home?: string;
  away?: string;
}

/**
 * TBD card labels from the feed wiring: the fixture receiving a winner/loser
 * shows "Winner of R1 #2" / "Loser of …" on the fed slot (doc 12 §2 — cards
 * render feed labels until entrants resolve).
 */
export function feedLabels(rows: readonly FeedRow[]): Record<string, FeedLabelPair> {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const labels: Record<string, FeedLabelPair> = {};
  for (const source of rows) {
    for (const [target, slot, side] of [
      [source.winner_to_fixture, source.winner_to_slot, "Winner"],
      [source.loser_to_fixture, source.loser_to_slot, "Loser"],
    ] as const) {
      if (!target || !slot || !byId.has(target)) continue;
      const label = `${side} of R${source.round_no} #${source.seq_in_round}`;
      const pair = (labels[target] ??= {});
      if (slot === 1) pair.home = label;
      else pair.away = label;
    }
  }
  return labels;
}

/** Day key (YYYY-MM-DD, local) for grouping assignments into board days. */
export function dayKey(isoOrDate: string | Date): string {
  const d = new Date(isoOrDate);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Slot rows for a day grid: starts every `slotMinutes` from `fromMs` up to
 *  (and excluding) `toMs`. */
export function daySlots(fromMs: number, toMs: number, slotMinutes: number): number[] {
  const out: number[] = [];
  const step = Math.max(5, slotMinutes) * 60_000;
  for (let t = fromMs; t < toMs; t += step) out.push(t);
  return out;
}

export function toLocalInput(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
