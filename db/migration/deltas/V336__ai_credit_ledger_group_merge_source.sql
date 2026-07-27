-- V336 — allow a `group_merge` source on the AI credit wallet ledger (#285,
-- docs/superpowers/specs/2026-07-26-v17-gap-remediation-design.md §W1).
--
-- attachOrgToGroup (server/usecases/billing-groups.ts) rewrites
-- `organizations.subscription_id` with NO wallet merge: the org's own AI
-- credit balance stays on `ai_credit_ledger` keyed to its OLD subscription
-- id. `walletIdFor` (lib/credits.ts) only ever resolves
-- `coalesce(subscription_id, id)` for a LIVE organizations row, so once the
-- org's subscription_id points at the group, nothing can ever address the
-- old wallet again — and if that old subscription was a bare community-of-
-- one, `dropEmptyGroup` deletes the row outright the moment the attach
-- commits (`ai_credit_ledger.wallet_id` carries no foreign key, so the
-- balance survives as an orphaned row rather than cascading away).
--
-- `mergeWalletOnAttach` (lib/credits.ts) is the fix: two compensating rows
-- per non-zero bucket (grant and pack tracked independently, V321), written
-- INSIDE attachOrgToGroup's own transaction so the org move and the wallet
-- merge commit or roll back together. `group_merge` is the new provenance
-- those rows carry, so they are attributable in the wallet run history/admin
-- adjustments log alongside monthly_grant, trial_grant, pack_purchase,
-- earn_grant and pass_grant.
--
-- Same drop-if-exists + re-add shape as V326/V330/V331; Flyway runs
-- -defaultSchema=seazn_club.
alter table ai_credit_ledger
  drop constraint if exists ai_credit_ledger_source_check;

alter table ai_credit_ledger
  add constraint ai_credit_ledger_source_check
    check (source in ('monthly_grant', 'trial_grant', 'pack_purchase',
                      'run_spend', 'refund', 'expiry', 'admin_adjust',
                      'earn_grant', 'pass_grant', 'group_merge'));
