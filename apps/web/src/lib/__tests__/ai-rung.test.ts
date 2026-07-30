import { afterEach, describe, expect, it } from "vitest";
import {
  createTokenMeter,
  freeDraftQuote,
  isRung,
  meterStamp,
  minRoundReserve,
  officialsRungWeights,
  predictRung,
  quoteRun,
  schedulingRungWeights,
  tokenBudgetForCredits,
  unmeteredTokenMeter,
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

/** A line whose sizeScore is exactly `n` under W. */
const sized = (key: string, n: number, chosen?: number) => ({
  key,
  input: { movableFixtures: n, entrants: 0, courts: 0 },
  ...(chosen !== undefined ? { chosen } : {}),
});

const BUDGET_ENV = [
  "AI_RUNG_BUDGET_1",
  "AI_RUNG_BUDGET_2",
  "AI_RUNG_BUDGET_3",
  "AI_RUNG_BUDGET_STEP",
  "AI_RUNG_MIN_ROUND_RESERVE",
  "AI_RUNG_RESERVE_PER_UNIT",
] as const;

/** Clear `keys` for the duration of a test; returns the restore thunk. */
function withCleanEnv(keys: readonly string[]) {
  const saved: Record<string, string | undefined> = {};
  for (const k of keys) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  return () => {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k]!;
    }
  };
}

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

// ---------------------------------------------------------------------------
// 1. SIZING
// ---------------------------------------------------------------------------

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
  let restore = () => {};
  afterEach(() => restore());

  it("defaults match the design doc's code constants when unset", () => {
    restore = withCleanEnv(keys);
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
    restore = withCleanEnv(keys);
    process.env.AI_RUNG_S1 = "10";
    process.env.AI_RUNG_S2 = "20";
    expect(schedulingRungWeights().s1).toBe(10);
    expect(schedulingRungWeights().s2).toBe(20);
    expect(officialsRungWeights().s1).toBe(120); // untouched
  });

  it("the entrant/court weights are env-overridable too", () => {
    restore = withCleanEnv(keys);
    process.env.AI_RUNG_ENTRANT_WEIGHT = "3";
    process.env.AI_RUNG_COURT_WEIGHT = "7";
    expect(schedulingRungWeights().entrantWeight).toBe(3);
    expect(schedulingRungWeights().courtWeight).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// 3. BUDGET — keyed on CREDITS, not on rung
// ---------------------------------------------------------------------------

describe("tokenBudgetForCredits", () => {
  let restore = () => {};
  afterEach(() => restore());

  it("keeps the owner-approved #348 curve for 1/2/3 credits", () => {
    restore = withCleanEnv(BUDGET_ENV);
    expect(tokenBudgetForCredits(1)).toBe(32_000);
    expect(tokenBudgetForCredits(2)).toBe(64_000);
    expect(tokenBudgetForCredits(3)).toBe(128_000);
  });

  // The whole reason the budget keys on CREDITS rather than on a Rung: #350's
  // joint solve charges max(1, Σ rungs − 1), which reaches 5, 8, 11 credits —
  // values a Record<1|2|3, number> cannot key.
  it("extends past 3 credits at a flat step, so a joint run can be priced at all", () => {
    restore = withCleanEnv(BUDGET_ENV);
    expect(tokenBudgetForCredits(4)).toBe(160_000);
    expect(tokenBudgetForCredits(5)).toBe(192_000);
    expect(tokenBudgetForCredits(9)).toBe(128_000 + 32_000 * 6);
  });

  it("is monotonic, and zero at or below zero credits", () => {
    restore = withCleanEnv(BUDGET_ENV);
    expect(tokenBudgetForCredits(0)).toBe(0);
    expect(tokenBudgetForCredits(-2)).toBe(0);
    for (let n = 1; n < 12; n++) {
      expect(tokenBudgetForCredits(n + 1)).toBeGreaterThan(tokenBudgetForCredits(n));
    }
  });

  // The escape hatch for uncalibrated constants: loosen the budget in prod
  // without a deploy, once `stopped_on_budget` shows runs being cut short.
  it("every rung's budget is env-overridable", () => {
    restore = withCleanEnv(BUDGET_ENV);
    process.env.AI_RUNG_BUDGET_1 = "50000";
    process.env.AI_RUNG_BUDGET_3 = "200000";
    process.env.AI_RUNG_BUDGET_STEP = "10000";
    expect(tokenBudgetForCredits(1)).toBe(50_000);
    expect(tokenBudgetForCredits(3)).toBe(200_000);
    expect(tokenBudgetForCredits(4)).toBe(210_000);
  });
});

// ---------------------------------------------------------------------------
// 2. PRICING
// ---------------------------------------------------------------------------

describe("quoteRun — single line (one division, issue #348)", () => {
  let restore = () => {};
  afterEach(() => restore());

  it("charges the predicted rung and sizes the budget from it", () => {
    restore = withCleanEnv(BUDGET_ENV);
    const q = quoteRun([sized("d1", 150)], W); // 100 < 150 <= 300 → rung 2
    expect(q.credits).toBe(2);
    expect(q.discount).toBe(0);
    expect(q.budget).toBe(64_000);
    expect(q.underfunded).toBe(false);
    expect(q.lines[0]!.predictedRung).toBe(2);
  });

  it("honours a rung chosen ABOVE the prediction — never underfunded", () => {
    restore = withCleanEnv(BUDGET_ENV);
    const q = quoteRun([sized("d1", 10, 3)], W); // predicts 1, picks 3
    expect(q.credits).toBe(3);
    expect(q.budget).toBe(128_000);
    expect(q.underfunded).toBe(false);
    expect(q.lines[0]!.predictedRung).toBe(1);
  });

  it("honours a rung chosen BELOW the prediction and flags underfunded", () => {
    restore = withCleanEnv(BUDGET_ENV);
    const q = quoteRun([sized("d1", 400, 1)], W); // predicts 3, picks 1
    expect(q.credits).toBe(1);
    expect(q.budget).toBe(32_000);
    expect(q.underfunded).toBe(true);
    expect(q.lines[0]!.predictedRung).toBe(3);
  });

  it("ignores an out-of-range override rather than charging a bogus amount", () => {
    restore = withCleanEnv(BUDGET_ENV);
    for (const bad of [0, 4, 2.5, -1, Number.NaN]) {
      expect(quoteRun([sized("d1", 150, bad)], W).credits).toBe(2); // fell back to the prediction
    }
  });
});

describe("quoteRun — joint lines (one competition, issue #350)", () => {
  let restore = () => {};
  afterEach(() => restore());

  it("applies the Σ − 1 batch discount across divisions", () => {
    restore = withCleanEnv(BUDGET_ENV);
    // rungs 1 + 2 + 3 = 6 → charge 5.
    const q = quoteRun([sized("a", 10), sized("b", 150), sized("c", 400)], W);
    expect(q.lines.map((l) => l.rung)).toEqual([1, 2, 3]);
    expect(q.rungTotal).toBe(6);
    expect(q.credits).toBe(5);
    expect(q.discount).toBe(1);
  });

  it("never charges below 1 credit", () => {
    restore = withCleanEnv(BUDGET_ENV);
    const q = quoteRun([sized("a", 10), sized("b", 10)], W); // 1 + 1 = 2 → max(1, 1)
    expect(q.credits).toBe(1);
    expect(q.discount).toBe(1);
  });

  // Owner decision: the discount is a margin gift, NOT a capability cut. Two
  // joint rung-1 divisions pay for one credit but still get the token budget
  // two divisions' worth of work needs — otherwise a joint run would be
  // strictly worse than running the divisions separately.
  it("sizes the budget from the UNDISCOUNTED rung total, not the charged credits", () => {
    restore = withCleanEnv(BUDGET_ENV);
    const q = quoteRun([sized("a", 10), sized("b", 10)], W);
    expect(q.credits).toBe(1);
    expect(q.budget).toBe(tokenBudgetForCredits(2)); // 64K, not 32K
    expect(q.budget).toBe(64_000);
  });

  it("flags underfunded when ANY division was picked below its prediction", () => {
    restore = withCleanEnv(BUDGET_ENV);
    const q = quoteRun([sized("a", 10), sized("b", 400, 1)], W);
    expect(q.underfunded).toBe(true);
    expect(q.lines[0]!.underfunded).toBe(false);
    expect(q.lines[1]!.underfunded).toBe(true);
  });

  it("sums the advisory est-token helper text across lines", () => {
    restore = withCleanEnv(BUDGET_ENV);
    expect(quoteRun([sized("a", 100), sized("b", 100)], W).estTokens).toBe(2 * W.estTokensAtS1);
  });
});

describe("freeDraftQuote — the zero-token deterministic path", () => {
  let restore = () => {};
  afterEach(() => restore());

  // Regression: sizing this path by the pack charged a large division 2-3
  // credits for a run that makes NO model call at all. It cost 1 credit before
  // rung pricing existed and must keep costing 1.
  it("always costs exactly 1 credit whatever the division size", () => {
    restore = withCleanEnv(BUDGET_ENV);
    const q = freeDraftQuote("d1");
    expect(q.credits).toBe(1);
    expect(q.lines[0]!.rung).toBe(1);
    expect(q.lines[0]!.predictedRung).toBe(1);
    expect(q.underfunded).toBe(false);
    expect(q.estTokens).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 4. METER
// ---------------------------------------------------------------------------

describe("minRoundReserve", () => {
  let restore = () => {};
  afterEach(() => restore());

  it("defaults to a 2_000-token floor and is env-overridable", () => {
    restore = withCleanEnv(BUDGET_ENV);
    expect(minRoundReserve()).toBe(2_000);
    process.env.AI_RUNG_MIN_ROUND_RESERVE = "500";
    expect(minRoundReserve()).toBe(500);
  });

  // A flat 2_000 floor is wrong for a big pack: emitting 200 assignments alone
  // costs several thousand output tokens, so a round clamped to 2_000 truncates,
  // fails to parse, and burns the rest of the budget for nothing.
  it("scales with the pack size so a big pack's round can actually be emitted", () => {
    restore = withCleanEnv(BUDGET_ENV);
    expect(minRoundReserve(10)).toBe(2_000); // the floor still binds on a small pack
    expect(minRoundReserve(200)).toBe(8_000); // 200 * 40
    process.env.AI_RUNG_RESERVE_PER_UNIT = "100";
    expect(minRoundReserve(200)).toBe(20_000);
  });

  it("treats a negative unit count as zero", () => {
    restore = withCleanEnv(BUDGET_ENV);
    expect(minRoundReserve(-5)).toBe(2_000);
  });
});

describe("createTokenMeter", () => {
  let restore = () => {};
  afterEach(() => restore());

  it("accumulates spend and refuses a round once the reserve no longer fits", () => {
    restore = withCleanEnv(BUDGET_ENV);
    const m = createTokenMeter(32_000);
    expect(m.canStartRound()).toBe(true);
    m.add(30_000);
    expect(m.spent).toBe(30_000);
    expect(m.canStartRound()).toBe(true); // 30,000 + 2,000 == 32,000 → fits exactly
    m.add(1);
    expect(m.canStartRound()).toBe(false); // one token over the reserve line
  });

  it("flags stoppedOnBudget only once a round has actually been refused", () => {
    restore = withCleanEnv(BUDGET_ENV);
    const m = createTokenMeter(32_000);
    m.add(10_000);
    m.canStartRound();
    expect(m.stoppedOnBudget).toBe(false); // finished under budget → not a cliff
    m.add(25_000);
    m.canStartRound();
    expect(m.stoppedOnBudget).toBe(true);
  });

  it("clamps a round to the ceiling, then to the remaining budget, never below zero", () => {
    restore = withCleanEnv(BUDGET_ENV);
    const m = createTokenMeter(64_000);
    expect(m.clampRound(32_000)).toBe(32_000); // plenty left — the ceiling binds
    m.add(40_000);
    expect(m.clampRound(32_000)).toBe(24_000); // the budget binds
    m.add(30_000);
    expect(m.clampRound(32_000)).toBe(0); // overspent — never negative
  });

  it("ignores non-positive and non-finite round usage", () => {
    restore = withCleanEnv(BUDGET_ENV);
    const m = createTokenMeter(32_000);
    m.add(0);
    m.add(-5);
    m.add(Number.NaN);
    expect(m.spent).toBe(0);
  });

  it("sizes its reserve from the pack it was built for", () => {
    restore = withCleanEnv(BUDGET_ENV);
    const big = createTokenMeter(32_000, { units: 200 }); // reserve 8_000
    big.add(25_000);
    expect(big.canStartRound()).toBe(false); // 25,000 + 8,000 > 32,000
    const small = createTokenMeter(32_000, { units: 10 }); // reserve 2_000
    small.add(25_000);
    expect(small.canStartRound()).toBe(true);
  });
});

describe("unmeteredTokenMeter", () => {
  it("never refuses a round but still counts spend", () => {
    const m = unmeteredTokenMeter();
    m.add(10_000_000);
    expect(m.canStartRound()).toBe(true);
    expect(m.stoppedOnBudget).toBe(false);
    expect(m.spent).toBe(10_000_000);
  });

  it("clamps to the caller's own ceiling, not to Infinity", () => {
    expect(unmeteredTokenMeter().clampRound(32_000)).toBe(32_000);
  });

  // A shared mutable singleton would carry one run's spend into the next.
  it("returns a fresh instance per call", () => {
    const a = unmeteredTokenMeter();
    a.add(5_000);
    expect(unmeteredTokenMeter().spent).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// STAMP
// ---------------------------------------------------------------------------

describe("meterStamp", () => {
  let restore = () => {};
  afterEach(() => restore());

  it("emits the flat rung fields for a single-division run", () => {
    restore = withCleanEnv(BUDGET_ENV);
    const q = quoteRun([sized("d1", 400, 1)], W);
    const m = createTokenMeter(q.budget);
    m.add(12_345);
    expect(meterStamp(q, m)).toEqual({
      credits: 1,
      budget: 32_000,
      spent_tokens: 12_345,
      underfunded: true,
      stopped_on_budget: false,
      est_tokens: q.estTokens,
      rung: 1,
      predicted_rung: 3,
    });
  });

  it("emits the per-division breakdown and discount for a joint run", () => {
    restore = withCleanEnv(BUDGET_ENV);
    const q = quoteRun([sized("a", 10), sized("b", 400)], W);
    const stamp = meterStamp(q, createTokenMeter(q.budget));
    expect(stamp.rung).toBeUndefined();
    expect(stamp.credits).toBe(3); // 1 + 3 − 1
    expect(stamp.discount).toBe(1);
    expect(stamp.divisions).toEqual([
      { id: "a", rung: 1, predicted_rung: 1, underfunded: false },
      { id: "b", rung: 3, predicted_rung: 3, underfunded: false },
    ]);
  });

  // What makes a mispriced rung visible in analytics: without this a run cut
  // off by the budget is indistinguishable from one that merely returned a
  // degraded plan.
  it("reports stopped_on_budget once the meter refused a round", () => {
    restore = withCleanEnv(BUDGET_ENV);
    const q = quoteRun([sized("d1", 10)], W);
    const m = createTokenMeter(q.budget);
    m.add(q.budget);
    m.canStartRound();
    expect(meterStamp(q, m).stopped_on_budget).toBe(true);
  });
});
