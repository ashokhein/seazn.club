-- Doc 10 §1 public-dashboard quota (PROMPT-12 item 7; the full v2 matrix is
-- seeded by migrations/012_entitlements_v2.sql, which apply-db runs BEFORE
-- this file): Community may hold 1 public competition at a time, Pro unlimited.
insert into plan_entitlements (plan_key, feature_key, bool_value, int_value) values
  ('community', 'dashboard.public.max', null, 1),
  ('pro',       'dashboard.public.max', null, null)
on conflict (plan_key, feature_key) do nothing;

-- Doc 12 §5 scheduling matrix (PROMPT-17; scheduling.constraints seeded by
-- 012): board editing is Pro (Community renders it view-only), the
-- competition-wide multi-division board is Pro.
insert into plan_entitlements (plan_key, feature_key, bool_value, int_value) values
  ('community', 'scheduling.board',          false, null),
  ('pro',       'scheduling.board',          true,  null),
  ('business',  'scheduling.board',          true,  null),
  ('community', 'scheduling.multi_division', false, null),
  ('pro',       'scheduling.multi_division', true,  null),
  ('business',  'scheduling.multi_division', true,  null)
on conflict (plan_key, feature_key) do nothing;

-- Doc 15 §5 discovery matrix (PROMPT-19; mirrors migration 016): listing free
-- on every tier, featured/branding are the Pro layer.
insert into plan_entitlements (plan_key, feature_key, bool_value, int_value) values
  ('community', 'discovery.listed',   true,  null),
  ('pro',       'discovery.listed',   true,  null),
  ('business',  'discovery.listed',   true,  null),
  ('community', 'discovery.featured', false, null),
  ('pro',       'discovery.featured', true,  null),
  ('business',  'discovery.featured', true,  null),
  ('community', 'discovery.branding', false, null),
  ('pro',       'discovery.branding', true,  null),
  ('business',  'discovery.branding', true,  null)
on conflict (plan_key, feature_key) do nothing;

-- Doc 13 §7 device links (PROMPT-21; mirrors migration 017): Pro/Business.
insert into plan_entitlements (plan_key, feature_key, bool_value, int_value) values
  ('community', 'scoring.device_links', false, null),
  ('pro',       'scoring.device_links', true,  null),
  ('business',  'scoring.device_links', true,  null)
on conflict (plan_key, feature_key) do nothing;

-- Doc 16 §1.1 registration (PROMPT-20a; mirrors migration 018): free-event
-- registration on every tier fills the funnel; entry fees are the paid layer.
insert into plan_entitlements (plan_key, feature_key, bool_value, int_value) values
  ('community', 'registration.enabled', true,  null),
  ('pro',       'registration.enabled', true,  null),
  ('business',  'registration.enabled', true,  null),
  ('community', 'registration.paid',    false, null),
  ('pro',       'registration.paid',    true,  null),
  ('business',  'registration.paid',    true,  null)
on conflict (plan_key, feature_key) do nothing;
