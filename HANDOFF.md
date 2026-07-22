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
- Fallback ladder (`schedule-ai.ts` `runLadder<T>`): gemini→sonnet→grok,
  opt-in `SCHEDULING_AI_LADDER`; unset = today's sonnet-direct. Tests:
  `schedule-ai-ladder.test.ts` (17).
- Phase B officials on the same ladder, own env `OFFICIALS_AI_LADDER`
  (default sonnet-direct). Tests: `officials-ai-ladder.test.ts` (4).
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
1. Decide merge path: rebase onto current main (main..HEAD carries dup
   #199/#200 squash artifacts — drop on rebase), then open a PR. Optionally
   run `/code-review ultra` first (user-triggered, billed).
2. Before the production flip: legal sign-off on the sub-processor copy, then
   set Fly env `SCHEDULING_AI_LADDER` + `OPENROUTER_API_KEY`.
3. USER: rotate leaked keys (ANTHROPIC, STRIPE, OpenRouter provisioning+inference).

## Key decisions
- 2026-07-22: gemini→sonnet→grok ladder; grok LAST (1 clean/3, slow/flaky).
- 2026-07-22: ladder is opt-in env; code default stays sonnet-direct (keeps
  local/CI/tests unchanged; "gemini default" = a deploy-env action).
- 2026-07-22: officials gets its OWN OFFICIALS_AI_LADDER (unbenched → must not
  inherit the schedule ladder).
- 2026-07-21: no sonnet-via-OpenRouter; allowlist narrowed to xai+google-vertex.

## Gotchas
- Run the live bench FROM apps/web (`--root apps/web`) or `server-only` import
  fails. `AI_AB_OPEN_Q=0` skips billed baseline cells; `AI_AB_ONLY_ARM` filters.
- grok emits >32k output on OpenRouter (max_tokens not a hard cap there).
- NEVER enable `.github/workflows/e2e.yml` (disabled deliberately).

## Verify
cd apps/web && npx tsc --noEmit && npx vitest run
# 2026-07-22: tsc clean; 268 files / 1790 pass, 693 skip (LIVE-gated); eslint clean.
