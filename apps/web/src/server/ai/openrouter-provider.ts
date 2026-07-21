// OpenRouter adapter. Opt-in via AI_PROVIDER=openrouter; Anthropic remains the
// shipped default.
import { buildOpenRouterBody } from "./openrouter-request";
import {
  AiProviderError,
  type AiChatRequest,
  type AiChatResponse,
  type AiProvider,
} from "./provider";

const DEFAULT_BASE = "https://openrouter.ai/api/v1";

export function openRouterProvider(): AiProvider {
  return {
    id: "openrouter",
    isConfigured: () => Boolean(process.env.OPENROUTER_API_KEY),
    async chat<T>(req: AiChatRequest<T>): Promise<AiChatResponse<T> | null> {
      const apiKey = process.env.OPENROUTER_API_KEY;
      if (!apiKey) throw new AiProviderError("OPENROUTER_API_KEY is not configured");
      const base = process.env.OPENROUTER_BASE_URL ?? DEFAULT_BASE;

      let res: Response;
      try {
        res = await fetch(`${base}/chat/completions`, {
          method: "POST",
          headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
          body: JSON.stringify(buildOpenRouterBody(req)),
          signal: req.signal,
        });
      } catch (err) {
        // An abort is the caller's round deadline, not a provider failure —
        // let it surface so the caller maps it to AI_PLAN_TIMEOUT.
        if (req.signal.aborted) throw err;
        throw new AiProviderError("OpenRouter request failed", err);
      }

      if (!res.ok) {
        throw new AiProviderError(
          `OpenRouter returned HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`,
        );
      }

      const body = await res.json();
      const choice = body?.choices?.[0];
      const message = choice?.message;
      const usage = body?.usage ?? {};

      // The whole message goes back on repair rounds: OpenRouter requires the
      // reasoning block sequence to match what the model produced, unmodified.
      const assistantTurn = { role: "assistant" as const, content: message ?? {} };

      let parsed: T | null = null;
      if (typeof message?.content === "string") {
        try {
          const check = req.schema.zod.safeParse(JSON.parse(message.content));
          if (check.success) parsed = check.data;
        } catch {
          // Malformed JSON is the corrective path's problem, not an exception.
          parsed = null;
        }
      }

      // Refusal signal: `choices[0].finish_reason === "content_filter"`.
      //
      // Checked OpenRouter's docs ("Finish Reason" section of the chat
      // completion reference): finish_reason is NORMALIZED across every
      // upstream provider to one of `tool_calls`, `stop`, `length`,
      // `content_filter`, `error` — the raw per-provider value lives
      // separately in `native_finish_reason`, which is NOT guaranteed present
      // or uniform across providers. Confirmed live against
      // anthropic/claude-sonnet-5 (2026-07-21, a prompt engineered to trigger
      // Anthropic's safety refusal): the response came back with
      // `finish_reason: "content_filter"`, `native_finish_reason: "refusal"`,
      // `message.content: null`, and an OpenAI-style `message.refusal`
      // string. finish_reason is the one field the docs guarantee is present
      // and normalized for every provider OpenRouter fronts, so it — not
      // native_finish_reason or message.refusal, which are corroborating but
      // not documented as universal — is the signal this checks. This must
      // stay a fast, no-retry path: a refusal is not a schema-invalid parse
      // (`parsed: null` alone), it's the model declining outright, so
      // spending a corrective retry on it would burn a second paid call on a
      // request already declined.
      const refused = choice?.finish_reason === "content_filter";

      return {
        parsed,
        refused,
        assistantTurn,
        usage: {
          inputTokens: usage.prompt_tokens ?? 0,
          outputTokens: usage.completion_tokens ?? 0,
          costUsd: typeof usage.cost === "number" ? usage.cost : null,
          cachedTokens: usage.cached_tokens,
          cacheWriteTokens: usage.cache_write_tokens,
        },
        servedModel: body?.model ?? req.model,
      };
    },
  };
}
