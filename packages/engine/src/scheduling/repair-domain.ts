// The z3-free half of repair (#401). Every calendar decision — which day a
// fixture may fall on, what "not before 18:00" means in the org zone, how long
// a DST day is — is made HERE, in TypeScript, against `tz.ts` and the rule
// semantics `calendar.ts` exports. z3 then sees nothing but integers.
//
// Why not encode day/HH:mm arithmetic symbolically: a calendar day is 23, 24 or
// 25 hours long and a wall-clock bound moves with it, so the symbolic form
// needs a timezone database inside the solver. Discretising into absolute
// intervals at encode time keeps ONE timezone implementation in the process —
// the verifier's.
import type { Assignment, RuleFixture, VerifyConfig } from "./calendar.ts";
import { effectiveHard, resolveSelector, scopeCoversFixture, startWindowFor } from "./calendar.ts";
import { dayKeyInTz, weekdayOfYmd, ymdAddDays, zonedTimeToUtc } from "./tz.ts";

const MS_PER_MIN = 60_000;
const MS_PER_DAY = 86_400_000;

/** The constraint families the solver asserts under their own assumption
 *  literal, so an UNSAT check names WHICH rules cannot hold together. Declared
 *  here rather than in `repair.ts` because the domain builder is what decides
 *  which family a bound belongs to, and one home beats two that can drift. */
export const REPAIR_FAMILIES = [
  "window",
  "blackout",
  "court",
  "rest",
  "person",
  "order",
  /** INDIRECT feed dependencies (`direct: false`) only. Its own family because
   *  `isBlockingConflict` covers `order` only when `direct === true`: asserted
   *  under the never-relaxed `order` literal, a pre-existing indirect violation
   *  the solver cannot undo would report the whole board `infeasible` over a
   *  conflict the verifier merely warns about. */
  "order_soft",
  "instruction",
  "start_window",
] as const;
export type RepairFamily = (typeof REPAIR_FAMILIES)[number];

/**
 * The families that make a board PHYSICALLY IMPOSSIBLE rather than merely
 * uncomfortable — the same four `isBlockingConflict` names. When the full rule
 * set has no solution these are what the solver falls back to, and everything it
 * dropped is reported as `relaxed` so the caller never mistakes a partial repair
 * for a clean one.
 *
 * Lives HERE rather than in `repair.ts` because the domain builder needs it too:
 * a pruning decision may only ever rest on a family that cannot be relaxed away
 * (see `FixtureDomain.span`), and two copies of this list would drift.
 */
export const BLOCKING_FAMILIES: readonly RepairFamily[] = ["window", "court", "person", "order"];

const FAMILY_ORDER = new Map(REPAIR_FAMILIES.map((f, i) => [f, i]));

/** Sorts families into their declared order — the reported list must not depend
 *  on the order z3 happened to hand back an unsat core. */
export function sortFamilies(families: Iterable<RepairFamily>): RepairFamily[] {
  return [...new Set(families)].sort((a, b) => (FAMILY_ORDER.get(a) ?? 0) - (FAMILY_ORDER.get(b) ?? 0));
}

/**
 * A run of legal START instants, **closed at both ends**, in absolute ms.
 *
 * Closed rather than half-open on purpose, and the tail is where it shows: a
 * fixture may start at exactly `window.to - durationMs`, because the verifier
 * rejects only `a.endAt > window.to`. A half-open `to` would have to be that
 * instant plus one millisecond, which reads as an off-by-one every time
 * somebody checks it against the verifier. Day-shaped bounds therefore carry
 * `bucketEnd - 1`, which is the same set of legal minutes.
 */
export interface Interval {
  from: number;
  to: number;
}

/** One calendar day in the org zone, or the part of one a session covers.
 *  Half-open on the instants, like every other window in the engine. `ymd` is
 *  always the org-zone date of EVERY instant in `[from, to)` — the invariant the
 *  day-shaped instruction rules read it for. */
export interface DayBucket {
  ymd: string;
  from: number;
  to: number;
}

export interface FixtureDomain {
  fixtureId: string;
  durationMs: number;
  /** The placement the proposal came in with. Kept here so the encoder can make
   *  "did not move" mean byte-identical rather than merely equivalent. */
  origStartAt: number;
  origCourt: string;
  /** Allowed START intervals per family. A family absent from the map imposes
   *  nothing. `from`/`to` bound the START (duration already subtracted). */
  byFamily: Partial<Record<RepairFamily, readonly Interval[]>>;
  /** Court labels this fixture may use, per family (blackouts are court-scoped). */
  courtsByFamily: Partial<Record<RepairFamily, readonly string[]>>;
  /** Blackout family, per court: the starts legal ON that court. A court whose
   *  list is empty is unusable for this fixture; the encoder asserts the
   *  implication `court == c → start ∈ courtIntervals[c]`. */
  courtIntervals: Readonly<Record<string, readonly Interval[]>>;
  /** True when some family left no legal start at all — reported before z3 runs. */
  empty: readonly RepairFamily[];
  /**
   * The PRUNING span: the universe bound intersected with the families in
   * `BLOCKING_FAMILIES` alone, collapsed to its outer bounds.
   *
   * Deliberately NOT the intersection of every family. `instruction`,
   * `blackout`, `start_window` and `rest` are dropped whole on the relaxation
   * fallback, so a span narrowed by one of them says nothing about where the
   * fixture may actually end up — and pruning a pair on it silently deletes the
   * court/person constraint that pair still owes. That is how a board with two
   * blocking court clashes came back reported as `clean`.
   *
   * `null` means the blocking families alone leave this fixture nowhere to
   * stand. It is a statement about PRUNING, never a licence to skip encoding:
   * the fixture is still on the board and still owes every other card its
   * constraints.
   */
  span: Interval | null;
}

export interface RepairDomainInput {
  proposal: readonly Assignment[];
  existing?: readonly Assignment[];
  config: VerifyConfig & { courts?: readonly string[] };
}

// --- interval algebra (closed, integer-valued) ------------------------------

/** Sort, drop the empties, and fuse touching runs. Two closed integer runs that
 *  abut (`[a,b]`, `[b+1,c]`) describe one set of legal starts, so fusing them
 *  keeps the encoding's `Or` as small as the domain really is. */
function normalise(intervals: readonly Interval[]): Interval[] {
  const sorted = intervals
    .filter((iv) => iv.to >= iv.from)
    .sort((a, b) => a.from - b.from || a.to - b.to);
  const out: Interval[] = [];
  for (const iv of sorted) {
    const last = out[out.length - 1];
    if (last !== undefined && iv.from <= last.to + 1) last.to = Math.max(last.to, iv.to);
    else out.push({ from: iv.from, to: iv.to });
  }
  return out;
}

function intersect(a: readonly Interval[], b: readonly Interval[]): Interval[] {
  const out: Interval[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const x = a[i]!;
    const y = b[j]!;
    const from = Math.max(x.from, y.from);
    const to = Math.min(x.to, y.to);
    if (to >= from) out.push({ from, to });
    if (x.to < y.to) i++;
    else j++;
  }
  return out;
}

/** Remove the closed range `[lo, hi]`. */
function subtractRange(intervals: readonly Interval[], lo: number, hi: number): Interval[] {
  if (hi < lo) return [...intervals];
  const out: Interval[] = [];
  for (const iv of intervals) {
    if (iv.to < lo || iv.from > hi) {
      out.push({ ...iv });
      continue;
    }
    if (iv.from < lo) out.push({ from: iv.from, to: lo - 1 });
    if (iv.to > hi) out.push({ from: hi + 1, to: iv.to });
  }
  return out;
}

// --- day buckets -----------------------------------------------------------

/**
 * Cuts `[from, to)` at the org zone's midnights, appending each slice to `out`.
 *
 * The shared walk behind both of `dayBuckets`' branches, so a bucket's `ymd` is
 * the date of every instant it holds no matter which branch produced it.
 *
 * The 4000-slice cap is shared across the whole call: a competition is days, not
 * centuries, and the cap is insurance against a zone whose midnight arithmetic
 * fails to advance, which would otherwise spin forever inside a pure function.
 */
function splitAtMidnights(from: number, to: number, tz: string, out: DayBucket[]): void {
  let cursor = from;
  while (cursor < to && out.length < 4000) {
    const ymd = dayKeyInTz(cursor, tz);
    // NEVER `cursor + 86_400_000`: the DST fall-back day is 25 hours long, and
    // a fixed step would drift the bucket boundaries off the org's midnight.
    const next = Math.min(to, zonedTimeToUtc(ymdAddDays(ymd, 1), "00:00", tz));
    if (next <= cursor) break;
    out.push({ ymd, from: cursor, to: next });
    cursor = next;
  }
}

/**
 * The calendar days a repair may place into, walked in the ORG zone.
 *
 * Session windows win over the pack window when present: they are absolute
 * instants and are the documented escape hatch for a division whose zone differs
 * from the org's, so a day walk over the window would be re-deriving something
 * the organiser already stated.
 *
 * They do NOT win over the day boundary itself. A session running 22:00 → 02:00
 * is two buckets, cut at the org's midnight, because `ymd` is what every
 * day-shaped instruction rule resolves against and the verifier asks
 * `dayKeyInTz(a.startAt)` of each start individually. Labelled whole with
 * `dayKeyInTz(session.from)`, the hours after midnight wore the previous day's
 * date and `buildDomains` admitted starts the verifier scored on the next one —
 * under `instruction`, so the strict pass reported `repaired` with `relaxed: []`
 * and `repairAndVerify` threw on the board it had just produced.
 *
 * Without a zone there is nothing to bucket BY — the verifier skips every
 * day-shaped rule in that state — so each window comes back whole rather than
 * being silently sliced in UTC.
 */
export function dayBuckets(
  config: Pick<VerifyConfig, "tz" | "window" | "sessionWindows">,
): DayBucket[] {
  const tz = config.tz;
  const sessions = config.sessionWindows ?? [];
  if (sessions.length > 0) {
    const out: DayBucket[] = [];
    for (const w of sessions) {
      if (w.to <= w.from) continue;
      if (tz === undefined) out.push({ ymd: "", from: w.from, to: w.to });
      else splitAtMidnights(w.from, w.to, tz, out);
    }
    // Session order is the caller's; bucket order is chronological, so the same
    // config always encodes identically.
    return out.sort((a, b) => a.from - b.from || a.to - b.to);
  }
  const window = config.window;
  if (window === undefined || window.to <= window.from) return [];
  if (tz === undefined) return [{ ymd: "", from: window.from, to: window.to }];
  const out: DayBucket[] = [];
  splitAtMidnights(window.from, window.to, tz, out);
  return out;
}

/**
 * WHOLE calendar days in the org zone covering `range`, padded by one day at
 * each end. The counting unit for anything the verifier tallies per day.
 *
 * `dayBuckets` is the wrong tool for that job twice over: it CLIPS its first and
 * last entries to the window it was handed, and when sessions are configured it
 * returns only the slices those sessions cover. Both make its entries something
 * other than a whole calendar day, and `validateInstructionRules` counts them —
 * a start in a clipped-off remainder is then counted by the verifier and by no
 * literal of the encoder, which is how a per-day cap came to be enforced on part
 * of a day only.
 *
 * The padding is not decoration. The solver's bound on a start is applied in
 * MINUTES (`floorMin` / `ceilMin`), so the extreme reachable start sits just
 * outside the millisecond range these days are derived from; a day at each end
 * costs two trivially-satisfied groups and removes the rounding edge entirely.
 */
export function calendarDaysCovering(range: Interval, tz: string): DayBucket[] {
  if (range.to < range.from) return [];
  const out: DayBucket[] = [];
  let ymd = ymdAddDays(dayKeyInTz(range.from, tz), -1);
  const last = ymdAddDays(dayKeyInTz(range.to, tz), 1);
  let cursor = zonedTimeToUtc(ymd, "00:00", tz);
  // A competition is days, not centuries. The cap mirrors `dayBuckets`; the
  // caller keeps the encoding honest if it ever bites (see the completeness
  // clause in `repair.ts`, which turns a truncated day list into a RELAXED
  // instruction family rather than an unenforced rule).
  while (out.length < 4000) {
    ymd = dayKeyInTz(cursor, tz);
    const next = zonedTimeToUtc(ymdAddDays(ymd, 1), "00:00", tz);
    if (next <= cursor) break;
    out.push({ ymd, from: cursor, to: next });
    if (ymd >= last) break;
    cursor = next;
  }
  return out;
}

// --- the universe the solver searches --------------------------------------

/** The outer bound on every start the solver may consider. The pack window when
 *  there is one; otherwise the board's own extent, widened so a repair has
 *  somewhere to move to. An unbounded search is not an option: z3 would be free
 *  to answer with the year 90210. */
export function repairUniverse(input: RepairDomainInput): { from: number; to: number } {
  const { config } = input;
  if (config.window !== undefined) return config.window;
  const sessions = config.sessionWindows ?? [];
  if (sessions.length > 0) {
    return {
      from: Math.min(...sessions.map((w) => w.from)),
      to: Math.max(...sessions.map((w) => w.to)),
    };
  }
  const board = [...input.proposal, ...(input.existing ?? [])];
  if (board.length === 0) return { from: 0, to: MS_PER_DAY };
  return {
    from: Math.min(...board.map((a) => a.startAt)) - 7 * MS_PER_DAY,
    to: Math.max(...board.map((a) => a.endAt)) + 7 * MS_PER_DAY,
  };
}

/** Every court label on the table, sorted. The configured courts plus the ones
 *  the board is already using: a court index the proposal's own placement
 *  cannot express would make k=0 unrepresentable, and an immovable parked on an
 *  unlisted court would become invisible to the clash constraint. */
export function repairCourts(input: RepairDomainInput): string[] {
  const labels = new Set<string>(input.config.courts ?? []);
  for (const a of input.proposal) labels.add(a.court);
  for (const a of input.existing ?? []) labels.add(a.court);
  return [...labels].sort();
}

// --- domains ---------------------------------------------------------------

export function buildDomains(input: RepairDomainInput): FixtureDomain[] {
  const { config } = input;
  const tz = config.tz;
  const universe = repairUniverse(input);
  const courts = repairCourts(input);
  const buckets = dayBuckets({ tz, window: universe, sessionWindows: config.sessionWindows });
  const hard = effectiveHard(config);
  const ruleFixtures = config.ruleFixtures ?? [];
  const fixtureById = new Map<string, RuleFixture>(ruleFixtures.map((f) => [f.id, f]));
  const blackouts = config.blackouts ?? [];
  const sessions = config.sessionWindows ?? [];

  // Determinism starts HERE, before z3 sees anything: variable creation order is
  // domain order, and domain order is fixtureId order.
  const ordered = [...input.proposal].sort((a, b) => (a.fixtureId < b.fixtureId ? -1 : a.fixtureId > b.fixtureId ? 1 : 0));

  return ordered.map((a) => {
    const durationMs = a.endAt - a.startAt;
    const byFamily: Partial<Record<RepairFamily, readonly Interval[]>> = {};
    const courtsByFamily: Partial<Record<RepairFamily, readonly string[]>> = {};
    const empty: RepairFamily[] = [];
    const universeStarts = normalise([{ from: universe.from, to: universe.to - durationMs }]);

    // window — the PACK window, minus the duration at the tail so the whole
    // OCCUPANCY fits. Session windows used to REPLACE it here, and that was a
    // bug: `validateAssignments` enforces the pack window as a blocking `window`
    // conflict whether or not sessions exist, so a session running past
    // `window.to` handed the solver a start the verifier then rejected —
    // `repairAndVerify` throwing on a board the solver called repaired.
    if (config.window !== undefined) {
      const windowRuns = normalise([
        { from: config.window.from, to: config.window.to - durationMs },
      ]);
      byFamily.window = windowRuns;
      if (windowRuns.length === 0) empty.push("window");
    }

    // Sessions are folded in under `blackout` below rather than under `window`,
    // because that is the family the VERIFIER reports them as: outside every
    // session window is `reason: "blackout"`, which `isBlockingConflict` does not
    // cover. Pinned under the never-relaxed `window` literal instead, a board
    // that only fits outside its sessions came back `infeasible` when a partial
    // repair was available.
    const sessionStarts =
      sessions.length > 0
        ? normalise(sessions.map((w) => ({ from: w.from, to: w.to - durationMs })))
        : null;

    // blackout — court-scoped, so it narrows the COURTS as well as the times. A
    // court whose every start is blacked out drops out of `courtsByFamily`; one
    // that is only partly blocked keeps its own interval list and the encoder
    // asserts it under `court == c`.
    const courtIntervals: Record<string, readonly Interval[]> = {};
    const usableCourts: string[] = [];
    for (const court of courts) {
      let runs = universeStarts;
      if (sessionStarts !== null) runs = intersect(runs, sessionStarts);
      for (const bo of blackouts) {
        if (bo.court !== undefined && bo.court !== court) continue;
        // A start overlapping the blackout is any start in
        // (bo.from - duration, bo.to) — half-open on both sides because
        // `intervalsOverlap` lets intervals touch.
        runs = subtractRange(runs, bo.from - durationMs + 1, bo.to - 1);
      }
      courtIntervals[court] = runs;
      if (runs.length > 0) usableCourts.push(court);
    }
    if (blackouts.length > 0 || sessionStarts !== null) {
      byFamily.blackout = normalise(Object.values(courtIntervals).flat());
      courtsByFamily.blackout = usableCourts;
      if (usableCourts.length === 0) empty.push("blackout");
    }

    // start_window — a bound on the START only (Jul3/04 §3), never on occupancy.
    const sw = startWindowFor(config, a);
    if (sw.notBefore > Number.NEGATIVE_INFINITY || sw.notAfter < Number.POSITIVE_INFINITY) {
      const runs = normalise([
        { from: Math.max(universe.from, sw.notBefore), to: Math.min(universe.to, sw.notAfter) },
      ]);
      byFamily.start_window = runs;
      if (runs.length === 0) empty.push("start_window");
    }

    // instruction — the merged hard-rule stream, read through the same selector
    // and scope helpers the verifier uses. Every rule here needs a day boundary
    // or a wall-clock time, so all of them are SKIPPED without an org zone,
    // exactly as `validateInstructionRules` skips them.
    let instruction: Interval[] | null = null;
    const restrict = (runs: Interval[]): void => {
      instruction = instruction === null ? normalise(runs) : intersect(instruction, normalise(runs));
    };
    if (tz !== undefined) {
      for (const h of hard) {
        if (h.type === "fixture_on_date" || h.type === "fixture_on_weekday") {
          const named = resolveSelector(h.selector, h.scope, ruleFixtures).find((f) => f.id === a.fixtureId);
          if (named === undefined) continue;
          if (!scopeCoversFixture(h.scope, named, a)) continue;
          const days = buckets.filter((b) =>
            h.type === "fixture_on_date" ? b.ymd === h.date : weekdayOfYmd(b.ymd) === h.weekday,
          );
          restrict(days.map((b) => ({ from: b.from, to: b.to - 1 })));
          continue;
        }
        if (h.type === "not_before" || h.type === "not_after") {
          if (!scopeCoversFixture(h.scope, fixtureById.get(a.fixtureId), a)) continue;
          const runs: Interval[] = [];
          for (const b of buckets) {
            const t = zonedTimeToUtc(b.ymd, h.time, tz);
            // `hhmmInTz` truncates to the minute, so `not_after 18:00` admits
            // every instant inside 18:00 — the whole minute, not just its edge.
            const from = h.type === "not_before" ? Math.max(b.from, t) : b.from;
            const to = h.type === "not_after" ? Math.min(b.to - 1, t + MS_PER_MIN - 1) : b.to - 1;
            if (from <= to) runs.push({ from, to });
          }
          restrict(runs);
        }
      }
    }
    if (instruction !== null) {
      byFamily.instruction = instruction;
      if ((instruction as Interval[]).length === 0) empty.push("instruction");
    }

    // The pruning span — BLOCKING families and the universe bound ONLY. See the
    // note on `FixtureDomain.span` for why a relaxable family must never narrow
    // it. In practice only `window` of the four is a per-fixture interval list;
    // the loop is written over `BLOCKING_FAMILIES` so a future blocking family
    // that IS one joins automatically instead of being forgotten.
    let acc = universeStarts;
    for (const family of BLOCKING_FAMILIES) {
      const runs = byFamily[family];
      if (runs !== undefined) acc = intersect(acc, runs);
    }
    const span = acc.length === 0 ? null : { from: acc[0]!.from, to: acc[acc.length - 1]!.to };

    return {
      fixtureId: a.fixtureId,
      durationMs,
      origStartAt: a.startAt,
      origCourt: a.court,
      byFamily,
      courtsByFamily,
      courtIntervals,
      empty,
      span,
    };
  });
}

/**
 * An UPPER BOUND, in minutes, on the separation any pair on this board can owe.
 *
 * Every source `effectiveRestMinutes` and `pairRestMinutesWith` can draw on,
 * maxed without reference to a particular pair — which is the point: the pruner
 * runs before any pair is resolved, and a bound that under-counts prunes away a
 * constraint that binds. Deliberately not the tight per-pair number; the tight
 * number costs the O(n²) walk the pruner exists to avoid.
 */
export function maxSeparationMinutes(config: VerifyConfig): number {
  const c = config.constraints;
  let minutes = Math.max(config.gapMinutes, config.perEntrantMinRest, c?.restMin ?? 0);
  // Order-independent: these are maxima, so no Map/Object iteration order
  // reaches the answer.
  for (const v of Object.values(c?.restByGroup ?? {})) minutes = Math.max(minutes, v);
  for (const v of Object.values(config.restByDivision ?? {})) minutes = Math.max(minutes, v);
  if (c?.noBackToBack === true && config.matchMinutes !== undefined) {
    minutes = Math.max(minutes, config.matchMinutes + config.gapMinutes);
  }
  for (const h of effectiveHard(config)) {
    if (h.type === "min_rest_minutes") minutes = Math.max(minutes, h.minutes);
  }
  return minutes;
}

/**
 * Index pairs whose domains can still interact. The O(n²) pruner that keeps 500
 * movable fixtures tractable: two fixtures that cannot come within `slackMs` of
 * each other can neither share a court nor crowd each other's rest, so the
 * encoder never emits a constraint for them.
 *
 * `slackMs` is the separation the pair might owe — `maxSeparationMinutes` in ms.
 * Testing bare OCCUPANCY overlap is not enough and was the bug: two fixtures 10
 * minutes apart that owe 45 minutes of rest do not overlap, yet the rest
 * constraint between them is real. The movable×immovable loop in `repair.ts` has
 * always widened its own reach by `max(gapMinutes, rest)`; this is the same
 * widening on the movable×movable side.
 */
export function candidatePairs(
  domains: readonly FixtureDomain[],
  slackMs = 0,
): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let i = 0; i < domains.length; i++) {
    const a = domains[i]!;
    for (let j = i + 1; j < domains.length; j++) {
      const b = domains[j]!;
      // A `null` span means the blocking families alone leave that fixture
      // nowhere to stand. It is NOT absent from the board, so there is nothing
      // to prune on — the pair is kept and the encoder constrains it.
      if (a.span === null || b.span === null) {
        out.push([i, j]);
        continue;
      }
      if (
        a.span.from < b.span.to + b.durationMs + slackMs &&
        b.span.from < a.span.to + a.durationMs + slackMs
      ) {
        out.push([i, j]);
      }
    }
  }
  return out;
}
