-- =============================================================================
-- Jul3/04 — Scheduling constraints v2 & AI-assisted planning (PROMPT-24).
-- Constraint objects live in schedule_settings.config (no new tables); this
-- adds the no-fixed-time mode flag and the AI entitlement.
-- =============================================================================

-- No-fixed-time mode (Jul3/04 §4, 26 Sep/9 Jun/8 Dec): flexible divisions
-- generate fixtures with scheduled_at = null — ordered, not clock-slotted.
alter table divisions add column if not exists
  scheduling_mode text not null default 'timed'
  check (scheduling_mode in ('timed','flexible'));

insert into plan_entitlements (plan_key, feature_key, bool_value, int_value) values
  ('community', 'scheduling.ai', false, null),
  ('pro',       'scheduling.ai', true,  null),
  ('business',  'scheduling.ai', true,  null)
on conflict (plan_key, feature_key) do nothing;
