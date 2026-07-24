-- V319 — v17 Phase 1 packaging re-org (design/v17-pricing-entitlements/SPEC-1).
-- Free runs big + officials ungate (#253) + dead-key disposition (#246).
-- AI credit wallet, add-ons, and the Event Pass M/L ladder are LATER phases.
-- Same upsert shape as V310/V311; Flyway runs -defaultSchema=seazn_club.

-- Community "runs big": a real club (season + cup) fits on free, still badged /
-- high fee / AI-taste. Plus the competition-scoped pass-above rule for entrants
-- (V311): raising community 32->64 forces event_pass above 64, or the resolver
-- treats the equal event_pass row as a no-op and the pass buys zero entrants.
insert into plan_entitlements (plan_key, feature_key, bool_value, int_value) values
  ('community', 'entrants.per_division.max',     null, 64),
  ('event_pass','entrants.per_division.max',     null, 128),  -- comp-scoped, pass-above
  ('community', 'competitions.max_active',       null, 10),
  ('community', 'divisions.per_competition.max', null, 4),    -- event_pass 10 already > 4
  ('community', 'members.max',                   null, 5),
  ('community', 'clubs.max',                     null, 5),
  ('community', 'teams.max',                     null, 8),
  ('community', 'import.bulk',                   null, 50),
  ('community', 'schedule.checkpoints.max',      null, 2),
  -- Officials ungate (#253): manual assign / multi-role / marks free on every
  -- plan. per_fixture NULL = unlimited. AI officials (officials.auto) is NOT
  -- touched here — it becomes credit-metered in Phase 2, stays Pro-Plus for now.
  ('community', 'officials.per_fixture.max',     null, null),
  ('pro',       'officials.per_fixture.max',     null, null),
  ('pro_plus',  'officials.per_fixture.max',     null, null),
  ('community', 'officials.roles_multi',         true, null),
  ('event_pass','officials.roles_multi',         true, null),
  ('pro',       'officials.roles_multi',         true, null),
  ('pro_plus',  'officials.roles_multi',         true, null),
  ('community', 'officials.marks',               true, null),
  ('event_pass','officials.marks',               true, null),
  ('pro',       'officials.marks',               true, null),
  ('pro_plus',  'officials.marks',               true, null)
on conflict (plan_key, feature_key) do update
  set bool_value = excluded.bool_value, int_value = excluded.int_value;

-- Org-wide caps are NOT competition-scoped, so the Event Pass (one competition)
-- must never cap them BELOW the raised community values. clubs/teams had
-- vestigial event_pass rows (=2) that would now REDUCE a passed community org's
-- clubs (5) / teams (8). Remove them — they fall through to the community value.
-- (members.max already has no event_pass row, deleted in V291 for this reason.)
delete from plan_entitlements
  where plan_key = 'event_pass' and feature_key in ('clubs.max', 'teams.max');

-- Dead-key disposition (#246): remove unenforced keys from the matrix so
-- /admin/entitlements shows only live, storied keys.
delete from plan_entitlements where feature_key in ('public_pages', 'eligibility.enforced');
-- stats.club_championship: KEPT — revived as the Pro Plus "coming soon" analytics
-- differentiator (SPEC-1 §9), rendered as roadmap in Task 4.
-- scorers.max: NOT touched — dormant legacy (#244); removed from MARKETING only
-- (pricing render + help, Tasks 4/5), not from the DB.
