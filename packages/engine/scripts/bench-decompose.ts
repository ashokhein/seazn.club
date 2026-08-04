// The measurement behind decomposed repair (#401, boundary 4).
//
// #401 locks "no fixture-count gate — solve the full 500-movable range", and
// `bench-repair.ts` proved the single solve cannot: from about 80 movable up the
// bare feasibility probe does not return in 119 s. This script is the evidence
// that decomposition does, and it is the only place the 500-movable numbers are
// produced — they take minutes, so they are NOT in the vitest suite. The suite
// carries the properties (partition, reset, gate, guard, anytime, determinism)
// at sizes it can afford; this carries the scale claim.
//
// Run it by hand, and paste the table into the commit or the ledger:
//
//   node --experimental-strip-types packages/engine/scripts/bench-decompose.ts
//   node --experimental-strip-types packages/engine/scripts/bench-decompose.ts \
//     --sizes=120,250,500 --densities=20,5 --component-budget=20000
//
// One CHILD PROCESS per case, for the same reason `bench-repair.ts` uses one: a
// WASM abort is not a catchable exception, and an in-process bench would vanish
// at that point taking every earlier row with it. A child that dies is a
// recorded ABORT row, which is itself the finding.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { validateAssignments } from "../src/scheduling/calendar.ts";
import {
  repairComponents,
  repairDecomposed,
  type RepairComponentReport,
} from "../src/scheduling/repair-decompose.ts";
import { singleComponentBoard, syntheticBoard } from "../src/scheduling/repair-synthetic-board.ts";
import { resetZ3 } from "../src/scheduling/z3-load.ts";

const MB = 1024 * 1024;

interface Row {
  n: number;
  clashEvery: number;
  pathological: boolean;
  status: string;
  mode: string;
  clashes: number;
  conflictsBefore: number;
  conflictsAfter: number;
  components: number;
  maxComponent: number;
  solved: number;
  skipped: number;
  k: number;
  lowerBound: number;
  verdict: string;
  caveats: string[];
  checks: number;
  graphMs: number;
  totalMs: number;
  worstComponentMs: number;
  worstComponentN: number;
  rssPeakMB: number;
}

const arg = (name: string, fallback: string): string => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
};
const nums = (name: string, fallback: string): number[] =>
  arg(name, fallback).split(",").map(Number);

async function runCase(
  n: number,
  clashEvery: number,
  pathological: boolean,
  componentBudgetMs: number,
  budgetMs: number,
  componentLimit: number,
): Promise<Row> {
  const board = pathological
    ? singleComponentBoard({ n, clashEvery })
    : syntheticBoard({ n, clashEvery });
  let rssPeak = process.memoryUsage().rss;
  const sample = (): void => {
    rssPeak = Math.max(rssPeak, process.memoryUsage().rss);
  };

  const before = validateAssignments(board.proposal, board.config, [], board.dependencies);
  const tGraph = performance.now();
  const components = repairComponents(board);
  const graphMs = performance.now() - tGraph;

  const reports: RepairComponentReport[] = [];
  const t0 = performance.now();
  const r = await repairDecomposed({
    proposal: board.proposal,
    existing: [],
    dependencies: board.dependencies,
    config: board.config,
    budgetMs,
    componentBudgetMs,
    componentLimit,
    onComponent: (report) => {
      reports.push(report);
      sample();
    },
  });
  const totalMs = performance.now() - t0;
  sample();

  const after = validateAssignments(r.assignments, board.config, [], board.dependencies);
  const worst = reports.reduce(
    (acc, c) => (c.elapsedMs > acc.elapsedMs ? c : acc),
    { elapsedMs: 0, size: 0 } as RepairComponentReport,
  );
  return {
    n,
    clashEvery,
    pathological,
    status: r.status,
    mode: r.mode,
    clashes: board.clashes,
    conflictsBefore: before.length,
    conflictsAfter: after.length,
    components: components.length,
    maxComponent: components.reduce((m, c) => Math.max(m, c.fixtureIds.length), 0),
    solved: reports.filter((c) => c.outcome === "repaired").length,
    skipped: reports.filter((c) => c.outcome !== "repaired" && c.outcome !== "clean").length,
    k: r.k,
    lowerBound: r.minimality.lowerBound,
    verdict: r.minimality.verdict,
    caveats: [...r.minimality.caveats],
    checks: r.checks,
    graphMs,
    totalMs,
    worstComponentMs: worst.elapsedMs,
    worstComponentN: worst.size,
    rssPeakMB: rssPeak / MB,
  };
}

const HERE = fileURLToPath(import.meta.url);

function spawnCase(
  n: number,
  clashEvery: number,
  pathological: boolean,
  componentBudgetMs: number,
  budgetMs: number,
  componentLimit: number,
): Row | { abort: true; kind: string; signal: string | null; code: number | null; tail: string } {
  const child = spawnSync(
    process.execPath,
    [
      "--experimental-strip-types",
      HERE,
      `--case=${n}`,
      `--clash-every=${clashEvery}`,
      `--path=${pathological ? 1 : 0}`,
      `--component-budget=${componentBudgetMs}`,
      `--budget=${budgetMs}`,
      `--component-limit=${componentLimit}`,
    ],
    { encoding: "utf8", maxBuffer: 32 * MB, timeout: budgetMs + 120_000 },
  );
  const line = (child.stdout ?? "").split("\n").find((l) => l.startsWith("RESULT "));
  if (line !== undefined) return JSON.parse(line.slice(7)) as Row;
  const tail = `${child.stdout ?? ""}${child.stderr ?? ""}`.trim().split("\n").slice(-4).join(" | ");
  const kind = child.error?.message.includes("ETIMEDOUT") === true ? "DRIVER-TIMEOUT" : "WASM-ABORT";
  return { abort: true, kind, signal: child.signal ?? null, code: child.status ?? null, tail };
}

const f0 = (x: number): string => x.toFixed(0);
const f1 = (x: number): string => x.toFixed(1);

async function main(): Promise<void> {
  const componentBudgetMs = Number(arg("component-budget", "20000"));
  const budgetMs = Number(arg("budget", "600000"));
  const componentLimit = Number(arg("component-limit", "50"));
  const caseN = arg("case", "");
  if (caseN !== "") {
    const row = await runCase(
      Number(caseN),
      Number(arg("clash-every", "20")),
      arg("path", "0") === "1",
      componentBudgetMs,
      budgetMs,
      componentLimit,
    );
    console.log(`RESULT ${JSON.stringify(row)}`);
    await resetZ3();
    return;
  }

  const sizes = nums("sizes", "120,250,500");
  const densities = nums("densities", "20,5");
  const pathological = arg("path", "0") === "1";

  console.log(
    `# decomposed repair bench — ${componentBudgetMs} ms per component, ${budgetMs} ms per call, limit ${componentLimit}\n`,
  );
  console.log(
    "| n | 1-in | comps | max comp | solved | skipped | graph ms | total ms | worst comp ms (n) | k | lower bound | verdict | conflicts after | status | peak RSS MB |",
  );
  console.log("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");

  let aborts = 0;
  let runs = 0;
  for (const n of sizes) {
    for (const clashEvery of densities) {
      runs++;
      const out = spawnCase(n, clashEvery, pathological, componentBudgetMs, budgetMs, componentLimit);
      if ("abort" in out) {
        aborts++;
        console.log(
          `| ${n} | ${clashEvery} | — | — | — | — | — | — | — | — | — | — | — | **${out.kind}** (signal ${out.signal ?? "-"}, code ${out.code ?? "-"}) | — |`,
        );
        console.log(`|  |  |  |  |  |  |  |  |  |  |  |  |  | ${out.tail} |  |`);
        continue;
      }
      console.log(
        `| ${out.n} | ${out.clashEvery} | ${out.components} | ${out.maxComponent} | ${out.solved} | ${out.skipped} | ${f1(out.graphMs)} | ${f0(out.totalMs)} | ${f0(out.worstComponentMs)} (${out.worstComponentN}) | ${out.k} | ${out.lowerBound} | ${out.verdict} | ${out.conflictsAfter} | ${out.status} | ${f0(out.rssPeakMB)} |`,
      );
      console.log(
        `<!-- n=${out.n} d=${out.clashEvery} mode=${out.mode} clashes=${out.clashes} conflictsBefore=${out.conflictsBefore} checks=${out.checks} caveats=${out.caveats.join("+") || "none"} -->`,
      );
    }
  }
  console.log(`\nWASM aborts: ${aborts} of ${runs} runs.`);
}

await main();
