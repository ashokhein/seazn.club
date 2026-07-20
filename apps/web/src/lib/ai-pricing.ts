// USD list pricing per 1M tokens for the models the architect can run on
// (schedule-ai.ts / officials-ai.ts — SCHEDULING_AI_MODEL). Isomorphic: the
// server stamps cost onto telemetry + the run ledger, /admin/ai-runs renders
// it. Cache reads/writes are not modelled — the runner's usage counters are
// raw input/output tokens.
//
// Some models carry a time-boxed introductory rate. Cost is stamped at run
// time, so the rate in force *at that moment* is the correct one and the
// window expires on its own — no dated constant to remember to delete.
type Rate = { input: number; output: number };

const PRICING: Record<string, { list: Rate; intro?: { untilIso: string; rate: Rate } }> = {
  "claude-sonnet-5": {
    list: { input: 3, output: 15 },
    // Introductory pricing runs through 2026-08-31 inclusive; `untilIso` is the
    // first instant the list rate applies again.
    intro: { untilIso: "2026-09-01T00:00:00Z", rate: { input: 2, output: 10 } },
  },
  "claude-sonnet-4-6": { list: { input: 3, output: 15 } },
  "claude-opus-4-8": { list: { input: 5, output: 25 } },
  "claude-opus-4-7": { list: { input: 5, output: 25 } },
  "claude-opus-4-6": { list: { input: 5, output: 25 } },
  "claude-haiku-4-5": { list: { input: 1, output: 5 } },
};

/** The per-1M rate in force for `model` at `at`. Exported for /admin surfaces
 *  that want to show the rate alongside the stamped cost. */
export function aiRate(model: string, at: Date = new Date()): Rate | null {
  const entry = PRICING[model];
  if (!entry) return null;
  if (entry.intro && at.getTime() < Date.parse(entry.intro.untilIso)) return entry.intro.rate;
  return entry.list;
}

/** Estimated USD cost of one architect run; null when the model is unknown
 *  (custom SCHEDULING_AI_MODEL) — never guess a price. `at` defaults to now
 *  and exists so tests can pin a date either side of an intro window. */
export function aiRunCostUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
  at: Date = new Date(),
): number | null {
  const p = aiRate(model, at);
  if (!p) return null;
  const usd = (inputTokens * p.input + outputTokens * p.output) / 1_000_000;
  return Math.round(usd * 10_000) / 10_000;
}
