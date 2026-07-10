// The sim scenario suites (v3/09 §3) run under vitest too: CI exercises the
// exact code the sim:matrix runner ships (coverage included), and a scenario
// violation fails the unit gate without waiting for the matrix job.
import { describe, expect, it } from "vitest";
import { builtinModules } from "../sports/index.ts";
import { simOptionsFor, simulateDivision } from "./simulation.ts";
import {
  runAmericanoScenario,
  runBoundaryMatrices,
  runCarryOverScenario,
  runCustomPointsScenario,
  runLadderScenario,
  runOfficialsScenario,
  runUndoStorm,
} from "./scenarios.ts";

describe("sim scenarios", () => {
  for (const module of builtinModules) {
    it(`undo storm — ${module.key}`, { timeout: 60_000 }, () => {
      const stats = runUndoStorm(module, 1);
      expect(stats.positions).toBeGreaterThan(0);
      expect(stats.accepted + stats.rejected).toBe(stats.positions);
    });

    it(`custom points rule — ${module.key}`, { timeout: 60_000 }, () => {
      const stats = runCustomPointsScenario(module, 1);
      expect(stats.fixtures).toBeGreaterThan(0);
    });
  }

  it("set-end boundary matrices (setbased presets)", () => {
    const stats = runBoundaryMatrices();
    expect(stats.map((s) => s.preset).sort()).toEqual(["badminton", "tabletennis", "volleyball"]);
    for (const s of stats) expect(s.cases).toBeGreaterThan(5);
  });

  it("officials assignment holds the no-double-booking invariant", () => {
    const stats = runOfficialsScenario(1);
    expect(stats.assignments).toBeGreaterThan(0);
  });

  it("carry-over conserves a simulated league table", () => {
    const generic = builtinModules.find((m) => m.key === "generic");
    expect(generic).toBeDefined();
    const sim = simulateDivision(simOptionsFor(generic!, "league", 1));
    const rows = sim.stages[0]?.tables?.pools[0]?.rows ?? [];
    expect(rows.length).toBeGreaterThan(1);
    expect(runCarryOverScenario(rows as never).rows).toBe(rows.length);
  });

  for (const key of ["badminton", "generic"]) {
    const module = builtinModules.find((m) => m.key === key)!;
    it(`americano rounds — ${key}`, { timeout: 60_000 }, () => {
      const stats = runAmericanoScenario(module, 1);
      expect(stats.matches).toBeGreaterThan(0);
      expect(stats.rounds).toBe(5);
    });

    it(`ladder challenges — ${key}`, { timeout: 60_000 }, () => {
      const stats = runLadderScenario(module, 1);
      expect(stats.challenges).toBeGreaterThan(0);
    });
  }
});
