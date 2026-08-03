// Token-weighted AI credit pricing (docs/superpowers/specs/2026-07-28-ai-credit-
// token-weight-design.md, issue #348) and the seam the multi-division joint
// solve (issue #350) plugs into. Pure, no I/O: imported by both server usecases
// (schedule-ai.ts, officials-ai.ts) and, eventually, a confirm-card client
// component — no I/O means no server-only import ever leaks into a client
// bundle (same discipline as lib/pass-ladder.ts).
//
// APPROACH 1 (heuristic predictor + harness token meter), per the design doc:
// no regression fitting, no Anthropic `task_budget` beta — enforcement lives in
// the ladder loop as a cumulative token meter, provider-agnostic.
//
// THREE SEPARATE CONCERNS, deliberately not collapsed into one another. #350
// needs each of them independently, and an earlier shape that keyed the token
// budget off the RUNG could not express its pricing at all:
//
//   1. SIZING   pack shape   -> sizeScore -> Rung (1|2|3)   `predictRung`
//   2. PRICING  chosen rungs -> credits charged             `quoteRun`
//   3. BUDGET   credits      -> hard generation-token cap   `tokenBudgetForCredits`
//
// A single-division run prices at its own rung, so (2) is the identity. A joint
// run over N divisions prices at `max(1, Σ rungs − 1)` — a batch discount that
// can reach 5, 8, 11 credits, values a `Record<Rung, number>` budget table
// cannot key. Hence (3) keys on CREDITS, and extends past 3 linearly.

export type Rung = 1 | 2 | 3;

export function isRung(n: number): n is Rung {
  return n === 1 || n === 2 || n === 3;
}

function envNumber(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) ? n : fallback;
}

// ---------------------------------------------------------------------------
// 1. SIZING — pack shape -> rung prediction
// ---------------------------------------------------------------------------

export interface RungWeights {
  entrantWeight: number;
  courtWeight: number;
  /** sizeScore at/under which the predictor picks rung 1. */
  s1: number;
  /** sizeScore at/under which the predictor picks rung 2 (above → rung 3). */
  s2: number;
  /** Helper-text-only anchors for the est-tokens curve — never used for
   *  billing/enforcement (the credit budget below is the hard cap, enforced
   *  independent of this estimate). UNCALIBRATED until the design's one-time
   *  SQL pass over competition_events buckets real output_tokens by
   *  pack_units (design §4, scripts/ai-rung-calibration.sql) — edit these
   *  anchors, not the code, once that data exists. */
  estTokensAtS1: number;
  estTokensAtS2: number;
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

/** Predict the credit rung a unit of work needs, purely from pack data already
 *  loaded to build it — no I/O, no new estimate endpoint (design §4/§6). The
 *  server always recomputes this at run time; a client's displayed prediction
 *  is advisory only. */
export function predictRung(input: RungInput, weights: RungWeights): RungPrediction {
  const sizeScore = computeSizeScore(input, weights);
  const rung: Rung = sizeScore <= weights.s1 ? 1 : sizeScore <= weights.s2 ? 2 : 3;
  return { sizeScore, rung, estTokens: computeEstTokens(sizeScore, weights) };
}

// ---------------------------------------------------------------------------
// 3. BUDGET — credits -> hard generation-token cap
// ---------------------------------------------------------------------------

/** Hard per-run generation-token budget N credits buy. Credits buy a token
 *  BUDGET, not usage — price is fixed at confirm time regardless of how much of
 *  the budget a run actually spends; no refunds, no true-up (design §5).
 *
 *  1/2/3 are the owner-approved #348 values. Past 3 (only reachable via #350's
 *  joint solve) the curve continues at a flat step per extra credit — #350 §2's
 *  "32K × credits" line is superseded, since it would have CUT rung 3 from
 *  128K to 96K.
 *
 *  Every value is env-overridable so a live cliff (visible via the
 *  `stopped_on_budget` stamp) can be loosened without a deploy while the
 *  calibration data is still being gathered. */
export function tokenBudgetForCredits(credits: number): number {
  if (!Number.isFinite(credits) || credits <= 0) return 0;
  const b3 = envNumber("AI_RUNG_BUDGET_3", 128_000);
  const n = Math.floor(credits);
  if (n === 1) return envNumber("AI_RUNG_BUDGET_1", 32_000);
  if (n === 2) return envNumber("AI_RUNG_BUDGET_2", 64_000);
  if (n === 3) return b3;
  return b3 + envNumber("AI_RUNG_BUDGET_STEP", 32_000) * (n - 3);
}

// ---------------------------------------------------------------------------
// 2. PRICING — chosen rungs -> credits charged (+ the budget they buy)
// ---------------------------------------------------------------------------

/** One priced unit of work. Single-division runs pass one; #350's joint solve
 *  passes one per selected division, `key` being the division id. */
export interface QuoteLineInput {
  key: string;
  input: RungInput;
  /** Caller's rung override. Ignored when it is not 1|2|3. A pick BELOW the
   *  prediction is honoured and stamps `underfunded` — the run still executes,
   *  capped to the smaller budget. */
  chosen?: number;
}

export interface QuoteLine {
  key: string;
  sizeScore: number;
  predictedRung: Rung;
  rung: Rung;
  estTokens: number;
  underfunded: boolean;
}

export interface Quote {
  lines: QuoteLine[];
  /** Σ of the chosen rungs, before the batch discount. Sizes the budget. */
  rungTotal: number;
  /** Credits actually charged: `rungTotal` for one line, `max(1, rungTotal−1)`
   *  for a joint run (#350 §7). */
  credits: number;
  /** Credits forgiven by the batch discount (0 or 1) — shown in the breakdown. */
  discount: number;
  /** Hard generation-token budget this run gets. Sized from `rungTotal`, NOT
   *  from the discounted `credits`: the batch discount is a margin gift, not a
   *  capability cut, so two joint rung-1 divisions pay 1 credit and still get
   *  the 64K two divisions' worth of work needs. */
  budget: number;
  /** Advisory sum of the lines' est-token helper text. */
  estTokens: number;
  /** Any line picked below its prediction. */
  underfunded: boolean;
}

/** Price a run. One line → the single-division path (credits = that rung).
 *  Two or more → #350's joint solve, with the `Σ − 1` batch discount.
 *
 *  Callers gate the ≥2-line requirement themselves (the competition endpoint
 *  400s on a single division so the discount cannot be arbitraged); this
 *  function stays total, and simply applies no discount to a lone line. */
export function quoteRun(lines: QuoteLineInput[], weights: RungWeights): Quote {
  const priced: QuoteLine[] = lines.map((l) => {
    const p = predictRung(l.input, weights);
    const rung: Rung = l.chosen !== undefined && isRung(l.chosen) ? l.chosen : p.rung;
    return {
      key: l.key,
      sizeScore: p.sizeScore,
      predictedRung: p.rung,
      rung,
      estTokens: p.estTokens,
      underfunded: rung < p.rung,
    };
  });
  const rungTotal = priced.reduce((n, l) => n + l.rung, 0);
  const credits = priced.length > 1 ? Math.max(1, rungTotal - 1) : rungTotal;
  return {
    lines: priced,
    rungTotal,
    credits,
    discount: rungTotal - credits,
    budget: tokenBudgetForCredits(rungTotal),
    estTokens: priced.reduce((n, l) => n + l.estTokens, 0),
    underfunded: priced.some((l) => l.underfunded),
  };
}

/** A run that charges credits but makes no model call — Phase B's
 *  empty-instruction path returns the deterministic solver draft with zero
 *  tokens, and must never cost more than the 1 credit it cost before rung
 *  pricing existed ("the sensible spread costs nothing", design/v4/03 §2). */
export function freeDraftQuote(key: string): Quote {
  return {
    lines: [{ key, sizeScore: 0, predictedRung: 1, rung: 1, estTokens: 0, underfunded: false }],
    rungTotal: 1,
    credits: 1,
    discount: 0,
    budget: tokenBudgetForCredits(1),
    estTokens: 0,
    underfunded: false,
  };
}

// ---------------------------------------------------------------------------
// 4. METER — enforcement, shared across every rung and round of one run
// ---------------------------------------------------------------------------

/** A round smaller than this cannot produce a useful plan or repair, so stop
 *  escalating rather than spending down to a sliver that could never finish.
 *  SIZE-AWARE: a flat floor is wrong for a 200-fixture pack, where the
 *  assignment list ALONE is several thousand tokens — a round clamped under
 *  that truncates, fails to parse, and burns the remaining budget for nothing. */
export function minRoundReserve(units = 0): number {
  const base = envNumber("AI_RUNG_MIN_ROUND_RESERVE", 2_000);
  const perUnit = envNumber("AI_RUNG_RESERVE_PER_UNIT", 40);
  return Math.max(base, Math.round(Math.max(units, 0) * perUnit));
}

/**
 * The run's cumulative generation-token meter. ONE instance is threaded through
 * the whole ladder — every model rung, every repair round — so the budget is
 * enforced across the run rather than reset per rung, and the "how much did
 * prior rungs spend" bookkeeping lives in one place instead of travelling as a
 * number each layer has to remember to forward.
 *
 * Only generation (output, incl. thinking) tokens are metered. On
 * adaptive-thinking models thinking bills as output, which is exactly the cost
 * the rung is scaling for; input tokens are not metered (design §5).
 */
export interface TokenMeter {
  readonly budget: number;
  readonly spent: number;
  /** True once `canStartRound()` has refused a round — the run ended EARLY, cut
   *  off by the budget rather than by finding a clean plan. Stamped on the
   *  ledger event so a mispriced rung shows up in analytics instead of looking
   *  like a normal (if degraded) result. */
  readonly stoppedOnBudget: boolean;
  /** Record a round's output tokens. Call it as soon as usage is known, on the
   *  failure path too — an un-metered failed round is a budget leak. */
  add(outputTokens: number): void;
  /** Is there enough budget left to justify another round? Refusing flips
   *  `stoppedOnBudget`. */
  canStartRound(): boolean;
  /** Per-round `max_tokens`: never more than the caller's own ceiling, never
   *  more than what is left of the run's budget. */
  clampRound(ceiling: number): number;
}

export function createTokenMeter(budget: number, opts: { units?: number } = {}): TokenMeter {
  const reserve = minRoundReserve(opts.units ?? 0);
  let spent = 0;
  let stopped = false;
  return {
    get budget() {
      return budget;
    },
    get spent() {
      return spent;
    },
    get stoppedOnBudget() {
      return stopped;
    },
    add(outputTokens: number) {
      if (Number.isFinite(outputTokens) && outputTokens > 0) spent += outputTokens;
    },
    canStartRound() {
      const ok = spent + reserve <= budget;
      if (!ok) stopped = true;
      return ok;
    },
    clampRound(ceiling: number) {
      return Math.max(0, Math.min(ceiling, budget - spent));
    },
  };
}

/** A meter that never refuses a round — the default for callers that do not
 *  price a run (unit tests, internal replays). Still counts spend, so the same
 *  telemetry works either way. Returns a FRESH meter per call: a shared mutable
 *  singleton would leak one run's spend into the next. */
export function unmeteredTokenMeter(): TokenMeter {
  return createTokenMeter(Number.POSITIVE_INFINITY);
}

// ---------------------------------------------------------------------------
// Ledger / API stamp — one shape, so every surface reports the same fields
// ---------------------------------------------------------------------------

export interface RunMeterStamp {
  credits: number;
  budget: number;
  spent_tokens: number;
  underfunded: boolean;
  stopped_on_budget: boolean;
  est_tokens: number;
  /** Single-line runs only: the flat rung fields the confirm card reads. */
  rung?: Rung;
  predicted_rung?: Rung;
  /** Joint runs only (#350): the per-division breakdown behind `credits`. */
  divisions?: { id: string; rung: Rung; predicted_rung: Rung; underfunded: boolean }[];
  discount?: number;
  /** The stage-1 instruction compile (#398). It runs OUTSIDE `spendCredit` and
   *  therefore outside `budget`, so it needs its own line or the spend is
   *  invisible — the exact reconciliation complaint #387 makes. Deliberately NOT
   *  folded into `spent_tokens`: that number must keep meaning "what the credit
   *  bought", or reconciliation double-counts. Absent when no compile ran. */
  parse_tokens?: number;
  parse_failed?: boolean;
}

/** The `schedule.ai_generated` / `ai_failed` payload fragment and the API
 *  response fragment, built once so the call sites cannot drift. */
export function meterStamp(
  quote: Quote,
  meter: TokenMeter,
  /** The unpriced pre-flight compile (#398). Omit when none ran. */
  parse?: { tokens: number; failed: boolean },
): RunMeterStamp {
  const base = {
    credits: quote.credits,
    budget: quote.budget,
    spent_tokens: meter.spent,
    underfunded: quote.underfunded,
    stopped_on_budget: meter.stoppedOnBudget,
    est_tokens: quote.estTokens,
    ...(parse !== undefined ? { parse_tokens: parse.tokens, parse_failed: parse.failed } : {}),
  };
  if (quote.lines.length === 1) {
    const only = quote.lines[0]!;
    return { ...base, rung: only.rung, predicted_rung: only.predictedRung };
  }
  return {
    ...base,
    discount: quote.discount,
    divisions: quote.lines.map((l) => ({
      id: l.key,
      rung: l.rung,
      predicted_rung: l.predictedRung,
      underfunded: l.underfunded,
    })),
  };
}
