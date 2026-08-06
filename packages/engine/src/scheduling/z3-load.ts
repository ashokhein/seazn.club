// z3 is loaded LAZILY and ONCE (#401). The WASM must never touch the LLM-only
// path: a proposal that verifies clean, or a run that falls back to LLM repair,
// pays nothing for a solver it does not use. `z3LoadCount` exists so that
// property is a test rather than a promise.
//
// Determinism is configured HERE, not at the call site, so every solver in the
// process shares one seeded, single-threaded configuration.
// `import type` is erased at compile time, so naming the context type costs
// nothing at runtime — it does NOT pull in or boot the WASM, which stays behind
// the dynamic `import("z3-solver")` in `loadZ3`.
import type { Context } from "z3-solver";

export interface Z3Context {
  Z3: Context<"repair">;
  shutdown: () => void;
}

let loaded: Promise<Z3Context> | null = null;
let count = 0;

export function z3LoadCount(): number {
  return count;
}

export async function loadZ3(): Promise<Z3Context> {
  if (loaded !== null) return loaded;
  count++;
  const attempt = (async () => {
    const { init } = await import("z3-solver");
    const { Context, em, setParam } = await init();
    // Single-threaded and unseeded-free: parallel portfolio solving picks
    // whichever thread finishes first, which is exactly the "the solver felt
    // different today" support ticket this wave refuses to file.
    setParam("parallel.enable", false);
    setParam("sat.random_seed", 0);
    setParam("smt.random_seed", 0);
    setParam("nlsat.seed", 0);
    return {
      Z3: Context("repair"),
      shutdown: () => em.PThread.terminateAllThreads(),
    };
  })();
  loaded = attempt;
  // A FAILED load must leave no trace. Caching the rejected promise made a
  // transient WASM boot failure permanent: every later caller got the same
  // rejection back, and `resetZ3` rethrew it before clearing anything — so the
  // process could never load z3 again.
  //
  // The identity guard matters: a `resetZ3` racing this rejection may already
  // have cleared the slot and a later `loadZ3` may already have filled it, and
  // this attempt must not tear down its successor.
  void attempt.catch(() => {
    if (loaded === attempt) {
      loaded = null;
      count--;
    }
  });
  return attempt;
}

/** The tail of the in-process solver queue. One WASM context, one solve at a
 *  time. */
let z3Queue: Promise<unknown> = Promise.resolve();

/**
 * Serialises everything that can touch the WASM, process-wide.
 *
 * `resetZ3` terminates the pthreads the whole process shares, so a reset
 * arriving while any solve is inside `check()` is the
 * `RuntimeError: memory access out of bounds` the reset exists to prevent,
 * reached by a different road. That is not hypothetical: `repairDecomposed`
 * resets between every component, and two web runners (the division one and the
 * competition one) each own a repair loop that a joint run can have in flight at
 * once. So the lock sits HERE, in front of the shared context, rather than
 * around any one caller — a queue on one entry point serialises that entry point
 * against itself and nothing else.
 *
 * Three properties, all load-bearing:
 *
 *   * chained through BOTH arms (`.then(work, work)`), so a rejected entrant
 *     still runs the next one;
 *   * the tail is reset through both arms as well, so a rejection releases the
 *     lock instead of wedging every later call behind it;
 *   * the tail is assigned SYNCHRONOUSLY with the read, so two callers in one
 *     turn cannot both chain off the same predecessor.
 *
 * NOT REENTRANT, deliberately — a lock a caller can take twice is a lock that
 * deadlocks the second time. It is taken by the leaves only: `repairSchedule`
 * and `resetZ3`. Everything else reaches the solver through one of those two —
 * `repairAndVerify` calls `repairSchedule` and then runs a pure verifier;
 * `repairDecomposed` takes it once per component solve and once per reset, which
 * is what lets a second caller in BETWEEN components rather than stalling it for
 * a 240 s decomposed budget. `loadZ3` does not take it, because it is called
 * from inside it; a boot is also harmless on its own, since it only ever hands
 * back the singleton.
 */
export function withZ3Lock<T>(work: () => Promise<T>): Promise<T> {
  const run = z3Queue.then(work, work);
  z3Queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/**
 * Drops the singleton and stops the worker threads node keeps alive.
 *
 * No longer test-only. `repairDecomposed` calls this BETWEEN component solves
 * and it is load-bearing there: many medium solves otherwise share one
 * monotonically-growing WASM heap, nothing frees the per-component `Solver`, and
 * the pthread worker dies with `RuntimeError: memory access out of bounds` (3 of
 * 3 runs without it, 0 of 3 with it). Teardown is about 1 ms; the next `loadZ3`
 * pays a 200-300 ms reboot.
 *
 * It is PROCESS-WIDE, which is why it runs UNDER `withZ3Lock`: calling this
 * while another solve is inside `check()` on the same context terminates the
 * threads underneath it. Waiting for the lock is why a reset can look slow —
 * the teardown itself is about 1 ms.
 *
 * `count` returns to zero, so `z3LoadCount()` reads "loads since the last reset"
 * — which is exactly what makes "a reset really did happen between those two
 * solves" assertable.
 */
export function resetZ3(): Promise<void> {
  return withZ3Lock(tearDownZ3);
}

/**
 * Run one whole solve under the lock, and hand the WASM heap back before
 * releasing it (R17).
 *
 * NOT HYGIENE — the process dies without it. One context is shared by every
 * solve in the process and its heap only ever GROWS: nothing frees a finished
 * `Solver`, so a server that has run a few auto-schedules aborts with
 * `Cannot enlarge memory arrays to size 2210201600 bytes (OOM)` and takes node
 * with it. Measured at six consecutive solves in one process.
 *
 * This exists so that ownership sits with the ENGINE rather than with whichever
 * caller happened to learn the lesson. The same fix written at a call seam is
 * one `finally` away from being dropped by the next entry point, and the symptom
 * is a dead production server rather than a failing test.
 *
 * THE TEARDOWN RUNS INSIDE THE LOCK, and the reason is heap ACCOUNTING, not
 * safety. `try { await withZ3Lock(work) } finally { await resetZ3() }` is the
 * obvious spelling and it is NOT unsafe: `resetZ3` takes the lock itself, so its
 * teardown can never land inside another solve's `check()`. What it loses is the
 * PAIRING. That reset queues behind every solve already waiting, so under
 * concurrency N solves share one un-freed context before the first teardown
 * fires — and N solves on one monotonically-growing heap is exactly the OOM
 * above. Holding the lock across both makes the bound per SOLVE rather than per
 * burst.
 *
 * Recorded because it cost a test: the difference is NOT observable from
 * `z3LoadCount()` across two queued solves. Both spellings run every solve to
 * completion and both end at zero. A case claiming to pin the ordering was
 * written, measured to survive the mutant, and deleted rather than kept as a
 * green assertion about nothing.
 *
 * `work` MUST NOT take the lock itself. `withZ3Lock` is deliberately not
 * reentrant, so anything reaching `repairSchedule`, `repairDecomposed` or
 * `resetZ3` from in here deadlocks rather than failing. `buildSchedule` is the
 * intended caller: its LNS pass re-enters `solveBuild`, never `buildSchedule`,
 * for precisely this reason.
 *
 * In a `finally`, because a solve that THREW allocated just as much as one that
 * returned. The cost is a 200-300 ms reboot on the next `loadZ3`, and it is a
 * no-op when the WASM never booted at all.
 */
export function withZ3LockAndReset<T>(work: () => Promise<T>): Promise<T> {
  return withZ3Lock(async () => {
    try {
      return await work();
    } finally {
      await tearDownZ3();
    }
  });
}

async function tearDownZ3(): Promise<void> {
  if (loaded === null) return;
  try {
    const ctx = await loaded;
    ctx.shutdown();
  } finally {
    // In a `finally` so a throwing `shutdown` (or a load that rejects between
    // the null check and the await) cannot strand the singleton — the whole
    // point of a reset is that the next `loadZ3` starts clean.
    loaded = null;
    count = 0;
  }
}
