# OpenRouter provider — model abstraction, policy-enforced routing, and a candidate shootout

Status: approved design, not yet planned.
Branch: `feat/openrouter-provider` (worktree `.claude/worktrees/openrouter-provider`).

## Problem

The AI Schedule Architect runs on exactly one model reachable exactly one way. `apps/web/package.json:20` pins `@anthropic-ai/sdk`, and both runners call it directly:

- `schedule-ai.ts:929` `callModel()` — Phase A, with legacy-model branching (`aiReasoningParams`) for the haiku cheap path
- `officials-ai.ts:762` — Phase B, hardcoding `thinking: {type: "adaptive"}`

Two consequences.

**We cannot evaluate alternatives.** The 2026-07-20 benchmark (28 live runs, `design/v4/04-architect-benchmarks.md`) compared only Claude models, because those are the only models reachable. "Would model X be cheaper or better?" is currently unanswerable without a rewrite.

**The cost ledger guesses.** `ai-pricing.ts` hardcodes per-1M rates and returns `null` for unknown models. Its own header records the burn: a published introductory rate was applied without checking the account, and the ledger understated by 33%. The provider knows what it billed; we re-derive it.

A third motivation is latent. `ai-pricing.ts` models no cache tokens, and the v4 notes warn that adding prompt caching later *must* extend `aiRunCostUsd` and usage capture with cache-creation/cache-read fields or `/admin/ai-runs` undercounts. Any path that reports billed cost directly retires that hazard.

### What OpenRouter is and is not

Verified against the API docs on 2026-07-21:

- **Wire format is OpenAI Chat Completions** (`POST /api/v1/chat/completions`). There is **no** Anthropic `/v1/messages` passthrough. Pointing the existing SDK's `baseURL` at OpenRouter does not work; an adapter is required.
- Model is chosen **per request** via `model`, format `{org}/{slug}`.
- `anthropic/claude-sonnet-5` and `x-ai/grok-4.5` both exist. Grok 4.5 reports `reasoning` and `structured_outputs` support, 500k context.
- Unified `reasoning` parameter: `{effort: "max"|"xhigh"|"high"|"medium"|"low"|"minimal"|"none", max_tokens, exclude, enabled}`.
- Provider routing: `provider: {order, only, ignore, allow_fallbacks, data_collection: "allow"|"deny"}` plus top-level `zdr: true`. Settable per request.
- Prompt caching supported. Anthropic models need **explicit `cache_control` breakpoints** — the shape we already send. Grok, OpenAI, DeepSeek, Moonshot, Groq and Z.AI cache automatically. Usage returns `cached_tokens`, `cache_write_tokens`, `cache_discount`. OpenRouter sticky-routes follow-ups to the same upstream endpoint to maximise hits.
- Response `usage` includes `cost`.

**Presets are rejected.** OpenRouter supports portal-side presets referenced as `@preset/slug`, which would move model choice out of code. We do not use them: `schedule.ts:567` deliberately stamps the runtime model onto the ledger, and `schedule-ai-effort-ab.live.test.ts:223` sets `SCHEDULING_AI_MODEL` per bench arm. A preset makes both record `@preset/foo` and destroys per-model attribution.

## Design

### 0. Prompt cherry-pick — prerequisite, separate commit

Three improvements to `schedule-ai-prompt.ts`, landed and merged **before** any bench arm runs so the prompt is a constant across all arms. The golden snapshot test (`__tests__/schedule-ai-prompt.test.ts`) fails on any edit by design; updating it is part of this change.

1. **Stable rule IDs.** Hard rules `1.`–`7.` become `H1`–`H7`; soft goals `a.`–`e.` become `S1`–`S5`. Makes unschedulable reasons, repair messages and bench failures machine-classifiable — which the shootout scoring in §9 depends on.
2. **Unschedulable reasons must cite the rule.** `:63` currently asks for "a short honest reason". It becomes "a short honest reason citing the rule id that blocked it". Makes reasons auditable and gradeable across candidates.
3. **An `assumptions` array** on `AiSchedulePlan` — `z.array(z.string().max(200)).max(10)`, optional. The organiser instruction is free text; today an ambiguous reading is folded into `summary` or lost. A dedicated slot records the interpretation.

Explicitly **not** adopted from the reviewed prompt pack: a model-authored `verification` self-report block (the engine referee at `packages/engine/src/scheduling/calendar.ts:97` is deterministic and authoritative; model-reported zeros are unverifiable and output tokens are ~90% of run cost), and a `needs_clarification` status (the flow is propose-only with a human in the loop, and non-empty `unschedulable` already signals partial).

### 1. The provider interface

New module `apps/web/src/server/ai/provider.ts`:

```ts
export type AiReasoning =
  | { kind: "effort"; effort: AiEffort }   // adaptive/effort models
  | { kind: "budget"; tokens: number }     // legacy (claude-haiku-4-5)
  | { kind: "none" };

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
  parsed: T | null;          // null → caller runs its corrective retry
  assistantTurn: AiTurn;     // replayed verbatim on repair rounds
  usage: { inputTokens: number; outputTokens: number; costUsd: number | null };
  servedModel: string;
};

export interface AiProvider {
  readonly id: "anthropic" | "openrouter";
  chat<T>(req: AiChatRequest<T>): Promise<AiChatResponse<T> | null>;
}
```

**Invariant — `AiTurn.content` is opaque and provider-owned.** The Anthropic adapter stores `ContentBlockParam[]` (thinking blocks); the OpenRouter adapter stores the assistant message including `reasoning_details`. Callers never inspect it. OpenRouter's docs are explicit that the reasoning block sequence "must match the outputs generated by the model during the original request; you cannot rearrange or modify the sequence" — the same verbatim-replay contract `assistantTurn()` (`schedule-ai.ts:925`) and `officialsAssistantTurn()` (`officials-ai.ts:757`) already honour.

**Consequence, to be documented at the type:** a conversation cannot change provider mid-flight. A repair round must use the provider that produced the earlier turns. Provider is resolved once per run and threaded through.

Error taxonomy: `instanceof Anthropic.APIError` (`schedule-ai.ts:966`, `officials-ai.ts:791`) becomes `instanceof AiProviderError`, thrown by each adapter for genuine transport/API failures. A `null` return keeps its current meaning — unparseable output, run the corrective path.

`AbortController` and `ROUND_TIMEOUT_MS` stay in the callers. Each adapter owns its own transport quirks.

### 2. Adapters

**`ai/anthropic-provider.ts`** — wraps today's code with no behavioural change. Keeps the `timeout: 600_000` at `schedule-ai.ts:956`, which is load-bearing: without it the SDK throws synchronously ("Streaming is required…") for `max_tokens` implying >10 min, and the corrective path would mask it as `AI_PLAN_FAILED`. Keeps `cache_control: {type: "ephemeral"}` on the system block. Keeps `client.messages.parse()` + `zodOutputFormat`. Cost via `aiRunCostUsd()`.

**`ai/openrouter-provider.ts`** — `fetch` against `/api/v1/chat/completions`. Maps:

| Concern | Anthropic | OpenRouter |
|---|---|---|
| system | `system: [{type:"text", …, cache_control}]` | `messages[0]` role `system`, `cache_control` on the content block |
| reasoning (effort) | `thinking:{type:"adaptive"}` + `output_config.effort` | `reasoning: {effort}` |
| reasoning (budget) | `thinking:{type:"enabled", budget_tokens}` | `reasoning: {max_tokens}` |
| structured output | `output_config.format: zodOutputFormat(S)` | `response_format: {type:"json_schema", json_schema:{name, strict:true, schema: z.toJSONSchema(S)}}` |
| assistant replay | `ContentBlockParam[]` | assistant message + `reasoning_details` |
| usage | `usage.input_tokens/output_tokens` | `usage.prompt_tokens/completion_tokens` |
| cost | `aiRunCostUsd()` | `usage.cost` |

`zod` is already at `^4.4.3` (`apps/web/package.json:57`) and Zod 4 ships native `z.toJSONSchema()`. No new dependency.

The adapter validates the returned JSON against the same Zod schema before returning `parsed`, so a strict-mode failure or a non-conforming payload degrades to `parsed: null` and the existing corrective retry, rather than throwing.

### 3. Configuration

| Var | Meaning |
|---|---|
| `AI_PROVIDER` | `anthropic` (default) \| `openrouter` |
| `OPENROUTER_API_KEY` | required when provider is `openrouter` |
| `OPENROUTER_BASE_URL` | optional; points the OpenRouter adapter at the fixture server |
| `SCHEDULING_AI_MODEL`, `SCHEDULING_AI_CHEAP_MODEL`, `SCHEDULING_AI_EFFORT`, `OFFICIALS_AI_EFFORT` | unchanged semantics; values become `{org}/{slug}` when provider is `openrouter` |

The shipped code default stays `anthropic`, so an unset `AI_PROVIDER` behaves exactly as today. Flipping an environment to OpenRouter is one variable — no code change, no redeploy.

The 503 guard generalises from "no `ANTHROPIC_API_KEY`" (`schedule-ai.ts:738`) to "the selected provider is unconfigured". `SCHEDULING_AI_BASE_URL` (`:742`) continues to override the Anthropic adapter's base URL; the OpenRouter adapter gets its own `OPENROUTER_BASE_URL` for the fixture server.

### 4. Data policy — hardcoded, not configurable

`ai-scheduling.md:30` tells customers the brief "is **not used to train AI models**", and `ai-officials.md:26` repeats the guarantee. Routing through third parties has to keep that true in code, not in prose.

Own module `ai/openrouter-policy.ts`, applied to **every** OpenRouter request, with no env override:

```ts
provider: { data_collection: "deny", only: ALLOWED_PROVIDERS, allow_fallbacks: false }
zdr: true
```

`allow_fallbacks: false` is not optional — without it routing can escape the allowlist. `ALLOWED_PROVIDERS` is a documented const whose comment cites the customer promise and the date it was last reviewed.

### 5. Cost and ledger

Precedence: `usage.cost` from the response when the provider reports it; otherwise `aiRunCostUsd(model, …)`; otherwise `null`. Never guess.

Stamp `servedModel` from the response rather than the requested constant — strictly more truthful than today, and it captures which upstream endpoint actually ran.

Because billed cost is read rather than derived, the cache-accounting hazard is retired on the OpenRouter path: cache reads and writes are already priced into `usage.cost`.

### 6. Prompt caching

Preserved on both paths at no cost. The Claude-via-OpenRouter path takes the same explicit `cache_control` breakpoint the code already sends at `schedule-ai.ts:948`; candidates that cache automatically need nothing. `cached_tokens` / `cache_write_tokens` / `cache_discount` are captured into the run record alongside the token counts.

### 7. Fixture server

`ai-fixture-server.ts` currently emulates the Anthropic Messages API and is selected via `SCHEDULING_AI_BASE_URL`. It gains an OpenRouter-shaped mode chosen by `AI_PROVIDER`, so e2e and smoke cover both paths. `FIXTURE_REFUSE` behaviour is mirrored.

Mocked suites cannot catch wire-level traps — the v4 notes record that the SDK constructor-timeout bug was invisible to every mocked test. The live bench in §9 is the real wire test.

### 8. Candidate eligibility — derived, plus named entrants

A pre-flight script queries OpenRouter's models API and filters to models that:

1. support `reasoning` — the benchmark showed no-thinking left blocking conflicts on 2/3 dense runs *and* cost more, because repairs resend prior output as input;
2. support `structured_outputs` — the runners read `parsed`;
3. have at least one endpoint surviving `data_collection: "deny"` + `zdr: true` + the allowlist;
4. have a context window of at least 128k — observed output alone averages 29,858 tokens on the dense pack, before the context pack and repair-round resends.

The eligible set is committed to `design/v4/05-openrouter-candidates.md` with the date it was generated and the filter output verbatim, so the shootout is reproducible.

**Named stage-1 entrants** in addition to the derived set: `z-ai/glm-5.2` and `moonshotai/kimi-k2.6`. They enter through the same filter as everything else — if either fails criterion 3, that is a result, and it is recorded rather than worked around. Their sub-processor implications for UK/EU customers are raised in §11 before any allowlist entry is made.

### 9. Two-stage shootout

Extends `schedule-ai-effort-ab.live.test.ts` with a provider dimension. Gated behind `AI_AB_LIVE=1` exactly as today.

**Control arms** (both stages):

| Arm | Purpose |
|---|---|
| `claude-sonnet-5`, Anthropic direct, effort `high` | reproduces the recorded baseline — teams-15: 276.8s, 29,858 out, 0 blocking, 0 warnings, $0.465 |
| `anthropic/claude-sonnet-5` via OpenRouter, effort `high` | **adapter fidelity** — same model, different transport. Divergence here is our bug, not the model's |

**Stage 1 — screen.** n=1, `teams-15` (dense) only, every candidate. The dense pack is the discriminator: haiku-4-5 matched sonnet exactly on `individuals-50` and produced 20/43/100 warnings on `teams-15`. Roughly $0.50 per candidate. A candidate is eliminated if any of: blocking conflicts > 0 after the repair loop, output that never parses against the schema, no policy-surviving route, or a round that exceeds `ROUND_TIMEOUT_MS`. Warnings do not eliminate at stage 1 — they are scored at stage 2.

**Stage 2 — full.** n=3, both packs, survivors plus both control arms. Comparable line-for-line with the existing results table.

Scoring, in order: blocking conflicts (must be 0), warnings, repair rounds, wall-clock, cost. The rule IDs from §0 make failures classifiable by rule rather than by count alone.

### 10. Call-site changes

`schedule-ai.ts:929` and `officials-ai.ts:762` collapse to `provider.chat(...)`. Both files keep their own reasoning-shape decisions — Phase A's `aiReasoningParams` legacy branch, Phase B's fixed adaptive — but express them as `AiReasoning` rather than Anthropic request fields. `aiReasoningParams` moves to the provider layer and gains an OpenRouter mapping.

Phase B has no cheap-model escalation today and does not gain one here.

### 11. Help, legal, smoke

`ai-scheduling.md:30` and `ai-officials.md:26` rewritten to name OpenRouter and the allowlisted upstream providers, keeping the no-training promise — now enforced in code (§4) rather than only asserted. Help-page pass is mandatory before merge.

`scripts/smoke.ts` extended to exercise the configured provider on both pro and free paths.

**Privacy policy and sub-processor list:** adding OpenRouter and any upstream provider is a sub-processor change with GDPR implications, and `lib/legal.ts` carries a consent stamp. This spec **flags** the change and identifies the touchpoints; it does not draft consent text. That is a decision for the user, made explicitly, before the allowlist is finalised.

## Testing

Every change ships a test that fails without it.

**Unit — provider layer (new, pure):**
- OpenRouter payloads always carry `data_collection:"deny"`, `zdr:true`, `only: ALLOWED_PROVIDERS`, `allow_fallbacks:false`. This is the regression guard for the customer promise.
- `AiReasoning` maps correctly per kind: effort → `reasoning.effort`, budget → `reasoning.max_tokens`, none → omitted.
- `z.toJSONSchema(AiSchedulePlan)` produces a strict-mode-valid schema; the round trip parses.
- Usage mapping: `prompt_tokens`/`completion_tokens` → `inputTokens`/`outputTokens`; cache fields captured.
- Cost precedence: response `cost` wins; falls back to `aiRunCostUsd`; `null` when neither.
- `AiProviderError` propagates; non-conforming payload returns `parsed: null`.

**Unit — Anthropic adapter parity:** the existing `schedule-ai-run.test.ts` expectations hold unchanged through the abstraction, including the constructor-timeout capture (`ctorOpts`) that guards the "Streaming is required…" trap.

**Route/config:** `schedule-ai-run.test.ts:371` extends from "missing `ANTHROPIC_API_KEY` → 503" to cover both providers unconfigured. Default-provider test asserts unset `AI_PROVIDER` selects Anthropic.

**Prompt (§0):** golden snapshot updated deliberately; a test asserts every `unschedulable` reason in the fixtures cites a rule id.

**e2e/smoke:** fixture server exercised in both modes.

**Live:** `AI_AB_LIVE=1` shootout, §9. Not part of CI.

Full local gate before push: `tsc`, unit, DB-backed suites on a fresh migrated database, AI e2e, smoke. The v4 notes record that running only targeted AI files let stale assertions through.

## Risks

**Grok may be policy-unroutable.** `x-ai/grok-4.5` is served by four endpoints, all xAI: `xai`, `xai/priority`, `xai/zdr`, `xai/zdr/priority`. Dedicated ZDR variants existing is strong evidence `zdr:true` + `data_collection:"deny"` will route, but the endpoints payload did not expose policy fields. **Resolved by step 1 of the plan:** one live request carrying the policy block, before any adapter code is written. The same probe covers GLM and Kimi.

**Reasoning-replay fidelity is the sharpest edge.** Repair rounds resend prior assistant turns; OpenRouter requires the reasoning sequence to match unmodified. A subtle mismatch shows up as degraded repair quality, not an exception. The fidelity control arm exists to catch exactly this.

**Provider cannot change mid-conversation.** Enforced by resolving provider once per run.

## Out of scope

- Making OpenRouter the shipped code default (it stays an env flip).
- Phase B cheap-model escalation.
- The haiku `SCHEDULING_AI_CHEAP_MODEL` isolation experiment.
- Rewriting the scheduling prompt beyond the three cherry-picks in §0.
- Drafting privacy-policy or consent copy (§11 flags; the user decides).
