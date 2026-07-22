-- V308 — the Event Pass grants player profiles for the competition it covers.
--
-- V306 made org_has_feature pass-aware and V307 moved the
-- `dashboard.player_profiles` gate out of public_players_v and into its only
-- consumer, getPublicPlayer (server/public-site/data.ts), which passes the
-- competition in view. That machinery was inert for the Event Pass: the shipped
-- matrix (V270) has no ('event_pass', 'dashboard.player_profiles') row at all,
-- and the resolver treats an absent pass row as "no answer" — it falls through
-- to the plan row, which for a community org is false. So a paid pass bought a
-- competition nothing on this feature.
--
-- Owner decision D17: it should. Same shape as V306's exports.branded grant,
-- upsert so re-runs and any later matrix reseed converge.
--
-- Scope is per-competition by construction, not by this row: the resolver only
-- consults a pass row when a competition id is in scope AND that competition
-- carries a competition_passes row for the org AND the org's own plan resolves
-- to community. A second, unpassed competition in the same org still denies.
--
-- CONSENT IS UNAFFECTED. public_players_v (v2-engine/views/V237, recreated by
-- V307) filters on `coalesce((p.consent->>'public_name')::boolean, false)`
-- regardless of plan, and public_entrants_v gates photo/person_id on
-- `public_photo` / `public_name` before it ever asks org_has_feature. This
-- migration touches neither view. An Event Pass buys the entitlement half of
-- the two-key gate and nothing else; a person who never consented stays
-- invisible on a passed competition exactly as on an unpassed one.
insert into plan_entitlements (plan_key, feature_key, bool_value, int_value)
values ('event_pass', 'dashboard.player_profiles', true, null)
on conflict (plan_key, feature_key) do update
  set bool_value = excluded.bool_value, int_value = excluded.int_value;
