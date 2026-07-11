-- v3/10 #4 — embeddable widgets are a Pro feature (the snippet UI sits
-- behind an UpgradeGate; the /embed routes 404 for non-entitled orgs).
insert into plan_entitlements (plan_key, feature_key, bool_value, int_value) values
  ('community', 'embeds.enabled', false, null),
  ('pro',       'embeds.enabled', true,  null)
on conflict (plan_key, feature_key) do nothing;
