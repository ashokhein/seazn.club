// z3 is loaded LAZILY and ONCE (#401). The WASM must never touch the LLM-only
// path: a proposal that verifies clean, or a run that falls back to LLM repair,
// pays nothing for a solver it does not use. `z3LoadCount` exists so that
// property is a test rather than a promise.
//
// Determinism is configured HERE, not at the call site, so every solver in the
// process shares one seeded, single-threaded configuration.
export interface Z3Context {
  // Deliberately loose: z3-solver's generic `Context<Name>` types do not survive
  // being handed around, and the encoder uses only the documented surface.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Z3: any;
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
  loaded = (async () => {
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
  return loaded;
}

/** Test-only: drops the singleton and stops the worker threads node keeps alive. */
export async function resetZ3(): Promise<void> {
  if (loaded === null) return;
  const ctx = await loaded;
  ctx.shutdown();
  loaded = null;
  count = 0;
}
