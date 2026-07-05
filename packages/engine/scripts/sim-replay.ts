// Deterministic simulation replay — PROMPT-14 §3.
//
//   npm run sim:replay -- <sport:format:seed>
//   npm run sim:replay -- sim-failures/<artifact>.json
//
// Re-runs the exact division a CI failure artifact points at (same seed ⇒ same
// entrant count, fixture ids, event ids, injection), re-checks the global
// invariants and the double-run determinism property, and exits non-zero when
// the failure reproduces.
import { readFileSync } from "node:fs";
import { builtinModules } from "../src/sports/index.ts";
import {
  assertDivisionInvariants,
  parseSeedToken,
  simOptionsFor,
  simulateDivision,
  SimInvariantError,
} from "../src/testkit/simulation.ts";

const arg = process.argv[2];
if (arg === undefined) {
  console.error("usage: npm run sim:replay -- <sport:format:seed | path/to/failure.json>");
  process.exit(2);
}

const token = arg.endsWith(".json")
  ? (JSON.parse(readFileSync(arg, "utf8")) as { seedToken: string }).seedToken
  : arg;
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
  console.log(`  champion=${sim.champion} finalRanks=[${sim.finalRanks.slice(0, 8).join(", ")}${sim.finalRanks.length > 8 ? ", …" : ""}]`);

  assertDivisionInvariants(sim, module, opts.cfg);
  console.log("  invariants: OK");

  const replay = simulateDivision(opts);
  if (JSON.stringify(replay) !== JSON.stringify(sim)) {
    console.error("  determinism: FAILED — the same seed produced a different division");
    process.exit(1);
  }
  console.log("  determinism: OK (double run byte-identical)");
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
