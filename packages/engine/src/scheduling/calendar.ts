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
  const byGroup =
    (group?.poolId !== undefined ? c?.restByGroup?.[group.poolId] : undefined) ??
    (group?.divisionId !== undefined ? c?.restByGroup?.[group.divisionId] : undefined);
  if (byGroup !== undefined) minutes = Math.max(minutes, byGroup);
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

export interface Conflict {
  fixtureId: string;
  reason: ConflictReason;
  detail?: string;
  /** `order` only: true when the dependency is a direct feed (blocks, doc 12 §2). */
  direct?: boolean;
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
  const restForMs = (f: SchedulableFixture): number => effectiveRestMinutes(config, f) * MS_PER_MIN;

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

  return { assignments: placed, conflicts };
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

/** Does a scoped rule bind this assignment? `person` is the bridge that makes
 *  person-scoped rules expressible at all: `people` is participants (#396), so a
 *  rule about a human reaches the TBD slots they can still advance into. */
export function scopeCoversFixture(
  scope: ConstraintScope,
  f: RuleFixture | undefined,
  a: Assignment,
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

  // --- typed instruction rules (#398) -------------------------------------
  const hard = config.hard ?? [];
  const fixtureById = new Map((config.ruleFixtures ?? []).map((f) => [f.id, f]));

  /** The strictest rest that applies to a PAIR: this division's resolved value,
   *  the other division's own value, and any instruction rule covering EITHER
   *  side. A lower bound only — "at least N minutes" can raise a stored setting,
   *  never lower it. */
  const restFor = (a: Assignment, other: Assignment): number => {
    let minutes = effectiveRestMinutes(config, a);
    const otherDivision = other.divisionId;
    if (otherDivision !== undefined) {
      minutes = Math.max(minutes, config.restByDivision?.[otherDivision] ?? 0);
    }
    for (const h of hard) {
      if (h.type !== "min_rest_minutes" || h.rest_scope === "feeder_to_dependent") continue;
      const covers =
        scopeCoversFixture(h.scope, fixtureById.get(a.fixtureId), a) ||
        scopeCoversFixture(h.scope, fixtureById.get(other.fixtureId), other);
      if (covers) minutes = Math.max(minutes, h.minutes);
    }
    return minutes;
  };

  // startWindows (Jul3/04 §3) are a hard bound the solver refuses to place
  // outside — so the verifier has to know them too, or the same rule holds for
  // Auto-schedule and evaporates the moment somebody drags a card.
  const windowFor = (a: Assignment): { notBefore: number; notAfter: number } => {
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
  };

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
    const window = windowFor(a);
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
      conflicts.push({ fixtureId: a.fixtureId, reason: "court", detail: `court ${a.court} double-booked` });
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
          conflicts.push({ fixtureId: a.fixtureId, reason: "person_overlap", detail: `entrant ${e} overlap` });
        } else {
          // Resolved per PAIR: restByGroup can differ pool to pool, the other
          // division's own rest may be the binding one, and a compiled
          // instruction can raise both (#398).
          const restMs = restFor(a, other) * MS_PER_MIN;
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
            conflicts.push({ fixtureId: a.fixtureId, reason: "person_overlap", detail: `person ${p} overlap` });
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
          const restMs = restFor(a, other) * MS_PER_MIN;
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

  // Typed instruction rules (#398). Warn-only in this wave. Every rule here
  // needs a day boundary or a wall-clock time, so all of them need the org zone;
  // without one the whole block is SKIPPED rather than bucketed in UTC.
  const ruleFixtures = config.ruleFixtures ?? [];
  const placedById = new Map(assignments.map((a) => [a.fixtureId, a]));
  const tz = config.tz;
  if (tz !== undefined) {
    for (const h of hard) {
      // min_rest_minutes is folded into `restFor` above — it raises the rest
      // bound rather than producing a rule violation of its own, so a single
      // too-short gap is reported once as `rest`, not twice.
      if (h.type === "min_rest_minutes") continue;

      if (h.type === "max_fixtures_per_day") {
        const perDay = new Map<string, Assignment[]>();
        for (const a of assignments) {
          if (!scopeCoversFixture(h.scope, fixtureById.get(a.fixtureId), a)) continue;
          const key = dayKeyInTz(a.startAt, tz);
          const bucket = perDay.get(key);
          if (bucket === undefined) perDay.set(key, [a]);
          else bucket.push(a);
        }
        for (const [day, list] of perDay) {
          if (list.length <= h.count) continue;
          for (const a of list) {
            conflicts.push({
              fixtureId: a.fixtureId,
              reason: "instruction",
              detail: `${list.length} fixtures on ${day} exceed the ${h.count}/day cap`,
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

  // Feed order (doc 12 §2 warn.order): a fixture may not start before a
  // fixture that feeds it has finished. Direct feeds block; the API layer maps
  // `direct` to blocking. Dependencies whose source is not on the board are
  // fine — an unscheduled feeder constrains nothing yet.
  for (const dep of dependencies) {
    const target = byId.get(dep.fixtureId);
    const source = byId.get(dep.dependsOn);
    if (!target || !source) continue;
    if (target.startAt < source.endAt) {
      conflicts.push({
        fixtureId: dep.fixtureId,
        reason: "order",
        detail: `starts before feeder ${dep.dependsOn} ends`,
        direct: dep.direct === true,
      });
    }
  }
  return conflicts;
}
