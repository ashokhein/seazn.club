# v17 Phase 3 — Add-ons + Stripe Credit Packs Implementation Plan

> REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`.

**Goal:** Complete the wallet's economic loop (grant → **buy** → spend) with Stripe credit packs, and add the `org_addons` additive-cap axis (extra seats / size packs) per SPEC-2 §3, §4b, §6, §8.

**Architecture:** Credit packs are **one-time Checkout Sessions** (stripe skill: one-time → Checkout Sessions); a paid pack writes a `pack_purchase` ledger row (`bucket='pack'`, never-expire, D2) into the buyer's wallet via the existing webhook path. `org_addons` (SPEC-2 §3) is a new table the resolver sums additively into `effective_cap`. Stripe interactions use restricted keys, dynamic payment methods (no `payment_method_types`), currency locked to the customer (SPEC-2 §6).

**Tech Stack:** Postgres + Flyway, Stripe (Checkout + webhooks), raw `sql`, Vitest, live-Stripe `BILLING_LIVE=1` (sk_test). Fresh schema: `export DATABASE_URL="$(cat /tmp/v17_base_url)" DB_SCHEMA=seazn_club_v17`.

## Global Constraints
- **Any Stripe design → load the `stripe:stripe-best-practices` skill first.** Credit packs + size packs = one-time Checkout Sessions; extra-seat = recurring line item. Never pass `payment_method_types`. Restricted key. Currency = the customer's locked currency (SPEC-2 §6; the `currency_options` 400 trap).
- Pack credits → ledger `source='pack_purchase'`, `bucket='pack'` (never-expire, D2). Reuse `credits.ts`'s `appendLedgerRow`/idempotency; idempotent on Stripe webhook replay (key off the Stripe event/payment_intent id).
- `org_addons` per SPEC-2 §3 exactly: `wallet_id`, `target_org_id`, `target_competition_id`, `feature_key`, `delta_each`, `qty`, `stripe_item_id`, `status`. Additive resolver: `effective_cap(org,comp) = plan_base + Σ(delta·qty where active AND target matches)` — extend the ONE resolver (SPEC-1 §10), never a second path.
- Every change: regression test (fails without it); `npm run typecheck --workspace apps/web` clean; live-Stripe for Stripe-touching tasks; i18n 4-locale for any user-facing string. Next migration **V323+**.
- Do NOT touch AI provider/openrouter code or the red-baseline route tests.

---

### Task 1: Stripe credit packs (buy → pack_purchase ledger)
**Files:** `apps/web/src/config/stripe-plans.json` (4 one-time pack prices × currencies); a Checkout-session creator (buy credits) in `lib/billing.ts` or a new `lib/credit-packs.ts`; the webhook handler (`checkout.session.completed` / payment_intent) → `credits.ts` pack grant; migration only if a purchase-record table is needed (prefer the ledger row as the record). Test: `credit-packs.test.ts` + a `*.live.test.ts`.
**Produces:** `createCreditPackCheckout(orgId, packKey)`, and a webhook branch that writes `pack_purchase` (bucket='pack').
- [ ] Load the stripe skill; design the one-time Checkout + webhook per it.
- [ ] Failing test: a completed pack checkout writes exactly one `pack_purchase` ledger row (bucket='pack') for the org's wallet with the right credit amount; a replayed webhook is idempotent (no double-credit).
- [ ] Pack SKUs in stripe-plans.json ($10→40 / $25→105 / $50→220 / $100→460, per SPEC-2 §6), synced via `stripe:sync`.
- [ ] Checkout session (one-time, locked currency, no `payment_method_types`); webhook → append `pack_purchase` bucket='pack', idempotent on the Stripe id.
- [ ] Unit test green + **live-Stripe** (`BILLING_LIVE=1`) at least the tier-probe baseline; add a live pack-checkout test if feasible.
- [ ] i18n for the buy-credits copy (4 locales). Commit + push.

### Task 2: `org_addons` table + additive cap resolver
**Files:** migration `V32x__org_addons.sql`; `lib/entitlements.ts` (extend `withinLimit`/cap resolution to sum active `org_addons`); test.
- [ ] Failing test: with an active `org_addons` row (`feature_key='members.max'`, `delta_each=5`, `target_org_id=org`), `withinLimit` returns `plan_base + 5`; a `target_competition_id`-scoped row only lifts that comp; a `canceled` row doesn't count; lapse → freeze not delete.
- [ ] Migration: `org_addons` per SPEC-2 §3. Resolver: additive sum in the ONE resolver, group-aware (SPEC-2 §11.3).
- [ ] Test green; typecheck. Commit + push.

### Task 3: Extra-seat + size-pack add-ons (Stripe)
**Files:** extra-seat = recurring Stripe line item → `org_addons` (target_org_id); size-pack = one-time Checkout → `org_addons` (target_competition_id). `billing.ts`/`credit-packs.ts`; tests + live-Stripe.
- [ ] Extra-seat: recurring add-on raises `members.max` for one org; size-pack: one-time raises `entrants.per_division.max` for one competition (SPEC-2 §4b), follows the SPEC-4 lifecycle lock.
- [ ] Live-Stripe + unit green; i18n. Commit + push.

### Task 4: Credit pack refunds claw back only unspent credits
**Files:** `billing-events.ts` (`charge.refunded` handler, alongside `syncRegistrationRefund`/`handleSponsorChargeRefunded`/`revokePassForRefundedChargeAndNotify`); `credits.ts` (new claw-back helper); test.
**Produces:** a `charge.refunded` branch that no-ops on non-pack charges and, for a refunded pack charge, appends a compensating ledger row capped at the pack bucket's current unspent balance.
- [ ] Failing test: refunding a pack charge whose credits are still fully unspent claws back exactly that amount; a charge refunded after some/all of its pack credits were already spent claws back only what remains in the `pack` bucket (never drives `packBalance` negative, never touches the `grant` bucket or already-spent credits) (SPEC-2 §8/§9).
- [ ] Match the refunded charge back to its `pack_purchase` ledger row via the charge's `payment_intent` (the same `ref` `recordPackPurchase` stamped); no match (e.g. pre-fix session with no ref) — surface it the same way as the T1 review fix (log + staff alert), do not silently no-op a real refund.
- [ ] Claw-back write: one `source='expiry'` (or a new dedicated refund source, whichever `credits.ts` review prefers), `bucket='pack'`, `delta = -min(unspent pack credits for this purchase, remaining pack balance)` — never negative balance, idempotent on the charge/refund id (a replayed `charge.refunded` must not double-claw-back).
- [ ] Test green; typecheck. Commit + push.

## Self-review
- SPEC-2 coverage: §5.1 pack_purchase bucket → T1; §6/§8 Stripe packs → T1; §3 org_addons additive → T2; §4b size pack + §11.3 scope → T2/T3; §8/§9 pack refund claw-back → T4. Operator allocation (SPEC-5) + UI (SPEC-6) are later.
- Order: credit packs (T1) completes the wallet loop first; org_addons (T2) is the separate additive axis; T3 wires the Stripe add-on SKUs; T4 closes the pack refund gap the review flagged.
