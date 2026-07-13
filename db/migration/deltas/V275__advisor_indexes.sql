-- V275: covering indexes for foreign keys + slug_history PK
-- (Supabase index-advisor pass, 2026-07-13.)
--
-- Tier 1: FKs joined or filtered on request paths. Partial (`where … is not
-- null`) where the column is mostly null, so the index stays tiny and writes
-- on null rows cost nothing.
-- Tier 2: audit/attribution FKs to users/orgs — only hit on user deletion or
-- org purges, where an unindexed FK forces a full child-table scan per row.
-- Deliberately NOT indexed: score_events.recorded_by / device_link_id (the
-- hottest write path; admin scans there are rare enough to eat), and the
-- sport_key/plan_key/pass_key FKs (tiny lookup parents that are never
-- deleted). platform_settings is a one-row table.

-- ── Tier 1 ────────────────────────────────────────────────────────────────
create index if not exists persons_user_idx
  on persons (user_id) where user_id is not null;
create index if not exists fixtures_pool_idx
  on fixtures (pool_id) where pool_id is not null;
create index if not exists fixtures_winner_to_idx
  on fixtures (winner_to_fixture) where winner_to_fixture is not null;
create index if not exists fixtures_loser_to_idx
  on fixtures (loser_to_fixture) where loser_to_fixture is not null;
create index if not exists registrations_entrant_idx
  on registrations (entrant_id) where entrant_id is not null;
create index if not exists team_members_person_idx
  on team_members (person_id);
create index if not exists player_stat_snapshots_person_idx
  on player_stat_snapshots (person_id);
create index if not exists officials_person_idx
  on officials (person_id) where person_id is not null;
create index if not exists officials_entrant_idx
  on officials (entrant_id) where entrant_id is not null;
create index if not exists officials_home_pool_idx
  on officials (home_pool_id) where home_pool_id is not null;
create index if not exists score_events_voids_idx
  on score_events (voids_event_id) where voids_event_id is not null;

-- ── Tier 2 ────────────────────────────────────────────────────────────────
create index if not exists api_keys_org_idx on api_keys (org_id);
create index if not exists api_keys_created_by_idx on api_keys (created_by);
create index if not exists competition_events_actor_idx
  on competition_events (actor_id) where actor_id is not null;
create index if not exists competitions_created_by_idx
  on competitions (created_by) where created_by is not null;
create index if not exists device_links_org_idx on device_links (org_id);
create index if not exists device_links_issued_by_idx
  on device_links (issued_by);
create index if not exists division_checkpoints_created_by_idx
  on division_checkpoints (created_by) where created_by is not null;
create index if not exists division_events_actor_idx
  on division_events (actor_id) where actor_id is not null;
create index if not exists imports_created_by_idx
  on imports (created_by) where created_by is not null;
create index if not exists imports_pin_division_idx
  on imports (pin_division_id) where pin_division_id is not null;
create index if not exists org_invites_created_by_idx
  on org_invites (created_by) where created_by is not null;
create index if not exists organizations_created_by_idx
  on organizations (created_by) where created_by is not null;
create index if not exists impersonation_sessions_target_idx
  on impersonation_sessions (target_id);
create index if not exists scorer_assignments_created_by_idx
  on scorer_assignments (created_by) where created_by is not null;
create index if not exists registrations_offline_paid_by_idx
  on registrations (offline_marked_paid_by) where offline_marked_paid_by is not null;
create index if not exists sport_variants_org_idx
  on sport_variants (org_id) where org_id is not null;

-- ── slug_history primary key ──────────────────────────────────────────────
-- V263 gave it a unique lookup index but no PK (advisor: no_primary_key;
-- replication/dedupe hazard). Surrogate id — the natural key is an
-- expression (coalesce on nullable parent_id), which can't back a PK.
alter table slug_history
  add column if not exists id uuid primary key default gen_random_uuid();
