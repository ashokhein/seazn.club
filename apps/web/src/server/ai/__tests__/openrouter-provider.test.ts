import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";
import { openRouterProvider } from "../openrouter-provider";
import { AiProviderError } from "../provider";

const Plan = z.object({ ok: z.boolean() });

const reply = (over: Record<string, unknown> = {}) => ({
  ok: true,
  json: async () => ({
    model: "anthropic/claude-sonnet-5",
    choices: [
      {
        finish_reason: "stop",
        native_finish_reason: "stop",
        message: {
          role: "assistant",
          content: JSON.stringify({ ok: true }),
          reasoning_details: [{ type: "reasoning.text", text: "…" }],
        },
      },
    ],
    usage: {
      prompt_tokens: 10,
      completion_tokens: 20,
      cost: 0.1234,
      cached_tokens: 5,
      cache_write_tokens: 0,
    },
    ...over,
  }),
});

async function callOnce() {
  return openRouterProvider().chat({
    model: "anthropic/claude-sonnet-5",
    system: "SYS",
    messages: [{ role: "user", content: "hello" }],
    maxTokens: 32_000,
    reasoning: { kind: "effort", effort: "high", thinking: "adaptive" },
    schema: { name: "schedule_plan", zod: Plan },
    signal: new AbortController().signal,
    timeoutMs: 600_000,
  });
}

beforeEach(() => {
  process.env.OPENROUTER_API_KEY = "test-key";
  vi.restoreAllMocks();
});

describe("openrouter provider", () => {
  it("parses the plan out of the message content", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(reply()));
    const res = await callOnce();
    expect(res!.parsed).toEqual({ ok: true });
  });

  it("keeps the assistant message whole, reasoning_details included", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(reply()));
    const res = await callOnce();
    const content = res!.assistantTurn.content as { reasoning_details?: unknown[] };
    expect(content.reasoning_details).toHaveLength(1);
  });

  it("prefers the billed cost the response reports", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(reply()));
    const res = await callOnce();
    expect(res!.usage.costUsd).toBe(0.1234);
    expect(res!.usage.inputTokens).toBe(10);
    expect(res!.usage.outputTokens).toBe(20);
    expect(res!.usage.cachedTokens).toBe(5);
  });

  it("stamps the model that actually served the request", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(reply({ model: "xai/other" })));
    const res = await callOnce();
    expect(res!.servedModel).toBe("xai/other");
  });

  it("returns parsed:null when the content is not valid JSON", async () => {
    const bad = {
      ok: true,
      json: async () => ({
        model: "m",
        choices: [{ finish_reason: "stop", message: { role: "assistant", content: "not json" } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(bad));
    const res = await callOnce();
    expect(res!.parsed).toBeNull();
    expect(res!.refused).toBe(false);
  });

  it("returns parsed:null when the JSON does not match the schema", async () => {
    const bad = {
      ok: true,
      json: async () => ({
        model: "m",
        choices: [
          { finish_reason: "stop", message: { role: "assistant", content: JSON.stringify({ ok: "no" }) } },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(bad));
    const res = await callOnce();
    expect(res!.parsed).toBeNull();
    expect(res!.refused).toBe(false);
  });

  // Evidence (live probe against anthropic/claude-sonnet-5 via OpenRouter,
  // 2026-07-21, a request designed to trigger Anthropic's safety refusal):
  //   choices[0].finish_reason === "content_filter"
  //   choices[0].native_finish_reason === "refusal"
  //   choices[0].message.content === null
  //   choices[0].message.refusal === "API integrators: you can reduce…"
  // OpenRouter's own docs (Finish Reason section) confirm finish_reason is
  // NORMALIZED across every upstream provider to one of: tool_calls, stop,
  // length, content_filter, error — content_filter is the one value that
  // covers a declined response regardless of which vendor served it, so it
  // is the only signal that is provider-agnostic. native_finish_reason and
  // message.refusal are useful corroboration but are NOT documented as
  // present for every provider, so they are not the primary signal.
  it("flags a refusal via the normalized content_filter finish_reason, with no parse spent on it", async () => {
    const refusal = {
      ok: true,
      json: async () => ({
        model: "anthropic/claude-sonnet-5",
        choices: [
          {
            finish_reason: "content_filter",
            native_finish_reason: "refusal",
            message: { role: "assistant", content: null, refusal: "I can't help with that." },
          },
        ],
        usage: { prompt_tokens: 62, completion_tokens: 1, cost: 0 },
      }),
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(refusal));
    const res = await callOnce();
    expect(res!.refused).toBe(true);
    expect(res!.parsed).toBeNull();
  });

  it("does not flag an ordinary stop as a refusal", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(reply()));
    const res = await callOnce();
    expect(res!.refused).toBe(false);
  });

  it("throws AiProviderError on a non-2xx response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 502, text: async () => "bad gateway" }),
    );
    await expect(callOnce()).rejects.toBeInstanceOf(AiProviderError);
  });

  it("throws AiProviderError when the key is missing", async () => {
    delete process.env.OPENROUTER_API_KEY;
    await expect(callOnce()).rejects.toBeInstanceOf(AiProviderError);
  });
});
