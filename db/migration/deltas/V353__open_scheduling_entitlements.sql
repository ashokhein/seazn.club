-- V353 — division scheduling is open to every plan; multi-division stays paid.
--
-- #382. `scheduling.ai` was already open to every plan: V322 retired
-- `scheduling.ai.runs_per_division.max` because the AI credit wallet meters runs
-- on every tier, so AI scheduling is credit-gated, not plan-gated. What was
-- still gated is the ordinary board and constraints — the non-AI scheduling an
-- organiser does by hand. An organiser who could ask the AI for a schedule then
-- could not drag one fixture of it is the shape this removes.
--
-- Event Pass carried NO ROW for any of the three. `hasFeature` reads
-- `row?.bool_value === true`, so a missing row is false: an Event Pass org got
-- none of them. These are inserts, not flips.
--
-- After this, `scheduling.multi_division` is the only scheduling paywall left.
--
-- Corrects V303's header while here: that comment states the save-point quota
-- as "1 free / 5 Pro", which V319 superseded — community has been 2 since. The
-- migration file itself is left untouched (Flyway validates its checksum); the
-- live numbers are `schedule.checkpoints.max` in this table, which as of V353
-- read community 2 / pro 5 / pro_plus unlimited.
insert into plan_entitlements (plan_key, feature_key, bool_value) values
  ('community',    'scheduling.board',          true),
  ('event_pass',   'scheduling.board',          true),
  ('event_pass_l', 'scheduling.board',          true),
  ('community',    'scheduling.constraints',    true),
  ('event_pass',   'scheduling.constraints',    true),
  ('event_pass_l', 'scheduling.constraints',    true),
  ('event_pass',   'scheduling.multi_division', true),
  ('event_pass_l', 'scheduling.multi_division', true)
on conflict (plan_key, feature_key) do update set bool_value = excluded.bool_value;
