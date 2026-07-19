-- V294 (v4 AI architect, owner 2026-07-19): AI schedule generations become a
-- per-division quota on EVERY tier — free 5 / event pass 10 / pro 20 /
-- pro plus 50 (supersedes V291's pro=5, plus=unlimited). The pass overlay
-- only upgrades community bases (lib/entitlements.ts resolution), so the
-- event_pass rows read as "a passed competition lifts free's 5 to 10".
insert into plan_entitlements (plan_key, feature_key, bool_value, int_value) values
  ('community',  'scheduling.ai',                       true, null),
  ('community',  'scheduling.ai.runs_per_division.max', null, 5),
  ('event_pass', 'scheduling.ai',                       true, null),
  ('event_pass', 'scheduling.ai.runs_per_division.max', null, 10),
  ('pro',        'scheduling.ai.runs_per_division.max', null, 20),
  ('pro_plus',   'scheduling.ai.runs_per_division.max', null, 50)
on conflict (plan_key, feature_key) do update
  set bool_value = excluded.bool_value, int_value = excluded.int_value;
