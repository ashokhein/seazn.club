// The seam between the AI runners and whichever service actually answers.
//
// Phase A (schedule-ai.ts) and Phase B (officials-ai.ts) both want the same
// thing: send a system prompt plus a conversation, get a schema-valid plan
// back, and be able to replay the model's own turn on a repair round. Only the
// wire format differs, so that is all an adapter owns.
import type { ZodType } from "zod";

/** Effort positions shared with the usecase layer. */
export type AiEffort = "low" | "medium" | "high" | "xhigh" | "max";

/** How much the model should think, expressed provider-neutrally.
 *  `budget` exists for models that predate effort (claude-haiku-4-5 400s on
 *  adaptive thinking and on output_config.effort alike).
 *
 *  `effort.thinking` is deliberately separate from `effort.effort`: in the
 *  code this preserves (schedule-ai.ts aiReasoningParams), whether thinking
 *  is adaptive or disabled is an independent env-driven toggle, while effort
 *  is sent UNCONDITIONALLY regardless of that toggle. Collapsing "disabled
 *  thinking" into `{ kind: "none" }` would silently drop the effort setting
 *  the caller still wants sent — do not re-collapse this. */
export type AiReasoning =
  | { kind: "effort"; effort: AiEffort; thinking: "adaptive" | "disabled" }
  | { kind: "budget"; tokens: number }
  | { kind: "none" };

/** A conversation turn. `content` is OPAQUE and owned by the adapter that
 *  produced it — Anthropic stores content blocks including thinking, OpenRouter
 *  stores an assistant message including reasoning_details, and both providers
 *  require their own shape back unmodified on a repair round. Callers pass it
 *  around; they never read it. A conversation therefore cannot change provider
 *  mid-flight: resolve one provider per run and thread it through. */
export type AiTurn = { role: "user" | "assistant"; content: unknown };

export type AiChatRequest<T> = {
  model: string;
  system: string;
  messages: AiTurn[];
  maxTokens: number;
  reasoning: AiReasoning;
  schema: { name: string; zod: ZodType<T> };
  signal: AbortSignal;
  timeoutMs: number;
};

export type AiChatResponse<T> = {
  /** null when the model answered but the payload is not schema-valid — the
   *  caller runs its corrective retry rather than surfacing a 500. */
  parsed: T | null;
  assistantTurn: AiTurn;
  usage: {
    inputTokens: number;
    outputTokens: number;
    /** Billed cost when the provider reports it, else derived, else null.
     *  Never a guess. */
    costUsd: number | null;
    cachedTokens?: number;
    cacheWriteTokens?: number;
  };
  /** The model that actually served the request, which can differ from the one
   *  asked for. Stamped onto the ledger in place of the requested constant. */
  servedModel: string;
  /** The model declined outright. MUST stay distinct from `parsed: null`:
   *  a refusal fails fast and spends no corrective retry. */
  refused: boolean;
};

export interface AiProvider {
  readonly id: "anthropic" | "openrouter";
  /** Whether this provider has the credentials it needs. Separate from chat()
   *  so the runners can refuse with 503 BEFORE any call, which is the contract
   *  schedule-ai-run.test.ts asserts ("503 before any call"). A missing key
   *  discovered inside chat() would surface as a 500 instead. */
  isConfigured(): boolean;
  chat<T>(req: AiChatRequest<T>): Promise<AiChatResponse<T> | null>;
}

/** A genuine transport or API failure. Adapters throw this; the runners let it
 *  propagate to a 5xx rather than folding it into the corrective path. */
export class AiProviderError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "AiProviderError";
  }
}
