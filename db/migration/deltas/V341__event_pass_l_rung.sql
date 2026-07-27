-- V341 — Event Pass L rung (v17 #294, decision 2026-07-26): $59, unlimited
-- entrants, <=20 divisions, SAME +25 one-time credit grant as M — the grant
-- machinery (lib/credits.ts recordPassGrant, called with the flat
-- PASS_CREDIT_GRANT constant) never reads pass_key at all, so nothing here
-- touches it.
--
-- The resolver (org_has_feature, V328; lib/entitlements.ts resolveFromDb) is
-- ALREADY rung-agnostic — both join plan_entitlements on
-- competition_passes.pass_key with no hardcoded 'event_pass' anywhere. So the
-- entire L rung is this migration: a plans row, and a plan_entitlements
-- matrix.
--
-- The matrix is derived from event_pass's CURRENT rows via INSERT...SELECT,
-- not hand-copied — event_pass has accumulated ~20 rows across ten+
-- migrations since V270 (V283 sponsors, V292 clubs/teams, V293 discipline,
-- V294 officials.marks, V295 news.auto, V302 scheduling.ai, V306
-- exports.branded, V308 dashboard.player_profiles, V319 the v17 reorg — see
-- that migration history for the full trail) and hand-copying them here
-- would be exactly the kind of drift #294's decision explicitly rejects
-- ("Entitlements derived from the M rung so they cannot drift"). Every key M
-- carries, L carries identically, except the two overrides below.
--
-- is_public = false, matching M: neither rung is a subscription plan and the
-- /pricing plan grid must not list it. The one-time price id lands on this
-- row later, written back by scripts/stripe-sync.ts.
insert into plans (key, name, is_public) values ('event_pass_l', 'Event Pass L', false)
on conflict (key) do nothing;

insert into plan_entitlements (plan_key, feature_key, bool_value, int_value)
select 'event_pass_l', feature_key, bool_value, int_value
from plan_entitlements
where plan_key = 'event_pass'
on conflict (plan_key, feature_key) do update
  set bool_value = excluded.bool_value, int_value = excluded.int_value;

-- Overrides (#294 decision): unlimited entrants (int null = unlimited, the
-- SAME convention pro's own divisions.per_competition.max/clubs.max rows
-- already use), divisions capped at 20 (M is 10, per V319).
--
-- These are UPDATEs, not inserts, and they touch int_value ONLY. Re-stating
-- bool_value here would hand-copy M's value onto exactly the two rows the
-- derivation above exists to protect — the rows stay derived, and only the
-- one column being overridden is written. Both rows are guaranteed to exist:
-- the INSERT...SELECT above copied every key M has, and M carries both.
update plan_entitlements set int_value = null
where plan_key = 'event_pass_l' and feature_key = 'entrants.per_division.max';

update plan_entitlements set int_value = 20
where plan_key = 'event_pass_l' and feature_key = 'divisions.per_competition.max';
