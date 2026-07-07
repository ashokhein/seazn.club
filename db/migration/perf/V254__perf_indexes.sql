-- =============================================================================
-- V254 — Performance indexes
-- =============================================================================
-- Two classes only (deliberately NOT a blanket org_id index on every tenant
-- table — RLS's `org_id = current_org_id()` is a cheap recheck when a more
-- selective index already drives the plan, and extra indexes tax every write):
--
--   A. FK columns with ON DELETE CASCADE / SET NULL that have no covering
--      index. Postgres does NOT auto-index FKs; a parent delete then seq-scans
--      the child. These are the composite-PK columns that are not a left
--      prefix, plus the self-referential bracket link.
--   B. Lone-org_id scan roots — tables read as "everything for this org" from
--      the organiser dashboard, with no other selective access path.
--
-- Idempotent (IF NOT EXISTS), matching repo convention. On a populated prod DB
-- prefer CREATE INDEX CONCURRENTLY run outside Flyway to avoid write locks;
-- dev tables are small so the plain form is used here.
-- =============================================================================

-- A. Uncovered cascade / reverse-lookup FKs -----------------------------------

-- persons delete + "which entrants is this person on" (person_id is the 2nd
-- PK column of entrant_members, so unindexed on its own).
create index if not exists entrant_members_person_idx
  on entrant_members(person_id);

-- entrants delete + persons delete cascade into lineups (both trail the
-- fixture_id PK prefix, so unindexed on their own).
create index if not exists lineups_entrant_idx on lineups(entrant_id);
create index if not exists lineups_person_idx  on lineups(person_id);

-- stages delete cascades into pools; also the stage->pools join in the public
-- read model.
create index if not exists pools_stage_idx on pools(stage_id);

-- Bracket regeneration deletes child fixtures via the self-FK; unindexed it
-- seq-scans the whole fixtures table per delete.
create index if not exists fixtures_parent_idx
  on fixtures(parent_fixture_id) where parent_fixture_id is not null;

-- B. Lone-org_id dashboard roots ----------------------------------------------

-- "List all competitions for this org" — the only access path besides the
-- (org_id, slug) unique, which does not help an unfiltered list.
create index if not exists competitions_org_idx on competitions(org_id);

-- "List all teams for this org".
create index if not exists teams_org_idx on teams(org_id);
