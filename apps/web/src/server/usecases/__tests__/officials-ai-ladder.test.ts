// Phase B (officials) uses the SAME runLadder as Phase A (covered exhaustively
// in schedule-ai-ladder.test.ts) — the only officials-specific logic is the
// rung list, which reads its OWN env (OFFICIALS_AI_LADDER) and must NOT inherit
// the schedule architect's SCHEDULING_AI_LADDER.
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { officialsPlanRungs } from "../officials-ai";
import { DEFAULT_LADDER } from "../schedule-ai";

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

  it("with nothing set, the DEFAULT_LADDER (unconfigured rungs skip → sonnet-direct until OpenRouter is keyed)", () => {
    expect(officialsPlanRungs()).toEqual([...DEFAULT_LADDER]);
  });

  it("parses OFFICIALS_AI_LADDER, inferring provider from the model id", () => {
    process.env.OFFICIALS_AI_LADDER = "google/gemini-3.6-flash,claude-sonnet-5";
    expect(officialsPlanRungs()).toEqual([
      { provider: "openrouter", model: "google/gemini-3.6-flash" },
      { provider: "anthropic", model: "claude-sonnet-5" },
    ]);
  });

  it("does NOT inherit SCHEDULING_AI_LADDER — that env is invisible to officials", () => {
    process.env.SCHEDULING_AI_LADDER = "claude-haiku-4-5,claude-sonnet-5";
    // OFFICIALS_AI_LADDER unset: officials reads ONLY its own env, so a custom
    // schedule ladder does not leak in — officials falls to its own default.
    expect(officialsPlanRungs()).toEqual([...DEFAULT_LADDER]);
  });

  it("SCHEDULING_AI_MODEL pins a single officials rung on the AI_PROVIDER transport", () => {
    process.env.AI_PROVIDER = "openrouter";
    process.env.SCHEDULING_AI_MODEL = "x-ai/grok-4.5";
    expect(officialsPlanRungs()).toEqual([{ provider: "openrouter", model: "x-ai/grok-4.5" }]);
  });
});
