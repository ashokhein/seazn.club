import { describe, it, expect } from "vitest";
import { z } from "zod";
import { buildOpenRouterBody } from "../openrouter-request";

const Plan = z.object({ ok: z.boolean() });

const req = (over: Record<string, unknown> = {}) => ({
  model: "anthropic/claude-sonnet-5",
  system: "SYS",
  messages: [{ role: "user" as const, content: "hello" }],
  maxTokens: 32_000,
  reasoning: { kind: "effort" as const, effort: "high" as const, thinking: "adaptive" as const },
  schema: { name: "schedule_plan", zod: Plan },
  signal: new AbortController().signal,
  timeoutMs: 600_000,
  ...over,
});

describe("openrouter request body", () => {
  it("puts the system prompt first and marks it cacheable", () => {
    const body = buildOpenRouterBody(req()) as any;
    expect(body.messages[0].role).toBe("system");
    expect(body.messages[0].content[0].cache_control).toEqual({ type: "ephemeral" });
  });

  it("maps effort reasoning (adaptive thinking) to the unified reasoning parameter", () => {
    const body = buildOpenRouterBody(req()) as any;
    expect(body.reasoning).toEqual({ effort: "high" });
  });

  it("sends effort while explicitly disabling reasoning when thinking is disabled — the two are orthogonal", () => {
    // Mirrors the Anthropic adapter's "disabled thinking + effort" case: the
    // effort intent must still be sent, but OpenRouter needs to be told not to
    // spend reasoning tokens on it. `enabled: false` is the unified param's
    // way of saying that without dropping `effort`.
    const body = buildOpenRouterBody(
      req({ reasoning: { kind: "effort", effort: "high", thinking: "disabled" } }),
    ) as any;
    expect(body.reasoning).toEqual({ effort: "high", enabled: false });
  });

  it("maps a legacy budget to reasoning.max_tokens", () => {
    const body = buildOpenRouterBody(
      req({ reasoning: { kind: "budget", tokens: 8_000 } }),
    ) as any;
    expect(body.reasoning).toEqual({ max_tokens: 8_000 });
  });

  it("omits reasoning entirely when none is asked for", () => {
    const body = buildOpenRouterBody(req({ reasoning: { kind: "none" } })) as any;
    expect(body.reasoning).toBeUndefined();
  });

  it("requests a strict json schema built from the zod schema", () => {
    const body = buildOpenRouterBody(req()) as any;
    expect(body.response_format.type).toBe("json_schema");
    expect(body.response_format.json_schema.name).toBe("schedule_plan");
    expect(body.response_format.json_schema.strict).toBe(true);
    expect(body.response_format.json_schema.schema.type).toBe("object");
  });

  it("always carries the data policy", () => {
    const body = buildOpenRouterBody(req()) as any;
    expect(body.provider.data_collection).toBe("deny");
    expect(body.zdr).toBe(true);
  });
});
