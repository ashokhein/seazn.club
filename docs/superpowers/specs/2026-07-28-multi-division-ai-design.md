# Multi-Division AI Scheduling (Competition Board) — Design

**Date:** 2026-07-28
**Status:** Approved by owner (brainstorm session), pending implementation plan
**Depends on:** Token-weighted AI credits design (`2026-07-28-ai-credit-token-weight-design.md`, issue #348) — this feature builds on its predictor, rung pricing, and budget meter.

## 1. Problem

The competition-level schedule board (`/o/[orgSlug]/c/[compSlug]/schedule`, Pro-only via `scheduling.multi_division`) is read-only, with the AI console explicitly disabled in multi mode (`schedule-board.tsx:125,149`). AI scheduling runs only per division; divisions sharing courts are handled defensively (siblings appear as immovable obstacles) but never optimized jointly. Owners of multi-division competitions want one AI action that schedules divisions together — avoiding cross-division clashes and balancing shared court use.

## 2. Decisions (owner-approved)

| Question | Decision |
|---|---|
| Shape | **B — one joint solve.** All selected divisions' movable fixtures in a single AI run (rejected: sequential orchestration, hierarchical meta-pass). |
| Size ceiling | **Block over cap.** >500 movable fixtures total → refuse with "too large — schedule per division". No silent fallback, no cap raise. |
| Pricing | **Sum of division rungs − 1, min 1** (batch discount). Each division predicted individually by the #348 predictor; breakdown shown to user. |
| Budget | **Follows charged credits**: total-run generation budget = 32K × credits charged (discounted total). Keeps the "credits buy budget" invariant; discount justified by shared context. |
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

- Same escalation ladder and #348 cumulative token meter. Budget = 32K × credits charged.
- Repair-round validation runs `validateAssignments` over ALL selected divisions' assignments jointly, so cross-division double-booking is caught in-run, not at apply.

## 7. Pricing

- Per-division rung via the #348 predictor (`ai-rung.ts`), then `credits = max(1, Σ rungs − 1)`.
- Breakdown UI: "Div A 1 + Div B 2 + Div C 3 − 1 batch discount = 5 credits". Per-division rung chips adjustable 1-3 (same semantics as single-division; below-predicted picks stamp `underfunded` per division).
- One `spendCredit(walletId, orgId, N)` reserve; one settle/release, atomic with the run. Grant-first order, wallet-only gating unchanged.
- Margin note: discount gives back ≈ one credit per joint run; worst-case COGS remains well under the retail sum of the rungs.

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
