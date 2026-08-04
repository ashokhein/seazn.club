// TEST SUPPORT ONLY (#401). Not exported from the scheduling barrel, never
// imported by the solver, and never reachable from `repairSchedule`.
//
// The repair tests assert wall-clock bounds on CPU-bound solver work, and this
// suite runs its files concurrently (`pool: "threads"`) beside whatever else is
// on the host. Measured on this machine: a fixed JS work unit cost 93 ms with
// the box quiet and 464 ms while another workspace's suite ran — five times
// slower, same machine, same code.
//
// Five times slower is enough to change what a test is testing. A 120-fixture
// encode costs 1.2 s at full speed; at 5x it no longer fits inside a 2.5 s
// budget, so the budget expires in the ENCODE, `checks` comes back 0, and a
// test whose whole point is "the budget binds inside the SOLVER, not only
// inside the encode" quietly stops reaching the solver at all. That is how
// three tests came to fail on a loaded host and pass on a quiet one — a suite
// that is green on an idle laptop and red in CI teaches nobody anything.
//
// Two different problems live in that sentence, and they need two different
// tools, which is why this file exports two things:
//
//   1. A bound on how far past its deadline a call may be NOTICED. That is a
//      real quantity that genuinely scales with the host, so it is measured
//      against the host — `measureLoadFactor` + `scaleForLoad`. The factor is
//      1 on a machine as fast as the reference, so the bar on a quiet box does
//      not move, and it rises only in proportion to demonstrated slowness, to
//      a ceiling.
//   2. A SCENARIO that requires the encode to finish so the solver is reached
//      at all. Scaling cannot fix that one honestly: the factor is sampled
//      once, before the run, and contention arriving mid-test would leave the
//      budget short again — the test would go back to passing vacuously on the
//      wrong code path. So the scenario is not estimated, it is OBSERVED:
//      `atABudgetThatReachesTheSolver` raises the budget until the result
//      itself shows the solver was reached, and hands back the budget it took.
//      If it never is, the caller's assertion fails honestly rather than
//      measuring something else. See its own comment.
//
// EITHER WAY IT SCALES TEST BOUNDS ONLY. Neither may ever scale a budget a
// CALLER passes: the web runner sizes its 45 s against `ROUND_TIMEOUT_MS` and
// against two full-ceiling components, and a slow host silently turning that
// into 225 s would leave an HTTP request waiting five times as long as the
// code says it will, invisibly. The honest answer on a slow host is the
// `timeout` and the LLM fallback #401 asks for, plus a number an operator can
// see — not a longer wait arranged behind the caller's back.
//
// `performance.now()` because ambient wall-clock reads are banned engine-wide
// (scripts/engine-boundary.ts), and this is an elapsed span.

/** Iterations per `workUnit()`. Sized so one unit costs tens of milliseconds:
 *  long enough to swamp timer resolution and JIT noise, short enough that
 *  calibrating a whole test file costs less than a tenth of a second. */
const UNIT_ITERATIONS = 1_000_000;

/**
 * Milliseconds one `workUnit()` costs on a reference host with cores to spare.
 *
 * Measured on the machine the #401 bench table was produced on (darwin arm64,
 * node v26.4.0): 23.1 ms, stable to about 0.5 ms across runs once the loop is
 * warm. A host faster than this yields a factor below 1, which is clamped away
 * — a fast machine must not be allowed to TIGHTEN a bound and start failing
 * for a reason nobody chose.
 *
 * If this constant is ever wrong LOW, every bound in every solver test is
 * silently multiplied on a perfectly healthy machine and the bounds stop
 * meaning anything. Re-measure it before changing `UNIT_ITERATIONS`.
 */
export const REFERENCE_UNIT_MS = 23;

/** Ceiling on the factor. A host more than this much slower than the reference
 *  is not one these bounds can be stretched to cover, and pretending otherwise
 *  would turn a real hang into a test that waits twenty minutes for it. */
export const MAX_LOAD_FACTOR = 6;

/** Integer arithmetic, no allocation, no I/O: the same resource the encode and
 *  z3 compete for, and nothing else. The result is returned so the loop cannot
 *  be optimised away. */
function workUnit(): number {
  const t0 = performance.now();
  let x = 0;
  for (let i = 0; i < UNIT_ITERATIONS; i++) x = (x * 31 + i) | 0;
  const ms = performance.now() - t0;
  // `x` is unused otherwise; reading it keeps the loop alive under a JIT that
  // would happily delete a pure computation nobody observes.
  return x === Number.MAX_SAFE_INTEGER ? -1 : ms;
}

/**
 * How much slower this host is, right now, than the one these bounds were
 * measured on. In `[1, MAX_LOAD_FACTOR]`.
 *
 * The BEST of four samples, not the mean: contention adds time and never
 * removes it, so the minimum is the honest estimate of what this box can do,
 * one unlucky sample cannot inflate every bound in the file, and the first
 * sample — which pays for JIT warm-up and reads about 25% high — is discarded
 * by that same rule without needing a special case. Costs under 100 ms at full
 * speed, and it is called once per test FILE rather than once per test.
 */
export function measureLoadFactor(): number {
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < 4; i++) best = Math.min(best, workUnit());
  const factor = best / REFERENCE_UNIT_MS;
  return Math.min(MAX_LOAD_FACTOR, Math.max(1, factor));
}

/**
 * A test-only bound, scaled to this host.
 *
 * Use it for wall-clock ASSERTIONS and for the slack around them. What such an
 * assertion then proves is not a fixed latency promise — it is that control
 * comes back within a bounded multiple of the deadline on THIS host, which is
 * the property #401 actually needs, because the failure it exists to prevent
 * is "never returns", not "returned in 3.1 s rather than 3.0 s".
 *
 * Never for a number that models what a production caller passes.
 */
export function scaleForLoad(ms: number, factor: number): number {
  return Math.ceil(ms * factor);
}

/**
 * Time a call and report the worst load seen on either side of it.
 *
 * Calibrating once per FILE looked cheap and is wrong: a file's module scope
 * runs at IMPORT time, which for the first files in a run is before the worker
 * pool has saturated. The factor then reads ~1 — the box really was quiet when
 * it was asked — and the bound it scales is applied to a call that ran while
 * every other suite was at full tilt. That is how this file passed alone and
 * failed inside the gate: not a wrong factor, a factor measured at the wrong
 * moment.
 *
 * So measure around the call rather than before the file. The WORST of the two
 * samples, because contention that arrives during the call and leaves before it
 * ends would otherwise be invisible to both. It is still an estimate — a spike
 * confined strictly to the middle escapes — but it cannot under-read the two
 * cases that actually happen here: a pool that ramps up after import, and one
 * that drains as other files finish.
 *
 * Costs ~150 ms per timed call at full speed, which is the price of a bound
 * that means the same thing alone and in the gate.
 */
export async function timedUnderLoad<T>(
  run: () => Promise<T>,
): Promise<{ result: T; wallMs: number; factor: number }> {
  const before = measureLoadFactor();
  const t0 = performance.now();
  const result = await run();
  const wallMs = performance.now() - t0;
  return { result, wallMs, factor: Math.max(before, measureLoadFactor()) };
}

/**
 * Run a solver call at the smallest budget, from `from` upward, that actually
 * gets as far as `check()`.
 *
 * Some tests are about what the solver's own clock does, and they can only ask
 * that question on a run where the solver was reached: the encode has to fit
 * inside the budget with enough left over that `check()` is entered and times
 * out there. On the authoring machine a fixed budget does that. On a host under
 * contention the same budget is eaten by the encode, the call returns `timeout`
 * with `checks: 0`, and every assertion after it is either vacuous or a false
 * failure.
 *
 * A calibrated multiplier is the wrong instrument for this one. It is sampled
 * once, before the run, so a machine that becomes busy between the calibration
 * and the call is short again — and being short is silent. This is an
 * observation instead: run, ask the RESULT whether the solver was reached, and
 * if not, double the budget and run again. Doubling converges in a step or two
 * at any plausible host speed and needs no constant that can go stale.
 *
 * Two properties matter, and both are deliberate:
 *
 *   - It never weakens an assertion. If every attempt is exhausted without
 *     reaching the solver, the last result is returned unchanged and the
 *     caller's `checks >= 1` fails, loudly, on the real problem.
 *   - It reports the budget it settled on, so the caller can bound the wall
 *     clock against the budget that was ACTUALLY in force rather than the one
 *     it asked for first.
 *
 * `run` is handed a budget and returns whatever the call under test produces;
 * it should do its own timing, because only the final attempt's wall clock
 * means anything.
 */
export async function atABudgetThatReachesTheSolver<T>(opts: {
  /** Budget to try first — the one the scenario was authored against. */
  readonly from: number;
  /** How many doublings to allow. `from × 2^(attempts-1)` is the ceiling. */
  readonly attempts: number;
  readonly run: (budgetMs: number) => Promise<T>;
  /** True when this result proves `check()` was entered. */
  readonly reachedSolver: (result: T) => boolean;
}): Promise<{ result: T; budgetMs: number; attempts: number }> {
  let budgetMs = opts.from;
  let result = await opts.run(budgetMs);
  let attempts = 1;
  while (!opts.reachedSolver(result) && attempts < opts.attempts) {
    budgetMs *= 2;
    result = await opts.run(budgetMs);
    attempts++;
  }
  return { result, budgetMs, attempts };
}
