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

  // Regression: OpenRouter's strict json_schema mode rejects maxItems/minItems
  // on array types (HTTP 400 "For 'array' type, property 'maxItems' is not
  // supported" — verified live 2026-07-21). AiSchedulePlan bounds two arrays
  // with zod .max() (assignments, assumptions), so this broke every OpenRouter
  // call, for every model, before the fix.
  it("strips maxItems/minItems from array schemas — OpenRouter's strict mode rejects them", () => {
    const Bounded = z.object({ items: z.array(z.string()).min(1).max(10) });
    const body = buildOpenRouterBody(req({ schema: { name: "bounded", zod: Bounded } })) as any;
    const itemsSchema = body.response_format.json_schema.schema.properties.items;
    expect(itemsSchema.maxItems).toBeUndefined();
    expect(itemsSchema.minItems).toBeUndefined();
    // The bound itself is still enforced elsewhere (AiSchedulePlan.safeParse
    // in schedule-ai.ts) — this only removes the wire-level hint the vendor
    // can't accept, so the rest of the schema must survive unstripped.
    expect(itemsSchema.type).toBe("array");
    expect(itemsSchema.items.type).toBe("string");
  });

  // Regression: same rejection class, on integers — OpenRouter's strict mode
  // also rejects minimum/maximum (HTTP 400 "For 'integer' type, properties
  // maximum, minimum are not supported" — verified live 2026-07-21, from
  // SchedulingConstraints' `restMin: z.number().int().nonnegative()` reached
  // via AiConstraintDelta = SchedulingConstraints.partial()).
  it("strips minimum/maximum/exclusive bounds from numeric schemas", () => {
    const Bounded = z.object({ n: z.number().int().nonnegative().max(100) });
    const body = buildOpenRouterBody(req({ schema: { name: "bounded", zod: Bounded } })) as any;
    const nSchema = body.response_format.json_schema.schema.properties.n;
    expect(nSchema.minimum).toBeUndefined();
    expect(nSchema.maximum).toBeUndefined();
    expect(nSchema.exclusiveMinimum).toBeUndefined();
    expect(nSchema.exclusiveMaximum).toBeUndefined();
    expect(nSchema.type).toBe("integer");
  });

  // Regression: a repair round replays the prior assistant turn.
  // openrouter-provider.ts's assistantTurn.content is deliberately the FULL
  // raw message object (role/content/reasoning_details), not a string — see
  // its "keeps the assistant message whole" test. Spreading it straight into
  // req.messages previously nested that object inside another message's
  // `content` field, which OpenRouter rejected live 2026-07-21 mid-repair
  // (`messages.2.content: Invalid input`, after ~340s of real round-1
  // generation on anthropic/claude-sonnet-5). It must be used AS the wire
  // message, not wrapped again.
  it("unwraps a replayed assistant turn into its own wire message, not nested content", () => {
    const rawAssistantMessage = {
      role: "assistant",
      content: JSON.stringify({ ok: true }),
      reasoning_details: [{ type: "reasoning.text", text: "…" }],
    };
    const body = buildOpenRouterBody(
      req({
        messages: [
          { role: "user", content: "hello" },
          { role: "assistant", content: rawAssistantMessage },
          { role: "user", content: "fix it" },
        ],
      }),
    ) as any;
    // messages[0] is the injected system prompt, so the replayed assistant
    // turn lands at index 2.
    expect(body.messages[2]).toEqual(rawAssistantMessage);
    expect(body.messages[3]).toEqual({ role: "user", content: "fix it" });
  });

  // A plain user turn's content is always a string (schedule-ai.ts sends
  // JSON.stringify(...)) — must pass through untouched, not be mistaken for
  // a replayable assistant message object.
  it("leaves plain string-content turns untouched", () => {
    const body = buildOpenRouterBody(req({ messages: [{ role: "user", content: "plain string" }] })) as any;
    expect(body.messages[1]).toEqual({ role: "user", content: "plain string" });
  });
});
