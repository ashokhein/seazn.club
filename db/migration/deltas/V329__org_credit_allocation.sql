-- V329 — operator per-org monthly credit allocation cap (design/v17-pricing-
-- entitlements/SPEC-5 §1).
--
-- A Pro Plus operator (federation/academy/county) runs ONE shared group wallet
-- (SPEC-2 §11): every member org spends from the same pool. Without a control,
-- one member can burn the whole month's credits. This table lets the operator
-- set a per-member HARD monthly cap, enforced at SPEND time inside reserve()'s
-- advisory-lock transaction (lib/credits.ts) — derive-then-check-then-write, so
-- the cap is tight under concurrency (no over-spend race).
--
-- Cap semantics (SPEC-5 §1, Q8 hard-cap):
--   * NO ROW for (wallet, org) = free-for-all — the member can spend up to the
--     whole pool (backward-compatible with SPEC-2 §11 before this task).
--   * a row with monthly_cap = NULL = unlimited share (an explicit "no cap").
--   * a row with a number = the hard monthly credit cap for that member org.
-- The cap resets implicitly with the grant cycle: the spend check derives the
-- org's spend from the ledger since date_trunc('month', now()), the same
-- calendar-month anchor grantMonthly() uses — no counter column, no reset job.
--
-- org_id is uuid (references organizations) — every org-scoped table in the
-- schema types it so (V005/V023/V025). wallet_id stays TEXT with no FK, exactly
-- like ai_credit_ledger.wallet_id / org_addons.wallet_id: it is
-- coalesce(group_subscription_id, org_id) (§11.1) and cannot reference one
-- table. The cap is keyed per (wallet, org) so the operator caps each member
-- independently on the shared wallet.
--
-- Same text/CHECK style as ai_credit_ledger (V320) / org_addons (V323), no pg
-- enum type; Flyway runs -defaultSchema=seazn_club.

create table if not exists org_credit_allocation (
  wallet_id    text not null,
  org_id       uuid not null references organizations(id) on delete cascade,
  -- NULL = unlimited share of the pool; a number = the hard monthly cap.
  monthly_cap  int,
  -- Staff/operator user id who set the cap (attribution; no FK, like
  -- ai_credit_ledger.created_by).
  updated_by   uuid,
  updated_at   timestamptz not null default now(),
  primary key (wallet_id, org_id),
  check (monthly_cap is null or monthly_cap >= 0)
);

comment on table org_credit_allocation is
  'Operator per-org monthly AI-credit cap on a shared group wallet (SPEC-5 §1). '
  'NO ROW = free-for-all (spend up to the pool); NULL cap = unlimited share; a '
  'number = hard monthly cap, enforced at spend time in reserve() and reset '
  'implicitly with the calendar-month grant cycle. wallet_id = '
  'coalesce(group_subscription_id, org_id), keyed per (wallet, org).';
