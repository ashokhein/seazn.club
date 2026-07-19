-- V291 (payments hardening wave, spec 2026-07-18): dispute flags for sponsor
-- orders + platform subscriptions, Connect health mirror, webhook retry
-- counter, and the dead Event Pass members.max row (org-wide key can never
-- resolve through the comp-scoped pass branch — pricing page over-promised).
alter table sponsor_orders
  add column if not exists disputed_at timestamptz,
  add column if not exists dispute_id  text;

alter table subscriptions
  add column if not exists disputed_at timestamptz,
  add column if not exists dispute_id  text;

-- T9 de-risk: a stable anchor for the past_due grace window, independent of
-- updated_at (which every field write bumps). Schema only for now — the
-- grace-anchor read/write wiring is a declared fast-follow after this branch
-- merges; see PR. Backfilled from updated_at so existing rows have an anchor.
alter table subscriptions
  add column if not exists status_changed_at timestamptz;
update subscriptions set status_changed_at = updated_at
  where status_changed_at is null;

alter table organizations
  add column if not exists stripe_payouts_enabled  boolean not null default true,
  add column if not exists stripe_disabled_reason  text,
  add column if not exists stripe_requirements_due int not null default 0;

alter table billing_events
  add column if not exists replay_attempts int not null default 0;

-- stripe_payment_intent is the match key on every charge.refunded
-- (revokePassForRefundedCharge) and every platform dispute (handlePlatformDispute),
-- so index it rather than sequential-scan competition_passes per charge event.
create index if not exists idx_competition_passes_intent
  on competition_passes(stripe_payment_intent);

delete from plan_entitlements
  where plan_key = 'event_pass' and feature_key = 'members.max';

-- Pro AI cap (owner 2026-07-18, amends pro-plus D4): Pro keeps AI scheduling,
-- 5 generations per division; Pro Plus unlimited; community none.
insert into plan_entitlements (plan_key, feature_key, bool_value, int_value) values
  ('pro',      'scheduling.ai',                       true, null),
  ('pro',      'scheduling.ai.runs_per_division.max', null, 5),
  ('pro_plus', 'scheduling.ai.runs_per_division.max', null, null)
on conflict (plan_key, feature_key) do update
  set bool_value = excluded.bool_value, int_value = excluded.int_value;
