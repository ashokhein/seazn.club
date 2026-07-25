-- V330 — allow a `pass_grant` source on the AI credit wallet ledger
-- (design/v17-pricing-entitlements/SPEC-2 §5, SPEC-1 fn3, SPEC-6 §A7).
--
-- The /pricing Event Pass card advertises "+25 AI credits, one-time" (SPEC-6 A1,
-- pricing-cards.ts PASS_CREDIT_GRANT), and SPEC-1 fn3 / SPEC-2 design the pass
-- to top the org wallet up by a one-off grant — but no shipped code granted them
-- (an Event Pass credited ZERO). recordPassPurchase (lib/billing.ts) now appends
-- a one-time `bucket='pack'` (never-expire) grant to the buyer's wallet, keyed
-- for idempotency on the competition (the same anchor the competition_passes row
-- uses), so a webhook/reconcile replay can't double-grant.
--
-- The ledger's `source` CHECK enumerates every provenance a row may carry; add
-- `pass_grant` so the new grant rows are attributable in the credits run history
-- / admin adjustments log alongside monthly_grant, trial_grant, pack_purchase.
--
-- Same upsert-safe shape as V320/V321/V326; Flyway runs -defaultSchema=seazn_club.
alter table ai_credit_ledger
  drop constraint if exists ai_credit_ledger_source_check;

alter table ai_credit_ledger
  add constraint ai_credit_ledger_source_check
    check (source in ('monthly_grant', 'trial_grant', 'pack_purchase',
                      'run_spend', 'refund', 'expiry', 'admin_adjust',
                      'earn_grant', 'pass_grant'));
