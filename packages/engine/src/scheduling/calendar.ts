// Calendar slotting — spec 05 §2.6, doc 12 (scheduling UX). A pure constraint
// pass mapping generated fixtures → (time, court): greedy round-order assignment
// honouring court occupancy, per-entrant rest and blackout windows, reporting
// every conflict rather than silently dropping a constraint. Cross-division
// aware (doc 06 §4.3): it accepts sibling divisions' assignments as fixed court
// occupancy and warns on per-person overlaps. No wall-clock reads — all times
// are injected (the same unit throughout, e.g. epoch ms); durations are minutes.
import type { EntrantId } from "../core/types.ts";

const MS_PER_MIN = 60_000;

export interface Blackout {
  court?: string; // court-scoped window; omit for a global blackout
  from: number;
  to: number; // exclusive
}

export interface SlotConfig {
  startAt: number; // earliest slot (injected)
  matchMinutes: number;
  gapMinutes: number; // minimum gap between two matches on the same court
  courts: string[]; // court/venue labels, tried in order
  perEntrantMinRest: number; // minutes an entrant must rest between its matches
  blackouts?: readonly Blackout[];
  horizonMinutes?: number; // how far past startAt to search before reporting no_slot
}

export interface SchedulableFixture {
  id: string;
  roundNo?: number; // scheduled in ascending round order (feed dependencies respected)
  home?: EntrantId; // may be a TBD feed (undefined) — then no rest/overlap checks apply
  away?: EntrantId;
  people?: readonly string[]; // person ids, for cross-division overlap (doc 06 §4.3)
  locked?: { court: string; startAt: number }; // pinned assignment — honoured as-is
}

export interface Assignment {
  fixtureId: string;
  court: string;
  startAt: number;
  endAt: number;
  entrants: EntrantId[];
  people: string[];
}

export type ConflictReason =
  | "no_slot" // no court/time within the horizon satisfies the hard constraints
  | "court" // two matches share a court+time (blocks — physically impossible)
  | "rest" // an entrant is below perEntrantMinRest (warn)
  | "blackout" // inside a blackout window (warn)
  | "person_overlap"; // a person plays in two overlapping matches (warn — doc 06 §4.3)

export interface Conflict {
  fixtureId: string;
  reason: ConflictReason;
  detail?: string;
}

export interface SlotInput {
  fixtures: readonly SchedulableFixture[];
  config: SlotConfig;
  existing?: readonly Assignment[]; // sibling divisions' assignments (cross-division)
}

export interface SlotResult {
  assignments: Assignment[];
  conflicts: Conflict[];
}

const entrantsOf = (f: SchedulableFixture): EntrantId[] =>
  [f.home, f.away].filter((e): e is EntrantId => e !== undefined);

const overlaps = (aStart: number, aEnd: number, bStart: number, bEnd: number): boolean =>
  aStart < bEnd && bStart < aEnd;

// Does [start, start+dur) clash with a court booking (respecting `gap` on both
// sides) or a blackout window on `court`?
function courtBlocked(
  court: string,
  start: number,
  durMs: number,
  gapMs: number,
  bookings: readonly Assignment[],
  blackouts: readonly Blackout[],
): "court" | "blackout" | null {
  const end = start + durMs;
  for (const b of bookings) {
    if (b.court !== court) continue;
    // Require a full gap between neighbouring matches on the same court.
    if (overlaps(start, end + gapMs, b.startAt, b.endAt + gapMs)) return "court";
  }
  for (const bo of blackouts) {
    if (bo.court !== undefined && bo.court !== court) continue;
    if (overlaps(start, end, bo.from, bo.to)) return "blackout";
  }
  return null;
}

// Earliest start ≥ lowerBound on `court` that is neither court-blocked nor in a
// blackout, or null if none exists before `horizon`. Candidate starts are the
// lower bound plus the trailing edge of every booking/blackout that could push
// the fixture later — the standard interval-gap scan.
function earliestOnCourt(
  court: string,
  lowerBound: number,
  durMs: number,
  gapMs: number,
  horizon: number,
  bookings: readonly Assignment[],
  blackouts: readonly Blackout[],
): number | null {
  const candidates = [lowerBound];
  for (const b of bookings) if (b.court === court) candidates.push(b.endAt + gapMs);
  for (const bo of blackouts) if (bo.court === undefined || bo.court === court) candidates.push(bo.to);
  candidates.sort((a, b) => a - b);
  for (const start of candidates) {
    if (start < lowerBound || start > horizon) continue;
    if (courtBlocked(court, start, durMs, gapMs, bookings, blackouts) === null) return start;
  }
  return null;
}

// Greedy auto-schedule. Fixtures are placed in (roundNo, id) order; locked
// fixtures keep their pinned slot (and report a `court` clash if they collide);
// the rest take the earliest feasible (court, time). Nothing is placed in
// violation of a hard constraint — an unplaceable fixture is reported `no_slot`.
export function slotFixtures(input: SlotInput): SlotResult {
  const { config } = input;
  const durMs = config.matchMinutes * MS_PER_MIN;
  const gapMs = config.gapMinutes * MS_PER_MIN;
  const restMs = config.perEntrantMinRest * MS_PER_MIN;
  const horizon = config.startAt + (config.horizonMinutes ?? 365 * 24 * 60) * MS_PER_MIN;
  const blackouts = config.blackouts ?? [];

  const bookings: Assignment[] = [...(input.existing ?? [])]; // court occupancy (incl. siblings)
  const placed: Assignment[] = [];
  const conflicts: Conflict[] = [];
  const lastEnd = new Map<EntrantId, number>(); // this division's per-entrant rest tracking

  const ordered = [...input.fixtures].sort((a, b) => {
    const ra = a.roundNo ?? 0;
    const rb = b.roundNo ?? 0;
    if (ra !== rb) return ra - rb;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  const locked = ordered.filter((f) => f.locked !== undefined);
  const free = ordered.filter((f) => f.locked === undefined);

  const commit = (f: SchedulableFixture, court: string, start: number): Assignment => {
    const ent = entrantsOf(f);
    const assignment: Assignment = {
      fixtureId: f.id,
      court,
      startAt: start,
      endAt: start + durMs,
      entrants: ent,
      people: [...(f.people ?? [])],
    };
    bookings.push(assignment);
    placed.push(assignment);
    for (const e of ent) lastEnd.set(e, Math.max(lastEnd.get(e) ?? -Infinity, assignment.endAt));
    // Per-person overlap against everything already on the board (warn only).
    for (const person of assignment.people) {
      for (const other of bookings) {
        if (other === assignment) continue;
        if (!other.people.includes(person)) continue;
        if (overlaps(assignment.startAt, assignment.endAt, other.startAt, other.endAt)) {
          conflicts.push({
            fixtureId: f.id,
            reason: "person_overlap",
            detail: `person ${person} also in ${other.fixtureId}`,
          });
        }
      }
    }
    return assignment;
  };

  // 1) Locked fixtures — honour the pin; report (don't fix) a court collision.
  for (const f of locked) {
    const lock = f.locked as { court: string; startAt: number };
    const clash = courtBlocked(lock.court, lock.startAt, durMs, gapMs, bookings, blackouts);
    if (clash !== null) {
      conflicts.push({ fixtureId: f.id, reason: clash, detail: `locked slot clashes on ${lock.court}` });
    }
    commit(f, lock.court, lock.startAt);
  }

  // 2) Greedy placement of the rest.
  for (const f of free) {
    const ent = entrantsOf(f);
    let ready = config.startAt;
    for (const e of ent) ready = Math.max(ready, (lastEnd.get(e) ?? -Infinity) + restMs);

    let best: { court: string; start: number } | null = null;
    for (const court of config.courts) {
      const start = earliestOnCourt(court, ready, durMs, gapMs, horizon, bookings, blackouts);
      if (start === null) continue;
      if (best === null || start < best.start) best = { court, start };
    }

    if (best === null) {
      conflicts.push({ fixtureId: f.id, reason: "no_slot", detail: "no court/time within horizon" });
      continue;
    }
    commit(f, best.court, best.start);
  }

  return { assignments: placed, conflicts };
}

// Full conflict report over a fixed board (the drag-and-drop validate pass, doc
// 12 §2/§4): court double-bookings (block), rest and blackout violations, and
// per-person overlaps (warn). Pure — the same inputs always give the same report.
export function validateAssignments(
  assignments: readonly Assignment[],
  config: Pick<SlotConfig, "perEntrantMinRest" | "gapMinutes" | "blackouts">,
  existing: readonly Assignment[] = [],
): Conflict[] {
  const restMs = config.perEntrantMinRest * MS_PER_MIN;
  const gapMs = config.gapMinutes * MS_PER_MIN;
  const blackouts = config.blackouts ?? [];
  const conflicts: Conflict[] = [];
  const board = [...existing, ...assignments];

  for (const a of assignments) {
    // Court clash / blackout — check against everything else on the board.
    const others = board.filter((o) => o !== a);
    if (courtBlocked(a.court, a.startAt, a.endAt - a.startAt, gapMs, others, blackouts) === "court") {
      conflicts.push({ fixtureId: a.fixtureId, reason: "court", detail: `court ${a.court} double-booked` });
    }
    for (const bo of blackouts) {
      if (bo.court !== undefined && bo.court !== a.court) continue;
      if (overlaps(a.startAt, a.endAt, bo.from, bo.to)) {
        conflicts.push({ fixtureId: a.fixtureId, reason: "blackout", detail: "inside a blackout window" });
        break;
      }
    }
    // Rest & person overlap — against other matches sharing an entrant/person.
    for (const other of board) {
      if (other === a) continue;
      for (const e of a.entrants) {
        if (!other.entrants.includes(e)) continue;
        if (overlaps(a.startAt, a.endAt, other.startAt, other.endAt)) {
          conflicts.push({ fixtureId: a.fixtureId, reason: "person_overlap", detail: `entrant ${e} overlap` });
        } else {
          const gap = a.startAt >= other.endAt ? a.startAt - other.endAt : other.startAt - a.endAt;
          if (gap < restMs) {
            conflicts.push({ fixtureId: a.fixtureId, reason: "rest", detail: `entrant ${e} below rest` });
          }
        }
      }
      for (const p of a.people) {
        if (!other.people.includes(p)) continue;
        if (overlaps(a.startAt, a.endAt, other.startAt, other.endAt)) {
          conflicts.push({ fixtureId: a.fixtureId, reason: "person_overlap", detail: `person ${p} overlap` });
        }
      }
    }
  }
  return conflicts;
}
