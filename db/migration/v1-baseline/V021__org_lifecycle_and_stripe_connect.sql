-- ---------------------------------------------------------------------------
-- Billing: plans, subscriptions, entitlements
-- Billing tables are accessed via the superuser connection only (not app_user),
-- so no RLS or GRANT to app_user is needed here.
-- ---------------------------------------------------------------------------

alter table organizations
  add column if not exists status      text not null default 'active',
  add column if not exists deleted_at  timestamptz,
  add column if not exists purge_after timestamptz;

-- Stripe Connect (doc 16 §1.1, PROMPT-20a; delta shipped as migration 018):
-- Express account for entry-fee payouts. charges_enabled mirrors Stripe via
-- account.updated webhooks + reconcile-on-return; gates paid checkout only.
alter table organizations
  add column if not exists stripe_account_id      text,
  add column if not exists stripe_charges_enabled boolean not null default false;
create unique index if not exists organizations_stripe_account_idx
  on organizations(stripe_account_id) where stripe_account_id is not null;
