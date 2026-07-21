import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";

const parse = vi.fn();
const ctorOpts: Record<string, unknown>[] = [];

vi.mock("@anthropic-ai/sdk", () => {
  class FakeAnthropic {
    messages = { parse };
    constructor(opts: Record<string, unknown>) {
      ctorOpts.push(opts);
    }
    static APIError = class extends Error {};
  }
  return { default: FakeAnthropic };
});

const Plan = z.object({ ok: z.boolean() });

beforeEach(() => {
  parse.mockReset();
  ctorOpts.length = 0;
  process.env.ANTHROPIC_API_KEY = "test-key";
});

async function callOnce(over: Record<string, unknown> = {}) {
  const { anthropicProvider } = await import("../anthropic-provider");
  return anthropicProvider().chat({
    model: "claude-sonnet-5",
    system: "SYS",
    messages: [{ role: "user", content: "hello" }],
    maxTokens: 32_000,
    reasoning: { kind: "effort", effort: "high" },
    schema: { name: "plan", zod: Plan },
    signal: new AbortController().signal,
    timeoutMs: 600_000,
    ...over,
  });
}

describe("anthropic provider", () => {
  it("sends adaptive thinking + effort, and caches the system block", async () => {
    parse.mockResolvedValue({
      parsed_output: { ok: true },
      content: [{ type: "text", text: "x" }],
      usage: { input_tokens: 10, output_tokens: 20 },
      model: "claude-sonnet-5",
    });

    await callOnce();

    const [body] = parse.mock.calls[0];
    expect(body.thinking).toEqual({ type: "adaptive" });
    expect(body.output_config.effort).toBe("high");
    expect(body.system[0].cache_control).toEqual({ type: "ephemeral" });
    expect(body.max_tokens).toBe(32_000);
  });

  it("sends a legacy token budget instead of effort when the model demands it", async () => {
    parse.mockResolvedValue({
      parsed_output: { ok: true },
      content: [],
      usage: { input_tokens: 1, output_tokens: 1 },
      model: "claude-haiku-4-5",
    });

    await callOnce({ reasoning: { kind: "budget", tokens: 8_000 } });

    const [body] = parse.mock.calls[0];
    expect(body.thinking).toEqual({ type: "enabled", budget_tokens: 8_000 });
    expect(body.output_config.effort).toBeUndefined();
  });

  it("carries a client-constructor timeout — a per-request timeout cannot bypass the SDK's non-streaming guard", async () => {
    parse.mockResolvedValue({
      parsed_output: { ok: true },
      content: [],
      usage: { input_tokens: 1, output_tokens: 1 },
      model: "claude-sonnet-5",
    });

    await callOnce();

    expect(ctorOpts[0].timeout).toBeGreaterThan(0);
  });

  it("returns the assistant turn verbatim for repair replay", async () => {
    const content = [{ type: "thinking", thinking: "…" }, { type: "text", text: "x" }];
    parse.mockResolvedValue({
      parsed_output: { ok: true },
      content,
      usage: { input_tokens: 1, output_tokens: 1 },
      model: "claude-sonnet-5",
    });

    const res = await callOnce();
    expect(res!.assistantTurn).toEqual({ role: "assistant", content });
  });

  it("maps usage and prices the run from the pricing table", async () => {
    parse.mockResolvedValue({
      parsed_output: { ok: true },
      content: [],
      usage: { input_tokens: 1_000_000, output_tokens: 0 },
      model: "claude-sonnet-5",
    });

    const res = await callOnce();
    expect(res!.usage.inputTokens).toBe(1_000_000);
    expect(res!.usage.costUsd).toBe(3); // $3 per 1M input, list
  });

  it("returns parsed:null when the payload does not match the schema", async () => {
    parse.mockResolvedValue({
      parsed_output: { ok: "not-a-boolean" },
      content: [],
      usage: { input_tokens: 1, output_tokens: 1 },
      model: "claude-sonnet-5",
    });

    const res = await callOnce();
    expect(res!.parsed).toBeNull();
  });

  it("reports whether it is configured, so the runner can refuse before calling", async () => {
    const { anthropicProvider } = await import("../anthropic-provider");
    expect(anthropicProvider().isConfigured()).toBe(true);
    delete process.env.ANTHROPIC_API_KEY;
    expect(anthropicProvider().isConfigured()).toBe(false);
  });
});
