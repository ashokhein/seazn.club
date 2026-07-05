// Tournament simulation harness — PROMPT-14. Every registered sport module ×
// every stage-graph template runs SIM_RUNS seeded full divisions; each division
// is checked against the global invariants and (on a slice) exact replay
// determinism. Failures dump a reproduction artifact: `npm run sim:replay --
// <seedToken>` re-runs that exact division.
//
// Budget: SIM_RUNS env — CI defaults to 200 per sport×format, local runs to 25,
// the nightly workflow_dispatch/cron job passes 10000.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { builtinModules } from "../sports/index.ts";
import type { AnySportModule } from "../sport/module.ts";
import {
  assertDivisionInvariants,
  canVoidFixtureEvent,
  FORMAT_TEMPLATES,
  SIM_CONFIGS,
  simOptionsFor,
  simulateDivision,
  SimInvariantError,
  type FormatTemplate,
  type SimulationResult,
} from "./simulation.ts";

const SIM_RUNS = Number(process.env.SIM_RUNS ?? (process.env.CI ? 200 : 25));

const FAILURE_DIR = new URL("../../sim-failures", import.meta.url).pathname;

// Dump the failing division (seed token + full event streams) for exact
// offline reproduction, then rethrow (PROMPT-14 §3).
function dumpFailure(token: string, error: unknown, sim?: SimulationResult): void {
  mkdirSync(FAILURE_DIR, { recursive: true });
  const file = join(FAILURE_DIR, `${token.replaceAll(":", "_")}.json`);
  writeFileSync(
    file,
    JSON.stringify(
      {
        seedToken: token,
        replay: `npm run sim:replay -- ${token}`,
        error: error instanceof Error ? { name: error.name, message: error.message } : String(error),
        detail: error instanceof SimInvariantError ? error.detail : undefined,
        simulation: sim,
      },
      null,
      2,
    ),
  );
  // eslint-disable-next-line no-console
  console.error(`simulation failure artifact written: ${file}`);
}

function runOne(module: AnySportModule, format: FormatTemplate, seed: number): SimulationResult {
  const opts = simOptionsFor(module, format, seed);
  const token = `${module.key}:${format}:${seed}`;
  let sim: SimulationResult | undefined;
  try {
    sim = simulateDivision(opts);
    assertDivisionInvariants(sim, module, opts.cfg);
    if (seed % 10 === 1) {
      // Deterministic replay: same seed ⇒ identical fixture ids, event ids and
      // final standings (PROMPT-14 §1).
      const replay = simulateDivision(opts);
      expect(JSON.stringify(replay)).toBe(JSON.stringify(sim));
    }
    if (sim.injection !== undefined && !sim.injection.applied) {
      expect(sim.injection.rejectedCode).toBeTruthy();
    }
    return sim;
  } catch (error) {
    dumpFailure(token, error, sim);
    throw error;
  }
}

for (const module of builtinModules) {
  describe(`simulation — ${module.key}@${module.version}`, () => {
    for (const format of FORMAT_TEMPLATES) {
      it(
        `${format}: ${SIM_RUNS} seeded divisions hold the global invariants`,
        // Nightly runs pass SIM_RUNS=10000 — budget the timeout accordingly.
        { timeout: Math.max(60_000, SIM_RUNS * 300) },
        () => {
          for (let seed = 1; seed <= SIM_RUNS; seed++) {
            runOne(module, format, seed);
          }
        },
      );
    }
  });
}

describe("rank_locked guard (PROMPT-14 §1)", () => {
  const generic = builtinModules.find((m) => m.key === "generic") as AnySportModule;

  it("blocks a void once the fixture's stage has completed", () => {
    const sim = simulateDivision({
      module: generic,
      cfg: SIM_CONFIGS["generic"],
      format: "group_knockout",
      seed: 7,
      entrantCount: 8,
    });
    // Every stage in a finished division has completed — any further void
    // attempt must be refused with the rank_locked code.
    for (const stage of sim.stages) {
      expect(canVoidFixtureEvent(sim.divisionEvents, stage.id)).toEqual({
        ok: false,
        code: "rank_locked",
      });
    }
    // While a stage is still open (its stage_completed not yet emitted), the
    // same fixture may be voided.
    const beforeCompletion = sim.divisionEvents.filter((e) => e.type === "stage_opened");
    expect(beforeCompletion.length).toBeGreaterThan(0);
    expect(canVoidFixtureEvent([{ type: "stage_opened", stageId: "groups" }], "groups")).toEqual({
      ok: true,
    });
  });
});

// ---------------------------------------------------------------------------
// Mutation canaries — PROMPT-14 acceptance: a deliberately seeded engine bug
// must be caught. Each canary corrupts one aspect of an otherwise-valid
// division the way a source mutation would, and the invariant checker fires.
// ---------------------------------------------------------------------------
describe("mutation canaries — the harness catches seeded engine bugs", () => {
  const generic = builtinModules.find((m) => m.key === "generic") as AnySportModule;
  const cfg = SIM_CONFIGS["generic"];
  const valid = () =>
    JSON.parse(
      JSON.stringify(
        simulateDivision({
          module: generic,
          cfg,
          format: "league",
          seed: 11,
          entrantCount: 6,
        }),
      ),
    ) as SimulationResult;

  it("accepts the unmutated division (canary baseline)", () => {
    expect(() => assertDivisionInvariants(valid(), generic, cfg)).not.toThrow();
  });

  it("catches a flipped ranking comparator (points order inverted)", () => {
    const sim = valid();
    const stage = sim.stages[0];
    const pool = stage?.tables?.pools[0];
    if (!stage || !pool) throw new Error("league simulation lost its pool table");
    // A flipped `points` comparator ranks the table bottom-up: same rows, same
    // rank numbers 1..n, reversed order — exactly what a mutated cascade emits.
    const reversed = [...pool.rows].reverse().map((row, i) => ({ ...row, rank: i + 1 }));
    (pool as unknown as { rows: typeof reversed }).rows = reversed;
    expect(() => assertDivisionInvariants(sim, generic, cfg)).toThrow(SimInvariantError);
    expect(() => assertDivisionInvariants(sim, generic, cfg)).toThrow(/contradicts points/);
  });

  it("catches a standingsDelta that stops conserving points", () => {
    const sim = valid();
    const fixture = sim.stages[0]?.fixtures.find((f) => f.result !== undefined);
    if (!fixture?.result) throw new Error("league simulation lost its results");
    (fixture.result[0] as { points: number }).points += 1;
    expect(() => assertDivisionInvariants(sim, generic, cfg)).toThrow(/points/);
  });

  it("catches a fold that miscounts played fixtures", () => {
    const sim = valid();
    const fixture = sim.stages[0]?.fixtures.find((f) => f.result !== undefined);
    if (!fixture?.result) throw new Error("league simulation lost its results");
    // Keep the fixture total inside the declared set but corrupt the played
    // tally — the ledger-sum invariant must notice the divergence.
    (fixture.result[0] as { played: number }).played = 0;
    expect(() => assertDivisionInvariants(sim, generic, cfg)).toThrow(/played counts/);
  });

  it("catches a champion outside the entrant set", () => {
    const sim = valid();
    (sim as { champion: string }).champion = "ghost";
    expect(() => assertDivisionInvariants(sim, generic, cfg)).toThrow(/not an entrant/);
  });
});
