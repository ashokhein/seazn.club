-- V304: the trial banner told every trialing org to add a card, including orgs
-- that already had one, because nothing local recorded the fact. Stripe knows;
-- the banner renders on org home (a hot path) where a live Stripe read is not
-- acceptable, so mirror it here.
--
-- Numbering note: the task brief specified V303, but V303__checkpoint_kind.sql
-- already landed on this branch (commit 63aee5cd, PR #180) and Flyway rejects
-- duplicate versions, so this delta takes the next free number.
--
-- Backfill is deliberately omitted: false is the safe default (the banner keeps
-- asking, as it does today) and every writer -- in-app add/remove card, the
-- subscription webhooks, and the payment_method/customer webhooks -- corrects
-- the row the first time it hears from Stripe.
alter table subscriptions
  add column if not exists has_payment_method boolean not null default false;

comment on column subscriptions.has_payment_method is
  'Mirror of "this org has a card on file" so the trial banner (org home, hot path) never makes a live Stripe read. Written only by syncPaymentMethodFlag() and syncSubscription().';
