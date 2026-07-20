import { describe, expect, it } from "vitest";
import { aiRate, aiRunCostUsd } from "../ai-pricing";

// Dates are pinned so these assertions cannot drift with the clock.
const JULY = new Date("2026-07-20T12:00:00Z");
const SEPTEMBER = new Date("2026-09-01T00:00:00Z");

describe("aiRunCostUsd", () => {
  // 5,212 in + 26,917 out — the measured live run from 2026-07-19.
  //
  // Billed at LIST. An introductory $2/$10 rate was briefly applied here and
  // reverted on 2026-07-20: reconciling the real account balance against 28
  // benched runs showed list-rate billing, so the intro rate had made the
  // ledger understate by 33%. The date argument stays because the mechanism
  // still supports a window — it is just not in use.
  it("prices sonnet-5 at list, and does not vary with the date", () => {
    expect(aiRunCostUsd("claude-sonnet-5", 5212, 26917, JULY)).toBe(0.4194);
    expect(aiRunCostUsd("claude-sonnet-5", 5212, 26917, SEPTEMBER)).toBe(0.4194);
  });

  it("prices haiku-4-5 at $1/$5 — the cheap-model escalation target", () => {
    // The 2026-07-20 sparse-pack measurement: 8,511 in + 4,629 out.
    expect(aiRunCostUsd("claude-haiku-4-5", 8511, 4629, JULY)).toBe(0.0317);
  });

  it("prices opus-4-8 at $5/$25 per 1M", () => {
    expect(aiRunCostUsd("claude-opus-4-8", 1_000_000, 1_000_000, JULY)).toBe(30);
  });

  it("aiRate reports the rate a cost was stamped at", () => {
    expect(aiRate("claude-sonnet-5", JULY)).toEqual({ input: 3, output: 15 });
    expect(aiRate("claude-haiku-4-5", JULY)).toEqual({ input: 1, output: 5 });
  });

  it("zero tokens cost zero (solver draft)", () => {
    expect(aiRunCostUsd("claude-sonnet-5", 0, 0, JULY)).toBe(0);
  });

  it("unknown model → null, never a guessed price", () => {
    expect(aiRunCostUsd("some-custom-model", 1000, 1000, JULY)).toBeNull();
    expect(aiRate("some-custom-model", JULY)).toBeNull();
  });
});
