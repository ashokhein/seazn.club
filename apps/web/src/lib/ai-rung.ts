// Token-weighted AI credit pricing (docs/superpowers/specs/2026-07-28-ai-credit-
// token-weight-design.md). Pure, no I/O: predicts the 1/2/3 credit "rung" a run
// needs from data already loaded to build its pack (fixtures, entrants,
// courts), and defines the hard token budget each rung buys. Imported by both
// server usecases (schedule-ai.ts, officials-ai.ts) and, eventually, a
// confirm-card client component — no I/O means no server-only import ever
// leaks into a client bundle (same discipline as lib/pass-ladder.ts).
//
// APPROACH 1 (heuristic predictor + harness token meter), per the design doc:
// no regression fitting, no Anthropic `task_budget` beta — enforcement lives
// in the ladder loop as a cumulative token meter, provider-agnostic.

export type Rung = 1 | 2 | 3;

export function isRung(n: number): n is Rung {
  return n === 1 || n === 2 || n === 3;
}

/** Hard per-run generation-token budget a rung buys (design §5). Credits buy a
 *  token BUDGET, not usage — price is fixed at confirm time regardless of how
 *  much of the budget a run actually spends; no refunds, no true-up. */
export const TOKEN_BUDGETS: Record<Rung, number> = {
  1: 32_000,
  2: 64_000,
  3: 128_000,
};

export function tokenBudgetForRung(rung: Rung): number {
  return TOKEN_BUDGETS[rung];
}

/** A round smaller than this can't produce a useful plan/repair — stop
 *  escalating (a new ladder rung, or a repair round) once the remaining
 *  budget drops below it, rather than spending down to a sliver that could
 *  never finish a round anyway. */
export function minRoundReserve(): number {
  const n = Number(process.env.AI_RUNG_MIN_ROUND_RESERVE);
  return Number.isFinite(n) && n >= 0 ? n : 2_000;
}

/** Is there enough of the run's hard budget left to justify starting another
 *  round? `spent` is the run's total generation tokens so far (every rung,
 *  every round, summed — the same usage numbers already captured for COGS). */
export function hasRoundBudget(budget: number, spent: number): boolean {
  return spent + minRoundReserve() <= budget;
}

/** Per-round token cap given how much of the run's budget remains: never more
 *  than `roundCeiling` (the existing MAX_TOKENS-style per-round cap), never
 *  more than what's left of the run's hard budget. */
export function clampRoundTokens(roundCeiling: number, budget: number, spent: number): number {
  return Math.max(0, Math.min(roundCeiling, budget - spent));
}

export interface RungWeights {
  entrantWeight: number;
  courtWeight: number;
  /** sizeScore at/under which the predictor picks rung 1. */
  s1: number;
  /** sizeScore at/under which the predictor picks rung 2 (above → rung 3). */
  s2: number;
  /** Helper-text-only anchors for the est-tokens curve — never used for
   *  billing/enforcement (TOKEN_BUDGETS is the hard budget, enforced
   *  independent of this estimate). UNCALIBRATED until the design's one-time
   *  SQL pass over competition_events buckets real output_tokens by
   *  pack_units (design §4) — edit these anchors, not the code, once that
   *  data exists. */
  estTokensAtS1: number;
  estTokensAtS2: number;
}

function envNumber(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) ? n : fallback;
}

/** Phase A (schedule) predictor weights. AI_RUNG_* env overrides per design §4. */
export function schedulingRungWeights(): RungWeights {
  return {
    entrantWeight: envNumber("AI_RUNG_ENTRANT_WEIGHT", 0.5),
    courtWeight: envNumber("AI_RUNG_COURT_WEIGHT", 2),
    s1: envNumber("AI_RUNG_S1", 60),
    s2: envNumber("AI_RUNG_S2", 200),
    estTokensAtS1: envNumber("AI_RUNG_EST_TOKENS_AT_S1", 18_000),
    estTokensAtS2: envNumber("AI_RUNG_EST_TOKENS_AT_S2", 50_000),
  };
}

/** Phase B (officials) predictor weights — officials packs are lighter, so
 *  these thresholds sit higher; a typical run lands rung 1 (design §4). */
export function officialsRungWeights(): RungWeights {
  return {
    entrantWeight: envNumber("AI_RUNG_OFFICIALS_ENTRANT_WEIGHT", 0.25),
    courtWeight: envNumber("AI_RUNG_OFFICIALS_COURT_WEIGHT", 1),
    s1: envNumber("AI_RUNG_OFFICIALS_S1", 120),
    s2: envNumber("AI_RUNG_OFFICIALS_S2", 400),
    estTokensAtS1: envNumber("AI_RUNG_OFFICIALS_EST_TOKENS_AT_S1", 10_000),
    estTokensAtS2: envNumber("AI_RUNG_OFFICIALS_EST_TOKENS_AT_S2", 30_000),
  };
}

export interface RungInput {
  movableFixtures: number;
  entrants: number;
  courts: number;
}

export interface RungPrediction {
  sizeScore: number;
  rung: Rung;
  /** Helper-text-only estimate ("~45K tokens") — advisory, not enforced. */
  estTokens: number;
}

function computeSizeScore(input: RungInput, weights: RungWeights): number {
  return input.movableFixtures + weights.entrantWeight * input.entrants + weights.courtWeight * input.courts;
}

/** Piecewise-linear over the anchors (0,0) → (s1, estTokensAtS1) →
 *  (s2, estTokensAtS2), extrapolating the last segment's slope beyond s2. */
function computeEstTokens(score: number, weights: RungWeights): number {
  const { s1, s2, estTokensAtS1, estTokensAtS2 } = weights;
  if (score <= 0) return 0;
  if (score <= s1) return Math.round((score / Math.max(s1, 1)) * estTokensAtS1);
  if (score <= s2) {
    const frac = (score - s1) / Math.max(s2 - s1, 1);
    return Math.round(estTokensAtS1 + frac * (estTokensAtS2 - estTokensAtS1));
  }
  const slope = (estTokensAtS2 - estTokensAtS1) / Math.max(s2 - s1, 1);
  return Math.round(estTokensAtS2 + (score - s2) * slope);
}

/** Predict the credit rung a run needs, purely from pack data already loaded
 *  to build it — no I/O, no new estimate endpoint (design §4/§6). The server
 *  always recomputes this at run time; a client's displayed prediction is
 *  advisory only. */
export function predictRung(input: RungInput, weights: RungWeights): RungPrediction {
  const sizeScore = computeSizeScore(input, weights);
  const rung: Rung = sizeScore <= weights.s1 ? 1 : sizeScore <= weights.s2 ? 2 : 3;
  return { sizeScore, rung, estTokens: computeEstTokens(sizeScore, weights) };
}
