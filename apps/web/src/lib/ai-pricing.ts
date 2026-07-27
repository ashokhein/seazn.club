// USD list pricing per 1M tokens for the models the architect can run on
// (schedule-ai.ts / officials-ai.ts — SCHEDULING_AI_MODEL). Isomorphic: the
// server stamps cost onto telemetry + the run ledger, /admin/ai-runs renders
// it. Cache reads/writes are not modelled — the runner's usage counters are
// raw input/output tokens.
//
// The mechanism supports a time-boxed introductory rate (cost is stamped at run
// time, so the rate in force *at that moment* is the correct one and a window
// expires on its own). No model currently uses one.
//
// 2026-07-20: sonnet-5 was briefly given Anthropic's published $2/$10
// introductory rate. That was wrong for this account — reconciling the real
// balance against 28 benched runs ($15 -> $9 observed, ~$5.6 predicted at list
// vs $3.4 at intro) showed billing at LIST. Applying a published rate without
// checking the account made the ledger understate by 33%, the same bug it was
// meant to fix, in the opposite direction. Do not re-add an intro rate here
// without confirming it against console.anthropic.com -> Plans & Billing.
type Rate = { input: number; output: number };

const PRICING: Record<string, { list: Rate; intro?: { untilIso: string; rate: Rate } }> = {
  "claude-sonnet-5": { list: { input: 3, output: 15 } },
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

/** What ONE `pack_units` unit MEANS, per AI run phase (v17 gap #295).
 *
 *  The two run paths stamp the same JSONB key from different denominators:
 *  `schedule-ai.ts` stamps `movableIds.size` — only the fixtures the pack asked
 *  the model to place — while `officials-ai.ts` stamps `pack.fixtures.length`,
 *  every fixture in the pack. So `pack_units` is NOT one measure with two
 *  sources: a $/unit computed across both phases is arithmetic over two
 *  different things. Every surface that renders a per-unit number must label it
 *  with this noun and segment by phase.
 *
 *  Deliberately parked in this leaf: `lib/email.ts` (the staff alert copy) and
 *  `server/usecases/ai-runs-admin.ts` (the margin panel) both need it, and
 *  ai-runs-admin already imports lib/email — putting it in either would close
 *  an import cycle. This module imports nothing. */
export const AI_RUN_UNIT_NOUN = {
  schedule: "movable fixture",
  officials: "fixture",
} as const;

/** `AI_RUN_UNIT_NOUN[phase]`, pluralised for `count` (anything but exactly 1,
 *  including a missing count, reads as the plural). */
export function aiRunUnitNoun(
  phase: keyof typeof AI_RUN_UNIT_NOUN,
  count?: number | null,
): string {
  const noun = AI_RUN_UNIT_NOUN[phase];
  return count === 1 ? noun : `${noun}s`;
}
