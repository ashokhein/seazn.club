// TEMPORARY investigation tool (REFLOW CP-SAT bench, not committed by this
// pass). Bridges the real z3 repair solver / real verifier to a Python CP-SAT
// bench so CP-SAT's output can be checked against production code directly,
// not a hand-rolled reimplementation of the rules.
//
// Usage:
//   node --experimental-strip-types packages/engine/scripts/repair-cpsat-harness.ts gen --n=20 --clashEvery=5 [--seed=N] [--single=1]
//   node --experimental-strip-types packages/engine/scripts/repair-cpsat-harness.ts solve-z3 < board.json
//   node --experimental-strip-types packages/engine/scripts/repair-cpsat-harness.ts verify < assignments-and-config.json
import { validateAssignments } from "../src/scheduling/calendar.ts";
import { repairSchedule } from "../src/scheduling/repair.ts";
import { syntheticBoard, singleComponentBoard } from "../src/scheduling/repair-synthetic-board.ts";
import { resetZ3 } from "../src/scheduling/z3-load.ts";

const arg = (name: string, fallback: string): string => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
};

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<void> {
  const cmd = process.argv[2];

  if (cmd === "gen") {
    const n = Number(arg("n", "20"));
    const clashEvery = Number(arg("clashEvery", "5"));
    const seed = arg("seed", "");
    const single = arg("single", "") === "1";
    const board = single
      ? singleComponentBoard({ n, clashEvery })
      : syntheticBoard({ n, clashEvery, ...(seed !== "" ? { seed: Number(seed) } : {}) });
    console.log(JSON.stringify(board));
    return;
  }

  if (cmd === "solve-z3") {
    const input = JSON.parse(await readStdin());
    const budgetMs = Number(arg("budget", "60000"));
    const t0 = performance.now();
    const result = await repairSchedule({
      proposal: input.proposal,
      existing: input.existing ?? [],
      dependencies: input.dependencies ?? [],
      config: input.config,
      budgetMs,
    });
    const elapsedMs = performance.now() - t0;
    console.log(JSON.stringify({ result, elapsedMs }));
    await resetZ3();
    return;
  }

  if (cmd === "verify") {
    const input = JSON.parse(await readStdin());
    const conflicts = validateAssignments(
      input.assignments,
      input.config,
      input.existing ?? [],
      input.dependencies ?? [],
    );
    console.log(JSON.stringify({ conflicts, conflictCount: conflicts.length }));
    return;
  }

  console.error(`unknown command ${String(cmd)}; use gen | solve-z3 | verify`);
  process.exitCode = 1;
}

await main();
