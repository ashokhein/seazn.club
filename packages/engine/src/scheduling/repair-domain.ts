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
  "instruction",
  "start_window",
] as const;
export type RepairFamily = (typeof REPAIR_FAMILIES)[number];

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

/** One calendar day in the org zone (or one session window). Half-open on the
 *  instants, like every other window in the engine. */
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
  /** The intersection of every family present, collapsed to its outer bounds.
   *  `null` when the families cannot hold together for this fixture alone. */
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
 * The calendar days a repair may place into, walked in the ORG zone.
 *
 * Session windows win when present: they are absolute instants and are the
 * documented escape hatch for a division whose zone differs from the org's, so
 * a day walk would be re-deriving something the organiser already stated.
 *
 * Without a zone there is nothing to bucket BY — the verifier skips every
 * day-shaped rule in that state — so the whole window comes back as one bucket
 * rather than being silently sliced in UTC.
 */
export function dayBuckets(
  config: Pick<VerifyConfig, "tz" | "window" | "sessionWindows">,
): DayBucket[] {
  const tz = config.tz;
  const sessions = config.sessionWindows ?? [];
  if (sessions.length > 0) {
    return sessions
      .filter((w) => w.to > w.from)
      .map((w) => ({ ymd: tz === undefined ? "" : dayKeyInTz(w.from, tz), from: w.from, to: w.to }))
      .sort((a, b) => a.from - b.from || a.to - b.to);
  }
  const window = config.window;
  if (window === undefined || window.to <= window.from) return [];
  if (tz === undefined) return [{ ymd: "", from: window.from, to: window.to }];
  const out: DayBucket[] = [];
  let cursor = window.from;
  // A competition window is days, not centuries. The cap is insurance against a
  // zone whose midnight arithmetic fails to advance, which would otherwise spin
  // forever inside a pure function.
  while (cursor < window.to && out.length < 4000) {
    const ymd = dayKeyInTz(cursor, tz);
    // NEVER `cursor + 86_400_000`: the DST fall-back day is 25 hours long, and
    // a fixed step would drift the bucket boundaries off the org's midnight.
    const to = Math.min(window.to, zonedTimeToUtc(ymdAddDays(ymd, 1), "00:00", tz));
    if (to <= cursor) break;
    out.push({ ymd, from: cursor, to });
    cursor = to;
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

    // window — the pack window, minus the duration at the tail so the whole
    // OCCUPANCY fits. Session windows fold in here: the verifier reports them
    // under a different reason, but they bound the same thing, and a fixture
    // that fits neither has the same repair either way.
    if (config.window !== undefined || sessions.length > 0) {
      const runs =
        sessions.length > 0
          ? sessions.map((w) => ({ from: w.from, to: w.to - durationMs }))
          : [{ from: config.window!.from, to: config.window!.to - durationMs }];
      const windowRuns = normalise(runs);
      byFamily.window = windowRuns;
      if (windowRuns.length === 0) empty.push("window");
    }

    // blackout — court-scoped, so it narrows the COURTS as well as the times. A
    // court whose every start is blacked out drops out of `courtsByFamily`; one
    // that is only partly blocked keeps its own interval list and the encoder
    // asserts it under `court == c`.
    const courtIntervals: Record<string, readonly Interval[]> = {};
    const usableCourts: string[] = [];
    for (const court of courts) {
      let runs = universeStarts;
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
    if (blackouts.length > 0) {
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

    let acc = universeStarts;
    for (const runs of Object.values(byFamily)) acc = intersect(acc, runs);
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
 * Index pairs whose domains can still collide. The O(n²) pruner that keeps 500
 * movable fixtures tractable: two fixtures pinned to different days can never
 * share a court or crowd each other's rest, so the encoder never emits a
 * constraint for them.
 */
export function candidatePairs(domains: readonly FixtureDomain[]): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let i = 0; i < domains.length; i++) {
    const a = domains[i]!;
    if (a.span === null) continue;
    for (let j = i + 1; j < domains.length; j++) {
      const b = domains[j]!;
      if (b.span === null) continue;
      // Occupancy is [span.from, span.to + duration) at its widest.
      if (a.span.from < b.span.to + b.durationMs && b.span.from < a.span.to + a.durationMs) {
        out.push([i, j]);
      }
    }
  }
  return out;
}
