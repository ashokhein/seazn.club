// Translates a provider-neutral request into OpenRouter's OpenAI-shaped body.
// Pure and synchronous so the wire shape can be asserted without a network.
import { z } from "zod";
import { applyPolicy } from "./openrouter-policy";
import type { AiChatRequest } from "./provider";

export function buildOpenRouterBody<T>(req: AiChatRequest<T>): Record<string, unknown> {
  // The system block carries the cache breakpoint. Anthropic models routed
  // through OpenRouter need it explicitly; models that cache automatically
  // ignore it. Keeping it first also keeps the stable prefix stable — anything
  // volatile ahead of it would invalidate the cache on every request.
  const messages = [
    {
      role: "system",
      content: [
        { type: "text", text: req.system, cache_control: { type: "ephemeral" } },
      ],
    },
    ...req.messages,
  ];

  // Three-way mapping onto OpenRouter's unified `reasoning` param, mirroring
  // anthropic-provider.ts's thinking/effort split (see AiReasoning in
  // provider.ts):
  //  - effort + adaptive thinking -> { effort }
  //  - effort + disabled thinking -> { effort, enabled: false }. The code this
  //    replaces sends effort UNCONDITIONALLY while toggling thinking on/off
  //    independently, so effort must still be sent here even when thinking is
  //    off — dropping it would silently discard intent the caller still
  //    wants. `enabled: false` is the unified param's way of switching off
  //    reasoning-token spend without erasing `effort`. This is deliberately
  //    NOT collapsed into `{ kind: "none" }` (that has already been the bug
  //    fixed twice on this branch).
  //  - budget -> { max_tokens }
  //  - none -> omit `reasoning` entirely
  const reasoning =
    req.reasoning.kind === "effort"
      ? req.reasoning.thinking === "disabled"
        ? { effort: req.reasoning.effort, enabled: false }
        : { effort: req.reasoning.effort }
      : req.reasoning.kind === "budget"
        ? { max_tokens: req.reasoning.tokens }
        : undefined;

  return applyPolicy({
    model: req.model,
    max_tokens: req.maxTokens,
    messages,
    ...(reasoning ? { reasoning } : {}),
    response_format: {
      type: "json_schema",
      json_schema: {
        name: req.schema.name,
        strict: true,
        schema: z.toJSONSchema(req.schema.zod),
      },
    },
  });
}
