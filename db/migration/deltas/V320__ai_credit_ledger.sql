-- V320 — AI credit wallet ledger (design/v17-pricing-entitlements/SPEC-2 §5, §11).
--
-- Phase 2 replaces the per-division AI run cap with a PREPAID credit wallet.
-- This migration lays the store: an append-only ledger keyed to the BILLING
-- ENTITY (wallet_id = coalesce(group_subscription_id, org_id), §11.1) so every
-- org in a billing group shares one pool. Grant (V-none, code) and spend come in
-- later tasks; the AI usecases meter against `balance()` on every tier.
--
-- Same upsert shape as V310/V311/V319; Flyway runs -defaultSchema=seazn_club.

-- The ledger is TRUTH, not a counter. Rows are append-only — corrections are
-- compensating rows, never UPDATE/DELETE — because credits are money. balance =
-- sum(delta); `balance_after` is a cached per-row snapshot carrying the CHECK
-- (>= 0) that makes oversell atomically impossible: two parallel runs cannot
-- both grab the last credit, since the second insert's snapshot would go
-- negative and the transaction aborts (no app lock needed, SPEC-2 §5.2).
--
-- wallet_id is TEXT with no foreign key on purpose: it is a subscription id when
-- grouped, else an org id (a group-of-one), so it cannot reference one table.
create table if not exists ai_credit_ledger (
  id              uuid primary key default gen_random_uuid(),
  wallet_id       text not null,
  -- Signed: +grant / +refund vs -spend / -expiry (SPEC-2 §5.1).
  delta           int  not null,
  source          text not null
                  check (source in ('monthly_grant', 'trial_grant', 'pack_purchase',
                                    'run_spend', 'refund', 'expiry', 'admin_adjust',
                                    'earn_grant')),
  -- stripe_payment_intent (buys) | ai_run_id (spends).
  ref             text,
  -- run_spend only: which org in the shared pool burned it (per-org reporting).
  spent_by_org_id text,
  balance_after   int  not null check (balance_after >= 0),
  -- Grant idempotency `(wallet, monthly, period)` and per-run spend idempotency
  -- both land here: a cron re-run or webhook replay conflicts and no-ops rather
  -- than double-crediting or double-debiting.
  idempotency_key text unique,
  created_at      timestamptz not null default now(),
  created_by      text
);

-- balance(wallet) and every per-wallet read scan by wallet_id.
create index if not exists ai_credit_ledger_wallet
  on ai_credit_ledger (wallet_id, created_at);

comment on table ai_credit_ledger is
  'Append-only AI credit wallet (SPEC-2 §5.1). wallet_id = '
  'coalesce(group_subscription_id, org_id) — a billing group shares one pool. '
  'balance = sum(delta); balance_after snapshot + CHECK (>= 0) blocks oversell '
  'atomically. Corrections are compensating rows, never UPDATE/DELETE — money.';

-- The wallet grant matrix. Phase 1 (V319) deliberately did NOT seed these — the
-- run-cap key it left in place is retired in a later task. Monthly grant is
-- use-or-lose per cycle and scales x quantity_paid for a group (§5.4 D1, §11.2);
-- trial grant is once-per-org (trial_used_at guard), Pro / Pro Plus only.
insert into plan_entitlements (plan_key, feature_key, bool_value, int_value) values
  ('community', 'ai.credits.monthly', null, 10),
  ('pro',       'ai.credits.monthly', null, 60),
  ('pro_plus',  'ai.credits.monthly', null, 200),
  ('pro',       'ai.credits.trial',   null, 20),
  ('pro_plus',  'ai.credits.trial',   null, 20)
on conflict (plan_key, feature_key) do update
  set bool_value = excluded.bool_value, int_value = excluded.int_value;
