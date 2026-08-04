// The measurement behind DEFAULT_REPAIR_BUDGET_MS (#401 Task 6).
//
// #401's acceptance criterion is "measured solve times recorded at
// 50 / 120 / 250 / 500 movable, and the wall-clock budget set from that
// evidence". A constant picked by feel does not satisfy it, so this script
// produces the table and the table produces the constant.
//
// Two things it is careful about, because getting either wrong makes the
// measurement worthless:
//
//   1. **The phases are separated.** Prologue (verifier pre-check + WASM boot +
//      domain build), encode (every assertion, including the O(n²) pair loop)
//      and solve (feasibility probe + ascending-k walk) scale differently and a
//      budget derived from their sum alone cannot tell you which one to fix.
//      They come from `repairSchedule`'s own `onPhase`/`onProgress` hooks —
//      re-running the prologue from outside would time a warm cache.
//   2. **Every case runs in its own child process.** z3 can abort the whole
//      process from inside the WASM (an `_emscripten_resize_heap` OOM is not a
//      catchable exception), and an in-process bench would simply vanish at
//      that point, taking every earlier row with it. A child that dies is a
//      recorded ABORT row, which is itself a finding.
//
// Usage:
//   node --experimental-strip-types packages/engine/scripts/bench-repair.ts
//   node --experimental-strip-types packages/engine/scripts/bench-repair.ts \
//     --sizes=250,500 --densities=20,5 --repeats=3 --budget=60000
//
// Not collected by vitest: the suite's `include` is `src/**/*.test.ts` and
// `test/**/*.test.ts`, and this file is neither.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { validateAssignments } from "../src/scheduling/calendar.ts";
import { buildDomains, candidatePairs, maxSeparationMinutes } from "../src/scheduling/repair-domain.ts";
import { repairSchedule, type RepairPhase } from "../src/scheduling/repair.ts";
import { syntheticBoard } from "../src/scheduling/repair-synthetic-board.ts";
import { resetZ3 } from "../src/scheduling/z3-load.ts";

const MB = 1024 * 1024;

interface Row {
  n: number;
  clashEvery: number;
  rep: number;
  status: string;
  k: number | null;
  checks: number | null;
  clashes: number;
  days: number;
  conflicts: number;
  pairs: number;
  precheckMs: number;
  z3Ms: number;
  domainsMs: number;
  encodeMs: number;
  probeMs: number;
  searchMs: number;
  totalMs: number;
  rssPeakMB: number;
  externalPeakMB: number;
}

const arg = (name: string, fallback: string): string => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
};
const nums = (name: string, fallback: string): number[] =>
  arg(name, fallback)
    .split(",")
    .map((s) => Number(s.trim()));

// --- child: one case, one process -------------------------------------------

async function runCase(n: number, clashEvery: number, rep: number, budgetMs: number): Promise<Row> {
  const board = syntheticBoard({ n, clashEvery });
  const conflicts = validateAssignments(board.proposal, board.config, [], board.dependencies).length;

  let rssPeak = 0;
  let externalPeak = 0;
  const sample = (): void => {
    const m = process.memoryUsage();
    if (m.rss > rssPeak) rssPeak = m.rss;
    if (m.external > externalPeak) externalPeak = m.external;
  };
  sample();

  const phases = new Map<RepairPhase, number>();
  let firstProgressMs = -1;

  const result = await repairSchedule({
    proposal: board.proposal,
    config: board.config,
    dependencies: board.dependencies,
    budgetMs,
    onPhase: ({ phase, elapsedMs }) => {
      phases.set(phase, elapsedMs);
      sample();
    },
    onProgress: ({ elapsedMs }) => {
      if (firstProgressMs < 0) firstProgressMs = elapsedMs;
      sample();
    },
  });
  sample();

  const at = (p: RepairPhase): number => phases.get(p) ?? 0;
  const encodedAt = at("encoded");
  // Counting the pairs after the solve rather than before it: the same call
  // inside `repairSchedule` is already accounted for in `encodeMs`, and doing
  // it first would hand the encode a warm JIT.
  const pairs = candidatePairs(
    buildDomains({ proposal: board.proposal, existing: [], config: board.config }),
    maxSeparationMinutes(board.config) * 60_000,
  ).length;

  return {
    n,
    clashEvery,
    rep,
    status: result.status,
    k: "k" in result ? result.k : "lastK" in result ? result.lastK : null,
    checks: "checks" in result ? result.checks : null,
    clashes: board.clashes,
    days: board.days,
    conflicts,
    pairs,
    precheckMs: at("precheck"),
    z3Ms: at("z3_ready") - at("precheck"),
    domainsMs: at("domains") - at("z3_ready"),
    encodeMs: encodedAt - at("domains"),
    probeMs: firstProgressMs < 0 ? result.elapsedMs - encodedAt : firstProgressMs - encodedAt,
    searchMs: firstProgressMs < 0 ? 0 : result.elapsedMs - firstProgressMs,
    totalMs: result.elapsedMs,
    rssPeakMB: rssPeak / MB,
    externalPeakMB: externalPeak / MB,
  };
}

// --- parent: the matrix ------------------------------------------------------

const HERE = fileURLToPath(import.meta.url);

function spawnCase(
  n: number,
  clashEvery: number,
  rep: number,
  budgetMs: number,
): Row | { abort: true; kind: string; signal: string | null; code: number | null; tail: string } {
  const r = spawnSync(
    process.execPath,
    [
      "--experimental-strip-types",
      HERE,
      `--case=${n}`,
      `--clash-every=${clashEvery}`,
      `--rep=${rep}`,
      `--budget=${budgetMs}`,
    ],
    // The driver's own deadline, well clear of the solver's: a child that
    // overruns its budget is a DIFFERENT finding from one that dies inside the
    // WASM, and a driver that hangs records neither.
    { encoding: "utf8", maxBuffer: 32 * MB, timeout: budgetMs * 3 + 60_000 },
  );
  const line = (r.stdout ?? "").split("\n").find((l) => l.startsWith("RESULT "));
  if (line !== undefined) return JSON.parse(line.slice(7)) as Row;
  const tail = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim().split("\n").slice(-4).join(" | ");
  const kind = r.error?.message.includes("ETIMEDOUT") === true ? "DRIVER-TIMEOUT" : "WASM-ABORT";
  return { abort: true, kind, signal: r.signal ?? null, code: r.status ?? null, tail };
}

const f0 = (x: number): string => x.toFixed(0);

async function main(): Promise<void> {
  const caseN = arg("case", "");
  if (caseN !== "") {
    const row = await runCase(
      Number(caseN),
      Number(arg("clash-every", "20")),
      Number(arg("rep", "0")),
      Number(arg("budget", "60000")),
    );
    console.log(`RESULT ${JSON.stringify(row)}`);
    await resetZ3();
    return;
  }

  const sizes = nums("sizes", "50,120,250,500");
  const densities = nums("densities", "20,5");
  const repeats = Number(arg("repeats", "3"));
  const budgetMs = Number(arg("budget", "60000"));

  console.log(
    `# repair bench — budget ${budgetMs} ms per solve, ${repeats} repeat(s), one child process per run\n`,
  );
  console.log(
    "| n | clash/1-in | rep | budget ms | pairs | conflicts | prologue ms | encode ms | probe ms | search ms | total ms | k | checks | status | peak RSS MB |",
  );
  console.log("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");

  let aborts = 0;
  let runs = 0;
  for (const n of sizes) {
    for (const clashEvery of densities) {
      for (let rep = 0; rep < repeats; rep++) {
        runs++;
        const out = spawnCase(n, clashEvery, rep, budgetMs);
        if ("abort" in out) {
          aborts++;
          console.log(
            `| ${n} | ${clashEvery} | ${rep} | ${budgetMs} | — | — | — | — | — | — | — | — | — | **${out.kind}** (signal ${out.signal ?? "-"}, code ${out.code ?? "-"}) | — |`,
          );
          console.log(`|  |  |  |  |  |  |  |  |  |  |  |  | ${out.tail} |  |`);
          continue;
        }
        const prologue = out.precheckMs + out.z3Ms + out.domainsMs;
        console.log(
          `| ${out.n} | ${out.clashEvery} | ${out.rep} | ${budgetMs} | ${out.pairs} | ${out.conflicts} | ${f0(prologue)} | ${f0(out.encodeMs)} | ${f0(out.probeMs)} | ${f0(out.searchMs)} | ${f0(out.totalMs)} | ${out.k ?? "—"} | ${out.checks ?? "—"} | ${out.status} | ${f0(out.rssPeakMB)} |`,
        );
        console.log(
          `<!-- n=${out.n} d=${out.clashEvery} rep=${out.rep} precheck=${f0(out.precheckMs)} z3boot=${f0(out.z3Ms)} domains=${f0(out.domainsMs)} clashes=${out.clashes} days=${out.days} external=${f0(out.externalPeakMB)}MB -->`,
        );
      }
    }
  }
  console.log(`\nWASM aborts: ${aborts} of ${runs} runs.`);
}

await main();
