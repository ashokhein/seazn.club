import { afterEach, describe, expect, it } from "vitest";
import {
  clampRoundTokens,
  hasRoundBudget,
  isRung,
  minRoundReserve,
  officialsRungWeights,
  predictRung,
  schedulingRungWeights,
  TOKEN_BUDGETS,
  tokenBudgetForRung,
  type RungWeights,
} from "../ai-rung";

// A fixed weight set so boundary math is easy to hand-verify: sizeScore =
// movableFixtures + 1*entrants + 1*courts, s1=100, s2=300.
const W: RungWeights = {
  entrantWeight: 1,
  courtWeight: 1,
  s1: 100,
  s2: 300,
  estTokensAtS1: 20_000,
  estTokensAtS2: 60_000,
};

describe("isRung", () => {
  it("accepts exactly 1, 2, 3", () => {
    expect(isRung(1)).toBe(true);
    expect(isRung(2)).toBe(true);
    expect(isRung(3)).toBe(true);
  });

  it("rejects anything else", () => {
    expect(isRung(0)).toBe(false);
    expect(isRung(4)).toBe(false);
    expect(isRung(1.5)).toBe(false);
  });
});

describe("TOKEN_BUDGETS / tokenBudgetForRung", () => {
  it("hard budgets per rung (design §5): 1→32K, 2→64K, 3→128K", () => {
    expect(TOKEN_BUDGETS).toEqual({ 1: 32_000, 2: 64_000, 3: 128_000 });
    expect(tokenBudgetForRung(1)).toBe(32_000);
    expect(tokenBudgetForRung(2)).toBe(64_000);
    expect(tokenBudgetForRung(3)).toBe(128_000);
  });
});

describe("predictRung — threshold boundaries", () => {
  it("sizeScore at or under s1 → rung 1", () => {
    expect(predictRung({ movableFixtures: 100, entrants: 0, courts: 0 }, W).rung).toBe(1);
    expect(predictRung({ movableFixtures: 100, entrants: 0, courts: 0 }, W).sizeScore).toBe(100);
  });

  it("one unit over s1 → rung 2 (the boundary is inclusive on rung 1's side)", () => {
    expect(predictRung({ movableFixtures: 101, entrants: 0, courts: 0 }, W).rung).toBe(2);
  });

  it("sizeScore at or under s2 → rung 2", () => {
    expect(predictRung({ movableFixtures: 300, entrants: 0, courts: 0 }, W).rung).toBe(2);
  });

  it("one unit over s2 → rung 3", () => {
    expect(predictRung({ movableFixtures: 301, entrants: 0, courts: 0 }, W).rung).toBe(3);
  });

  it("entrants and courts are weighted into the score, not just fixtures", () => {
    // 50 fixtures + 40 entrants*1 + 20 courts*1 = 110 > s1(100) → rung 2.
    const p = predictRung({ movableFixtures: 50, entrants: 40, courts: 20 }, W);
    expect(p.sizeScore).toBe(110);
    expect(p.rung).toBe(2);
  });

  it("zero-size input predicts rung 1 and zero est tokens", () => {
    const p = predictRung({ movableFixtures: 0, entrants: 0, courts: 0 }, W);
    expect(p.rung).toBe(1);
    expect(p.estTokens).toBe(0);
  });

  it("est tokens is piecewise-linear over the anchors and monotonic in size", () => {
    const at0 = predictRung({ movableFixtures: 0, entrants: 0, courts: 0 }, W).estTokens;
    const atS1 = predictRung({ movableFixtures: 100, entrants: 0, courts: 0 }, W).estTokens;
    const atS2 = predictRung({ movableFixtures: 300, entrants: 0, courts: 0 }, W).estTokens;
    const beyondS2 = predictRung({ movableFixtures: 400, entrants: 0, courts: 0 }, W).estTokens;
    expect(atS1).toBe(W.estTokensAtS1);
    expect(atS2).toBe(W.estTokensAtS2);
    expect(at0).toBeLessThan(atS1);
    expect(atS1).toBeLessThan(atS2);
    expect(beyondS2).toBeGreaterThan(atS2); // extrapolated past s2, never flat
  });
});

describe("schedulingRungWeights / officialsRungWeights — env overrides", () => {
  const keys = [
    "AI_RUNG_ENTRANT_WEIGHT",
    "AI_RUNG_COURT_WEIGHT",
    "AI_RUNG_S1",
    "AI_RUNG_S2",
    "AI_RUNG_EST_TOKENS_AT_S1",
    "AI_RUNG_EST_TOKENS_AT_S2",
    "AI_RUNG_OFFICIALS_ENTRANT_WEIGHT",
    "AI_RUNG_OFFICIALS_COURT_WEIGHT",
    "AI_RUNG_OFFICIALS_S1",
    "AI_RUNG_OFFICIALS_S2",
    "AI_RUNG_OFFICIALS_EST_TOKENS_AT_S1",
    "AI_RUNG_OFFICIALS_EST_TOKENS_AT_S2",
  ] as const;
  const saved: Record<string, string | undefined> = {};
  afterEach(() => {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
      delete saved[k];
    }
  });

  it("defaults match the design doc's code constants when unset", () => {
    for (const k of keys) delete process.env[k];
    expect(schedulingRungWeights()).toEqual({
      entrantWeight: 0.5,
      courtWeight: 2,
      s1: 60,
      s2: 200,
      estTokensAtS1: 18_000,
      estTokensAtS2: 50_000,
    });
    // Officials lands rung 1 almost always — higher thresholds, lighter weights.
    expect(officialsRungWeights()).toEqual({
      entrantWeight: 0.25,
      courtWeight: 1,
      s1: 120,
      s2: 400,
      estTokensAtS1: 10_000,
      estTokensAtS2: 30_000,
    });
  });

  it("AI_RUNG_S1/S2 override the schedule thresholds independently of officials", () => {
    saved.AI_RUNG_S1 = process.env.AI_RUNG_S1;
    saved.AI_RUNG_S2 = process.env.AI_RUNG_S2;
    process.env.AI_RUNG_S1 = "10";
    process.env.AI_RUNG_S2 = "20";
    expect(schedulingRungWeights().s1).toBe(10);
    expect(schedulingRungWeights().s2).toBe(20);
    expect(officialsRungWeights().s1).toBe(120); // untouched
  });
});

describe("minRoundReserve / hasRoundBudget / clampRoundTokens — meter math", () => {
  const saved = process.env.AI_RUNG_MIN_ROUND_RESERVE;
  afterEach(() => {
    if (saved === undefined) delete process.env.AI_RUNG_MIN_ROUND_RESERVE;
    else process.env.AI_RUNG_MIN_ROUND_RESERVE = saved;
  });

  it("defaults to 2_000 and is env-overridable", () => {
    delete process.env.AI_RUNG_MIN_ROUND_RESERVE;
    expect(minRoundReserve()).toBe(2_000);
    process.env.AI_RUNG_MIN_ROUND_RESERVE = "500";
    expect(minRoundReserve()).toBe(500);
  });

  it("hasRoundBudget is true while spent + reserve fits the budget, false once it doesn't", () => {
    process.env.AI_RUNG_MIN_ROUND_RESERVE = "2000";
    expect(hasRoundBudget(32_000, 30_000)).toBe(true); // 30,000 + 2,000 == 32,000 → fits exactly
    expect(hasRoundBudget(32_000, 30_001)).toBe(false); // one token over the reserve line
  });

  it("clampRoundTokens never exceeds the round ceiling nor the remaining budget", () => {
    expect(clampRoundTokens(32_000, 64_000, 0)).toBe(32_000); // plenty left — capped by the ceiling
    expect(clampRoundTokens(32_000, 64_000, 40_000)).toBe(24_000); // budget is the binding constraint
    expect(clampRoundTokens(32_000, 64_000, 64_000)).toBe(0); // budget fully spent
    expect(clampRoundTokens(32_000, 64_000, 70_000)).toBe(0); // never negative
  });
});
