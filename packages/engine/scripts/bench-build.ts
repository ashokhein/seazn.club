// The measurement behind `DEFAULT_BUILD_RLIMIT`, ruling R18's knee, and the
// seven other open questions against the build solver (z3 auto-schedule
// Task 13).
//
// This file is an INSTRUMENT, not a feature. Every number the task report
// quotes has to be reproducible by re-running a mode here, because a bench
// whose findings live only in a commit message is a bench nobody can check.
//
// Three things it is careful about, because getting any of them wrong makes the
// measurement worthless:
//
//   1. **The greedy baseline comes from `buildSchedule` itself**, run at
//      `rlimit: 1` — the documented lever that starves the search and returns
//      the LEGALISED seed (`build-polish.test.ts:23`). Re-running `slotFixtures`
//      from outside would skip the legalisation pass and measure a board the
//      solver never compares itself against, and hand-rolling the comparison
//      would fork `boardMetrics`, which is the recurring defect class in this
//      area. Both boards on a row therefore come from the same code path and
//      the same metric function; only the budget differs.
//   2. **Every case runs in its own child process.** z3 can abort the whole
//      process from inside the WASM (an `_emscripten_resize_heap` OOM is not a
//      catchable exception), and an in-process bench would simply vanish at
//      that point, taking every earlier row with it. A child that dies is a
//      recorded ABORT row, which is itself a finding.
//   3. **Every board carries typed `hard` rules.** `repair-synthetic-board.ts`
//      omits them on purpose and `bench-repair.ts` is therefore inert for
//      exactly the rules organisers write (#455). This board carries a
//      `min_rest_minutes` that RAISES the config's own rest bound and a
//      per-division `max_fixtures_per_day`, so the placer, the encoder and the
//      verifier are all measured doing the work they do in production.
//
// Modes:
//
//   # the R18 knee sweep (Q1) and the bound question (Q2/Q4/Q6)
//   node --experimental-strip-types packages/engine/scripts/bench-build.ts
//   node --experimental-strip-types packages/engine/scripts/bench-build.ts \
//     --sizes=10,20,40 --per-entrant=2,4 --repeats=1 --wall=8000
//
//   # z3 boot + teardown cost (Q7)
//   node --experimental-strip-types packages/engine/scripts/bench-build.ts --probe=boot
//
//   # encoding size per tier, and per-check rlimit cost (Q8/Q9)
//   node --experimental-strip-types packages/engine/scripts/bench-build.ts --probe=encode --sizes=200
//
//   # what R22's gate admits at two rest values — seconds, no z3, no child
//   node --experimental-strip-types packages/engine/scripts/bench-build.ts --probe=gate
//
// Not collected by vitest: the suite's `include` is `src/**/*.test.ts` and
// `test/**/*.test.ts`, and this file is neither. It costs minutes, so it must
// stay out of the standard gate.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  BUILD_MAIN_RLIMIT_SHARE,
  DEFAULT_BUILD_RLIMIT,
  DEFAULT_BUILD_WALL_MS,
  MAX_SOLVE_ENCODING,
  buildSchedule,
  buildTiers,
  canSolveWithin,
  type BuildResult,
} from "../src/scheduling/build.ts";
import { encodeBuild } from "../src/scheduling/build-encode.ts";
import { buildGrid } from "../src/scheduling/build-grid.ts";
import type { RuleFixture, SchedulableFixture, SlotConfig, VerifyConfig } from "../src/scheduling/calendar.ts";
import type { HardConstraint } from "../src/scheduling/constraints.ts";
import { loadZ3, resetZ3 } from "../src/scheduling/z3-load.ts";

const MB = 1024 * 1024;
const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

// --- the board ---------------------------------------------------------------
//
// Shape notes, all load-bearing:
//
//   * `gapMinutes: 0` makes the lattice step the PITCH (`gridStepMinutes` is
//     `gcd(match, gap)` floored at 5, and `gcd(m, 0) === m`), so the slot count
//     is ~`slack x n` rather than three times it. The turnaround is inside
//     `matchMinutes`. This is what keeps a 200-fixture board near the ~250-slot
//     encoding the Task 3 scaling work measured, instead of a 750-slot one that
//     measures an encoder nobody runs.
//   * A Monday epoch, so a weekday-scoped rule added later reads the way it
//     looks.
//   * Entrants are assigned round-robin from a pool sized by `perEntrant`, so
//     every entrant plays exactly that many matches and the repeats land in
//     ascending `roundNo` — the shape that gives the idle-gap tier something to
//     find, since greedy's (roundNo, id) walk serves unrelated cards between a
//     pair.

const EPOCH = Date.parse("2026-09-07T00:00:00Z");
const COURTS = ["C1", "C2", "C3", "C4"];
const MATCH_MIN = 40;
const GAP_MIN = 0;
const OPEN_MS = 8 * HOUR;
const CLOSE_MS = 20 * HOUR;
const SLOTS_PER_COURT_DAY = Math.floor((CLOSE_MS - OPEN_MS) / (MATCH_MIN * MIN));
const PER_DAY = COURTS.length * SLOTS_PER_COURT_DAY;
const DIVISIONS = ["d1", "d2"];

export interface BenchBoardOptions {
  /** Fixtures to place. */
  n: number;
  /** Matches each entrant plays. Higher is DENSER — more shared entrants, so
   *  more rest and person clauses per fixture. */
  perEntrant: number;
  /**
   * Lattice slots per fixture. 1.0 is a board with no room at all.
   *
   * HELD ACROSS THE SWEEP, which it was not. `slotsPerCourtDay` is clamped at
   * `SLOTS_PER_COURT_DAY` while `days` used to derive from the full-day
   * `PER_DAY`, so `--slack=2` actually delivered 2.0 / 2.0 / 1.8 / 1.2 / 1.8 /
   * 1.2 / 1.08 at n = 10…200: the R18 knee sweep varied board size and board
   * TIGHTNESS together while reporting only size, and n=60 was materially
   * tighter than the n=80 row beside it. `days` now derives from the same slot
   * count `slack` asks for, and the REALISED ratio is reported per row so the
   * residual granularity at small n is visible rather than assumed away.
   */
  slack: number;
  /**
   * The typed `min_rest_minutes` rule, in minutes. Must exceed
   * `perEntrantMinRest` or the rule is inert and the board is #455 again.
   *
   * KEEP IT A MULTIPLE OF TWICE `MATCH_MIN`. The lattice step is the gcd over
   * every interval that can displace a start, rest included, so the old default
   * of 45 (with its derived `perEntrantMinRest` of 22) gives `gcd(40, 0, 22,
   * 45) = 1`, floored to five minutes — an EIGHT-fold lattice on a board whose
   * header claims the step is the pitch. That is a property of the config, not a
   * defect: a real competition with incommensurate rest really does get that
   * lattice, and running `--hard-rest=45` to measure it is a legitimate use.
   * The default just must not do it silently, so the derived step is printed in
   * the run header.
   */
  hardRestMin: number;
  /**
   * `max_fixtures_per_day` count, per division. `0` means "derive one that binds
   * at the margin": the even per-division per-day share, rounded up.
   *
   * THAT DERIVATION IS INERT ON A ONE-DAY BOARD, and it used to be one-day for
   * every size up to 72: with a single day the even share IS the division's
   * whole fixture count, so the cap is satisfied by construction and cannot
   * bind — exactly the #455 shape the file header says this board exists to
   * avoid, for the smaller half of the sweep. `days` is therefore floored at 2.
   */
  dayCap: number;
  /**
   * Minutes past the session open to pin one entrant's earliest start, as a
   * `startWindows.notBefore`. MUST NOT divide the lattice step, or the knob is
   * inert.
   *
   * THIS IS THE INSTRUMENT'S CONTROL, and without it the sweep cannot tell
   * "z3 found nothing" from "the bench cannot see anything". Greedy starts a
   * card at EXACTLY its `notBefore` (measured in `build.test.ts`: `notBefore:
   * T0+7min` gives `a@C1+7` against slots at `+0/30/60`), so an off-grid bound
   * puts that court's whole ladder off-lattice and lengthens the board by the
   * offset. The solver may only use lattice slots, so it is strictly shorter —
   * a KNOWN, DOCUMENTED greedy defect the makespan tier must find. A sweep row
   * where it does not is a finding about the budget, not about the board.
   *
   * 0 disables it, which is the honest shape: a board with no greedy defect at
   * all, where `already_optimal` is the correct answer.
   */
  offGridMin: number;
  /**
   * How many entrants get a `notAfter` bound pinning them to the FIRST slot
   * time. This is the instrument's working control.
   *
   * It is the corner `build.test.ts` measured for T0: greedy walks fixtures in
   * (roundNo, id) order and hands the contested early slots to whichever card
   * it reaches first, so a card that may ONLY sit there arrives to find them
   * gone and is reported `start_window`. The solver swaps them and places both,
   * which is an improvement in `placed` — the top of D3's ordering, and the one
   * tier that always gets budget because it runs first.
   *
   * The entrants chosen are the HIGHEST-indexed ones, because the generator
   * hands entrant `2f`/`2f+1` to fixture `f`: a high-index entrant is in a
   * late-`id` fixture, which is exactly the one greedy serves after the slots
   * are gone. Constraining a low-index entrant is INERT — greedy reaches it
   * first and places it correctly by luck.
   *
   * A constrained entrant's SECOND match is unplaceable for anybody (rest
   * forbids two matches in one slot time), which costs both boards the same
   * card and leaves the delta a real z3 win rather than an artefact.
   */
  notAfterEntrants: number;
}

export interface BenchBoard {
  fixtures: SchedulableFixture[];
  config: SlotConfig & { courts: string[] } & Pick<VerifyConfig, "hard" | "restByDivision">;
  days: number;
  pool: number;
  dayCap: number;
  /** One day's session length in ms — the horizon a tier bound is stated
   *  against. */
  sessionMs: number;
  /** Lattice slots per fixture as BUILT, which is not always the `slack` that
   *  was asked for. Reported per row; see `BenchBoardOptions.slack`. */
  slackRealised: number;
}

const idOf = (f: number): string => `f${String(f).padStart(4, "0")}`;
const entrantOf = (e: number): string => `e${String(e).padStart(4, "0")}`;

export function benchBoard(opts: BenchBoardOptions): BenchBoard {
  const { n, perEntrant, slack, hardRestMin } = opts;
  // `slack` sizes the SESSION, not just the day count. Deriving days alone from
  // it leaves the session at a full 12 hours, so a 10-fixture board gets the
  // same 72 slots a 70-fixture one does — `slack` then does nothing below day
  // granularity and every small board is measured at slack 7, which is not a
  // shape any organiser runs and not one greedy can fail on.
  //
  // BOTH DIMENSIONS COME OFF THE SAME NUMBER, and that is the fix. `days` used
  // to derive from the full-day `PER_DAY` while `slotsPerCourtDay` was clamped
  // at `SLOTS_PER_COURT_DAY`, so the two disagreed about how big a day is and
  // the realised slack collapsed as n grew (2.0 at 10, 1.08 at 200). Deriving
  // the day count from the slot count `slack` actually asks for keeps the ratio
  // flat, which is what makes a size sweep a size sweep.
  //
  // FLOORED AT TWO DAYS so the per-division `max_fixtures_per_day` can bind at
  // all: on one day the even per-division share IS that division's whole
  // fixture count. See `BenchBoardOptions.dayCap`.
  const slotsWanted = Math.max(1, Math.ceil(n * slack));
  const days = Math.max(2, Math.ceil(slotsWanted / PER_DAY));
  const slotsPerCourtDay = Math.max(
    1,
    Math.min(SLOTS_PER_COURT_DAY, Math.ceil(slotsWanted / (COURTS.length * days))),
  );
  const sessionMs = slotsPerCourtDay * MATCH_MIN * MIN;
  /** What the board ACTUALLY delivers, against the `slack` that was asked for.
   *  Rounding up at both stages overshoots at small n (2.4 at n=10), and a
   *  sweep that reports only the requested ratio hides it. */
  const slackRealised = (COURTS.length * days * slotsPerCourtDay) / Math.max(1, n);
  // Two entrants a fixture, so `2n` entrant-slots to hand out. A pool of
  // `2n / perEntrant` gives every entrant exactly `perEntrant` matches.
  const pool = Math.max(4, Math.ceil((2 * n) / perEntrant));
  const perRound = Math.max(1, Math.floor(pool / 2));
  const dayCap =
    opts.dayCap > 0 ? opts.dayCap : Math.max(1, Math.ceil(n / DIVISIONS.length / days));

  const fixtures: SchedulableFixture[] = [];
  const ruleFixtures: RuleFixture[] = [];
  for (let f = 0; f < n; f++) {
    const home = entrantOf((2 * f) % pool);
    const away = entrantOf((2 * f + 1) % pool);
    const divisionId = DIVISIONS[f % DIVISIONS.length]!;
    fixtures.push({
      id: idOf(f),
      // One round is one full pass through the pool, so an entrant's second
      // match is always in a strictly later round.
      roundNo: Math.floor(f / perRound) + 1,
      home,
      away,
      people: [`p-${home}`, `p-${away}`],
      divisionId,
    });
    ruleFixtures.push({ id: idOf(f), extKey: null, divisionId, winnerTo: null });
  }

  // Typed rules — the whole point of this board over `syntheticBoard`.
  //
  // `min_rest_minutes` is at COMPETITION scope and RAISES the config's own
  // 45-minute bound, so it is not a restatement of `perEntrantMinRest`: drop
  // the rule and the board's legal placements genuinely change.
  //
  // `max_fixtures_per_day` is per DIVISION rather than per competition, which
  // is both what organisers write and what keeps it satisfiable — a
  // competition-scoped cap at the same number would be the day's whole
  // capacity and bind on nothing.
  const hard: HardConstraint[] = [
    {
      type: "min_rest_minutes",
      minutes: hardRestMin,
      rest_scope: "per_person",
      scope: { kind: "competition" },
    },
    ...DIVISIONS.map(
      (divisionId): HardConstraint => ({
        type: "max_fixtures_per_day",
        count: dayCap,
        scope: { kind: "division", divisionId },
      }),
    ),
  ];

  const sessionWindows = Array.from({ length: days }, (_, d) => ({
    from: EPOCH + d * DAY + OPEN_MS,
    to: EPOCH + d * DAY + OPEN_MS + sessionMs,
  }));

  const config: SlotConfig & { courts: string[] } & Pick<VerifyConfig, "hard" | "restByDivision"> = {
    startAt: EPOCH + OPEN_MS,
    matchMinutes: MATCH_MIN,
    gapMinutes: GAP_MIN,
    courts: [...COURTS],
    // Half the typed rule, so `min_rest_minutes` always RAISES the bound the
    // verifier uses rather than restating it. Equal values make the rule inert
    // and the board is #455 again.
    //
    // The DEFAULT `hardRestMin` is two pitches for a reason — see the field's
    // doc. Halving an odd number here is what put a 22 next to a 45 and a 40 and
    // collapsed the lattice step to one minute.
    perEntrantMinRest: Math.max(1, Math.floor(hardRestMin / 2)),
    blackouts: [],
    sessionWindows,
    window: { from: EPOCH + OPEN_MS, to: EPOCH + (days - 1) * DAY + OPEN_MS + sessionMs },
    tz: "UTC",
    constraints: {
      noBackToBack: false,
      startWindows: [
        ...(opts.offGridMin > 0
          ? [
              {
                target: { kind: "entrant" as const, id: entrantOf(0) },
                notBefore: EPOCH + OPEN_MS + opts.offGridMin * MIN,
              },
            ]
          : []),
        // The highest-indexed entrants, pinned to the first slot time.
        ...Array.from({ length: Math.min(opts.notAfterEntrants, pool) }, (_, k) => ({
          target: { kind: "entrant" as const, id: entrantOf(pool - 1 - k) },
          notAfter: EPOCH + OPEN_MS,
        })),
      ],
      fieldFairness: "off",
      parallelism: "mixed",
      crossPersonClash: "warn",
      // NO `hard` HERE. `effectiveHard` is `[...compiled, ...stored]` whenever
      // both are non-empty, and this used to be the SAME ARRAY as the top-level
      // `hard` below — so every typed rule was registered twice and the encoder
      // emitted each per-division cap clause twice. Q8's `encodeAssertions` and
      // `tierSetupAssertions`, and Q9's per-check `spent`, were all measured
      // against a rule set of twice the production size. One channel, and the
      // compiled one, because that is where an organiser's instruction arrives.
    },
    ruleFixtures,
    hard,
  };

  return { fixtures, config, days, pool, dayCap, sessionMs, slackRealised };
}

// --- one case ----------------------------------------------------------------

interface CaseRow {
  kind: "case";
  n: number;
  perEntrant: number;
  rep: number;
  days: number;
  pool: number;
  dayCap: number;
  slots: number;
  /** Lattice slots per fixture as BUILT. The R18 knee sweep varies board size;
   *  this is the column that says whether it varied anything else. */
  slackRealised: number;
  /** The lattice step in minutes, which is the gcd over match, gap and every
   *  rest — printed because an incommensurate rest silently multiplies the
   *  lattice, and the slot count alone does not say why. */
  stepMinutes: number;
  overCap: boolean;
  rlimit: number;
  wallMs: number;
  /** The greedy incumbent, measured through `buildSchedule` at `rlimit: 1`. */
  g: Metrics;
  gElapsedMs: number;
  gRlimitSpent: number;
  gEngine: string;
  /** The real run. */
  z: Metrics;
  engine: string;
  status: string;
  tiers: number;
  expired: boolean;
  elapsedMs: number;
  rlimitSpent: number;
  moved: number;
  lost: number;
  lnsWindowRlimits: number[];
  rssPeakMB: number;
}

interface Metrics {
  placed: number;
  total: number;
  makespan: number;
  idle: number;
  imbalance: number;
}

const metricsOf = (r: BuildResult): Metrics => ({
  placed: r.metrics.placed,
  total: r.metrics.total,
  makespan: r.metrics.makespanMinutes,
  idle: r.metrics.worstIdleGapMinutes,
  imbalance: r.metrics.courtImbalanceMinutes,
});

async function runCase(opts: {
  n: number;
  perEntrant: number;
  rep: number;
  rlimit: number;
  wallMs: number;
  slack: number;
  hardRestMin: number;
  dayCap: number;
  offGridMin: number;
  notAfterEntrants: number;
}): Promise<CaseRow> {
  const board = benchBoard(opts);
  const grid = buildGrid({ config: board.config });

  let rssPeak = 0;
  const sample = (): void => {
    const m = process.memoryUsage();
    if (m.rss > rssPeak) rssPeak = m.rss;
  };
  sample();

  // The baseline. `rlimit: 1` lets exactly one check be armed and that check
  // aborts, so the incumbent is never displaced and `engine` comes back
  // `greedy` — asserted in `build-polish.test.ts`. Its `metrics` is the
  // LEGALISED seed's, which is the board `isStrictlyBetter` is asked about.
  const seed = await buildSchedule({
    fixtures: board.fixtures,
    config: board.config,
    rlimit: 1,
    wallMs: opts.wallMs,
  });
  sample();

  const out = await buildSchedule({
    fixtures: board.fixtures,
    config: board.config,
    rlimit: opts.rlimit,
    wallMs: opts.wallMs,
  });
  sample();

  return {
    kind: "case",
    n: opts.n,
    perEntrant: opts.perEntrant,
    rep: opts.rep,
    days: board.days,
    pool: board.pool,
    dayCap: board.dayCap,
    slots: grid.slots.length,
    slackRealised: board.slackRealised,
    stepMinutes: grid.stepMinutes,
    overCap: grid.overCap,
    rlimit: opts.rlimit,
    wallMs: opts.wallMs,
    g: metricsOf(seed),
    gElapsedMs: seed.elapsedMs,
    gRlimitSpent: seed.rlimitSpent,
    gEngine: seed.engine,
    z: metricsOf(out),
    engine: out.engine,
    status: out.status,
    tiers: out.tiersCompleted,
    expired: out.budgetExpired,
    elapsedMs: out.elapsedMs,
    rlimitSpent: out.rlimitSpent,
    moved: out.moved,
    lost: out.lost,
    lnsWindowRlimits: [...out.lnsWindowRlimits],
    rssPeakMB: rssPeak / MB,
  };
}

// --- Q7: what a z3 boot and teardown cost ------------------------------------

interface BootRow {
  kind: "boot";
  coldBootMs: number[];
  teardownMs: number[];
}

async function probeBoot(reps: number): Promise<BootRow> {
  const coldBootMs: number[] = [];
  const teardownMs: number[] = [];
  for (let i = 0; i < reps; i++) {
    const t0 = performance.now();
    await loadZ3();
    coldBootMs.push(performance.now() - t0);
    const t1 = performance.now();
    await resetZ3();
    teardownMs.push(performance.now() - t1);
  }
  return { kind: "boot", coldBootMs, teardownMs };
}

// --- Q8/Q9: encoding size per tier, and what a check costs -------------------

interface EncodeRow {
  kind: "encode";
  n: number;
  /** The bound the SAT check was asked at — greedy's own placed count unless
   *  overridden. */
  satK: number;
  perEntrant: number;
  slots: number;
  fixtures: number;
  /** `solver.assertions()` after `encodeBuild`, i.e. the base model. */
  encodeAssertions: number;
  encodeMs: number;
  /** Assertions the shared tier definitions add before any bound is stated. */
  tierSetupAssertions: number;
  tierSetupMs: number;
  /** Per tier: what ONE `atMost(bound)` costs in assertions and ms. */
  tiers: { name: string; assertions: number; ms: number }[];
  /** A bare `push`/`pop` over the fully-set-up solver. Drained before the tier
   *  loop so the first tier is not charged z3's one-time scope bookkeeping. */
  firstPushMs: number;
  /** Q9. `rlimit count` deltas, measured off z3's own counter, one row per
   *  bound shape. */
  checks: { label: string; k: number | null; rlimit: number; spent: number; ms: number; verdict: string }[];
}

async function probeEncode(opts: {
  n: number;
  perEntrant: number;
  slack: number;
  hardRestMin: number;
  dayCap: number;
  offGridMin: number;
  notAfterEntrants: number;
  successRlimit: number;
  /** The SAT bound for the Q9 check. 0 means "use what greedy reached". */
  satK: number;
}): Promise<EncodeRow> {
  const board = benchBoard(opts);
  const grid = buildGrid({ config: board.config });

  // The SAT bound, resolved BEFORE this probe opens its own context. It has to
  // run first: `buildSchedule` wraps itself in `withZ3LockAndReset`, so calling
  // it later would tear down the very solver being measured.
  const satK =
    opts.satK > 0
      ? opts.satK
      : (await buildSchedule({ fixtures: board.fixtures, config: board.config, rlimit: 1 })).metrics
          .placed;

  const { Z3 } = await loadZ3();
  const solver = new Z3.Solver();

  // z3's own counter, read exactly the way `build.ts::rlimitCount` reads it.
  // `release()` is not optional: leaving the `Z3_stats` objects to the JS
  // collector corrupts the WASM heap under one reading per check.
  const rlimitCount = (): number => {
    const stats = solver.statistics();
    try {
      return stats.keys().includes("rlimit count") ? stats.get("rlimit count") : 0;
    } finally {
      stats.release();
    }
  };
  const assertions = (): number => solver.assertions().length();

  const t0 = performance.now();
  const model = encodeBuild({
    Z3,
    solver,
    fixtures: board.fixtures,
    grid,
    config: { ...board.config, matchMinutes: MATCH_MIN },
  });
  const encodeMs = performance.now() - t0;
  const encodeAssertions = assertions();

  const t1 = performance.now();
  const tiers = buildTiers({
    Z3,
    solver,
    model,
    grid,
    fixtures: board.fixtures,
    config: board.config,
  });
  const tierSetupMs = performance.now() - t1;
  const tierSetupAssertions = assertions() - encodeAssertions;

  // A BARE `push`/`pop` first, and it is not a formality.
  //
  // The first `push()` after the tier setup carries a one-time cost that has
  // nothing to do with the tier that happens to go first — z3 does its scope
  // bookkeeping over everything asserted so far. Measured at n=200 that cost is
  // SECONDS, so a tier loop that starts timing at the first `push` charges the
  // whole of it to the makespan tier and reports a one-assertion bound as the
  // most expensive thing in the solver. Draining it here is what makes the
  // per-tier numbers below mean what they say.
  const p0 = performance.now();
  solver.push();
  solver.pop();
  const firstPushMs = performance.now() - p0;

  // Each tier's bound is stated inside its own `push`/`pop`, exactly as the
  // control loop states it, so the count is the clause family alone. A LOOSE
  // bound (half the horizon) rather than a tight one: the idle-gap family's
  // size depends on the bound, and a bound at the metric floor would emit a
  // degenerate clause set the real walk never asks for.
  const horizonMs = board.days * board.sessionMs;
  const tierRows: { name: string; assertions: number; ms: number }[] = [];
  for (const tier of tiers) {
    const before = assertions();
    const t = performance.now();
    solver.push();
    tier.atMost(Math.floor(horizonMs / 2));
    const ms = performance.now() - t;
    tierRows.push({ name: tier.name, assertions: assertions() - before, ms });
    solver.pop();
  }

  // Q9 — what one check costs at this scale.
  //
  // THE BOUND IS THE MEASUREMENT, not a detail:
  //
  //   * a BARE check is satisfiable by inspection (every clause is an at-most,
  //     a negation or an equivalence and `placed[i]` is free to be false), so
  //     the empty board answers it in microseconds and timing it reports a
  //     per-check cost orders out;
  //   * `AtLeast(placed, n)` is UNSAT on any board the constraints do not
  //     admit in full, and a fast unsat is not what a tier walk pays either.
  //
  // So the SAT bound is asked at `satK`, which defaults to the count greedy
  // itself reached — by construction a bound some board meets, and the exact
  // question T0 asks on its way down.
  const measure = async (
    label: string,
    k: number | null,
    rlimit: number,
  ): Promise<{ label: string; k: number | null; rlimit: number; spent: number; ms: number; verdict: string }> => {
    solver.push();
    if (k !== null) {
      const [head, ...rest] = model.placed;
      if (head !== undefined) solver.add(Z3.AtLeast([head, ...rest], k));
    }
    const before = rlimitCount();
    const t = performance.now();
    solver.set("rlimit", rlimit);
    solver.set("timeout", 120_000);
    const verdict = await solver.check();
    const ms = performance.now() - t;
    const spent = rlimitCount() - before;
    solver.pop();
    return { label, k, rlimit, spent, ms, verdict };
  };

  const checks = [
    await measure("bare", null, opts.successRlimit),
    await measure("aborted@satK", satK, 1),
    await measure("sat@satK", satK, opts.successRlimit),
    await measure("unsat@n", board.fixtures.length, opts.successRlimit),
  ];

  return {
    kind: "encode",
    n: opts.n,
    satK,
    perEntrant: opts.perEntrant,
    slots: grid.slots.length,
    fixtures: board.fixtures.length,
    encodeAssertions,
    encodeMs,
    tierSetupAssertions,
    tierSetupMs,
    tiers: tierRows,
    firstPushMs,
    checks,
  };
}

// --- driver ------------------------------------------------------------------

const arg = (name: string, fallback: string): string => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
};
const nums = (name: string, fallback: string): number[] =>
  arg(name, fallback)
    .split(",")
    .map((s) => Number(s.trim()));

const HERE = fileURLToPath(import.meta.url);

type Abort = { abort: true; kind: string; signal: string | null; code: number | null; tail: string };

function spawnChild(args: string[], timeoutMs: number): unknown {
  const r = spawnSync(process.execPath, ["--experimental-strip-types", HERE, ...args], {
    encoding: "utf8",
    maxBuffer: 32 * MB,
    timeout: timeoutMs,
  });
  const line = (r.stdout ?? "").split("\n").find((l) => l.startsWith("RESULT "));
  if (line !== undefined) return JSON.parse(line.slice(7)) as unknown;
  const tail = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim().split("\n").slice(-4).join(" | ");
  const kind = r.error?.message.includes("ETIMEDOUT") === true ? "DRIVER-TIMEOUT" : "WASM-ABORT";
  return { abort: true, kind, signal: r.signal ?? null, code: r.status ?? null, tail };
}

const f0 = (x: number): string => x.toFixed(0);
const f1 = (x: number): string => x.toFixed(1);

/** Which of the two caps stopped the run, judged from the result alone.
 *
 *  `budgetExpired` cannot answer this: `build.ts` sets it both when `arm()`
 *  declines a check (the rlimit run total is gone) and when `elapsed() >=
 *  wallMs` (the backstop fired). The two are told apart by comparing what the
 *  run drew against what each cap allowed — the MAIN phase's share for the
 *  rlimit, `wallMs` for the clock.
 *
 *  ONLY MEANINGFUL NEAR THE 30M DEFAULT. Below roughly 38 000 rlimit the two
 *  caps cannot be separated at all: an ABORTED check costs about 28 500 units
 *  whatever limit it was handed, so `rlimitSpent >= phaseCap` is satisfied by
 *  the abort itself and every small-rlimit row reads `rlimit` or `both` however
 *  the run actually ended. A `--rlimit` under ~38 000 is a lever for reaching
 *  the fallback, not a measurement of which cap binds; read this column at the
 *  default and nowhere else. */
function whichBound(row: CaseRow): string {
  if (!row.expired) return "neither";
  const phaseCap = Math.max(1, Math.floor(row.rlimit * BUILD_MAIN_RLIMIT_SHARE));
  const wallHit = row.elapsedMs >= row.wallMs;
  const rlimitHit = row.rlimitSpent >= phaseCap;
  if (wallHit && rlimitHit) return "both";
  if (wallHit) return "WALL";
  if (rlimitHit) return "rlimit";
  return "unclear";
}

/** Which metric, if any, the solver moved. Reads `boardMetrics`' own output on
 *  both boards — never a recomputation. */
function improvement(row: CaseRow): string {
  const parts: string[] = [];
  if (row.z.placed !== row.g.placed) parts.push(`placed ${row.g.placed}→${row.z.placed}`);
  if (row.z.makespan !== row.g.makespan) parts.push(`makespan ${f0(row.g.makespan)}→${f0(row.z.makespan)}`);
  if (row.z.idle !== row.g.idle) parts.push(`idle ${f0(row.g.idle)}→${f0(row.z.idle)}`);
  if (row.z.imbalance !== row.g.imbalance) parts.push(`imbal ${f0(row.g.imbalance)}→${f0(row.z.imbalance)}`);
  return parts.length === 0 ? "—" : parts.join(", ");
}

async function main(): Promise<void> {
  const slack = Number(arg("slack", "2"));
  // Two pitches, and the derived `perEntrantMinRest` is then one. Both divide
  // `MATCH_MIN`, so the lattice step stays the pitch and the slot count stays
  // the ~`slack x n` this file's header claims. The old default of 45 gave
  // `gcd(40, 0, 22, 45) = 1`, floored to a five-minute step — an eight-fold
  // lattice, measured by nothing and reported by no column.
  const hardRestMin = Number(arg("hard-rest", "80"));
  const dayCap = Number(arg("day-cap", "0"));
  const offGridMin = Number(arg("off-grid", "0"));
  const notAfterEntrants = Number(arg("not-after", "0"));

  // --- child modes ---
  const caseN = arg("case", "");
  if (caseN !== "") {
    const row = await runCase({
      n: Number(caseN),
      perEntrant: Number(arg("per-entrant", "2")),
      rep: Number(arg("rep", "0")),
      rlimit: Number(arg("rlimit", String(DEFAULT_BUILD_RLIMIT))),
      wallMs: Number(arg("wall", String(DEFAULT_BUILD_WALL_MS))),
      slack,
      hardRestMin,
      dayCap,
      offGridMin,
      notAfterEntrants,
    });
    console.log(`RESULT ${JSON.stringify(row)}`);
    await resetZ3();
    return;
  }
  const probe = arg("probe", "");
  if (probe === "boot" && arg("child", "") === "1") {
    console.log(`RESULT ${JSON.stringify(await probeBoot(Number(arg("reps", "5"))))}`);
    return;
  }
  if (probe === "encode" && arg("child", "") === "1") {
    const row = await probeEncode({
      n: Number(arg("sizes", "200")),
      perEntrant: Number(arg("per-entrant", "2")),
      slack,
      hardRestMin,
      dayCap,
      offGridMin,
      notAfterEntrants,
      successRlimit: Number(arg("success-rlimit", "100000000")),
      satK: Number(arg("sat-k", "0")),
    });
    console.log(`RESULT ${JSON.stringify(row)}`);
    await resetZ3();
    return;
  }

  // --- parent modes ---
  if (probe === "gate") {
    // R22's gate, asked of the SAME boards the knee sweep runs, at two rest
    // values at once — which is the only way to read what the lattice step did
    // to it. `hardRestMin` is the whole lever: 80 is two pitches and derives a
    // 40-minute step, 45 derives `gcd(40, 0, 22, 45) = 1` floored to five, and
    // the ~8x lattice that buys turns the SAME competition from one the solver
    // is called on into one it is not.
    //
    // NO CHILD AND NO z3. `buildGrid` never boots the WASM and `canSolveWithin`
    // only multiplies, so this mode is seconds and can be re-run beside a sweep
    // without competing with it for the wall it is measuring.
    const rests = nums("hard-rests", "80,45");
    const gateWall = Number(arg("gate-wall", "8000"));
    console.log(
      `# canSolveWithin — wall ${gateWall} ms, gate ${MAX_SOLVE_ENCODING} fixture-slots, slack ${slack}\n`,
    );
    console.log(
      `| n | per-entrant | ${rests.map((r) => `slots@${r} | n x slots@${r} | admitted@${r}`).join(" | ")} |`,
    );
    console.log(`|---|---|${rests.map(() => "---|---|---|").join("")}`);
    let flipped = 0;
    let rows = 0;
    for (const n of nums("sizes", "10,20,40,60,80,120,140,160,200")) {
      for (const pe of nums("per-entrant", "2,4")) {
        const cells: string[] = [];
        const verdicts: boolean[] = [];
        for (const hardRestMin of rests) {
          const b = benchBoard({
            n,
            perEntrant: pe,
            slack,
            hardRestMin,
            dayCap,
            offGridMin,
            notAfterEntrants,
          });
          const slots = buildGrid({ config: b.config }).slots.length;
          const admitted = canSolveWithin(b.fixtures, b.config, gateWall);
          verdicts.push(admitted);
          cells.push(String(slots), String(b.fixtures.length * slots), admitted ? "yes" : "NO");
        }
        rows++;
        // The number the report owes: boards the gate USED to admit and now
        // refuses, i.e. competitions on which z3 is no longer called at all.
        if (verdicts[0] === true && verdicts[verdicts.length - 1] === false) flipped++;
        console.log(`| ${n} | ${pe} | ${cells.join(" | ")} |`);
      }
    }
    console.log(
      `\nadmitted at ${rests[0]} but refused at ${rests[rests.length - 1]}: ${flipped} of ${rows} boards.`,
    );
    return;
  }
  if (probe === "boot") {
    const out = spawnChild(["--probe=boot", "--child=1", `--reps=${arg("reps", "5")}`], 300_000);
    console.log(JSON.stringify(out, null, 2));
    return;
  }
  if (probe === "encode") {
    for (const n of nums("sizes", "200")) {
      for (const pe of nums("per-entrant", "2")) {
        const out = spawnChild(
          [
            "--probe=encode",
            "--child=1",
            `--sizes=${n}`,
            `--per-entrant=${pe}`,
            `--slack=${slack}`,
            `--hard-rest=${hardRestMin}`,
            `--day-cap=${dayCap}`,
            `--off-grid=${offGridMin}`,
            `--not-after=${notAfterEntrants}`,
            `--success-rlimit=${arg("success-rlimit", "100000000")}`,
            `--sat-k=${arg("sat-k", "0")}`,
          ],
          600_000,
        );
        console.log(JSON.stringify(out, null, 2));
      }
    }
    return;
  }

  const sizes = nums("sizes", "10,20,40,60,80,120,200");
  const perEntrants = nums("per-entrant", "2,4");
  const repeats = Number(arg("repeats", "1"));
  const rlimit = Number(arg("rlimit", String(DEFAULT_BUILD_RLIMIT)));
  const wallMs = Number(arg("wall", String(DEFAULT_BUILD_WALL_MS)));

  console.log(
    `# build bench — rlimit ${rlimit}, wall ${wallMs} ms, slack ${slack}, hard rest ${hardRestMin} min, off-grid ${offGridMin} min, not-after ${notAfterEntrants} entrant(s), ${repeats} repeat(s), one child process per run\n`,
  );
  console.log(
    "| n | per-entrant | rep | slots | step | slack | days | cap | greedy placed | z3 placed | engine | status | tiers | expired | bound | improved | moved | lost | rlimit spent | elapsed ms | LNS windows |",
  );
  console.log("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");

  let aborts = 0;
  let runs = 0;
  for (const n of sizes) {
    for (const pe of perEntrants) {
      for (let rep = 0; rep < repeats; rep++) {
        runs++;
        const out = spawnChild(
          [
            `--case=${n}`,
            `--per-entrant=${pe}`,
            `--rep=${rep}`,
            `--rlimit=${rlimit}`,
            `--wall=${wallMs}`,
            `--slack=${slack}`,
            `--hard-rest=${hardRestMin}`,
            `--day-cap=${dayCap}`,
            `--off-grid=${offGridMin}`,
            `--not-after=${notAfterEntrants}`,
          ],
          wallMs * 4 + 180_000,
        );
        if (out !== null && typeof out === "object" && "abort" in out) {
          aborts++;
          const a = out as Abort;
          console.log(
            `| ${n} | ${pe} | ${rep} | — | — | — | — | — | — | — | **${a.kind}** (signal ${a.signal ?? "-"}, code ${a.code ?? "-"}) | — | — | — | — | — | — | — | — | — |`,
          );
          console.log(`<!-- ${a.tail} -->`);
          continue;
        }
        const row = out as CaseRow;
        console.log(
          `| ${row.n} | ${row.perEntrant} | ${row.rep} | ${row.slots} | ${row.stepMinutes} | ${f1(row.slackRealised)} | ${row.days} | ${row.dayCap} | ${row.g.placed}/${row.g.total} | ${row.z.placed}/${row.z.total} | ${row.engine} | ${row.status} | ${row.tiers} | ${row.expired} | ${whichBound(row)} | ${improvement(row)} | ${row.moved} | ${row.lost} | ${row.rlimitSpent} | ${f0(row.elapsedMs)} | ${row.lnsWindowRlimits.length === 0 ? "—" : row.lnsWindowRlimits.join("/")} |`,
        );
        console.log(
          `<!-- n=${row.n} pe=${row.perEntrant} rep=${row.rep} pool=${row.pool} greedy(mk=${f1(row.g.makespan)},idle=${f1(row.g.idle)},imb=${f1(row.g.imbalance)},ms=${f0(row.gElapsedMs)},rl=${row.gRlimitSpent},engine=${row.gEngine}) z3(mk=${f1(row.z.makespan)},idle=${f1(row.z.idle)},imb=${f1(row.z.imbalance)}) rss=${f0(row.rssPeakMB)}MB overCap=${row.overCap} -->`,
        );
      }
    }
  }
  console.log(`\nWASM aborts: ${aborts} of ${runs} runs.`);
}

await main();
