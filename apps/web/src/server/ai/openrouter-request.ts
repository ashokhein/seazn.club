// Translates a provider-neutral request into OpenRouter's OpenAI-shaped body.
// Pure and synchronous so the wire shape can be asserted without a network.
import { z } from "zod";
import { applyPolicy } from "./openrouter-policy";
import type { AiChatRequest, AiTurn } from "./provider";

/** An OpenRouter assistant turn's `content` (see openrouter-provider.ts's
 *  `assistantTurn`, and its test "keeps the assistant message whole,
 *  reasoning_details included") is deliberately the FULL raw message object
 *  this adapter received back — `{role, content, reasoning_details, ...}` —
 *  so a repair round can replay it unmodified. Spreading `req.messages`
 *  directly into the wire array (the previous behavior) nested that whole
 *  object inside ANOTHER message's `content` field —
 *  `{role:"assistant", content: {role,content,reasoning_details}}` — which
 *  OpenRouter rejects (`content` must be a string or content-part array, not
 *  an object): verified live 2026-07-21, a real repair round on
 *  `anthropic/claude-sonnet-5` after ~340s of round-1 generation —
 *  `messages.2.content: Invalid input` (HTTP 400). When an assistant turn's
 *  content IS that raw message shape, use it directly as the wire message
 *  instead of re-wrapping it. A plain user turn's content is always a string
 *  (schedule-ai.ts sends `JSON.stringify(...)`), so it is untouched here. */
function toWireMessage(turn: AiTurn): unknown {
  if (
    turn.role === "assistant" &&
    turn.content &&
    typeof turn.content === "object" &&
    !Array.isArray(turn.content) &&
    "role" in (turn.content as Record<string, unknown>)
  ) {
    return turn.content;
  }
  return turn;
}

/** OpenRouter's strict `json_schema` mode (as enforced on the Anthropic
 *  first-party route, at minimum) rejects numeric/array bound keywords
 *  outright. Verified live 2026-07-21 against `anthropic/claude-sonnet-5`,
 *  two distinct rejections:
 *    - `output_config.format.schema: For 'array' type, property 'maxItems'
 *      is not supported` (request_id `req_011CdFj2ythzm8q8drnCah8F`) — from
 *      `AiSchedulePlan`'s `.max()` on `assignments`/`assumptions`
 *      (schedule-ai-prompt.ts).
 *    - `output_config.format.schema: For 'integer' type, properties maximum,
 *      minimum are not supported` (request_id `req_011CdFjaCFxkqpqrJEH8BysU`)
 *      — from `restMin`/`restByGroup`'s `.nonnegative()` on
 *      `SchedulingConstraints` (packages/engine/src/scheduling/constraints.ts),
 *      reached via `AiConstraintDelta = SchedulingConstraints.partial()`.
 *    - `output_config.format.schema: For 'object' type, property
 *      'propertyNames' is not supported` (request_id
 *      `req_011CdFjiYZKZ5oumqKtT66w6`) — from `restByGroup`'s
 *      `z.record(z.string(), ...)`, whose JSON Schema form constrains the
 *      record's keys with `propertyNames`.
 *  All three are zod-derived bounds `z.toJSONSchema` turns into JSON Schema
 *  keywords the vendor won't accept — so EVERY structured-output call
 *  through this adapter failed before this fix, for every model, independent
 *  of which candidate was being tested. Strip the whole bound-keyword family
 *  recursively rather than changing the zod schemas themselves:
 *  `AiSchedulePlan.safeParse()` in schedule-ai.ts still enforces every bound
 *  on the response, so this only drops a wire-level hint the vendor can't
 *  accept, not the enforcement. */
const UNSUPPORTED_BOUND_KEYS = new Set([
  "maxItems",
  "minItems",
  "maximum",
  "minimum",
  "exclusiveMaximum",
  "exclusiveMinimum",
  "propertyNames",
]);

function stripUnsupportedBounds(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(stripUnsupportedBounds);
  if (node && typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) {
      if (UNSUPPORTED_BOUND_KEYS.has(key)) continue;
      out[key] = stripUnsupportedBounds(value);
    }
    return out;
  }
  return node;
}

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
    ...req.messages.map(toWireMessage),
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
        schema: stripUnsupportedBounds(z.toJSONSchema(req.schema.zod)),
      },
    },
  });
}
