import { describe, expect, it } from "vitest";
import { aiRate, aiRunCostUsd } from "../ai-pricing";

// Dates are pinned explicitly: these assertions must not change meaning when
// the sonnet-5 introductory window lapses on 2026-09-01.
const DURING_INTRO = new Date("2026-07-20T12:00:00Z");
const AFTER_INTRO = new Date("2026-09-01T00:00:00Z");

describe("aiRunCostUsd", () => {
  // 5,212 in + 26,917 out — the measured live run from 2026-07-19.
  it("prices sonnet-5 at the $2/$10 introductory rate during the window", () => {
    expect(aiRunCostUsd("claude-sonnet-5", 5212, 26917, DURING_INTRO)).toBe(0.2796);
  });

  it("prices sonnet-5 at the $3/$15 list rate once the window lapses", () => {
    expect(aiRunCostUsd("claude-sonnet-5", 5212, 26917, AFTER_INTRO)).toBe(0.4194);
  });

  it("intro window is inclusive of its final day", () => {
    const lastMoment = new Date("2026-08-31T23:59:59Z");
    expect(aiRate("claude-sonnet-5", lastMoment)).toEqual({ input: 2, output: 10 });
    expect(aiRate("claude-sonnet-5", AFTER_INTRO)).toEqual({ input: 3, output: 15 });
  });

  it("models without an intro window are date-independent", () => {
    expect(aiRunCostUsd("claude-opus-4-8", 1_000_000, 1_000_000, DURING_INTRO)).toBe(30);
    expect(aiRunCostUsd("claude-opus-4-8", 1_000_000, 1_000_000, AFTER_INTRO)).toBe(30);
  });

  it("zero tokens cost zero (solver draft)", () => {
    expect(aiRunCostUsd("claude-sonnet-5", 0, 0, DURING_INTRO)).toBe(0);
  });

  it("unknown model → null, never a guessed price", () => {
    expect(aiRunCostUsd("some-custom-model", 1000, 1000, DURING_INTRO)).toBeNull();
    expect(aiRate("some-custom-model", DURING_INTRO)).toBeNull();
  });
});
