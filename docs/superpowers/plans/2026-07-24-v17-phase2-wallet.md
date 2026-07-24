# v17 Phase 2 — AI Credit Wallet Implementation Plan

> REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`.

**Goal:** Replace the per-division AI run cap with a prepaid **credit wallet** (SPEC-2 §5, §11): an append-only ledger keyed to the billing entity, monthly grant + trial grant, reserve→settle spend, 402 when empty.

**Architecture:** New `ai_credit_ledger` table (append-only, `balance_after >= 0` guard). Wallet id = `coalesce(group_subscription_id, org_id)`. A `lib/credits.ts` module owns balance/grant/spend. The AI run paths call `spendCredit()` instead of `withinLimit("scheduling.ai.runs_per_division.max")`. Ledger logic is fully testable without the LLM; only the final integration touches the AI usecases.

**Tech Stack:** Postgres + Flyway, raw `sql`, Vitest. Tests on the fresh `seazn_club_v17` schema (dev DB drifted): `export DATABASE_URL="$(cat /tmp/v17_base_url)" DB_SCHEMA=seazn_club_v17`.

## Global Constraints
- Migrations: unqualified DDL, Flyway `-defaultSchema`, upsert shape as V310/V311. Next number: `ls db/migration/deltas | sort | tail -1` +1 (V319 is Phase 1's; use **V320+**).
- Wallet id = `coalesce(group_subscription_id, org_id)` (SPEC-2 §11.1). Standalone org = group-of-one.
- Ledger append-only; corrections = compensating rows; `balance_after` snapshot with `CHECK (balance_after >= 0)`. 1 credit = 1 run.
- Spend order: monthly/trial grant first, then paid packs. Grant resets monthly (scaled × `quantity_paid` for groups); trial `ai.credits.trial` once per org (`trial_used_at`). D1/D2 per SPEC-2 §5.4.
- Every change: regression test that fails without it; `npm run typecheck --workspace apps/web` clean; i18n for any user-facing string (402 copy).
- **Do NOT** touch AI provider/OpenRouter code or the `officials-ai-route`/`schedule-ai-route` tests (red baseline, concurrent WIP). Tasks 1–3 don't go near them; Task 4 integration is scoped + flagged.
- `ai.credits.monthly` / `ai.credits.trial` matrix rows were NOT seeded in Phase 1 — Task 1 seeds them (community 10 / pro 60 / pro_plus 200; trial 20).

---

### Task 1: Ledger schema + wallet resolution + balance
**Files:** Create `db/migration/deltas/V320__ai_credit_ledger.sql`, `apps/web/src/lib/credits.ts`; Test `apps/web/src/lib/__tests__/credits-balance.test.ts`.
**Produces:** `walletIdFor(orgId): Promise<string>`, `balance(walletId): Promise<number>`.

- [ ] Step 1: failing test — `balance` of a fresh wallet is 0; after inserting a +40 grant row, 40; `walletIdFor` returns the org's group subscription id when grouped, else org id.
- [ ] Step 2: run → fail.
- [ ] Step 3: migration — `ai_credit_ledger(id uuid pk default gen_random_uuid(), wallet_id text not null, delta int not null, source text not null, ref text, spent_by_org_id text, balance_after int not null check (balance_after >= 0), idempotency_key text unique, created_at timestamptz default now(), created_by text)`; index on `(wallet_id)`. Seed `ai.credits.monthly` (10/60/200) + `ai.credits.trial` (pro/pro_plus 20) into `plan_entitlements`.
- [ ] Step 4: `lib/credits.ts` — `walletIdFor` (join billing_groups/subscriptions per SPEC-2 §11; fall back to org id), `balance` (sum(delta) or latest balance_after).
- [ ] Step 5: apply migration (fresh schema) + test → pass.
- [ ] Step 6: commit `feat(credits): ai_credit_ledger + wallet resolution + balance (V320)`; **push**.

### Task 2: Grant (monthly + trial), idempotent
**Files:** extend `lib/credits.ts`; Test `credits-grant.test.ts`.
**Consumes:** Task 1. **Produces:** `grantMonthly(walletId, plan, qty)`, `grantTrial(orgId)`.
- [ ] failing test — monthly grant inserts `plan.monthly × qty`; a second call same period is a no-op (idempotency_key `(wallet, monthly, period)`); trial grants `ai.credits.trial` once, second call no-op (`trial_used_at`).
- [ ] implement grants (source `monthly_grant`/`trial_grant`, compute `balance_after`).
- [ ] test → pass; commit `feat(credits): monthly + trial grants (idempotent, scaled)`; **push**.

### Task 3: Spend (reserve → settle → release) + 402
**Files:** extend `lib/credits.ts`; Test `credits-spend.test.ts`.
**Consumes:** Task 2. **Produces:** `reserve(walletId, orgId, cost)`, `settle(holdId, aiRunId)`, `release(holdId)`, and a `spendCredit(walletId, orgId, cost, fn)` wrapper that reserves→runs `fn`→settles, or releases + rethrows.
- [ ] failing test — reserve debits; concurrent reserve past balance blocked by the `>= 0` guard (402/PaymentRequiredError); settle links `ai_run_id`; release nets zero; spend order burns grant before packs; idempotent per run id.
- [ ] implement; unit-test concurrency via two transactions.
- [ ] test → pass; commit `feat(credits): reserve/settle/release spend + oversell guard`; **push**.

### Task 4: Integrate into AI run paths (SCOPED — flag WIP)
**Files:** `usecases/schedule-ai.ts`, `usecases/officials-ai.ts` (replace `withinLimit("scheduling.ai.runs_per_division.max")` with `spendCredit`).
- [ ] **Before starting:** diff `schedule-ai.ts`/`officials-ai.ts` in this branch vs the 5 uncommitted main-checkout WIP files; if they overlap the spend site, STOP and ask (merge-conflict risk). The `officials-ai-route`/`schedule-ai-route` tests are red baseline — do not depend on them going green here.
- [ ] Wrap the model call in `spendCredit`; on wallet-empty return the 402 with an "out of credits" body (i18n key, 4 locales).
- [ ] Regression test at the usecase layer (mock the model) that a community org with 0 credits gets 402 and with credits spends 1.
- [ ] commit + **push**.

### Task 5: Retire the run-cap matrix key
**Files:** `V321` migration; `pricing-matrix.ts` (INT_FEATURES); matrix/route tests.
- [ ] Remove `scheduling.ai.runs_per_division.max` from `plan_entitlements` + `INT_FEATURES`; the wallet replaces it. Update `pro-plus-matrix.test.ts` (drop the V302 run-cap assertions) + any route test that asserts the old cap **only if it can run** (the AI-route timeouts stay out of scope).
- [ ] Task 4 review (2026-07-24): `officials.auto` (V290, bool pro_plus-only) is now vestigial for the AI officials path — `officials-ai.ts` no longer gates on it (wallet-only, any tier). Retire/normalize it here alongside the run-cap key (it's still load-bearing for the separate MANUAL `officials.ts` gate — check before removing outright).
- [ ] commit + **push**.

### Task 6: Wire grants into billing (checkout + cron) — closes the grant-wiring gap (Task 2 review)
Grants (`grantMonthly`/`grantTrial`) are implemented but never CALLED — without this task they ship dead-on-arrival.
- [ ] **Trial grant:** call `grantTrial(orgId)` at first paid checkout / plan-change **BEFORE** `syncSubscriptionForGroup` stamps `trial_used_at` (`apps/web/src/lib/billing.ts:724`) — same transaction, using `grantTrial`'s `for update of s` lock. Otherwise the guard is already tripped and trial credits never fire.
- [ ] **Monthly grant:** grant each active wallet `ai.credits.monthly × quantity_paid` per billing period — extend `api/cron/billing-quantity` (or a new `billing-grant` cron). Idempotent per period (Task 2 guard). Community/free wallets: grant 10/mo on a creation-day calendar anchor (README §7).
- [ ] Regression test: trial fires once, before the stamp; monthly grant per period, idempotent.
- [ ] Touches checkout/webhook → run **live-Stripe** (`BILLING_LIVE=1`). commit + push.

## Self-review
- SPEC-2 coverage: §5.1 store → T1; §5.4 grant/trial/plan-change → T2; §5.2 reserve/settle → T3; §5.3 track → the ledger rows (T1); §11 wallet/scaled → T1/T2; AI-metered-on-every-tier → T4. Stripe packs (§6/§8) + operator allocation (SPEC-5) are **Phase 3+**, not here.
- Order: ledger core (T1–3) is LLM-independent; the AI-path integration (T4) is last + guarded.
