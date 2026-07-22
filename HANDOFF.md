# HANDOFF

## Status
Branch `feat/openrouter-provider` — OpenRouter provider abstraction + a
cost-aligned model fallback ladder. NOT merged. Verified GREEN 2026-07-22:
tsc clean, full unit suite 268 files / 1790 tests, eslint clean. See
memory `project_openrouter_ladder.md` for the full picture.

## Current task
None in flight. Awaiting the merge/PR + production-flip decision (user).

## Done
- Provider seam (`src/server/ai/`): AiProvider, anthropic/openrouter adapters,
  `resolveProvider(name)`; policy deny+zdr+allowlist[xai,google-vertex].
- Fallback ladder (`schedule-ai.ts` `runLadder<T>`): gemini→sonnet→grok is
  the CODE DEFAULT (`DEFAULT_LADDER`); unconfigured rungs skip, so it resolves
  to sonnet-direct until `OPENROUTER_API_KEY` is set. Tests:
  `schedule-ai-ladder.test.ts`.
- Phase B officials on the same DEFAULT_LADDER, own override env
  `OFFICIALS_AI_LADDER`. Tests: `officials-ai-ladder.test.ts`.
- Cost alignment: real OpenRouter cost summed across rungs; ledger/analytics
  stamp the winning rung's model + rungs_tried.
- Bench: `withGreedyDraft` fills all bench packs from the real solver (14/14
  bracket). Verdict in design/v4/06 §12–§15 (gemini clean; grok 1/3 slow).
- Sub-processors + help GDPR copy: /legal/sub-processors names Anthropic /
  OpenRouter / Google-Vertex / xAI; ai-scheduling + ai-officials help updated.
- Stale anthropicClient()/ANTHROPIC_API_KEY comment cleanup.

## In progress
Nothing.

## Next steps
1. Rebased onto origin/main + pushed; PR open (see gh). Optionally run
   `/code-review ultra` (user-triggered, billed).
2. Before the production flip: legal sign-off on the sub-processor copy, then
   set Fly `OPENROUTER_API_KEY` (that alone activates the default ladder).
   Consider `OFFICIALS_AI_LADDER=claude-sonnet-5` until officials is benched.
3. USER: rotate leaked keys (ANTHROPIC, STRIPE, OpenRouter provisioning+inference).
4. Local DB-backed tests need a DB migrated to main's V314–V316 (Event Pass /
   billing groups) — CI runs them fresh; local dev/test DB is behind.

## Key decisions
- 2026-07-22: gemini→sonnet→grok ladder; grok LAST (1 clean/3, slow/flaky).
- 2026-07-22: ladder is the CODE DEFAULT, gated by provider keys — a rung with
  no API key skips (AI_PROVIDER_NOT_CONFIGURED→recoverable), so no-OpenRouter
  deployments stay sonnet-direct; the flip = set OPENROUTER_API_KEY.
- 2026-07-22: officials shares DEFAULT_LADDER but reads its OWN
  OFFICIALS_AI_LADDER override (unbenched → pin to sonnet if flipping early).
- 2026-07-21: no sonnet-via-OpenRouter; allowlist narrowed to xai+google-vertex.

## Gotchas
- Run the live bench FROM apps/web (`--root apps/web`) or `server-only` import
  fails. `AI_AB_OPEN_Q=0` skips billed baseline cells; `AI_AB_ONLY_ARM` filters.
- grok emits >32k output on OpenRouter (max_tokens not a hard cap there).
- NEVER enable `.github/workflows/e2e.yml` (disabled deliberately).

## Verify
cd apps/web && npx tsc --noEmit && npx vitest run
# 2026-07-22: tsc clean; 268 files / 1790 pass, 693 skip (LIVE-gated); eslint clean.
