# Multi-Division AI Scheduling (Competition Board) — Design

**Date:** 2026-07-28
**Amended:** 2026-07-29 — §2/§6/§7 budget formula (see "Amendment" below)
**Status:** Approved by owner (brainstorm session), pending implementation plan
**Depends on:** Token-weighted AI credits design (`2026-07-28-ai-credit-token-weight-design.md`, issue #348) — this feature builds on its predictor, rung pricing, and budget meter.

## Amendment — 2026-07-29 (owner-approved)

The original §2 budget line, "32K × credits charged (discounted total)", was
found to conflict with #348 and to make a joint run strictly worse than running
the same divisions separately. Two corrections, both owner-approved, and both
already implemented in `apps/web/src/lib/ai-rung.ts` (PR #359):

**1. The budget curve is not linear.** #348 approved 1cr→32K, 2cr→64K,
3cr→**128K**. `32K × credits` gives 96K at 3 credits — a cut to the largest
single-division runs that nobody agreed to. The curve now keeps the approved
values and extends past 3 at a flat step:

```
tokenBudgetForCredits(n) = n <= 3 ? {1: 32K, 2: 64K, 3: 128K}[n]
                                  : 128K + 32K * (n - 3)
```

**2. The budget is sized from the UNDISCOUNTED rung total, not from the credits
charged.** Under the original wording, two joint rung-1 divisions pay
`max(1, 2−1) = 1` credit and would have received 32K — half the budget the same
two divisions get when run separately. The batch discount is a margin gift, not
a capability cut, so pricing and budget are now decoupled:

```
rungTotal = Σ chosen rungs                  // sizes the budget
credits   = max(1, rungTotal − 1)           // what the org pays  (≥2 divisions)
budget    = tokenBudgetForCredits(rungTotal)
```

Worked: Div A rung 1 + Div B rung 2 + Div C rung 3 → rungTotal 6 → **charge 5
credits**, **budget 224K** (`128K + 32K×3`).

The "credits buy a budget" invariant still holds from the buyer's side — what
they buy is sized by the work they asked for; the discount reduces the price of
that work, not the work itself.

**Also landed ahead of this issue** (PR #359, so §7/§10 need no further design):
- `quoteRun(lines, weights)` already takes one line per division and applies the
  `max(1, Σ−1)` discount — the joint path calls the same function the division
  path calls, with more lines.
- `meterStamp()` already emits the joint payload shape §10 asks for
  (`{credits, discount, budget, spent_tokens, divisions: [{id, rung,
  predicted_rung, underfunded}]}`), plus `stopped_on_budget` — a stamp §10 did
  not have, which distinguishes "the budget cut this run short" from "the plan
  was merely degraded".
- Every budget value is env-overridable (`AI_RUNG_BUDGET_1/2/3`,
  `AI_RUNG_BUDGET_STEP`), so a mispriced joint run can be loosened in prod
  without a deploy.

## 1. Problem

The competition-level schedule board (`/o/[orgSlug]/c/[compSlug]/schedule`, Pro-only via `scheduling.multi_division`) is read-only, with the AI console explicitly disabled in multi mode (`schedule-board.tsx:125,149`). AI scheduling runs only per division; divisions sharing courts are handled defensively (siblings appear as immovable obstacles) but never optimized jointly. Owners of multi-division competitions want one AI action that schedules divisions together — avoiding cross-division clashes and balancing shared court use.

## 2. Decisions (owner-approved)

| Question | Decision |
|---|---|
| Shape | **B — one joint solve.** All selected divisions' movable fixtures in a single AI run (rejected: sequential orchestration, hierarchical meta-pass). |
| Size ceiling | **Block over cap.** >500 movable fixtures total → refuse with "too large — schedule per division". No silent fallback, no cap raise. |
| Pricing | **Sum of division rungs − 1, min 1** (batch discount). Each division predicted individually by the #348 predictor; breakdown shown to user. |
| Budget | ~~Follows charged credits: 32K × credits charged (discounted total).~~ **SUPERSEDED 2026-07-29** — sized from the UNDISCOUNTED rung total on the #348 curve: `tokenBudgetForCredits(Σ rungs)`. See Amendment above. |
| Officials | Joint officials (Phase B) **out of scope** — stays per-division. |

## 3. Current state (file:line anchors)

- Competition board: `apps/web/src/app/o/[orgSlug]/c/[compSlug]/schedule/page.tsx` (read-only, all divisions, `scheduling.multi_division` gate at `:36`); board component `apps/web/src/components/v2/schedule-board.tsx:100` (AI console disabled when `multi=true`, `:125,149`)
- Cross-division awareness: `siblingAssignments` (`apps/web/src/server/usecases/schedule.ts:271-297`) → AI pack obstacles labeled "Other division" (`schedule-ai.ts:309,426-446`); `validateAssignments` (`packages/engine/src/scheduling/calendar.ts:419-500`) blocks court double-booking when labels match
- Courts are **division-scoped text labels** (`schedule_settings.config` JSONB per division, `fixtures.court_label`, no court FK) — cross-division court identity = string name match
- All scheduling APIs are per-division (`/api/v1/divisions/[id]/schedule/*`); no competition-level AI/apply endpoint exists
- 500 movable-fixture cap per run: `schedule-ai.ts:288`

## 4. Joint pack

New `buildCompetitionPack(competitionId, divisionIds[])` alongside `buildSchedulePack`:

- Union of the selected divisions' packs; every fixture and slot tagged with `division_id`.
- Division selection comes from the board (default: all divisions with movable fixtures).
- Canonical court list = union of the divisions' court labels. **Divergent labels across divisions ("Court 1" vs "Court A") get a board warning** — name matching is the only shared-court identity today; a venue-level court entity is separate future work.
- Obstacles = immovable fixtures from all selected divisions + all placements of excluded divisions.
- Cap check: total movable fixtures > 500 → 409 with "too large — schedule per division". Checked before any credit reserve.

## 5. Prompt

Extends the existing Phase-A prompt (`schedule-ai-prompt.ts`):

- Fixtures carry division tags; per-division slot config expressed separately (divisions may run different slot durations on the same courts — `toSlotConfig` is per-division).
- New joint rules: shared-court exclusivity across divisions; fairness clause (no division starved of prime slots).
- Output format unchanged (assignment list) → existing parse/repair machinery reused.

## 6. Engine

- Same escalation ladder and #348 cumulative token meter — one `TokenMeter` (`lib/ai-rung.ts`) shared by every rung and repair round of the joint run. Budget = `tokenBudgetForCredits(Σ rungs)` (Amendment).
- The meter's per-round reserve is size-aware (`max(2_000, movableFixtures × 40)`), which matters more here than per-division: a joint pack's assignment list is the sum of every selected division's.
- Repair-round validation runs `validateAssignments` over ALL selected divisions' assignments jointly, so cross-division double-booking is caught in-run, not at apply.

## 7. Pricing

- Per-division rung via the #348 predictor, then `credits = max(1, Σ rungs − 1)`. **Already implemented**: `quoteRun(lines, schedulingRungWeights())` in `lib/ai-rung.ts` takes one `{key: divisionId, input, chosen?}` line per division and returns `{lines, rungTotal, credits, discount, budget, estTokens, underfunded}`. The division path calls the same function with one line — there is no second pricing code path to keep in sync.
- Breakdown UI: "Div A 1 + Div B 2 + Div C 3 − 1 batch discount = 5 credits" — read straight off `quote.lines` / `quote.discount` / `quote.credits`. Per-division rung chips adjustable 1-3 (same semantics as single-division; below-predicted picks stamp `underfunded` per division, and `quote.underfunded` is the any-line roll-up).
- One `spendCredit(walletId, orgId, quote.credits)` reserve; one settle/release, atomic with the run. Grant-first order, wallet-only gating unchanged.
- Margin note: discount gives back ≈ one credit per joint run; worst-case COGS remains well under the retail sum of the rungs. Note the budget is NOT discounted (Amendment), so the COGS ceiling of a joint run is the undiscounted `tokenBudgetForCredits(Σ rungs)` — still bounded, and bounded by the same 500-fixture cap.

## 8. API

- `POST /api/v1/competitions/[id]/schedule/ai-plan` — body `{divisionIds, rungOverrides?}`. Server recomputes rungs + discount, validates the cap. Gates: `scheduling.ai` + `scheduling.multi_division` + wallet ≥ N.
- **`divisionIds.length ≥ 2` required** (400 otherwise, "use the division schedule page") — prevents discount arbitrage where a single rung-2/3 division runs cheaper through the board (`max(1, rung−1)`) than through the division flow.
- `GET /api/v1/competitions/[id]/schedule/ai-last` — last joint plan for the review UI.
- Apply is server-side at plan end (mirrors per-division flow): **one transaction writes all divisions or nothing** — no partial competition apply.
- Rate limit: `ai-plan-competition:{competitionId}` max 3/hour. Per-division 5/hr brakes untouched and not double-counted by joint runs.

## 9. Board UI

`schedule-board.tsx` multi mode gains the AI console:

- Division picker → per-division rung chips + breakdown + discount line + total + wallet balance → CTA "Run AI schedule — N credits".
- Court-label divergence warning banner (§4).
- Result state: proposed assignments colored per division; joint Apply / Discard.
- 375px-clean, all new strings in en/es/fr/nl, help page for multi-division AI, `scripts/smoke.ts` gains a 2-division joint path.

## 10. Events / audit

- One competition-level `schedule.ai_generated_multi` event, payload: `{divisions: [{id, rung, underfunded}], discount: 1, budget, spent_tokens, cost_usd, pack_units}`.
- Failure event mirrors `schedule.ai_failed` at competition level.

## 11. Failure semantics

- No valid joint schedule / budget exhausted with nothing usable → hold released, no charge, nothing applied.
- One division's data invalid (e.g. zero courts, no slot config) → 422 naming the division, before any reserve.

## 12. Testing

- **Unit:** pack union + division tags + cap enforcement + court-label union/divergence detection; discount math (`max(1, Σ−1)`); ≥2-division requirement (single division → 400, no discount arbitrage); atomic-apply rollback; joint `validateAssignments` catches cross-division double-book; event payload shape. Every change ships its failing-without-it test.
- **Smoke:** 2-division joint run, breakdown price asserted; insufficient-balance path.
- **e2e:** prod build + `E2E_PROD_TARGET` — board flow: picker → price → run → review → apply.
- `BILLING_LIVE` not applicable (no Stripe surface).

## 13. Out of scope

- Joint officials assignment (Phase B stays per-division).
- Venue-level court entity (real shared-court identity) — prerequisite for removing the name-match warning, separate design.
- Auto-chunk fallback for >500-fixture competitions.
- Sequential orchestration mode (rejected approach A).
