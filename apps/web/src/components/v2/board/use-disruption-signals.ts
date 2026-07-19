"use client";

// Client-derived repair signals (v4 Task 16). The board already holds every
// fixture and the schedule config, so it can tell — with zero server calls —
// when placed matches no longer fit the settings: a slot sitting inside a
// blackout, a court that was removed from the config, a match scheduled outside
// every session window, or a postponed match still holding a slot. That's the
// signal the amber repair banner surfaces, and the scope it deep-links into the
// AI console's repair mode with.
//
// `computeDisruptions` is pure and React-free so the reasons/scope math is
// unit-tested in isolation; `useDisruptionSignals` is the thin memo the board
// renders through.
import { useMemo } from "react";

export type DisruptionReason = "blackout" | "court_gone" | "outside_window" | "postponed";

/** The fixture fields the signal reads — a structural subset of BoardFixture, so
 *  the board passes its live fixtures straight in. */
export interface DisruptionFixtureInput {
  id: string;
  /** ISO string over the wire, Date straight from an RSC, null when in the tray. */
  scheduled_at: string | Date | null;
  court_label: string | null;
  status: string;
}

/** The config fields the signal reads — a structural subset of ScheduleConfig /
 *  BoardConfig (courts, blackouts, sessionWindows, matchMinutes). */
export interface DisruptionSettingsInput {
  courts: string[];
  blackouts: { court?: string; from: string; to: string }[];
  sessionWindows: { from: string; to: string }[];
  /** Match length; a fixture occupies [start, start + matchMinutes). Optional —
   *  a missing/zero length treats the slot as its start instant. */
  matchMinutes?: number;
}

export interface DisruptionResult {
  /** Distinct disrupted fixture ids, in board order. */
  fixtureIds: string[];
  /** Distinct reasons present, in a stable canonical order. */
  reasons: DisruptionReason[];
  /** The repair scope the console pre-arms with: the removed courts and the
   *  earliest disrupted slot. Fields are omitted when empty. */
  scope: { courts?: string[]; from?: string };
}

/**
 * Statuses that hold a slot yet remain re-schedulable. Mirrors the board's
 * `movable = status === "scheduled"` (lib/schedule-board / fixture-block), plus
 * `postponed`, which shouldn't be holding a slot at all. Every other status is
 * live or finished (in_play, decided, finalized, abandoned, forfeited,
 * cancelled) and is NEVER flagged — you don't reschedule a match that's already
 * been played or is underway.
 */
const FLAGGABLE_STATUS = new Set(["scheduled", "postponed"]);

/** Canonical reason order so the reasons array is deterministic for tests. */
const REASON_ORDER: readonly DisruptionReason[] = [
  "blackout",
  "court_gone",
  "outside_window",
  "postponed",
];

function toMs(v: string | Date): number {
  return v instanceof Date ? v.getTime() : new Date(v).getTime();
}

/** Half-open interval overlap. A zero-length slot at exactly `bFrom` still counts
 *  as inside the blackout (the second clause), matching "a fixture inside a
 *  blackout" even when no match length is supplied. */
function overlaps(startMs: number, endMs: number, bFrom: number, bTo: number): boolean {
  return (startMs < bTo && endMs > bFrom) || (startMs >= bFrom && startMs < bTo);
}

/**
 * Derive the disruption signal from the board's own fixtures + config. Pure: no
 * React, no DB, no clock — everything is read off the two arguments so it is
 * unit-testable and cheap to memoize.
 */
export function computeDisruptions(
  fixtures: readonly DisruptionFixtureInput[],
  settings: DisruptionSettingsInput,
): DisruptionResult {
  const configuredCourts = new Set(settings.courts);
  const windows = settings.sessionWindows;
  const blackouts = settings.blackouts;
  const durMs = Math.max(0, settings.matchMinutes ?? 0) * 60_000;

  const fixtureIds: string[] = [];
  const seen = new Set<string>();
  const reasons = new Set<DisruptionReason>();
  const goneCourts = new Set<string>();
  let earliestMs: number | null = null;

  for (const f of fixtures) {
    // Live/finished fixtures are never flagged; a fixture with no slot (in the
    // tray) has nothing to be disrupted.
    if (!FLAGGABLE_STATUS.has(f.status) || f.scheduled_at === null) continue;
    const startMs = toMs(f.scheduled_at);
    if (Number.isNaN(startMs)) continue;
    const endMs = startMs + durMs;

    const hits: DisruptionReason[] = [];

    // Postponed but still occupying a slot it shouldn't.
    if (f.status === "postponed") hits.push("postponed");

    // Court removed from the config — the fixture points at a court that no
    // longer exists. That court seeds the repair scope.
    if (f.court_label !== null && !configuredCourts.has(f.court_label)) {
      hits.push("court_gone");
      goneCourts.add(f.court_label);
    }

    // Slot intersects a blackout — either a court-less one (applies everywhere)
    // or one scoped to this fixture's court.
    for (const b of blackouts) {
      if (b.court != null && b.court !== f.court_label) continue;
      const bFrom = toMs(b.from);
      const bTo = toMs(b.to);
      if (Number.isNaN(bFrom) || Number.isNaN(bTo)) continue;
      if (overlaps(startMs, endMs, bFrom, bTo)) {
        hits.push("blackout");
        break;
      }
    }

    // Outside every session window — only meaningful when windows are defined
    // (an empty windows list means "no window constraint", never a disruption).
    if (windows.length > 0) {
      const inSomeWindow = windows.some((w) => {
        const wFrom = toMs(w.from);
        const wTo = toMs(w.to);
        if (Number.isNaN(wFrom) || Number.isNaN(wTo)) return false;
        return startMs >= wFrom && startMs < wTo;
      });
      if (!inSomeWindow) hits.push("outside_window");
    }

    if (hits.length === 0) continue;

    if (!seen.has(f.id)) {
      seen.add(f.id);
      fixtureIds.push(f.id);
    }
    for (const r of hits) reasons.add(r);
    if (earliestMs === null || startMs < earliestMs) earliestMs = startMs;
  }

  const scope: { courts?: string[]; from?: string } = {};
  if (goneCourts.size > 0) scope.courts = [...goneCourts].sort();
  if (earliestMs !== null) scope.from = new Date(earliestMs).toISOString();

  return {
    fixtureIds,
    reasons: REASON_ORDER.filter((r) => reasons.has(r)),
    scope,
  };
}

/** Board-facing hook: memoize the pure signal over the live fixtures + config. */
export function useDisruptionSignals(
  fixtures: readonly DisruptionFixtureInput[],
  settings: DisruptionSettingsInput,
): DisruptionResult {
  return useMemo(() => computeDisruptions(fixtures, settings), [fixtures, settings]);
}
