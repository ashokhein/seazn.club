-- V321 — per-source bucket accounting for the AI credit wallet ledger
-- (design/v17-pricing-entitlements/SPEC-2-addons-and-ai-credit-wallet.md §5.4,
-- Phase-2 Task 3 review).
--
-- V320 shipped one pooled ledger (balance = sum(delta) over every row,
-- provenance-blind). That can't express §5.4's D1 (the monthly grant is
-- use-or-lose — it must be independently resettable) or D2 (purchased packs
-- never expire) without also touching the other bucket's credits, because a
-- grant-expiry row and a pack row summed identically. This migration splits
-- the ledger into two buckets tracked (and later reset/expired)
-- independently, while both still share one wallet_id and one spend order —
-- grant credits burn first, packs are only touched once grant hits 0
-- (lib/credits.ts `reserve()`).
--
-- Correction to V320's comment "no app lock needed, SPEC-2 §5.2": that is
-- wrong. The `balance_after >= 0` CHECK alone does NOT prevent oversell under
-- concurrent reserves — two transactions can both read the same
-- not-yet-committed running sum and each compute a balance_after that
-- individually satisfies the CHECK, oversell by lost update. `reserve()` also
-- takes `pg_advisory_xact_lock(hashtext('ai-credit-wallet:' || wallet_id))` to
-- serialize read -> compute -> insert per wallet; the CHECK and the advisory
-- lock together are what block oversell, not the CHECK alone.
alter table ai_credit_ledger
  add column if not exists bucket text
    check (bucket in ('grant', 'pack'));

-- Backfill rows written before this bucket existed: monthly/trial grants are
-- unambiguously 'grant', pack purchases unambiguously 'pack'. Any earlier
-- run_spend/refund/expiry/admin_adjust rows (the pre-review reserve/release
-- wrote plain rows with no bucket split, and this is a shared dev/test
-- schema that already carries some of those from Task 3's first pass) have
-- no recoverable per-row provenance; they default to 'grant' as the
-- conservative catch-all — harmless dev-schema history, never read by a
-- production wallet.
update ai_credit_ledger set bucket = 'pack'
 where source = 'pack_purchase' and bucket is null;
update ai_credit_ledger set bucket = 'grant'
 where bucket is null;

alter table ai_credit_ledger alter column bucket set not null;

comment on column ai_credit_ledger.bucket is
  'grant | pack (SPEC-2 §5.4) — which independently-resettable bucket this '
  'row affects. monthly_grant/trial_grant/earn_grant/admin_adjust write '
  'grant; pack_purchase writes pack; run_spend/refund/expiry carry whichever '
  'bucket they debit, credit back, or expire. reserve() burns grant before '
  'pack (grant-first spend order) and may write one row per bucket for a '
  'single spend that crosses both.';

-- grantBalance(wallet)/packBalance(wallet) both scan by (wallet_id, bucket).
create index if not exists ai_credit_ledger_wallet_bucket
  on ai_credit_ledger (wallet_id, bucket, created_at);
