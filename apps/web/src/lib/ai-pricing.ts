// USD list pricing per 1M tokens for the models the architect can run on
// (schedule-ai.ts / officials-ai.ts — SCHEDULING_AI_MODEL). Isomorphic: the
// server stamps cost onto telemetry + the run ledger, /admin/ai-runs renders
// it. Prices are list rates (cache reads/writes not modelled — the runner's
// usage counters are raw input/output tokens).
const PER_MILLION: Record<string, { input: number; output: number }> = {
  "claude-sonnet-5": { input: 3, output: 15 },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-opus-4-8": { input: 5, output: 25 },
  "claude-opus-4-7": { input: 5, output: 25 },
  "claude-opus-4-6": { input: 5, output: 25 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};

/** Estimated USD cost of one architect run; null when the model is unknown
 *  (custom SCHEDULING_AI_MODEL) — never guess a price. */
export function aiRunCostUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number | null {
  const p = PER_MILLION[model];
  if (!p) return null;
  const usd = (inputTokens * p.input + outputTokens * p.output) / 1_000_000;
  return Math.round(usd * 10_000) / 10_000;
}
