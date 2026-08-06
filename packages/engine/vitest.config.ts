import { availableParallelism, totalmem } from "node:os";
import { defineConfig } from "vitest/config";

/**
 * THIS SUITE IS BOUNDED BY MEMORY, NOT BY CORES.
 *
 * 17 of the 111 files boot a z3 WASM solver, each with a heap that only ever
 * grows — `resetZ3()` cannot hand memory back — and vitest starts ten of them
 * together. On a 12-core / 16 GB box that killed one worker per run with a bare
 * `STACK_TRACE_ERROR`, in a DIFFERENT innocent file each time
 * (`testkit/golden`, `scheduling/roundrobin`, `officials/assign.property`,
 * `testkit/simulation` — none of them z3 tests), which is exactly why it read
 * as flake rather than as memory pressure.
 *
 * Capping the pool fixes it and is also FASTER, because eleven workers on
 * twelve cores thrash. Everything below was measured on a full run, not
 * reasoned about:
 *
 *   uncapped, one pool     69-71 s   a dead worker most runs
 *   `isolate: true`        75 s      still dead — the cost is CONCURRENT, not
 *                                    cumulative, so isolation cannot help
 *   `pool: "forks"`        79-130 s  still dead, and much slower: process
 *                                    isolation is not the missing ingredient
 *   capped at 5            46-57 s   green over repeated runs
 *
 * ~3 GB per worker reproduces the cap validated on this 16 GB box. The core
 * count still bounds it on a many-core / small-memory machine, and the floor of
 * 2 keeps a constrained CI runner from serialising outright.
 *
 * A TWO-PROJECT SPLIT WAS TRIED AND REJECTED — z3 files at the memory cap, the
 * 94 pure-TS files at full core count. Vitest 4 refuses it: "Projects 'unit'
 * and 'z3' have different 'maxWorkers' but same 'sequence.groupOrder'". Projects
 * SHARE ONE POOL, so differing caps must run in separate serial groups — which
 * removes the entire point, since the win depended on the light files filling
 * the gaps between heavy solves. One capped pool already does that.
 *
 * NOT the cause, though it looked like it twice: the intermittent
 * `build-lns-wiring` failures were `vi.doMock` going inert because
 * `isolate: false` shares the MODULE CACHE across files in a worker. Fixed in
 * that test, not here — see its header.
 */
const GB = 1024 ** 3;
const maxWorkers = Math.max(
  2,
  Math.min(availableParallelism() - 1, Math.floor(totalmem() / (3 * GB))),
);

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    pool: "threads",
    isolate: false,
    maxWorkers,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/**/index.ts"],
      // PROMPT-14 §4 gate: ≥90% lines across the engine; the fold kernel and
      // the tiebreaker cascade must be fully covered.
      thresholds: {
        lines: 90,
        "src/core/**/*.ts": { lines: 100 },
        "src/competition/tiebreakers.ts": { lines: 100 },
      },
    },
  },
});
