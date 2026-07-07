-- Jul3/06 §6 (PROMPT-26): branded/templated PDF is its own Pro key on top of
-- the existing `exports` gate; layout flags stay free on export-enabled plans.
insert into plan_entitlements (plan_key, feature_key, bool_value, int_value) values
  ('community', 'exports.branded', false, null),
  ('pro',       'exports.branded', true,  null),
  ('business',  'exports.branded', true,  null)
on conflict (plan_key, feature_key) do nothing;
