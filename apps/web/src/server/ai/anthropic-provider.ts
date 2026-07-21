// Anthropic adapter — the shipped default. Behaviour must match the inline call
// this replaced (schedule-ai.ts:929 before the seam landed); the parity tests
// exist to keep it that way.
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { aiRunCostUsd } from "@/lib/ai-pricing";
import {
  AiProviderError,
  type AiChatRequest,
  type AiChatResponse,
  type AiProvider,
} from "./provider";

/** One hour. Load-bearing on the CLIENT CONSTRUCTOR, not per-request: the SDK
 *  computes a non-streaming timeout from max_tokens and throws synchronously
 *  ("Streaming is required…") when it exceeds ten minutes. A per-request
 *  timeout cannot bypass that check. */
const CLIENT_TIMEOUT_MS = 60 * 60 * 1000;

export function anthropicProvider(): AiProvider {
  return {
    id: "anthropic",
    isConfigured: () => Boolean(process.env.ANTHROPIC_API_KEY),
    async chat<T>(req: AiChatRequest<T>): Promise<AiChatResponse<T> | null> {
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) throw new AiProviderError("ANTHROPIC_API_KEY is not configured");
      const baseURL = process.env.SCHEDULING_AI_BASE_URL;

      const client = new Anthropic({
        apiKey,
        timeout: CLIENT_TIMEOUT_MS,
        ...(baseURL ? { baseURL } : {}),
      });

      const thinking =
        req.reasoning.kind === "effort"
          ? { type: req.reasoning.thinking }
          : req.reasoning.kind === "budget"
            ? { type: "enabled" as const, budget_tokens: req.reasoning.tokens }
            : undefined;

      let response;
      try {
        response = await client.messages.parse(
          {
            model: req.model,
            max_tokens: req.maxTokens,
            ...(thinking ? { thinking } : {}),
            output_config: {
              ...(req.reasoning.kind === "effort" ? { effort: req.reasoning.effort } : {}),
              format: zodOutputFormat(req.schema.zod),
            },
            system: [
              { type: "text", text: req.system, cache_control: { type: "ephemeral" } },
            ],
            messages: req.messages as Anthropic.MessageParam[],
          },
          { signal: req.signal, timeout: req.timeoutMs },
        );
      } catch (err) {
        if (Anthropic.APIError && err instanceof Anthropic.APIError) {
          throw new AiProviderError("Anthropic API call failed", err);
        }
        // The SDK throws on schema-invalid structured output rather than
        // returning a null parse; fold that into the corrective path.
        return null;
      }

      const raw = (response as { parsed_output?: unknown }).parsed_output ?? null;
      const check = raw === null ? null : req.schema.zod.safeParse(raw);

      const inputTokens = response.usage?.input_tokens ?? 0;
      const outputTokens = response.usage?.output_tokens ?? 0;
      const servedModel = response.model ?? req.model;

      return {
        parsed: check && check.success ? check.data : null,
        assistantTurn: { role: "assistant", content: response.content ?? [] },
        usage: {
          inputTokens,
          outputTokens,
          costUsd: aiRunCostUsd(servedModel, inputTokens, outputTokens),
        },
        servedModel,
        refused: (response as { stop_reason?: string }).stop_reason === "refusal",
      };
    },
  };
}
