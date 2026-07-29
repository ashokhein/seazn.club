# AI Credit Token-Weight Pricing — Design

**Date:** 2026-07-28
**Status:** Approved by owner (brainstorm session), pending implementation plan
**Scope:** Schedule AI (Phase A) + Officials AI (Phase B)

## 1. Problem

Every AI run charges a flat **1 credit** regardless of size. A 12-fixture youth division and a 480-fixture multi-court tournament cost the org the same credit, while our COGS differ by an order of magnitude (~90% of run cost is thinking tokens — see AI effort bench, #178). We want the charge to scale with the token budget a run actually needs, predicted from data the run is about to consume: fixtures, entrants, courts.

## 2. Decisions (owner-approved)

| Question | Decision |
|---|---|
| What drives price | Predictor estimates tokens → maps to a credit **rung** (1/2/3). Prediction shown as helper text before the run. |
| Settlement semantics | **Hard budget.** Credits buy a token budget, not usage: 1cr→32K, 2cr→64K, 3cr→128K total-run generation tokens. Price fixed at confirm time; no refunds, no true-up. |
| User control | Predicted rung is the **pre-selected default**; user may adjust up or down before confirming. Below-predicted picks get a warning and are stamped `underfunded`. |
| Surfaces | Both Phase A (schedule) and Phase B (officials AI). Officials mostly uses the deterministic solver; AI officials is an optional extra and gets the same treatment for consistency. |
| Approach | **Heuristic predictor + harness token meter** (Approach 1). No regression fitting, no Anthropic `task_budget` beta. |

### Why not `budget_tokens` / `task_budget`

`thinking.budget_tokens` is removed on current models (400 on sonnet-5). Anthropic's `task_budget` beta only works on Anthropic — but our code-default provider is the OpenRouter cost ladder (gemini→sonnet→grok, key-gated, see #219). Enforcement therefore lives in **our** ladder loop as a cumulative token meter: provider-agnostic, no beta headers, one code path.

## 3. Current state (file:line anchors)

- Model/config: `apps/web/src/server/usecases/schedule-ai.ts:646` (`schedulingAiModel()`, sonnet-5 default), `:677` (effort `high`), `:707` (thinking `adaptive`), `:637` (`MAX_TOKENS` 32_000/round), `:629` (600s round timeout)
- Orchestrator + ladder: `schedule-ai.ts:1439` (`runAiPlanLadder()`), `:1466` (`aiPlanForDivision()`); officials: `officials-ai.ts:1025` (`officialsAiPlanForDivision()`)
- Credit spend: `schedule-ai.ts:1526` — `spendCredit(walletId, orgId, 1, ...)`; reserve→run→settle/release in `apps/web/src/lib/credits.ts:1098/1172/1252`
- COGS stamps: `schedule.ai_generated` payload carries `cost_usd`, `input_tokens`, `output_tokens`, `repair_rounds`, `pack_units` (`schedule-ai.ts:1632/1641/1592`; officials `officials-ai.ts:1128/1133`) in `competition_events`
- Guards: wallet is the only spend gate (v17 SPEC-2), 5 runs/division/hour brake (`schedule-ai.ts:1516`), 500-fixture hard cap (`schedule-ai.ts:288`), per-plan quota retired (V322)

## 4. Predictor

New pure module `apps/web/src/lib/ai-rung.ts` (no I/O, unit-testable):

```ts
sizeScore = movableFixtures + ENTRANT_W * entrants + COURT_W * courts
rung      = sizeScore <= S1 ? 1 : sizeScore <= S2 ? 2 : 3
estTokens = piecewise-linear(sizeScore)   // for helper text only
```

- `ENTRANT_W`, `COURT_W`, `S1`, `S2`, and the est-tokens curve are code constants with env override (`AI_RUNG_*`).
- **Calibration** happens once during implementation: one SQL pass over `competition_events` (`schedule.ai_generated` / `schedule.ai_officials_generated` payloads) bucketing actual `output_tokens` (p50/p90) by `pack_units`. Thresholds chosen so p90 of a rung's bucket fits inside that rung's budget. Recalibration = rerun the query, edit constants. The query ships as `scripts/ai-rung-calibration.sql`. **Constants shipped UNCALIBRATED** — the query has not yet been run against prod; §3 of it reads the `stopped_on_budget` stamp as ground truth once there is history, and every budget/threshold is env-overridable in the meantime.
- Phase B uses the same function with its own constant set (`AI_RUNG_OFFICIALS_*`) — officials packs are lighter and will land rung 1 almost always.
- The server **always recomputes** the prediction at run time; the client's displayed prediction is advisory.

## 5. Budget meter (enforcement)

The budget keys on **credits charged**, not on the rung — issue #350 charges
`max(1, Σ rungs − 1)`, which reaches 5, 8, 11 credits, and a `Record<Rung, …>`
table cannot key those. The approved 1/2/3 values are unchanged; the curve
extends past 3 at a flat step:

```ts
tokenBudgetForCredits(n)  // generation tokens (output incl. thinking), whole run
  n <= 3 ? {1: 32_000, 2: 64_000, 3: 128_000}[n]
         : 128_000 + 32_000 * (n - 3)
```

Every value is env-overridable (`AI_RUNG_BUDGET_1/2/3`, `AI_RUNG_BUDGET_STEP`)
so an uncalibrated cliff can be loosened in prod without a deploy.

In the existing ladder loop (both phases), via one `TokenMeter` per run shared
by every rung — so the budget spans the whole ladder and cross-rung accounting
lives in one object rather than a number each layer must remember to forward:

1. `meter.add(usage.output_tokens)` as soon as a round's usage is known, **before** the refusal/parse-failure throws — a round that spent tokens and then failed still counts, so a run cannot loop past its cap on failures alone.
2. Before starting the next round: `meter.canStartRound()` → `spent + reserve <= budget`. False stops escalation, finalizes with the best valid result so far, else fails — and flips `stoppedOnBudget`.
3. Per-round cap: `meter.clampRound(32_000)` = `min(32_000, budget − spent)`.

`MIN_ROUND_RESERVE` is **size-aware**: `max(2_000, movableFixtures × 40)`
(`AI_RUNG_MIN_ROUND_RESERVE` / `AI_RUNG_RESERVE_PER_UNIT`). A flat 2 000 is
wrong for a 200-fixture pack — the assignment list alone is several thousand
output tokens, so a round clamped below that truncates, fails to parse, and
burns the remaining budget for nothing.

Provider-agnostic: identical on OpenRouter fallback models and direct Anthropic. Input tokens are **not** metered (budget = generation budget; on adaptive-thinking models thinking bills as output, which is exactly the cost we're scaling for).

## 6. API

- Run endpoints (both phases) gain optional `rung: 1|2|3`; default = server prediction; validated server-side.
- User-chosen `rung < predictedRung` is allowed; event payload stamps `underfunded: true` (drives the UI warning and later "cheaped-out → failed" analytics).
- Prediction data for the confirm card comes from the existing page/server data (division counts already loaded) — **no new estimate endpoint**.

## 7. Billing / ledger

- `spendCredit(walletId, orgId, quote.credits, ...)` — the amount param exists today (hardcoded 1). Reserve→settle/release flow untouched. Grant-first spend order untouched. **No schema change, no migration.**
- Settle payload adds `meterStamp(quote, meter)`: `{ credits, budget, spent_tokens, est_tokens, underfunded, stopped_on_budget, rung, predicted_rung }` — and, for a joint run, `{ discount, divisions: [{id, rung, predicted_rung, underfunded}] }` instead of the flat `rung`/`predicted_rung`.
- **`stopped_on_budget`** is stamped by the meter itself and is the only signal that separates "the budget cut this run short" from "the plan was merely degraded". `underfunded` records the user's choice, not the outcome; without both, §10's "cheaped-out → failed" analysis cannot be run. It is stamped on the failure event too.
- **The zero-token path is not priced from the pack.** Phase B's empty-instruction run returns the deterministic solver draft with no model call, so it is quoted flat at 1 credit (`freeDraftQuote()`) — sizing it would charge a large division 2-3 credits for a run that spends nothing.
- Failure path unchanged: no valid schedule (including budget exhausted with nothing usable) → hold **released, no charge**. COGS eaten; worst case ≈ $2 (128K output × $15/M), acceptable.
- Margin sanity: rung 3 worst-case COGS ≈ $2–2.5 vs 3 credits ≈ $7 retail-equivalent; rung 1 ≈ $0.50 vs 1 credit.

## 8. UI (confirm card, both AI buttons)

- Prediction line: “~220 fixtures · 4 courts → est. ~45K tokens”.
- Segmented control **1 / 2 / 3 credits**, predicted rung pre-selected.
- Below-predicted selection → inline warning: “may stop before a full schedule”.
- Wallet balance shown; insufficient balance → existing top-up state, now with amount N.
- CTA: “Run AI schedule — N credits”.
- Copy rule (matches what the meter enforces, nothing more): **“credits buy a thinking budget (up to X tokens)”**.
- Predicted > rung-3 capacity → still allow rung 3, warn “very large — consider splitting the division” (500-fixture cap bounds the blast radius).
- All new strings in all 4 locales (en/es/fr/nl), 375px-clean, help pages updated in the closing pass, `scripts/smoke.ts` extended (pro path exercises a rung-2 prediction).

## 9. Unchanged

Wallet-only gating, monthly org caps (SPEC-5 §1), grant-first order, 5/hr division brake, 500-fixture cap, escalation ladder structure, failure-release semantics, feature gate `scheduling.ai`.

## 10. Testing

- **Unit:** rung threshold boundaries (S1/S2 edges), meter stop + per-round clamp math, `spendCredit` amount per rung, settle payload shape, `underfunded` stamp. Every change ships its failing-without-it test.
- **Smoke:** `scripts/smoke.ts` pro path covers prediction → rung-2 charge; free path covers insufficient-balance card.
- **e2e:** prod build + `E2E_PROD_TARGET` on :3100 — confirm-card flow (predicted default, adjust, warning states).
- **Not applicable:** `BILLING_LIVE` live-Stripe pass — no Stripe surface is touched; credit ledger tests are DB-level.

## 11. Out of scope

- Regression-fitted predictor / nightly calibration job (Approach 2 — future upgrade path).
- Anthropic `task_budget` pacing.
- Refund/true-up settlement.
- Changing pack prices or credit grants.
