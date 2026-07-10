// Deterministic simulation runner — PROMPT-14 §3, upgraded by PROMPT-38
// (v3/09 §3) with a full coverage matrix and a machine-readable report.
//
//   npm run sim:replay -- <sport:format:seed>       # replay one failure
//   npm run sim:replay -- sim-failures/<a>.json     # replay a CI artifact
//   npm run sim:matrix                              # full matrix + report
//   npm run sim:matrix -- --seeds 3 --report out.json   # bounded profile
//
// Matrix mode runs every registered sport module × every stage-graph template
// × N seeds, plus the permanent scenario suites (undo storms, set-end boundary
// matrices, officials, custom points, carry-over, americano, ladder), writes
// `packages/engine/sim-report.json` and prints a table. Every failure line
// carries the reproducing seed token — determinism (engine ground rule 1)
// makes each one replayable via the first form.
import { readFileSync, writeFileSync } from "node:fs";
import { builtinModules } from "../src/sports/index.ts";
import {
  assertDivisionInvariants,
  FORMAT_TEMPLATES,
  parseSeedToken,
  simOptionsFor,
  simulateDivision,
  SimInvariantError,
  type FormatTemplate,
} from "../src/testkit/simulation.ts";
import {
  runAmericanoScenario,
  runBoundaryMatrices,
  runCarryOverScenario,
  runCustomPointsScenario,
  runLadderScenario,
  runOfficialsScenario,
  runUndoStorm,
} from "../src/testkit/scenarios.ts";

interface MatrixCell {
  sport: string;
  format: FormatTemplate;
  seeds: number;
  fixtures: number;
  events: number;
  injectionsApplied: number;
  injectionsRejected: number;
  ok: boolean;
}

interface Failure {
  where: string; // seed token or scenario id — the reproduction handle
  error: string;
  detail?: unknown;
}

interface SimReport {
  version: 2;
  startedAt: string;
  durationMs: number;
  seedsPerCell: number;
  divisionMatrix: MatrixCell[];
  scenarios: {
    undoStorm: { sport: string; positions: number; accepted: number; rejected: number }[];
    boundaryMatrix: { preset: string; cases: number }[];
    officials: { fixtures: number; assignments: number; blockConflicts: number } | null;
    customPoints: { sport: string; fixtures: number }[];
    carryOver: { rows: number } | null;
    americano: { sport: string; players: number; rounds: number; matches: number }[];
    ladder: { sport: string; entrants: number; challenges: number; swaps: number }[];
  };
  coverage: {
    modules: string[];
    formats: string[];
    scenarios: string[];
  };
  failures: Failure[];
}

function fail(failures: Failure[], where: string, error: unknown): void {
  failures.push({
    where,
    error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    ...(error instanceof SimInvariantError && error.detail !== undefined
      ? { detail: error.detail }
      : {}),
  });
  console.error(`  FAIL ${where}\n       ${error instanceof Error ? error.message : String(error)}`);
  if (where.includes(":")) console.error(`       reproduce: npm run sim:replay -- ${where}`);
}

// ---------------------------------------------------------------------------
// Replay mode (unchanged contract): one token, exit non-zero on reproduction.
// ---------------------------------------------------------------------------

function replayToken(tokenArg: string): never {
  const token = tokenArg.endsWith(".json")
    ? (JSON.parse(readFileSync(tokenArg, "utf8")) as { seedToken: string }).seedToken
    : tokenArg;
  const { sport, format, seed } = parseSeedToken(token);
  const module = builtinModules.find((m) => m.key === sport);
  if (module === undefined) {
    console.error(`unknown sport "${sport}" — shipped: ${builtinModules.map((m) => m.key).join(", ")}`);
    process.exit(2);
  }

  const opts = simOptionsFor(module, format, seed);
  console.log(`replaying ${token} …`);
  try {
    const sim = simulateDivision(opts);
    const fixtures = sim.stages.reduce((acc, stage) => acc + stage.fixtures.length, 0);
    const events = sim.stages.reduce(
      (acc, stage) => acc + stage.fixtures.reduce((a, f) => a + f.events.length, 0),
      0,
    );
    console.log(
      `  entrants=${sim.entrants.length} stages=[${sim.stages.map((s) => `${s.id}:${s.kind}`).join(", ")}] fixtures=${fixtures} events=${events}`,
    );
    if (sim.injection !== undefined) {
      console.log(
        `  void injection: fixture=${sim.injection.fixtureId} event=${sim.injection.voidedEventId} applied=${sim.injection.applied}${sim.injection.rejectedCode === undefined ? "" : ` rejected=${sim.injection.rejectedCode}`} outcomeChanged=${sim.injection.outcomeChanged}`,
      );
    }
    console.log(
      `  champion=${sim.champion} finalRanks=[${sim.finalRanks.slice(0, 8).join(", ")}${sim.finalRanks.length > 8 ? ", …" : ""}]`,
    );

    assertDivisionInvariants(sim, module, opts.cfg);
    console.log("  invariants: OK");

    const replay = simulateDivision(opts);
    if (JSON.stringify(replay) !== JSON.stringify(sim)) {
      console.error("  determinism: FAILED — the same seed produced a different division");
      process.exit(1);
    }
    console.log("  determinism: OK (double run byte-identical)");
    process.exit(0);
  } catch (error) {
    console.error("  failure reproduced:");
    if (error instanceof SimInvariantError) {
      console.error(`  ${error.message}`);
      if (error.detail !== undefined) console.error(`  detail: ${JSON.stringify(error.detail)}`);
    } else {
      console.error(error);
    }
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Matrix mode.
// ---------------------------------------------------------------------------

function runMatrix(seedsPerCell: number, reportPath: string): never {
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const failures: Failure[] = [];
  const cells: MatrixCell[] = [];

  console.log(
    `sim matrix: ${builtinModules.length} modules × ${FORMAT_TEMPLATES.length} formats × ${seedsPerCell} seeds`,
  );

  for (const module of builtinModules) {
    for (const format of FORMAT_TEMPLATES) {
      const cell: MatrixCell = {
        sport: module.key,
        format,
        seeds: 0,
        fixtures: 0,
        events: 0,
        injectionsApplied: 0,
        injectionsRejected: 0,
        ok: true,
      };
      for (let seed = 1; seed <= seedsPerCell; seed++) {
        const token = `${module.key}:${format}:${seed}`;
        try {
          const opts = simOptionsFor(module, format, seed);
          const sim = simulateDivision(opts);
          assertDivisionInvariants(sim, module, opts.cfg);
          if (seed === 1) {
            // Determinism slice: the first seed of every cell double-runs.
            const replay = simulateDivision(opts);
            if (JSON.stringify(replay) !== JSON.stringify(sim)) {
              throw new SimInvariantError("determinism: double run diverged");
            }
          }
          cell.seeds++;
          cell.fixtures += sim.stages.reduce((a, s) => a + s.fixtures.length, 0);
          cell.events += sim.stages.reduce(
            (a, s) => a + s.fixtures.reduce((x, f) => x + f.events.length, 0),
            0,
          );
          if (sim.injection !== undefined) {
            if (sim.injection.applied) cell.injectionsApplied++;
            else cell.injectionsRejected++;
          }
        } catch (error) {
          cell.ok = false;
          fail(failures, token, error);
        }
      }
      cells.push(cell);
    }
  }

  // Scenario suites — the permanent regressions + Jul3 feature coverage.
  const scenarios: SimReport["scenarios"] = {
    undoStorm: [],
    boundaryMatrix: [],
    officials: null,
    customPoints: [],
    carryOver: null,
    americano: [],
    ladder: [],
  };

  for (const module of builtinModules) {
    try {
      const stats = runUndoStorm(module, 1);
      scenarios.undoStorm.push(stats);
    } catch (error) {
      fail(failures, `scenario:undo-storm:${module.key}`, error);
    }
    try {
      scenarios.customPoints.push(runCustomPointsScenario(module, 1));
    } catch (error) {
      fail(failures, `scenario:custom-points:${module.key}`, error);
    }
  }

  try {
    scenarios.boundaryMatrix = runBoundaryMatrices();
  } catch (error) {
    fail(failures, "scenario:boundary-matrix", error);
  }
  try {
    scenarios.officials = runOfficialsScenario(1);
  } catch (error) {
    fail(failures, "scenario:officials", error);
  }
  try {
    // Carry a real simulated league table (generic module, seed 1).
    const generic = builtinModules.find((m) => m.key === "generic");
    if (generic) {
      const opts = simOptionsFor(generic, "league", 1);
      const sim = simulateDivision(opts);
      const rows = sim.stages[0]?.tables?.pools[0]?.rows ?? [];
      scenarios.carryOver = runCarryOverScenario(rows as never);
    }
  } catch (error) {
    fail(failures, "scenario:carry-over", error);
  }
  // Americano/ladder run on the set-based + generic modules (the formats the
  // app offers them for); every module would multiply time without new signal.
  for (const key of ["badminton", "tabletennis", "generic"]) {
    const module = builtinModules.find((m) => m.key === key);
    if (!module) continue;
    try {
      scenarios.americano.push({ sport: key, ...runAmericanoScenario(module, 1) });
    } catch (error) {
      fail(failures, `scenario:americano:${key}`, error);
    }
    try {
      scenarios.ladder.push({ sport: key, ...runLadderScenario(module, 1) });
    } catch (error) {
      fail(failures, `scenario:ladder:${key}`, error);
    }
  }

  const report: SimReport = {
    version: 2,
    startedAt,
    durationMs: Date.now() - t0,
    seedsPerCell,
    divisionMatrix: cells,
    scenarios,
    coverage: {
      modules: builtinModules.map((m) => m.key),
      formats: [...FORMAT_TEMPLATES],
      scenarios: [
        "undo-storm",
        "boundary-matrix",
        "officials",
        "custom-points",
        "carry-over",
        "americano",
        "ladder",
      ],
    },
    failures,
  };
  writeFileSync(reportPath, JSON.stringify(report, null, 2));

  // Human table.
  console.log("\nsport        format           seeds  fixtures  events  inj+  inj-  ok");
  for (const cell of cells) {
    console.log(
      [
        cell.sport.padEnd(12),
        cell.format.padEnd(16),
        String(cell.seeds).padStart(5),
        String(cell.fixtures).padStart(9),
        String(cell.events).padStart(7),
        String(cell.injectionsApplied).padStart(5),
        String(cell.injectionsRejected).padStart(5),
        cell.ok ? "  ok" : "  FAIL",
      ].join(" "),
    );
  }
  const storms = scenarios.undoStorm.reduce((a, s) => a + s.positions, 0);
  const boundary = scenarios.boundaryMatrix.reduce((a, s) => a + s.cases, 0);
  console.log(
    `\nscenarios: undo-storm ${storms} positions · boundary ${boundary} cases · officials ${scenarios.officials?.assignments ?? 0} assignments · custom-points ${scenarios.customPoints.reduce((a, s) => a + s.fixtures, 0)} fixtures · carry-over ${scenarios.carryOver?.rows ?? 0} rows · americano ${scenarios.americano.reduce((a, s) => a + s.matches, 0)} matches · ladder ${scenarios.ladder.reduce((a, s) => a + s.challenges, 0)} challenges`,
  );
  console.log(`report: ${reportPath} (${report.durationMs} ms)`);

  if (failures.length > 0) {
    console.error(`\n${failures.length} failure(s) — each line above carries its reproduction handle.`);
    process.exit(1);
  }
  console.log("all green");
  process.exit(0);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
if (args.includes("--matrix") || args.length === 0) {
  const seedsFlag = args.indexOf("--seeds");
  const reportFlag = args.indexOf("--report");
  const seeds = seedsFlag >= 0 ? Number(args[seedsFlag + 1]) : Number(process.env.SIM_SEEDS ?? 5);
  const reportPath =
    reportFlag >= 0
      ? (args[reportFlag + 1] as string)
      : new URL("../sim-report.json", import.meta.url).pathname;
  if (!Number.isInteger(seeds) || seeds < 1) {
    console.error("--seeds must be a positive integer");
    process.exit(2);
  }
  runMatrix(seeds, reportPath);
}

const tokenArg = args.find((a) => !a.startsWith("--"));
if (tokenArg === undefined) {
  console.error(
    "usage: npm run sim:replay -- <sport:format:seed | path/to/failure.json>\n       npm run sim:matrix [-- --seeds N --report path]",
  );
  process.exit(2);
}
replayToken(tokenArg);
