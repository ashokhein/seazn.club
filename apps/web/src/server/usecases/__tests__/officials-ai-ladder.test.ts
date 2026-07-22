// Phase B (officials) uses the SAME runLadder as Phase A (covered exhaustively
// in schedule-ai-ladder.test.ts) — the only officials-specific logic is the
// rung list, which reads its OWN env (OFFICIALS_AI_LADDER) and must NOT inherit
// the schedule architect's SCHEDULING_AI_LADDER.
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { officialsPlanRungs } from "../officials-ai";

describe("officialsPlanRungs", () => {
  const keys = ["OFFICIALS_AI_LADDER", "SCHEDULING_AI_LADDER", "SCHEDULING_AI_MODEL", "AI_PROVIDER"] as const;
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of keys) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("with nothing set, a single sonnet-direct rung (shipped default, unchanged)", () => {
    expect(officialsPlanRungs()).toEqual([{ provider: "anthropic", model: "claude-sonnet-5" }]);
  });

  it("parses OFFICIALS_AI_LADDER, inferring provider from the model id", () => {
    process.env.OFFICIALS_AI_LADDER = "google/gemini-3.6-flash,claude-sonnet-5";
    expect(officialsPlanRungs()).toEqual([
      { provider: "openrouter", model: "google/gemini-3.6-flash" },
      { provider: "anthropic", model: "claude-sonnet-5" },
    ]);
  });

  it("does NOT inherit SCHEDULING_AI_LADDER — officials stays single-model until benched", () => {
    process.env.SCHEDULING_AI_LADDER = "google/gemini-3.6-flash,claude-sonnet-5,x-ai/grok-4.5";
    // OFFICIALS_AI_LADDER unset: flipping the schedule architect to gemini must
    // not silently route officials (unbenched) through it too.
    expect(officialsPlanRungs()).toEqual([{ provider: "anthropic", model: "claude-sonnet-5" }]);
  });

  it("AI_PROVIDER=openrouter carries into the default rung's provider", () => {
    process.env.AI_PROVIDER = "openrouter";
    expect(officialsPlanRungs()).toEqual([{ provider: "openrouter", model: "claude-sonnet-5" }]);
  });
});
