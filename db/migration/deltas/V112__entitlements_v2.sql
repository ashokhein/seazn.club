-- ============================================================
-- 012 — Entitlements v2 (PROMPT-13, doc 10 §1)
-- Seeds the full v2 feature matrix into plan_entitlements and the
-- dark Business plan. The dead v1 keys (seasons.max, tournaments.per_season.max,
-- players.max, formats.all) are gone post-cutover; `branding`, `exports`, and
-- `realtime` survive as they are still read by v2 app paths. Idempotent.
-- ============================================================

-- Business = third plan; ships dark (is_public=false) until pricing decided.
INSERT INTO plans (key, name, is_public) VALUES
  ('business', 'Business', false)
ON CONFLICT (key) DO NOTHING;

-- ------------------------------------------------------------
-- v2 matrix (doc 10 §1). int_value NULL = unlimited; a missing
-- (plan, feature) row resolves to deny/0 in lib/entitlements.ts.
-- Seat quotas (orgs.max_owned, members.max, scorers.max) are normative in
-- doc 13 §5; enforcement of those lands with PROMPT-18 — values seeded now
-- so the read endpoint and UI can show them.
-- ------------------------------------------------------------
INSERT INTO plan_entitlements (plan_key, feature_key, bool_value, int_value) VALUES
  -- Structure & scale ------------------------------------------------------
  ('community', 'orgs.max_owned',                null, 1),
  ('pro',       'orgs.max_owned',                null, 5),
  ('business',  'orgs.max_owned',                null, null),
  ('community', 'members.max',                   null, 3),
  ('pro',       'members.max',                   null, 10),
  ('business',  'members.max',                   null, null),
  ('community', 'scorers.max',                   null, 1),
  ('pro',       'scorers.max',                   null, 1),
  ('business',  'scorers.max',                   null, null),
  ('community', 'competitions.max_active',       null, 2),
  ('pro',       'competitions.max_active',       null, null),
  ('business',  'competitions.max_active',       null, null),
  ('community', 'divisions.per_competition.max', null, 1),
  ('pro',       'divisions.per_competition.max', null, 10),
  ('business',  'divisions.per_competition.max', null, null),
  ('community', 'entrants.per_division.max',     null, 16),
  ('pro',       'entrants.per_division.max',     null, 64),
  ('business',  'entrants.per_division.max',     null, 256),
  ('community', 'stages.per_division.max',       null, 2),
  ('pro',       'stages.per_division.max',       null, 4),
  ('business',  'stages.per_division.max',       null, null),
  ('community', 'formats.double_elim',           false, null),
  ('pro',       'formats.double_elim',           true,  null),
  ('business',  'formats.double_elim',           true,  null),
  -- Sport depth ------------------------------------------------------------
  ('community', 'scoring.ball_by_ball',          false, null),
  ('pro',       'scoring.ball_by_ball',          true,  null),
  ('business',  'scoring.ball_by_ball',          true,  null),
  ('community', 'scoring.rally_by_rally',        false, null),
  ('pro',       'scoring.rally_by_rally',        true,  null),
  ('business',  'scoring.rally_by_rally',        true,  null),
  ('community', 'scoring.match_timeline',        false, null),
  ('pro',       'scoring.match_timeline',        true,  null),
  ('business',  'scoring.match_timeline',        true,  null),
  ('community', 'cricket.dls',                   false, null),
  ('pro',       'cricket.dls',                   true,  null),
  ('business',  'cricket.dls',                   true,  null),
  ('community', 'stats.player',                  false, null),
  ('pro',       'stats.player',                  true,  null),
  ('business',  'stats.player',                  true,  null),
  ('community', 'stats.club_championship',       false, null),
  ('pro',       'stats.club_championship',       true,  null),
  ('business',  'stats.club_championship',       true,  null),
  ('community', 'tiebreakers.custom',            false, null),
  ('pro',       'tiebreakers.custom',            true,  null),
  ('business',  'tiebreakers.custom',            true,  null),
  ('community', 'eligibility.enforced',          false, null),
  ('pro',       'eligibility.enforced',          true,  null),
  ('business',  'eligibility.enforced',          true,  null),
  -- Public & realtime ------------------------------------------------------
  ('community', 'dashboard.public.max',          null, 1),
  ('pro',       'dashboard.public.max',          null, null),
  ('business',  'dashboard.public.max',          null, null),
  ('community', 'dashboard.branding',            false, null),
  ('pro',       'dashboard.branding',            true,  null),
  ('business',  'dashboard.branding',            true,  null),
  ('community', 'dashboard.player_profiles',     false, null),
  ('pro',       'dashboard.player_profiles',     true,  null),
  ('business',  'dashboard.player_profiles',     true,  null),
  ('community', 'realtime',                      false, null),
  ('pro',       'realtime',                      true,  null),
  ('business',  'realtime',                      true,  null),
  -- Platform (Pro → Business ladder) ---------------------------------------
  ('community', 'api.access',                    false, null),
  ('pro',       'api.access',                    true,  null),
  ('business',  'api.access',                    true,  null),
  ('community', 'api.write',                     false, null),
  ('pro',       'api.write',                     false, null),
  ('business',  'api.write',                     true,  null),
  ('community', 'exports',                       false, null),
  ('pro',       'exports',                       true,  null),
  ('business',  'exports',                       true,  null),
  ('community', 'scheduling.constraints',        false, null),
  ('pro',       'scheduling.constraints',        true,  null),
  ('business',  'scheduling.constraints',        true,  null),
  ('community', 'officials.assignment',          false, null),
  ('pro',       'officials.assignment',          true,  null),
  ('business',  'officials.assignment',          true,  null),
  -- `branding` is the one surviving v1 key: still read by the logo-upload
  -- gate and the public-site branded flag. Business inherits Pro's value.
  ('business',  'branding',                      true,  null)
ON CONFLICT (plan_key, feature_key) DO NOTHING;
