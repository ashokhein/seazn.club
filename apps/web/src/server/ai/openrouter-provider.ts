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

      let body;
      try {
        body = await res.json();
      } catch (err) {
        // An abort firing mid-stream can surface as a SyntaxError from
        // res.json() — that's the caller's round deadline, not a transport
        // failure, so let it pass through unwrapped like the fetch() catch
        // above does.
        if (req.signal.aborted) throw err;
        throw new AiProviderError("OpenRouter returned an unparsable response body", err);
      }
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

      // Refusal signal: `finish_reason === "content_filter"` OR a structured
      // `message.refusal` string.
      //
      // Checked OpenRouter's docs ("Finish Reason" section of the chat
      // completion reference): finish_reason is NORMALIZED across every
      // upstream provider to one of `tool_calls`, `stop`, `length`,
      // `content_filter`, `error` — the raw per-provider value lives
      // separately in `native_finish_reason`, which is NOT guaranteed present
      // or uniform across providers, so it is deliberately NOT checked here.
      // `message.refusal` is the OpenAI-contract field that is only ever
      // populated when the model declined (content is null when it's set),
      // so OR-ing it in costs no false positives.
      //
      // Confirmed live against anthropic/claude-sonnet-5 (2026-07-21, a
      // prompt engineered to trigger Anthropic's safety refusal): the
      // response came back with `finish_reason: "content_filter"`,
      // `native_finish_reason: "refusal"`, `message.content: null`, and
      // `message.refusal` set. xai, z-ai, and moonshotai are UNVERIFIED —
      // it is not known whether they populate either field on a decline.
      // This also does not, and cannot, catch a "soft" refusal: a model can
      // decline in ordinary prose with `finish_reason: "stop"` and no
      // `refusal` field; content inspection to catch that is out of scope
      // for a transport adapter. So this narrows the gap, it does not close
      // it. This must stay a fast, no-retry path: a refusal is not a
      // schema-invalid parse (`parsed: null` alone), it's the model
      // declining outright, so spending a corrective retry on it would burn
      // a second paid call on a request already declined.
      const refused =
        choice?.finish_reason === "content_filter" || typeof message?.refusal === "string";

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
