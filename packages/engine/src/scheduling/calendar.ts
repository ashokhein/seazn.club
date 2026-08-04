// Calendar slotting — spec 05 §2.6, doc 12 (scheduling UX). A pure constraint
// pass mapping generated fixtures → (time, court): greedy round-order assignment
// honouring court occupancy, per-entrant rest and blackout windows, reporting
// every conflict rather than silently dropping a constraint. Cross-division
// aware (doc 06 §4.3): it accepts sibling divisions' assignments as fixed court
// occupancy and warns on per-person overlaps. No wall-clock reads — all times
// are injected (the same unit throughout, e.g. epoch ms); durations are minutes.
import type { EntrantId } from "../core/types.ts";
import type { ConstraintScope, FixtureSelector, HardConstraint, SchedulingConstraints } from "./constraints.ts";
import { dayKeyInTz, hhmmInTz, weekdayOfYmd } from "./tz.ts";

const MS_PER_MIN = 60_000;

export interface Blackout {
  court?: string; // court-scoped window; omit for a global blackout
  from: number;
  to: number; // exclusive
}

// A playable window (doc 12 §2): matches must sit fully inside one. The
// complement of the union of windows behaves as a global blackout.
export interface SessionWindow {
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
  sessionWindows?: readonly SessionWindow[]; // when set, matches only inside these
  /** The competition's resolved calendar window (#397). Absent means unbounded,
   *  which is every pre-W2 caller. `from` is inclusive; `to` is EXCLUSIVE — the
   *  instant the final day ends, so a match finishing exactly at midnight on
   *  that day is inside. Built from wall-clock day boundaries in ONE zone at
   *  the pack edge — never by adding 86_400_000, because a DST day is 23 or 25
   *  hours long. */
  window?: { from: number; to: number };
  horizonMinutes?: number; // how far past startAt to search before reporting no_slot
  /** Constraints v2 (Jul3/04 §3) — extends, never replaces, the base pass. */
  constraints?: SchedulingConstraints;
}

export interface SchedulableFixture {
  id: string;
  roundNo?: number; // scheduled in ascending round order (feed dependencies respected)
  home?: EntrantId; // may be a TBD feed (undefined) — then no rest/overlap checks apply
  away?: EntrantId;
  people?: readonly string[]; // person ids, for cross-division overlap (doc 06 §4.3)
  poolId?: string; // restByGroup / startWindows targeting (Jul3/04 §3)
  divisionId?: string;
  locked?: { court: string; startAt: number }; // pinned assignment — honoured as-is
}

export interface Assignment {
  fixtureId: string;
  court: string;
  startAt: number;
  endAt: number;
  entrants: EntrantId[];
  people: string[];
  poolId?: string; // restByGroup targeting when validating (Jul3/04 §3)
  divisionId?: string;
}

/** The rest an entrant owes between two matches, in minutes — the strictest of
 *  every source that can demand one:
 *
 *    perEntrantMinRest   the Settings tab ("the shape of the day")
 *    constraints.restMin the Constraints tab ("a rule about entrants")
 *    restByGroup         a per-pool / per-division override
 *    noBackToBack        at least one whole fixture in between
 *
 *  Exported because the placer and the verifier must answer this question
 *  identically. They used to disagree: `slotFixtures` took the max, the board's
 *  validation read only `perEntrantMinRest`, and the AI referee read only
 *  `constraints.restMin` — so whether a timetable was legal depended on which
 *  code path asked. */
export function effectiveRestMinutes(
  // matchMinutes is optional: validateAssignments is called with configs that
  // carry no match length (the board's own callers, and every pre-existing
  // caller), and noBackToBack is the only rule that needs it.
  config: Pick<SlotConfig, "perEntrantMinRest" | "gapMinutes" | "constraints"> &
    Partial<Pick<SlotConfig, "matchMinutes">>,
  group?: { poolId?: string; divisionId?: string },
): number {
  const c = config.constraints;
  let minutes = config.perEntrantMinRest;
  if (c?.restMin !== undefined) minutes = Math.max(minutes, c.restMin);
  // MAX, not precedence (#459, owner ruling 2026-08-04). A row can match both a
  // division-keyed and a pool-keyed entry; a pool entry RAISES the floor and
  // never lowers it, exactly like `restMin` and `noBackToBack` on the lines
  // either side of this one. Resolving with `??` instead made the pool entry
  // shadow the division one — and, because `0 ?? x` is `0`, an explicit pool
  // entry of zero ERASED a division rule rather than adding nothing.
  //
  // Nothing in the UI presents a pool rest as an override of its division, so
  // "most specific wins" would have been a semantics no surface teaches.
  for (const key of [group?.poolId, group?.divisionId]) {
    const v = key !== undefined ? c?.restByGroup?.[key] : undefined;
    if (v !== undefined) minutes = Math.max(minutes, v);
  }
  // "One fixture between" is only meaningful once we know how long a fixture
  // is; callers that validate without a match length simply don't get it.
  if (c?.noBackToBack && config.matchMinutes !== undefined) {
    minutes = Math.max(minutes, config.matchMinutes + config.gapMinutes);
  }
  return minutes;
}

export type ConflictReason =
  | "no_slot" // no court/time within the horizon satisfies the hard constraints
  | "court" // two matches share a court+time (blocks — physically impossible)
  | "rest" // an entrant is below perEntrantMinRest (warn)
  | "blackout" // inside a blackout window / outside every session window (warn)
  | "person_overlap" // a person plays in two overlapping matches (warn — doc 06 §4.3)
  | "start_window" // Jul3/04 §3: no feasible slot inside the target's window (hard)
  | "window" // outside the pack's resolved calendar window (#397 — warn; W4 blocks)
  // A rule compiled from the organiser's own instruction, or a durable division
  // rule in the same vocabulary (#398). Warn-only here: `isBlocking` still
  // covers `court` and direct `order` alone, and W4 (#399) is what turns this
  // into a delta-based block and gives it rule code H8.
  | "instruction"
  | "order"; // scheduled before a fixture that feeds it (doc 12 §2; blocks when direct)

/** The rule vocabulary the scheduling prompts teach (H1–H8), so a repair round
 *  is handed the token it was taught rather than a word of our own. `CAP` is not
 *  a rule: when demand exceeds capacity no single rule is broken — the schedule
 *  simply cannot exist — so `no_slot` and unschedulable rows carry it instead of
 *  a code that would misdirect the repair (#399, design §4.1). */
export type RuleCode = "H2" | "H3" | "H4" | "H5" | "H6" | "H8" | "CAP";

/** Fixed and exhaustive, defined once beside the union rather than at each call
 *  site — the `Record<ConflictReason, …>` key type is what keeps a new reason
 *  from shipping code-less. */
export const RULE_BY_REASON: Record<ConflictReason, RuleCode> = {
  court: "H2",
  blackout: "H3",
  window: "H3",
  rest: "H4",
  person_overlap: "H4",
  start_window: "H5",
  order: "H6",
  instruction: "H8",
  no_slot: "CAP",
};

export interface Conflict {
  fixtureId: string;
  reason: ConflictReason;
  detail?: string;
  /** `order` only: true when the dependency is a direct feed (blocks, doc 12 §2). */
  direct?: boolean;
  /** The rule the prompt taught for this reason (#399). Stamped at one choke
   *  point per producer, never at the push site. */
  rule?: RuleCode;
  /** How far a MEASURED breach falls short, in minutes (#399). Deliberately not
   *  part of `conflictKey`, and the reason is the delta: a card dragged from 30
   *  minutes short to 10 minutes short is repairing the board, and a key that
   *  moved with the number would report that repair as a new conflict and
   *  refuse it. The size travels beside the key instead, so `deltaConflicts` can
   *  tell "worse" from "better" without either being a different conflict. */
  shortfallMinutes?: number;
}

/** Stamped where a producer RETURNS, not where it pushes: a new
 *  `conflicts.push` would otherwise ship without a code and the repair round
 *  would quietly fall back to interpreting prose. */
const withRule = (c: Conflict): Conflict => ({ ...c, rule: RULE_BY_REASON[c.reason] });

/** Stable conflict identity — the key `verifyJoint`'s dedupe and the joint apply
 *  gate already use. `detail` is deliberately part of it: a worse breach writes a
 *  different detail string, so "worsened" needs no second comparison. */
export const conflictKey = (c: Conflict): string => `${c.fixtureId}|${c.reason}|${c.detail ?? ""}`;

/**
 * A conflict that makes the schedule PHYSICALLY IMPOSSIBLE, as opposed to
 * uncomfortable: a court booked twice, a human on two courts at once, a fixture
 * outside the days the competition runs, or one placed before the match that
 * feeds it has finished.
 *
 * Lives here, beside the reasons, because the AI pipeline and the board's
 * persistence gates must answer this identically — "two vocabularies" (#399 gap
 * 5) is exactly what happens when they each keep a copy. Below-minimum rest is
 * deliberately NOT here: uncomfortable is not impossible, and organisers
 * legitimately override it.
 *
 * ABSOLUTE. Whether a change may be WRITTEN is this answer filtered through
 * `deltaConflicts` at the gate, so a dirty board stays editable.
 */
export function isBlockingConflict(c: Conflict): boolean {
  return (
    c.reason === "court" ||
    c.reason === "person_overlap" ||
    c.reason === "window" ||
    (c.reason === "order" && c.direct === true)
  );
}

/**
 * The conflicts a change INTRODUCED OR WORSENED — a multiset difference, not a
 * set one. Two instances of a key after and one before means the change added a
 * second, and one instance is returned.
 *
 * This is what keeps a dirty board editable (#399). Boards published before this
 * wave may carry person overlaps, because those were warnings all along. Under
 * an absolute rule the organiser's next edit to such a board would 409 and they
 * would be stuck — unable to fix anything precisely because it is already wrong.
 */
export function deltaConflicts(
  before: readonly Conflict[],
  after: readonly Conflict[],
): Conflict[] {
  const budget = new Map<string, number>();
  /** The worst instance of each key beforehand, for the measured reasons. */
  const worstBefore = new Map<string, number>();
  for (const c of before) {
    const key = conflictKey(c);
    budget.set(key, (budget.get(key) ?? 0) + 1);
    if (c.shortfallMinutes !== undefined) {
      worstBefore.set(key, Math.max(worstBefore.get(key) ?? 0, c.shortfallMinutes));
    }
  }
  const out: Conflict[] = [];
  for (const c of after) {
    const key = conflictKey(c);
    const left = budget.get(key) ?? 0;
    if (left > 0) {
      budget.set(key, left - 1);
      // Matched an existing conflict — but a MEASURED one can still have got
      // worse without changing identity. A bigger shortfall is a worsening;
      // a smaller one is the organiser repairing the board and must never be
      // refused.
      if (c.shortfallMinutes !== undefined && c.shortfallMinutes > (worstBefore.get(key) ?? 0)) {
        out.push(c);
      }
      continue;
    }
    out.push(c);
  }
  return out;
}

/** Bracket dependency for order validation: `fixtureId` must not start before
 *  `dependsOn` ends. `direct` = winner/loser feed (blocks); otherwise warns. */
export interface OrderDependency {
  fixtureId: string;
  dependsOn: string;
  direct?: boolean;
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

// Session windows reduce to blackouts: the complement of their union over
// [lo, hi] is unplayable time. Keeps every downstream check (slotting,
// validation, candidate scan) window-aware without a second interval system.
function sessionGaps(
  windows: readonly SessionWindow[],
  lo: number,
  hi: number,
): Blackout[] {
  const merged = [...windows]
    .sort((a, b) => a.from - b.from)
    .reduce<SessionWindow[]>((acc, w) => {
      const last = acc[acc.length - 1];
      if (last && w.from <= last.to) last.to = Math.max(last.to, w.to);
      else acc.push({ ...w });
      return acc;
    }, []);
  const gaps: Blackout[] = [];
  let cursor = lo;
  for (const w of merged) {
    if (w.from > cursor) gaps.push({ from: cursor, to: w.from });
    cursor = Math.max(cursor, w.to);
  }
  if (cursor < hi) gaps.push({ from: cursor, to: hi });
  return gaps;
}

// Effective blackout list: configured blackouts plus session-window complement.
function effectiveBlackouts(
  config: Pick<SlotConfig, "blackouts" | "sessionWindows">,
  lo: number,
  hi: number,
): readonly Blackout[] {
  const blackouts = config.blackouts ?? [];
  if (!config.sessionWindows || config.sessionWindows.length === 0) return blackouts;
  return [...blackouts, ...sessionGaps(config.sessionWindows, lo, hi)];
}

/** Half-open overlap: touching intervals do NOT overlap, which is why a match
 *  may start at the exact instant the previous one ends. Exported (#401) so the
 *  solver's domain pruning agrees with the verifier about "touching". */
export function intervalsOverlap(aFrom: number, aTo: number, bFrom: number, bTo: number): boolean {
  return aFrom < bTo && bFrom < aTo;
}
const overlaps = intervalsOverlap;

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
  // Session-gap range must span every time the pass can touch, including
  // pinned slots outside [startAt, horizon].
  const pinned = input.fixtures
    .map((f) => f.locked?.startAt)
    .filter((t): t is number => t !== undefined);
  const lo = Math.min(config.startAt, ...pinned) - durMs;
  const hi = Math.max(horizon, ...pinned.map((t) => t + durMs)) + durMs;
  const blackouts = effectiveBlackouts(config, lo, hi);

  const bookings: Assignment[] = [...(input.existing ?? [])]; // court occupancy (incl. siblings)
  const siblings = input.existing ?? []; // other divisions' fixed board (parallelism=block)
  const placed: Assignment[] = [];
  const conflicts: Conflict[] = [];
  const lastEnd = new Map<EntrantId, number>(); // this division's per-entrant rest tracking
  const courtUse = new Map<EntrantId, Map<string, number>>(); // fieldFairness=balance
  const lastCourt = new Map<EntrantId, string>(); // fieldFairness=rotate
  const c = config.constraints;

  // Jul3/04 §3 — shared with validateAssignments so the placer and the verifier
  // can never drift apart on what "enough rest" means.
  //
  // #447: `effectiveRestMinutes` reads the settings/constraints family only, so
  // a durable `min_rest_minutes` rule raised the bound the VERIFIER used and not
  // the one the placer packed to. Auto then proposed a board the apply gate
  // warned about, and re-running auto could never fix it. `hardRestMinutesFor`
  // is the verifier's own fold, called here on the one row this pass is placing
  // — the same single-direction question `pairRestMinutes(config, movable,
  // immovable)` asks, and the strongest one the placer's per-entrant `lastEnd`
  // map can answer. Derived once: the rule list does not vary per fixture.
  const hard = effectiveHard(config);
  const scopeRowOf = (f: SchedulableFixture): ScopeRow => ({
    entrants: entrantsOf(f),
    people: [...(f.people ?? [])],
    ...(f.poolId !== undefined ? { poolId: f.poolId } : {}),
    ...(f.divisionId !== undefined ? { divisionId: f.divisionId } : {}),
  });
  const restForMs = (f: SchedulableFixture): number =>
    (hard.length === 0
      ? effectiveRestMinutes(config, f)
      : Math.max(
          effectiveRestMinutes(config, f),
          // No `RuleFixture` here on purpose: the placer holds none, and
          // `scopeCoversFixture` falls back to the row's own pool/division,
          // which is exactly what a `SchedulableFixture` carries.
          hardRestMinutesFor(hard, undefined, scopeRowOf(f)),
        )) * MS_PER_MIN;

  // startWindows (Jul3/04 §3): hard lower/upper bounds per entrant/pool/division.
  const windowFor = (f: SchedulableFixture): { notBefore: number; notAfter: number } => {
    let notBefore = -Infinity;
    let notAfter = Infinity;
    for (const w of c?.startWindows ?? []) {
      const hits =
        (w.target.kind === "entrant" && entrantsOf(f).includes(w.target.id)) ||
        (w.target.kind === "pool" && f.poolId === w.target.id) ||
        (w.target.kind === "division" && f.divisionId === w.target.id);
      if (!hits) continue;
      if (w.notBefore !== undefined) notBefore = Math.max(notBefore, w.notBefore);
      if (w.notAfter !== undefined) notAfter = Math.min(notAfter, w.notAfter);
    }
    return { notBefore, notAfter };
  };

  // crossPersonClash=hard (Jul3/04 §2): a person double-booking rejects the
  // placement like a court clash instead of warning after the fact.
  const personBlocked = (f: SchedulableFixture, start: number): Assignment | null => {
    if (c?.crossPersonClash !== "hard") return null;
    const people = f.people ?? [];
    if (people.length === 0) return null;
    const end = start + durMs;
    for (const b of bookings) {
      if (!b.people.some((p) => people.includes(p))) continue;
      if (overlaps(start, end, b.startAt, b.endAt)) return b;
    }
    return null;
  };

  // parallelism=block (29 May): the division gets exclusive time slots — a
  // candidate overlapping any sibling assignment is rejected.
  const blockModeBlocked = (start: number): Assignment | null => {
    if (c?.parallelism !== "block") return null;
    const end = start + durMs;
    for (const b of siblings) {
      if (overlaps(start, end, b.startAt, b.endAt)) return b;
    }
    return null;
  };

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
    for (const e of ent) {
      const m = courtUse.get(e) ?? new Map<string, number>();
      m.set(court, (m.get(court) ?? 0) + 1);
      courtUse.set(e, m);
      lastCourt.set(e, court);
    }
    const assignment: Assignment = {
      fixtureId: f.id,
      court,
      startAt: start,
      endAt: start + durMs,
      entrants: ent,
      people: [...(f.people ?? [])],
      // Carried through, not dropped (#446). `windowFor`/`restForMs` above read
      // the fixture's pool and division to honour a pool- or division-targeted
      // `startWindow`/`restByGroup`; `validateAssignments` reads the SAME two
      // fields off the Assignment. Emitting a placement that has lost them means
      // feeding the placer's own output back to the verifier flips the verdict —
      // the placer/verifier fork this module exists to prevent.
      ...(f.poolId !== undefined ? { poolId: f.poolId } : {}),
      ...(f.divisionId !== undefined ? { divisionId: f.divisionId } : {}),
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

  // 2) Greedy placement of the rest (with the v2 hard constraints as
  // placement rejections + repair-by-shifting, Jul3/04 §3).
  for (const f of free) {
    const ent = entrantsOf(f);
    const restF = Math.max(restMs, restForMs(f));
    const window = windowFor(f);
    let ready = Math.max(config.startAt, window.notBefore);
    for (const e of ent) ready = Math.max(ready, (lastEnd.get(e) ?? -Infinity) + restF);

    let best: { court: string; start: number } | null = null;
    let windowBound = false;
    for (const court of config.courts) {
      // repair loop: person-clash / block-parallelism rejections push the
      // candidate later on the same court instead of silently placing
      let lb = ready;
      let start: number | null = null;
      for (let i = 0; i < 64; i++) {
        start = earliestOnCourt(court, lb, durMs, gapMs, horizon, bookings, blackouts);
        if (start === null) break;
        const clash = personBlocked(f, start) ?? blockModeBlocked(start);
        if (clash === null) break;
        lb = Math.max(clash.endAt, start + 1);
        start = null;
      }
      if (start === null) continue;
      if (start > window.notAfter) {
        windowBound = true;
        continue;
      }
      if (best === null || start < best.start) best = { court, start };
      else if (start === best.start && c?.fieldFairness !== undefined && c.fieldFairness !== "off") {
        // soft objective (Jul3/04 §3): among equal-time candidates prefer the
        // fairer court — fewest prior uses (balance) or a different court
        // than last time (rotate)
        const usage = (courtLabel: string) =>
          ent.reduce((n, e) => n + (courtUse.get(e)?.get(courtLabel) ?? 0), 0);
        const rotated = (courtLabel: string) =>
          ent.some((e) => lastCourt.get(e) === courtLabel) ? 1 : 0;
        const better =
          c.fieldFairness === "balance"
            ? usage(court) < usage(best.court)
            : rotated(court) < rotated(best.court);
        if (better) best = { court, start };
      }
    }

    if (best === null) {
      // over-constrained: best-effort + a named binding constraint (Jul3/04 §7)
      conflicts.push({
        fixtureId: f.id,
        reason: windowBound ? "start_window" : "no_slot",
        detail: windowBound
          ? "no feasible slot before the start window's notAfter bound"
          : "no court/time within horizon",
      });
      continue;
    }
    commit(f, best.court, best.start);
  }

  return { assignments: placed, conflicts: conflicts.map(withRule) };
}

// Full conflict report over a fixed board (the drag-and-drop validate pass, doc
// 12 §2/§4): court double-bookings (block), rest / blackout / session-window
// violations, per-person overlaps, and feed-order violations against the given
// bracket dependencies (block when direct). Pure — the same inputs always give
// the same report.
/** The fixture metadata a typed rule needs and an `Assignment` does not carry:
 *  which fixture is terminal, and what its stable external key is. Supplied by
 *  the pack, never re-derived here — `winnerTo === null` is the ONLY definition
 *  of terminal. Round numbers are display labels and elimination brackets number
 *  sparsely, so nothing below may reason from one. */
export interface RuleFixture {
  id: string;
  extKey: string | null;
  divisionId?: string;
  poolId?: string;
  winnerTo: string | null;
}

/** Everything `validateAssignments` reads. Named (#398) because three call sites
 *  build it — `verifyConfig`, `verifyConfigFor` and the apply path — and a bare
 *  structural type in the signature gives none of them a name to annotate. */
export type VerifyConfig = Pick<
  SlotConfig,
  "perEntrantMinRest" | "gapMinutes" | "blackouts" | "sessionWindows"
> &
  Partial<Pick<SlotConfig, "matchMinutes" | "constraints" | "window">> & {
    /** The ORG zone (#397). Day buckets, weekday targets and HH:mm bounds are
     *  meaningless without it, so a rule that needs one is SKIPPED when it is
     *  absent rather than silently bucketed in UTC — reporting a violation the
     *  organiser never expressed is worse than reporting none. */
    tz?: string;
    /** Compiled instruction rules plus durable division rules, ONE merged
     *  stream, so hard rules have exactly one home (design §4.1). */
    hard?: readonly HardConstraint[];
    ruleFixtures?: readonly RuleFixture[];
    /** Every division's own `perEntrantMinRest`, keyed by division id, so a
     *  cross-division pair is rested at the MAX of both rather than at whichever
     *  pass happened to see it. Our joint verifier runs one pass per division
     *  with that division's own config, so without this a shared human is
     *  checked twice at two different values instead of once at the maximum —
     *  and their recovery does not care which bracket they are in (design §7.2). */
    restByDivision?: Readonly<Record<string, number>>;
  };

/** Exactly the fields `scopeCoversFixture` reads. Named (#447) so the PLACER can
 *  ask the same question the verifier does: `slotFixtures` holds
 *  `SchedulableFixture`s, which carry the same four facts under `home`/`away`
 *  rather than `entrants`, and an `Assignment` it has not built yet is not
 *  available to it. Widening the parameter rather than duplicating the switch is
 *  what keeps one definition of "does this rule bind this row". */
export type ScopeRow = Pick<Assignment, "entrants" | "people" | "poolId" | "divisionId">;

/** Does a scoped rule bind this assignment? `person` is the bridge that makes
 *  person-scoped rules expressible at all: `people` is participants (#396), so a
 *  rule about a human reaches the TBD slots they can still advance into. */
export function scopeCoversFixture(
  scope: ConstraintScope,
  f: RuleFixture | undefined,
  a: ScopeRow,
): boolean {
  switch (scope.kind) {
    case "competition":
      return true;
    case "division":
      return (f?.divisionId ?? a.divisionId) === scope.divisionId;
    case "pool":
      return (f?.divisionId ?? a.divisionId) === scope.divisionId && (f?.poolId ?? a.poolId) === scope.pool;
    case "entrant":
      return a.entrants.includes(scope.entrantId);
    case "person":
      return a.people.includes(scope.personKey);
  }
}

/** Which fixtures a selector names. `terminal` is `winnerTo === null`, resolved
 *  per division in scope — never a round number, never a naming convention. An
 *  unqualified terminal target therefore covers EVERY division's final. */
export function resolveSelector(
  sel: FixtureSelector,
  scope: ConstraintScope,
  fixtures: readonly RuleFixture[],
): RuleFixture[] {
  switch (sel.kind) {
    case "terminal": {
      const divisionId = scope.kind === "division" || scope.kind === "pool" ? scope.divisionId : null;
      return fixtures.filter((f) => f.winnerTo === null && (divisionId === null || f.divisionId === divisionId));
    }
    case "ext_key":
      return fixtures.filter(
        (f) => f.extKey === sel.extKey && (sel.divisionId === undefined || f.divisionId === sel.divisionId),
      );
    case "id":
      return fixtures.filter((f) => f.id === sel.fixtureId);
  }
}

/**
 * The typed rules compiled from the organiser's instruction (#398), evaluated
 * over the assignments given.
 *
 * Separate from `validateAssignments` because SCOPE AND PASS ARE DIFFERENT
 * THINGS. `verifyJoint` runs one `validateAssignments` pass per division with
 * that division's own config, but a competition-scoped rule — "two matches per
 * day" — is a statement about the WHOLE board. Counted inside a per-division
 * pass it sees only that division's fixtures, so three fixtures split 2/1 across
 * two divisions would satisfy a 2/day cap that the competition plainly breaks.
 * The joint verifier therefore calls this ONCE over every assignment and hands
 * its per-division passes only the `min_rest_minutes` entries, which are the
 * ones resolved pairwise rather than counted.
 *
 * `min_rest_minutes` is deliberately not reported here: it RAISES the rest bound
 * inside `validateAssignments` instead, so one too-short gap is reported once as
 * `rest` and not twice.
 */
/** The typed rules in force, from BOTH homes: the ones a run compiled from the
 *  organiser's instruction (`hard`) and the ones stored durably on the division
 *  (`constraints.hard`, written through the API). A rule that binds on one entry
 *  point and not the other is the worst kind — the board shows it enforced on
 *  Monday and silently not on Tuesday.
 *
 *  Exported for the repair solver (#401): the solver reads the SAME merged
 *  stream the verifier does, because a solver with its own idea of which rules
 *  are in force can produce a "repaired" board the verifier rejects. */
export function effectiveHard(config: Pick<VerifyConfig, "hard" | "constraints">): readonly HardConstraint[] {
  const stored = config.constraints?.hard ?? [];
  const compiled = config.hard ?? [];
  if (stored.length === 0) return compiled;
  if (compiled.length === 0) return stored;
  return [...compiled, ...stored];
}

/** The rest, in minutes, that the typed rules demand of ONE row.
 *
 *  THE PLACER AND THE VERIFIER MUST BOTH READ THIS (#447). `min_rest_minutes`
 *  with `rest_scope: "per_person"` is deliberately absent from
 *  `validateInstructionRules` — it is folded into the rest bound instead, so one
 *  too-short gap is reported once as `rest` and not twice. That fold used to
 *  live only in `pairRestMinutesWith`, i.e. only in the verifier, while
 *  `slotFixtures` resolved rest through `effectiveRestMinutes`, which never
 *  reads `hard`. So the auto pass proposed a board the apply gate immediately
 *  warned about and re-running auto could not fix it: the placer did not know
 *  the rule existed. That is a placer/verifier fork, the exact failure
 *  `calendar-shared-semantics.test.ts` exists to catch.
 *
 *  `feeder_to_dependent` is excluded because that half IS reported as its own
 *  `instruction` rule (it has no rest bound to hide inside); `both` is included,
 *  since it carries the per-person half too.
 *
 *  A lower bound only — every caller combines it with `Math.max`. "At least N
 *  minutes" may raise a stored setting, never lower it.
 *
 *  SCOPE OF THE PLACER HALF, so nobody reads more into it than is there: the
 *  placer keys `lastEnd` by `EntrantId`, so it applies this bound only to pairs
 *  that share an ENTRANT. A pair sharing a PERSON but no entrant — which is
 *  precisely what `validateAssignments` reports below — and any pair against
 *  `existing` (other divisions' cards, obstacles) are still placer-blind, so
 *  the auto pass can still propose a board the gate warns about for those.
 *  Tracked in #463; the verifier half has always covered both. */
export function hardRestMinutesFor(
  hard: readonly HardConstraint[],
  f: RuleFixture | undefined,
  row: ScopeRow,
): number {
  let minutes = 0;
  for (const h of hard) {
    if (h.type !== "min_rest_minutes" || h.rest_scope === "feeder_to_dependent") continue;
    if (scopeCoversFixture(h.scope, f, row)) minutes = Math.max(minutes, h.minutes);
  }
  return minutes;
}

export function validateInstructionRules(
  assignments: readonly Assignment[],
  config: Pick<VerifyConfig, "tz" | "hard" | "ruleFixtures" | "constraints">,
  /** The rest of the board: other divisions' cards, immovable fixtures, and
   *  obstacles. COUNTING rules (a per-day cap) have to see it — a 2/day cap is
   *  not satisfied by placing two more on a day that already holds three.
   *  PLACEMENT rules do not: this run is not being asked to move a fixture it
   *  does not own.
   *
   *  Only entries that are KNOWN FIXTURES (present in `ruleFixtures`) are
   *  counted. Callers pass obstacles in here too, and an outside booking or a
   *  court blackout is not a fixture — counting one under "how many fixtures run
   *  that day" would invent a cap breach out of a closed court. */
  existing: readonly Assignment[] = [],
): Conflict[] {
  const conflicts: Conflict[] = [];
  const hard = effectiveHard(config);
  const fixtureById = new Map((config.ruleFixtures ?? []).map((f) => [f.id, f]));
  // Typed instruction rules (#398). Warn-only in this wave. Every rule here
// needs a day boundary or a wall-clock time, so all of them need the org zone;
// without one the whole block is SKIPPED rather than bucketed in UTC.
const ruleFixtures = config.ruleFixtures ?? [];
const placedById = new Map(assignments.map((a) => [a.fixtureId, a]));
const tz = config.tz;
if (tz !== undefined) {
  for (const h of hard) {
    if (h.type === "min_rest_minutes") {
      // The per-person half is folded into `restFor` — it raises the rest bound
      // rather than producing a rule of its own, so one too-short gap is
      // reported once as `rest`, not twice. The feeder→dependent half has no
      // such home: `gapMinutes` is a court turnaround and the `order` check only
      // asks that a feeder has FINISHED. Left unenforced, "40 minutes before the
      // round it feeds" compiles, displays as a rule, and binds nothing.
      if (h.rest_scope === "per_person") continue;
      for (const f of ruleFixtures) {
        if (f.winnerTo === null) continue;
        const feeder = placedById.get(f.id);
        if (feeder === undefined) continue;
        // THE FEED EDGE IS A FIXTURE ID, NOT AN EXT KEY (#443). `winnerTo`
        // carries `fixtures.winner_to_fixture` — a uuid FK to `fixtures.id`.
        // `extKey` carries `fixtures.ext_key`, which is nullable text and lives
        // in a different namespace entirely; nothing converts one into the
        // other. This join used to compare them, so on every real payload it
        // matched ZERO pairs and the whole rule compiled, displayed as enforced,
        // and bound nothing.
        //
        // No division guard either. The old one existed only to disambiguate a
        // reused generator key like "SF1"; a uuid FK names exactly one fixture
        // row wherever it sits, so there is nothing left to disambiguate — and
        // keeping the guard would silently DROP a legitimate cross-division
        // feed, which is the same binds-nothing failure in a smaller costume.
        //
        // `repair.ts` carries this join verbatim: the solver may not hold an
        // opinion of its own about what a rule means (#401).
        {
          const d = fixtureById.get(f.winnerTo);
          if (d === undefined) continue;
          const dependent = placedById.get(d.id);
          if (dependent === undefined) continue;
          if (!scopeCoversFixture(h.scope, f, feeder) && !scopeCoversFixture(h.scope, d, dependent)) continue;
          // Only a dependent placed AFTER its feeder is measured here. One
          // placed before is an ordering violation, already reported as
          // `order` — a rest row on top of it teaches the repair round nothing.
          if (dependent.startAt < feeder.endAt) continue;
          const gapMin = (dependent.startAt - feeder.endAt) / MS_PER_MIN;
          if (gapMin < h.minutes) {
            conflicts.push({
              fixtureId: d.id,
              reason: "instruction",
              detail: `starts ${Math.round(gapMin)} min after its feeder, instruction requires ${h.minutes}`,
            });
          }
        }
      }
      continue;
    }

    if (h.type === "max_fixtures_per_day") {
      // Counted over the WHOLE board. A cap is a statement about how busy a day
      // is, and a day is exactly as busy as everything already on it.
      const perDay = new Map<string, { movable: Assignment[]; total: number }>();
      for (const a of [...existing.filter((e) => fixtureById.has(e.fixtureId)), ...assignments]) {
        if (!scopeCoversFixture(h.scope, fixtureById.get(a.fixtureId), a)) continue;
        const key = dayKeyInTz(a.startAt, tz);
        const bucket = perDay.get(key) ?? { movable: [], total: 0 };
        bucket.total++;
        if (placedById.has(a.fixtureId)) bucket.movable.push(a);
        perDay.set(key, bucket);
      }
      for (const [day, { movable, total }] of perDay) {
        if (total <= h.count) continue;
        // Reported on the cards this run can actually move. A day pushed over
        // by immovable fixtures alone yields no row — there is nothing here to
        // repair, and a conflict on a card nobody can drag is noise.
        for (const a of movable) {
          conflicts.push({
            fixtureId: a.fixtureId,
            reason: "instruction",
            detail: `${total} fixtures on ${day} exceed the ${h.count}/day cap`,
          });
        }
      }
      continue;
    }

    if (h.type === "fixture_on_weekday" || h.type === "fixture_on_date") {
      for (const f of resolveSelector(h.selector, h.scope, ruleFixtures)) {
        const a = placedById.get(f.id);
        // Absence is not a violation of THIS rule — an unplaced fixture is
        // reported by the no_slot / unschedulable path instead.
        if (a === undefined) continue;
        if (!scopeCoversFixture(h.scope, f, a)) continue;
        const day = dayKeyInTz(a.startAt, tz);
        if (h.type === "fixture_on_weekday" && weekdayOfYmd(day) !== h.weekday) {
          conflicts.push({
            fixtureId: f.id,
            reason: "instruction",
            detail: `is on ${weekdayOfYmd(day)} ${day}, instruction requires ${h.weekday}`,
          });
        }
        if (h.type === "fixture_on_date" && day !== h.date) {
          conflicts.push({
            fixtureId: f.id,
            reason: "instruction",
            detail: `is on ${day}, instruction requires ${h.date}`,
          });
        }
      }
      continue;
    }

    // not_before / not_after — wall-clock bounds on the START, in the org zone.
    for (const a of assignments) {
      if (!scopeCoversFixture(h.scope, fixtureById.get(a.fixtureId), a)) continue;
      const start = hhmmInTz(a.startAt, tz);
      const bad = h.type === "not_before" ? start < h.time : start > h.time;
      if (bad) {
        conflicts.push({
          fixtureId: a.fixtureId,
          reason: "instruction",
          detail: `starts ${start}, violating ${h.type} ${h.time}`,
        });
      }
    }
  }
}
  return conflicts.map(withRule);
}

/** `ruleFixtures` as an id lookup. Split out so a caller in a loop derives it
 *  ONCE — see `pairRestMinutesWith`. */
function ruleFixtureIndex(config: Pick<VerifyConfig, "ruleFixtures">): ReadonlyMap<string, RuleFixture> {
  return new Map((config.ruleFixtures ?? []).map((f) => [f.id, f]));
}

/** The strictest rest that applies to a PAIR — this division's resolved value,
 *  the other division's own value, and any instruction rule covering EITHER
 *  side. A lower bound only: "at least N minutes" can raise a stored setting,
 *  never lower it.
 *
 *  Module-scope and exported (#401) so the repair solver bounds a pair by the
 *  same number the verifier will judge it by.
 *
 *  NOTE for callers — WHAT A PAIR ACTUALLY OWES DEPENDS ON WHICH SIDES MOVE.
 *  `validateAssignments` iterates `for (const a of assignments)` over an inner
 *  `board = [...existing, ...assignments]`, so:
 *
 *    * movable vs movable (both in `assignments`) — the pair is evaluated in
 *      BOTH directions, once per assignment, and owes
 *      `max(pairRestMinutes(c,a,b), pairRestMinutes(c,b,a))`.
 *    * movable vs immovable (`other` came from `existing`) — the immovable side
 *      is never an outer `a`, so exactly ONE direction is ever evaluated:
 *      `pairRestMinutes(config, movable, immovable)`, that argument order.
 *
 *  The asymmetry is real, not a rounding detail: `effectiveRestMinutes` reads
 *  the FIRST argument's pool/division, so a per-pool `restByGroup` or a
 *  `min_rest_minutes` scoped to one side only makes the two directions differ.
 *
 *  Consequence for the repair solver: asserting the max against an immovable
 *  OVER-constrains — it refuses boards the verifier would pass and reports a
 *  spurious infeasible. Asserting the wrong single direction UNDER-constrains —
 *  the solver returns a "repaired" board that the verifier then rejects, which
 *  is the exact lock-out this wave exists to prevent. */
export function pairRestMinutes(config: VerifyConfig, a: Assignment, other: Assignment): number {
  // Thin wrapper for one-off callers (the solver asks pair by pair). Anything
  // iterating pairs must hoist and call `pairRestMinutesWith` directly.
  return pairRestMinutesWith(effectiveHard(config), ruleFixtureIndex(config), config, a, other);
}

/** `pairRestMinutes` bound to ONE config, with the two per-config derivations
 *  made once up front (#401).
 *
 *  The repair encoder walks the same O(n²) pair space `validateAssignments`
 *  does — 125k pairs at the 500-fixture cap — and the plain wrapper re-derives
 *  `effectiveHard` and the ruleFixtures index on every call, which cost this
 *  file 47 ms → 5242 ms before the hoist. Rather than let the solver grow its
 *  own copy of that loop's body, it takes this closure: one implementation
 *  (`pairRestMinutesWith`), three readers (the verifier, this factory, and the
 *  one-off wrapper above).
 *
 *  The asymmetry note on `pairRestMinutes` applies unchanged — this is the same
 *  answer, not a cheaper approximation of it. */
export function pairRestMinutesFor(
  config: VerifyConfig,
): (a: Assignment, other: Assignment) => number {
  const hard = effectiveHard(config);
  const fixtureById = ruleFixtureIndex(config);
  return (a, other) => pairRestMinutesWith(hard, fixtureById, config, a, other);
}

/** `pairRestMinutes` with the two per-CONFIG derivations lifted into parameters.
 *
 *  They do not vary with `a`/`other`, and this is called from an O(n²) loop, so
 *  deriving them inside made the per-config work quadratic as well: a
 *  500-fixture board with a board-wide shared person took 5242 ms instead of
 *  47 ms. A WeakMap memo keyed on `config` would also work, but the callers are
 *  a single hot loop and one explicit hoist beats a cache whose lifetime nobody
 *  can see. The exported signature is unchanged because the solver depends on
 *  it. */
function pairRestMinutesWith(
  hard: readonly HardConstraint[],
  fixtureById: ReadonlyMap<string, RuleFixture>,
  config: VerifyConfig,
  a: Assignment,
  other: Assignment,
): number {
  let minutes = effectiveRestMinutes(config, a);
  const otherDivision = other.divisionId;
  if (otherDivision !== undefined) {
    minutes = Math.max(minutes, config.restByDivision?.[otherDivision] ?? 0);
  }
  // THE HOT PATH. This runs once per PAIR — 125k times on the 500-fixture cap —
  // and the overwhelmingly common case is no typed rules at all. The old inline
  // `for (const h of hard)` did nothing when `hard` was empty; extracting the
  // body into a function turned that into two calls and two Map lookups per
  // pair, which put `repair-scale`'s budget bench over its 7000 ms line. Keep
  // the early return.
  if (hard.length === 0) return minutes;
  // A PAIR is covered when EITHER side is — the same disjunction this loop
  // always applied, now expressed as the max of the two per-row answers so the
  // placer can ask for one of them on its own (#447). `hardRestMinutesFor` is
  // the single definition; nothing here may grow a second copy of the scope
  // walk, which is how the placer and the verifier forked in the first place.
  return Math.max(
    minutes,
    hardRestMinutesFor(hard, fixtureById.get(a.fixtureId), a),
    hardRestMinutesFor(hard, fixtureById.get(other.fixtureId), other),
  );
}

/** The start bounds `startWindows` impose on an assignment. Exported (#401) so
 *  the repair domain clips to the same instants the verifier compares against —
 *  it bounds the START, not the occupancy.
 *
 *  startWindows (Jul3/04 §3) are a hard bound the solver refuses to place
 *  outside — so the verifier has to know them too, or the same rule holds for
 *  Auto-schedule and evaporates the moment somebody drags a card. */
export function startWindowFor(
  config: Pick<VerifyConfig, "constraints">,
  a: Assignment,
): { notBefore: number; notAfter: number } {
  let notBefore = -Infinity;
  let notAfter = Infinity;
  for (const w of config.constraints?.startWindows ?? []) {
    const hits =
      (w.target.kind === "entrant" && a.entrants.includes(w.target.id)) ||
      (w.target.kind === "pool" && a.poolId === w.target.id) ||
      (w.target.kind === "division" && a.divisionId === w.target.id);
    if (!hits) continue;
    if (w.notBefore !== undefined) notBefore = Math.max(notBefore, w.notBefore);
    if (w.notAfter !== undefined) notAfter = Math.min(notAfter, w.notAfter);
  }
  return { notBefore, notAfter };
}

export function validateAssignments(
  assignments: readonly Assignment[],
  config: VerifyConfig,
  existing: readonly Assignment[] = [],
  dependencies: readonly OrderDependency[] = [],
): Conflict[] {
  const gapMs = config.gapMinutes * MS_PER_MIN;
  const blackouts = config.blackouts ?? [];
  const windows = config.sessionWindows ?? [];
  const conflicts: Conflict[] = [];
  const board = [...existing, ...assignments];
  const byId = new Map(board.map((a) => [a.fixtureId, a]));

  // The typed rule stream (#398) and its fixture lookup, derived ONCE and
  // handed to `pairRestMinutesWith` in the O(n²) rest loop below — deriving
  // them per call cost 111× on a 500-fixture board.
  //
  // This function reads only the `min_rest_minutes` SUBSET of the typed rules,
  // and only to raise a pair's rest bound. Every other typed rule is evaluated
  // by `validateInstructionRules`, which derives its own copy.
  const hard = effectiveHard(config);
  const fixtureById = ruleFixtureIndex(config);

  for (const a of assignments) {
    // The pack window (#397): the whole occupancy must fall inside the days the
    // competition actually runs. Only `assignments` are bound — `existing` is
    // other divisions' board and outside bookings, which this run is not being
    // asked to move. Warn-only until W4 makes it delta-blocking (#399).
    const packWindow = config.window;
    if (packWindow !== undefined && (a.startAt < packWindow.from || a.endAt > packWindow.to)) {
      conflicts.push({
        fixtureId: a.fixtureId,
        reason: "window",
        detail: "outside the competition window",
      });
    }
    // Bounds the START, matching the solver's `start > window.notAfter`.
    const window = startWindowFor(config, a);
    if (a.startAt < window.notBefore || a.startAt > window.notAfter) {
      conflicts.push({
        fixtureId: a.fixtureId,
        reason: "start_window",
        detail: "outside the target's start window",
      });
    }
    // Court clash / blackout — check against everything else on the board.
    const others = board.filter((o) => o !== a);
    if (courtBlocked(a.court, a.startAt, a.endAt - a.startAt, gapMs, others, blackouts) === "court") {
      // ONE ROW PER COLLIDING FIXTURE, and the counterparty is part of the
      // identity rather than decoration (#399). Both halves are load-bearing for
      // the delta gate:
      //
      //   * naming the court alone made a SWAP invisible — a card already
      //     clashing with B, dragged onto C instead, keyed identically;
      //   * one row per CARD made an ADDED collision invisible — a card that
      //     keeps its clash with B and gains one with C still reports the single
      //     row it always did.
      //
      // Either way a brand-new double-booking wrote through as pre-existing, on
      // the one reason that blocked absolutely before this wave. `person_overlap`
      // has always reported per counterparty; `court` now matches it.
      const hits = others.filter(
        (o) =>
          o.court === a.court &&
          overlaps(a.startAt - gapMs, a.endAt + gapMs, o.startAt, o.endAt),
      );
      // `courtBlocked` said "court", so at least one exists; the fallback keeps
      // the reason reportable if the two predicates ever drift apart.
      for (const hit of hits.length > 0 ? hits.map((h) => h.fixtureId) : ["another fixture"]) {
        conflicts.push({
          fixtureId: a.fixtureId,
          reason: "court",
          detail: `court ${a.court} double-booked with ${hit}`,
        });
      }
    }
    for (const bo of blackouts) {
      if (bo.court !== undefined && bo.court !== a.court) continue;
      if (overlaps(a.startAt, a.endAt, bo.from, bo.to)) {
        conflicts.push({ fixtureId: a.fixtureId, reason: "blackout", detail: "inside a blackout window" });
        break;
      }
    }
    // Session windows: the match must sit fully inside one (doc 12 §2).
    if (windows.length > 0 && !windows.some((w) => a.startAt >= w.from && a.endAt <= w.to)) {
      conflicts.push({ fixtureId: a.fixtureId, reason: "blackout", detail: "outside session windows" });
    }
    // Rest & person overlap — against other matches sharing an entrant/person.
    for (const other of board) {
      if (other === a) continue;
      for (const e of a.entrants) {
        if (!other.entrants.includes(e)) continue;
        if (overlaps(a.startAt, a.endAt, other.startAt, other.endAt)) {
          conflicts.push({
            fixtureId: a.fixtureId,
            reason: "person_overlap",
            detail: `entrant ${e} overlap with ${other.fixtureId}`,
          });
        } else {
          // Resolved per PAIR: restByGroup can differ pool to pool, the other
          // division's own rest may be the binding one, and a compiled
          // instruction can raise both (#398).
          const restMs = pairRestMinutesWith(hard, fixtureById, config, a, other) * MS_PER_MIN;
          const gap = a.startAt >= other.endAt ? a.startAt - other.endAt : other.startAt - a.endAt;
          if (gap < restMs) {
            conflicts.push({ fixtureId: a.fixtureId, reason: "rest", detail: `entrant ${e} below rest` });
          }
        }
      }
      const sharedPeople = a.people.filter((p) => other.people.includes(p));
      if (sharedPeople.length > 0) {
        if (overlaps(a.startAt, a.endAt, other.startAt, other.endAt)) {
          for (const p of sharedPeople) {
            conflicts.push({
              fixtureId: a.fixtureId,
              reason: "person_overlap",
              detail: `person ${p} overlap with ${other.fixtureId}`,
            });
          }
        } else if (!a.entrants.some((e) => other.entrants.includes(e))) {
          // Rest between two fixtures sharing a PERSON but no entrant — the case
          // the entrant loop above cannot see, and the only one in which a
          // cross-division or TBD-slot pair is rested at all (#396 gave us the
          // participants; #398 is what makes rest read them). Skipped when the
          // pair also shares an entrant, so an entrant-sharing pair still
          // reports exactly the conflicts it did before. Reported ONCE for the
          // pair rather than once per shared person: a grand final shares seven
          // people with its feeders and seven identical rows teach the repair
          // round nothing.
          const restMs = pairRestMinutesWith(hard, fixtureById, config, a, other) * MS_PER_MIN;
          const gap = a.startAt >= other.endAt ? a.startAt - other.endAt : other.startAt - a.endAt;
          if (gap < restMs) {
            conflicts.push({
              fixtureId: a.fixtureId,
              reason: "rest",
              detail: `person ${sharedPeople.join("/")} below rest`,
            });
          }
        }
      }
    }
  }

  conflicts.push(...validateInstructionRules(assignments, config, existing));

  // Feed order (doc 12 §2 warn.order): a fixture may not start before a
  // fixture that feeds it has finished. Direct feeds block; the API layer maps
  // `direct` to blocking. Dependencies whose source is not on the board are
  // fine — an unscheduled feeder constrains nothing yet.
  for (const dep of dependencies) {
    const target = byId.get(dep.fixtureId);
    const source = byId.get(dep.dependsOn);
    if (!target || !source) continue;
    // The advancing player is a participant of the fixture they feed (#396), so
    // the dependent may not start at the feeder's final whistle — it may start
    // once the feeder's occupancy PLUS the rest that player is owed has passed
    // (#399 gap 7). `effectiveRestMinutes` is the same answer the placer and the
    // person checks give, so the three cannot disagree about what rest means.
    //
    // In the original payloads a 45-minute instruction happened to cover this by
    // luck. A rule should not depend on luck.
    const restMinutes = effectiveRestMinutes(config, target);
    if (target.startAt < source.endAt + restMinutes * MS_PER_MIN) {
      // Two distinct details on purpose. They are different failures, and the
      // delta gate keys on `detail`: one string for both would let a newly
      // introduced rest breach hide behind a pre-existing ordering violation.
      const before = target.startAt < source.endAt;
      const gapMin = (target.startAt - source.endAt) / MS_PER_MIN;
      conflicts.push({
        fixtureId: dep.fixtureId,
        reason: "order",
        // Two distinct details on purpose: they are different failures, and one
        // string for both would let a newly introduced rest breach hide behind
        // a pre-existing ordering violation.
        //
        // NEITHER carries the measured gap. `conflictKey` includes `detail`, so
        // a number in here would move the identity every time the card moved —
        // and dragging a dependent from 10 minutes short to 20 would read as a
        // NEW conflict and be refused, which is the exact lock-out this wave
        // exists to prevent. The size rides in `shortfallMinutes` instead.
        detail: before
          ? `starts before feeder ${dep.dependsOn} ends`
          : `starts inside feeder ${dep.dependsOn}'s ${restMinutes} min rest`,
        direct: dep.direct === true,
        shortfallMinutes: Math.max(0, Math.round(restMinutes - gapMin)),
      });
    }
  }
  return conflicts.map(withRule);
}
