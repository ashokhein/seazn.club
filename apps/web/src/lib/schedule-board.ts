// Pure helpers for the schedule board (doc 12 §2). Isomorphic — used by the
// server page (feed labels) and the client board (grid math); unit-testable
// without React or a DB.
import type { Conflict } from "@seazn/engine/scheduling";
import type { ScheduleConflict } from "@/server/api-v1/schemas";

// ---------------------------------------------------------------------------
// Conflict taxonomy (doc 12 §2) — engine verifier reason tokens → API conflict
// codes. The single source of truth for the mapping, lifted here (isomorphic,
// no server-only) so both sides share ONE table: usecases/schedule.ts maps
// drag-drop conflicts through it on the server, and the AI diff panel maps a
// blocking row's engine reason through it on the client to reach the shared
// `board.conflict.*` labels the conflicts panel already localizes (v4 Task 13).
// The Record key type keeps it exhaustive against the engine's reason union.
// ---------------------------------------------------------------------------
export const REASON_CODE: Record<Conflict["reason"], ScheduleConflict["code"]> = {
  court: "conflict.court",
  rest: "warn.rest",
  person_overlap: "warn.person_overlap",
  order: "warn.order",
  blackout: "warn.blackout",
  no_slot: "warn.no_slot",
  // Jul3/04 §3: an unsatisfiable start window is a hard bound, not a warning
  start_window: "conflict.start_window",
};

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

export function toLocalInput(iso: string | Date): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ---------------------------------------------------------------------------
// Daily play hours ⇄ session windows (PROMPT-33 follow-up). The engine takes
// ABSOLUTE {from,to} intervals; organisers think "we play 09:00–18:00". These
// two convert between the shapes so the settings panel can offer plain hours
// while the auto pass and validator keep their one interval system.
// ---------------------------------------------------------------------------

export interface IsoWindow {
  from: string;
  to: string;
}

const HHMM = /^(\d{2}):(\d{2})$/;

/** Cap on the expansion when the schedule has no end date — two weeks of
 *  windows is plenty for the auto pass's search horizon. */
const DEFAULT_SPAN_DAYS = 14;

/**
 * Expand daily play hours into one absolute window per day across the
 * schedule's date span (inclusive). Returns null when the hours don't parse
 * or are inverted/empty (from must be before to — overnight windows are out
 * of scope). Times are local wall-clock, matching every other input on the
 * settings panel.
 */
export function dailyHoursToWindows(
  fromHHMM: string,
  toHHMM: string,
  startIso: string,
  endIso?: string | null,
): IsoWindow[] | null {
  const from = HHMM.exec(fromHHMM);
  const to = HHMM.exec(toHHMM);
  if (!from || !to) return null;
  if (fromHHMM >= toHHMM) return null;
  const first = new Date(startIso);
  if (Number.isNaN(first.getTime())) return null;
  const last = endIso ? new Date(endIso) : null;
  const days =
    last && !Number.isNaN(last.getTime())
      ? Math.max(1, Math.round((dayStart(last) - dayStart(first)) / 86_400_000) + 1)
      : DEFAULT_SPAN_DAYS;
  const out: IsoWindow[] = [];
  for (let i = 0; i < Math.min(days, 90); i++) {
    const d = new Date(dayStart(first) + i * 86_400_000 + 12 * 3_600_000); // noon anchor dodges DST
    const at = (h: string, m: string) =>
      new Date(d.getFullYear(), d.getMonth(), d.getDate(), Number(h), Number(m)).toISOString();
    out.push({ from: at(from[1]!, from[2]!), to: at(to[1]!, to[2]!) });
  }
  return out;
}

function dayStart(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/**
 * The inverse, for prefilling the panel: when every window shares the same
 * local wall-clock from/to, report those hours; otherwise null (hand-built
 * windows from the constraints panel stay untouched).
 */
export function windowsToDailyHours(
  windows: readonly IsoWindow[],
): { from: string; to: string } | null {
  if (windows.length === 0) return null;
  const pad = (n: number) => String(n).padStart(2, "0");
  const hhmm = (iso: string) => {
    const d = new Date(iso);
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };
  const from = hhmm(windows[0]!.from);
  const to = hhmm(windows[0]!.to);
  for (const w of windows) {
    if (hhmm(w.from) !== from || hhmm(w.to) !== to) return null;
  }
  return { from, to };
}
