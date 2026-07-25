-- V326 — attributed reason on the AI credit ledger (design/v17-pricing-
-- entitlements/SPEC-3-admin-adjustments.md §1, §2 "Reason mandatory").
--
-- SPEC-3's admin adjustment layer requires every money-adjacent row to carry
-- WHO (created_by, already on V320) and WHY. `admin_adjust` rows (staff
-- grant/deduct of AI credits) store a reason built from a fixed reason_code
-- (support_goodwill · sales_comp · promo · bug_fix · refund_adjust) plus
-- optional free text — the Adjustments log (§3) and the org-side friendly line
-- (§5) both read it. The column is nullable: the machine-written rows
-- (monthly_grant, trial_grant, pack_purchase, run_spend, refund, expiry) carry
-- no reason and never did.
--
-- Same upsert-safe shape as V320/V321; Flyway runs -defaultSchema=seazn_club.
alter table ai_credit_ledger
  add column if not exists reason text;

comment on column ai_credit_ledger.reason is
  'admin_adjust only (SPEC-3 §1/§2): staff-supplied reason (reason_code + '
  'optional note) for a manual credit grant/deduct. Null for machine-written '
  'grant/spend/refund/expiry rows. Paired with created_by (V320) for the '
  'attributed, auditable adjustment trail.';
