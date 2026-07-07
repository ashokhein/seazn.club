-- =============================================================================
-- Jul3/05 — Custom points, carry-over & manual rank control (PROMPT-25).
-- Rules/overrides live in stages.config (no new tables); this seeds the
-- entitlement keys.
-- =============================================================================
insert into plan_entitlements (plan_key, feature_key, bool_value, int_value) values
  ('community', 'standings.custom_points', false, null),
  ('pro',       'standings.custom_points', true,  null),
  ('business',  'standings.custom_points', true,  null),
  ('community', 'standings.carry_over',    false, null),
  ('pro',       'standings.carry_over',    true,  null),
  ('business',  'standings.carry_over',    true,  null)
on conflict (plan_key, feature_key) do nothing;
