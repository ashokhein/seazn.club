-- V277 — one trial per organisation (product gap 2026-07-13): the
-- downgrade→upgrade loop re-granted the 14-day no-card trial on every new
-- checkout session. trial_used_at is stamped when the first trialing
-- subscription syncs (webhook/reconcile) and is never cleared; the checkout
-- route omits trial_period_days once it's set.
alter table subscriptions add column if not exists trial_used_at timestamptz;

-- Backfill: any org that ever held a Stripe subscription (or a recorded
-- trial window) has had its chance — an existing customer re-subscribing
-- should not restart a trial.
update subscriptions
   set trial_used_at = coalesce(trial_end, updated_at, now())
 where trial_used_at is null
   and (trial_end is not null or stripe_subscription_id is not null);
