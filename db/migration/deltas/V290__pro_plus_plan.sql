-- ============================================================
-- V290 — Pro Plus plan (spec 2026-07-18-pro-plus-tier §1, D1–D6).
-- New self-serve tier above Pro. Retires the dark v2 'business' plan.
-- Adds quota keys for officials-per-fixture and schedule save points.
-- scheduling.ai + officials.auto + api.write move up to Pro Plus
-- (approved hard move, no grandfather — pre-launch). Idempotent.
-- ORDERING: numbered AFTER V288 (v13 fidelity) on purpose — V288 still
-- seeds a 'business' row for scoring.audit_export, so the retirement
-- below must run last; this file also grants that v13 key to pro_plus.
-- (Was drafted as V286; renumbered when v13 landed first.)
-- ============================================================

insert into plans (key, name, is_public) values ('pro_plus', 'Pro Plus', true)
on conflict (key) do nothing;

-- Full pro_plus column: a missing row DENIES (lib/entitlements.ts resolver),
-- so EVERY feature key gets a row. Boolean grants first:
insert into plan_entitlements (plan_key, feature_key, bool_value, int_value)
select 'pro_plus', f, true, null from unnest(array[
  'api.access','api.write','branding','clubs.hierarchy','cricket.dls',
  'dashboard.branding','dashboard.player_profiles','discovery.branding',
  'discovery.featured','discovery.listed','domains.custom',
  'eligibility.enforced','embeds.enabled','exports','exports.branded',
  'formats.advanced','formats.double_elim','import.bulk','logos.bulk',
  'officials.auto','officials.roles_multi','public_pages','realtime',
  'registration.enabled','registration.paid','schedule.versioning',
  'scheduling.ai','scheduling.board','scheduling.constraints',
  'scheduling.multi_division','scoring.audit_export','scoring.ball_by_ball',
  'scoring.device_links',
  'scoring.match_timeline','scoring.rally_by_rally','sponsors.monetize',
  'sponsors.tiers','standings.carry_over','standings.custom_points',
  'stats.club_championship','stats.player','support.priority',
  'tiebreakers.custom'
]) as f
on conflict (plan_key, feature_key) do update
  set bool_value = excluded.bool_value, int_value = excluded.int_value;

-- Unlimited scale (int_value null = unlimited) + the 1% platform fee:
insert into plan_entitlements (plan_key, feature_key, bool_value, int_value) values
  ('pro_plus', 'competitions.max_active',       null, null),
  ('pro_plus', 'dashboard.public.max',          null, null),
  ('pro_plus', 'divisions.per_competition.max', null, null),
  ('pro_plus', 'entrants.per_division.max',     null, null),
  ('pro_plus', 'members.max',                   null, null),
  ('pro_plus', 'officials.per_fixture.max',     null, null),
  ('pro_plus', 'orgs.max_owned',                null, null),
  ('pro_plus', 'registration.fee_percent',      null, 1),
  ('pro_plus', 'schedule.checkpoints.max',      null, null),
  ('pro_plus', 'scorers.max',                   null, null),
  ('pro_plus', 'stages.per_division.max',       null, null)
on conflict (plan_key, feature_key) do update
  set bool_value = excluded.bool_value, int_value = excluded.int_value;

-- Approved hard moves: these leave Pro (D4 + D3 api.write).
update plan_entitlements set bool_value = false, int_value = null
where plan_key = 'pro'
  and feature_key in ('scheduling.ai', 'officials.auto', 'api.write');

-- New quota/flag keys for the existing plans. No event_pass rows — a key
-- missing from the pass matrix falls through to community by design (v3/07 §3).
insert into plan_entitlements (plan_key, feature_key, bool_value, int_value) values
  ('community', 'officials.per_fixture.max', null,  1),
  ('pro',       'officials.per_fixture.max', null,  null),
  ('community', 'schedule.checkpoints.max',  null,  1),
  ('pro',       'schedule.checkpoints.max',  null,  5),
  ('community', 'domains.custom',            false, null),
  ('pro',       'domains.custom',            false, null),
  ('community', 'support.priority',          false, null),
  ('pro',       'support.priority',          false, null)
on conflict (plan_key, feature_key) do update
  set bool_value = excluded.bool_value, int_value = excluded.int_value;

-- The never-enforced officials.assignment key dies (D5) — replaced by the
-- officials.per_fixture.max quota + the existing roles_multi/auto gates.
delete from plan_entitlements where feature_key = 'officials.assignment';

-- Retire the dark v2 'business' plan (D1). Guarded: never delete a plan a
-- subscription still references (there are none — it was never sellable).
delete from plan_entitlements where plan_key = 'business'
  and not exists (select 1 from subscriptions s where s.plan_key = 'business');
delete from plans where key = 'business'
  and not exists (select 1 from subscriptions s where s.plan_key = 'business');
