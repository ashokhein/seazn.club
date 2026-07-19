import { describe, expect, it } from "vitest";
import { aiRunCostUsd } from "../ai-pricing";

describe("aiRunCostUsd", () => {
  it("prices sonnet-5 at $3/$15 per 1M", () => {
    // 5,212 in + 26,917 out — the measured live run from 2026-07-19.
    expect(aiRunCostUsd("claude-sonnet-5", 5212, 26917)).toBe(0.4194);
  });

  it("prices opus-4-8 at $5/$25 per 1M", () => {
    expect(aiRunCostUsd("claude-opus-4-8", 1_000_000, 1_000_000)).toBe(30);
  });

  it("zero tokens cost zero (solver draft)", () => {
    expect(aiRunCostUsd("claude-sonnet-5", 0, 0)).toBe(0);
  });

  it("unknown model → null, never a guessed price", () => {
    expect(aiRunCostUsd("some-custom-model", 1000, 1000)).toBeNull();
  });
});
