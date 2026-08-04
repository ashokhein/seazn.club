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
 * It is PROCESS-WIDE, which is why `repairDecomposed` serialises itself: calling
 * this while another solve is inside `check()` on the same context terminates
 * the threads underneath it.
 *
 * `count` returns to zero, so `z3LoadCount()` reads "loads since the last reset"
 * — which is exactly what makes "a reset really did happen between those two
 * solves" assertable.
 */
export async function resetZ3(): Promise<void> {
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
