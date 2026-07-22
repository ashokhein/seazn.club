// Unit tests for the model fallback ladder (schedule-ai.ts): rung parsing,
// the pure runLadder orchestrator, and the cost/served-model truth it carries.
// No network — runLadder is exercised over injected attempt/acceptable fns.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HttpError } from "@/lib/errors";
import { AiProviderError } from "@/server/ai/provider";
import {
  DEFAULT_LADDER,
  planRungs,
  runLadder,
  schedulingAiLadder,
  type LadderRung,
  type AiPlanResult,
} from "../schedule-ai";

// --- fakes -----------------------------------------------------------------
type Usage = AiPlanResult["usage"];
const usage = (input: number, output: number, cost: number | null): Usage => ({
  input_tokens: input,
  output_tokens: output,
  repair_rounds: 0,
  cost_usd: cost,
});

function fakeResult(over: { warnings?: number; blocking?: number; usage?: Usage } = {}): AiPlanResult {
  return {
    proposal: [],
    unschedulable: [],
    warnings: Array.from({ length: over.warnings ?? 0 }, () => ({ fixtureId: "x", reason: "rest" as const })),
    blocking: Array.from({ length: over.blocking ?? 0 }, () => ({ fixtureId: "x", reason: "court" as const })),
    diff: { moved: [], placed: [], unscheduled: [], unchanged: [] },
    explanations: [],
    summary: "ok",
    usage: over.usage ?? usage(100, 50, 0.01),
  };
}

const planFailed = (u?: Usage) =>
  new HttpError(422, "AI scheduling could not produce a usable plan; please retry", "AI_PLAN_FAILED", {
    ...(u ? { usage: u } : {}),
  });

// Every rung is acceptable unless a test says otherwise.
const alwaysOk = () => true;

// --- schedulingAiLadder ----------------------------------------------------
describe("schedulingAiLadder", () => {
  const saved = process.env.SCHEDULING_AI_LADDER;
  afterEach(() => {
    if (saved === undefined) delete process.env.SCHEDULING_AI_LADDER;
    else process.env.SCHEDULING_AI_LADDER = saved;
  });

  it("returns null when unset or whitespace-only (caller uses the legacy path)", () => {
    delete process.env.SCHEDULING_AI_LADDER;
    expect(schedulingAiLadder()).toBeNull();
    process.env.SCHEDULING_AI_LADDER = "   ";
    expect(schedulingAiLadder()).toBeNull();
  });

  it("parses the recommended production ladder, inferring provider from the model id", () => {
    process.env.SCHEDULING_AI_LADDER = "google/gemini-3.6-flash,claude-sonnet-5,x-ai/grok-4.5";
    expect(schedulingAiLadder()).toEqual([
      { provider: "openrouter", model: "google/gemini-3.6-flash" },
      { provider: "anthropic", model: "claude-sonnet-5" },
      { provider: "openrouter", model: "x-ai/grok-4.5" },
    ]);
  });

  it("trims whitespace and drops empty entries (trailing comma, double comma)", () => {
    process.env.SCHEDULING_AI_LADDER = " google/gemini-3.6-flash , , claude-sonnet-5 ,";
    expect(schedulingAiLadder()).toEqual([
      { provider: "openrouter", model: "google/gemini-3.6-flash" },
      { provider: "anthropic", model: "claude-sonnet-5" },
    ]);
  });
});

// --- planRungs -------------------------------------------------------------
describe("planRungs", () => {
  const keys = ["SCHEDULING_AI_LADDER", "SCHEDULING_AI_MODEL", "SCHEDULING_AI_CHEAP_MODEL", "AI_PROVIDER"] as const;
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

  it("an explicit SCHEDULING_AI_LADDER wins and ignores model/cheap overrides", () => {
    process.env.SCHEDULING_AI_LADDER = "google/gemini-3.6-flash,claude-sonnet-5";
    process.env.SCHEDULING_AI_MODEL = "claude-haiku-4-5";
    process.env.SCHEDULING_AI_CHEAP_MODEL = "claude-haiku-4-5";
    expect(planRungs()).toEqual([
      { provider: "openrouter", model: "google/gemini-3.6-flash" },
      { provider: "anthropic", model: "claude-sonnet-5" },
    ]);
  });

  it("with nothing set, the DEFAULT_LADDER (gemini→sonnet→grok) is the shipped default", () => {
    // Unconfigured rungs skip at run time, so on a no-OPENROUTER_API_KEY box this
    // still resolves to sonnet-direct — but the code default IS the ladder.
    expect(planRungs()).toEqual([...DEFAULT_LADDER]);
  });

  it("SCHEDULING_AI_MODEL pins a single rung (no fallback) on the AI_PROVIDER transport", () => {
    process.env.SCHEDULING_AI_MODEL = "claude-haiku-4-5";
    expect(planRungs()).toEqual([{ provider: "anthropic", model: "claude-haiku-4-5" }]);
    process.env.AI_PROVIDER = "openrouter";
    process.env.SCHEDULING_AI_MODEL = "x-ai/grok-4.5";
    expect(planRungs()).toEqual([{ provider: "openrouter", model: "x-ai/grok-4.5" }]);
  });

  it("reproduces the legacy cheap→primary escalation when SCHEDULING_AI_CHEAP_MODEL is set", () => {
    process.env.SCHEDULING_AI_CHEAP_MODEL = "claude-haiku-4-5";
    expect(planRungs()).toEqual([
      { provider: "anthropic", model: "claude-haiku-4-5" },
      { provider: "anthropic", model: "claude-sonnet-5" },
    ]);
  });
});

// --- runLadder -------------------------------------------------------------
describe("runLadder", () => {
  const R: LadderRung[] = [
    { provider: "openrouter", model: "google/gemini-3.6-flash" },
    { provider: "anthropic", model: "claude-sonnet-5" },
    { provider: "openrouter", model: "x-ai/grok-4.5" },
  ];

  it("returns the first acceptable rung without trying the rest", async () => {
    const attempt = vi.fn().mockResolvedValue(fakeResult());
    const out = await runLadder<AiPlanResult>(R, attempt, alwaysOk);
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(out.served_model).toBe("google/gemini-3.6-flash");
    expect(out.escalated_from).toBeUndefined();
    expect(out.rungs_tried).toEqual(["google/gemini-3.6-flash"]);
  });

  it("falls through a thrown recoverable failure to the next rung, summing usage and stamping the winner", async () => {
    const attempt = vi
      .fn()
      .mockRejectedValueOnce(planFailed(usage(200, 100, 0.02)))
      .mockResolvedValueOnce(fakeResult({ usage: usage(300, 150, 0.05) }));
    const out = await runLadder<AiPlanResult>(R, attempt, alwaysOk);
    expect(attempt).toHaveBeenCalledTimes(2);
    expect(out.served_model).toBe("claude-sonnet-5");
    expect(out.escalated_from).toBe("google/gemini-3.6-flash");
    expect(out.rungs_tried).toEqual(["google/gemini-3.6-flash", "claude-sonnet-5"]);
    // gemini's failed spend + sonnet's winning spend.
    expect(out.usage).toMatchObject({ input_tokens: 500, output_tokens: 250, cost_usd: 0.07 });
  });

  it("skips a rung whose provider is unconfigured (AI_PROVIDER_NOT_CONFIGURED) and lands on the next", async () => {
    // This is what lets DEFAULT_LADDER ship: no OPENROUTER_API_KEY → the gemini
    // rung throws 503/AI_PROVIDER_NOT_CONFIGURED → skip → sonnet serves.
    const attempt = vi
      .fn()
      .mockRejectedValueOnce(new HttpError(503, "not configured", "AI_PROVIDER_NOT_CONFIGURED"))
      .mockResolvedValueOnce(fakeResult());
    const out = await runLadder<AiPlanResult>(R, attempt, alwaysOk);
    expect(attempt).toHaveBeenCalledTimes(2);
    expect(out.served_model).toBe("claude-sonnet-5");
  });

  it("a real failure on a configured rung is NOT masked by a trailing unconfigured skip", async () => {
    // gemini unconfigured (skip) → sonnet throws a genuine provider error →
    // grok unconfigured (skip, last). The thrown error must be sonnet's real
    // AiProviderError, never grok's 'not configured' — otherwise a provider
    // outage would surface as a spurious 503-not-configured (the CI regression).
    const providerErr = new AiProviderError("credit balance too low");
    const attempt = vi
      .fn()
      .mockRejectedValueOnce(new HttpError(503, "not configured", "AI_PROVIDER_NOT_CONFIGURED"))
      .mockRejectedValueOnce(providerErr)
      .mockRejectedValueOnce(new HttpError(503, "not configured", "AI_PROVIDER_NOT_CONFIGURED"));
    const err = await runLadder<AiPlanResult>(R, attempt, alwaysOk).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBe(providerErr);
    expect((err as { model?: string }).model).toBe("claude-sonnet-5");
  });

  it("a configured rung's AI_PLAN_FAILED wins over a trailing unconfigured skip", async () => {
    const attempt = vi
      .fn()
      .mockRejectedValueOnce(new HttpError(503, "not configured", "AI_PROVIDER_NOT_CONFIGURED"))
      .mockRejectedValueOnce(planFailed(usage(100, 50, 0.01)))
      .mockRejectedValueOnce(new HttpError(503, "not configured", "AI_PROVIDER_NOT_CONFIGURED"));
    const err = await runLadder<AiPlanResult>(R, attempt, alwaysOk).then(
      () => null,
      (e: HttpError) => e,
    );
    expect(err!.code).toBe("AI_PLAN_FAILED");
    expect(err!.extra?.model).toBe("claude-sonnet-5");
  });

  it("advances past a usable-but-unacceptable plan (warning flood) and pays for it", async () => {
    const attempt = vi
      .fn()
      .mockResolvedValueOnce(fakeResult({ warnings: 9, usage: usage(200, 100, 0.02) }))
      .mockResolvedValueOnce(fakeResult({ usage: usage(300, 150, 0.05) }));
    const acceptable = (r: AiPlanResult) => r.warnings.length === 0;
    const out = await runLadder<AiPlanResult>(R, attempt, acceptable);
    expect(attempt).toHaveBeenCalledTimes(2);
    expect(out.served_model).toBe("claude-sonnet-5");
    expect(out.usage).toMatchObject({ input_tokens: 500, output_tokens: 250, cost_usd: 0.07 });
  });

  it("does NOT fall back on a deterministic user error — it rethrows immediately", async () => {
    const userErr = new HttpError(422, "AI_PLAN_EMPTY_SCOPE", "AI_PLAN_EMPTY_SCOPE");
    const attempt = vi.fn().mockRejectedValue(userErr);
    await expect(runLadder<AiPlanResult>(R, attempt, alwaysOk)).rejects.toBe(userErr);
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it("falls back on a provider transport error (AiProviderError)", async () => {
    const attempt = vi
      .fn()
      .mockRejectedValueOnce(new AiProviderError("OpenRouter returned an unparsable response body"))
      .mockResolvedValueOnce(fakeResult());
    const out = await runLadder<AiPlanResult>(R, attempt, alwaysOk);
    expect(attempt).toHaveBeenCalledTimes(2);
    expect(out.served_model).toBe("claude-sonnet-5");
  });

  it("ships the last rung's plan even when it is not acceptable (best effort beats a hard fail)", async () => {
    const attempt = vi.fn().mockResolvedValue(fakeResult({ blocking: 1 }));
    const out = await runLadder<AiPlanResult>(R, attempt, () => false);
    expect(attempt).toHaveBeenCalledTimes(3);
    expect(out.served_model).toBe("x-ai/grok-4.5");
    expect(out.blocking).toHaveLength(1);
  });

  it("when every rung fails, throws the last error with accumulated usage and the last model", async () => {
    const attempt = vi
      .fn()
      .mockRejectedValueOnce(planFailed(usage(100, 50, 0.01)))
      .mockRejectedValueOnce(planFailed(usage(200, 100, 0.02)))
      .mockRejectedValueOnce(planFailed(usage(300, 150, 0.03)));
    const err = await runLadder<AiPlanResult>(R, attempt, alwaysOk).then(
      () => null,
      (e: HttpError) => e,
    );
    expect(err).toBeInstanceOf(HttpError);
    expect(err!.code).toBe("AI_PLAN_FAILED");
    expect(err!.extra?.usage).toMatchObject({ input_tokens: 600, output_tokens: 300, cost_usd: 0.06 });
    expect(err!.extra?.model).toBe("x-ai/grok-4.5");
  });

  it("annotates a final AiProviderError with accumulated usage and the last model (loose fields)", async () => {
    const attempt = vi
      .fn()
      .mockRejectedValueOnce(planFailed(usage(100, 50, 0.01)))
      .mockRejectedValueOnce(new AiProviderError("provider down"));
    const err = await runLadder<AiPlanResult>([R[0]!, R[1]!], attempt, alwaysOk).then(
      () => null,
      (e: AiProviderError & { usage?: Usage; model?: string }) => e,
    );
    expect(err).toBeInstanceOf(AiProviderError);
    // gemini's failed spend rode along; the provider error carried none of its own.
    expect(err!.usage).toMatchObject({ input_tokens: 100, output_tokens: 50, cost_usd: 0.01 });
    expect(err!.model).toBe("claude-sonnet-5");
  });

  it("preserves a null cost across the sum (unknown price must not read as free)", async () => {
    const attempt = vi
      .fn()
      .mockResolvedValueOnce(fakeResult({ warnings: 9, usage: usage(200, 100, null) }))
      .mockResolvedValueOnce(fakeResult({ usage: usage(300, 150, 0.05) }));
    const out = await runLadder<AiPlanResult>(R, attempt, (r) => r.warnings.length === 0);
    expect(out.usage.cost_usd).toBeNull();
  });
});
