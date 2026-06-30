-- =============================================================================
-- S.A.F.E Tournament Platform — Supabase / PostgreSQL schema (v3)
-- =============================================================================
-- How to use:
--   1. Open your Supabase project -> SQL Editor -> New query.
--   2. Paste this whole file and run it.
--   3. Copy the connection string into .env.local as DATABASE_URL.
--
-- Re-running is safe: it drops and recreates the schema objects.
-- v3 adds multi-tenant organizations ("boards"), memberships with roles
-- (owner | admin | viewer), shareable invite links, email/password +
-- Google OAuth users, and scopes seasons + tournaments to an organization.
-- =============================================================================

create extension if not exists "pgcrypto";

drop table if exists audit_log cascade;
drop table if exists match_events cascade;
drop table if exists matches cascade;
drop table if exists rounds cascade;
drop table if exists players cascade;
drop table if exists tournaments cascade;
drop table if exists seasons cascade;
drop table if exists org_sport_presets cascade;
drop table if exists org_invites cascade;
drop table if exists org_members cascade;
drop table if exists organizations cascade;
drop table if exists email_verifications cascade;
drop table if exists users cascade;
drop table if exists groups cascade; -- legacy name from v1

-- ---------------------------------------------------------------------------
-- Users.
--   password_hash : bcrypt hash; null for accounts created via Google OAuth.
--   email         : optional; used to link a Google login to an account.
--   google_sub    : Google's stable subject id (set when linked via OAuth).
-- ---------------------------------------------------------------------------
create table users (
  id             uuid primary key default gen_random_uuid(),
  email          text not null unique,
  password_hash  text,
  display_name   text not null,
  email_verified boolean not null default false,
  google_sub     text unique,
  avatar_url     text,
  created_at     timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Email verification tokens for email/password sign-ups. A token is
-- consumed (deleted) when the link is opened; Google logins skip this.
-- ---------------------------------------------------------------------------
create table email_verifications (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users(id) on delete cascade,
  token       text not null unique,
  expires_at  timestamptz not null,
  created_at  timestamptz not null default now()
);

create index email_verifications_user_idx on email_verifications(user_id);

-- ---------------------------------------------------------------------------
-- Organizations — a "board" that owns seasons and tournaments. A user creates
-- one and becomes its owner; others join via invite with a role.
-- ---------------------------------------------------------------------------
create table organizations (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  slug        text not null unique,
  created_by  uuid references users(id) on delete set null,
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Membership of a user in an organization.
--   role: 'owner' | 'admin' | 'viewer'
-- ---------------------------------------------------------------------------
create table org_members (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations(id) on delete cascade,
  user_id     uuid not null references users(id) on delete cascade,
  role        text not null default 'viewer',
  created_at  timestamptz not null default now(),
  unique (org_id, user_id)
);

create index org_members_user_idx on org_members(user_id);
create index org_members_org_idx  on org_members(org_id);

-- ---------------------------------------------------------------------------
-- Shareable invite links. A logged-in user opens /join/<token> to join the
-- org with the embedded role.
--   max_uses   : 0 = unlimited, otherwise the link expires after N joins.
--   expires_at : optional absolute expiry.
-- ---------------------------------------------------------------------------
create table org_invites (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations(id) on delete cascade,
  role        text not null default 'viewer',
  token       text not null unique,
  created_by  uuid references users(id) on delete set null,
  expires_at  timestamptz,
  max_uses    int  not null default 1,
  used_count  int  not null default 0,
  revoked     boolean not null default false,
  created_at  timestamptz not null default now()
);

create index org_invites_org_idx on org_invites(org_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Seasons / series (optional container within an org, e.g. SAFE2026).
-- ---------------------------------------------------------------------------
create table seasons (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations(id) on delete cascade,
  name        text not null,
  slug        text not null,
  created_at  timestamptz not null default now(),
  unique (org_id, slug)
);

create index seasons_org_idx on seasons(org_id);

-- ---------------------------------------------------------------------------
-- Per-organization sport presets — default tournament settings per sport.
-- Seeded when an org is created; editors customize in Settings.
-- ---------------------------------------------------------------------------
create table org_sport_presets (
  id                   uuid primary key default gen_random_uuid(),
  org_id               uuid not null references organizations(id) on delete cascade,
  sport_key            text not null,
  sport_name           text not null,
  entity_label         text not null default 'Players',
  format               text not null default 'swiss_knockout',
  result_mode          text not null default 'win_loss',
  score_label          text not null default 'Score',
  points_win           int  not null default 1,
  points_draw          int  not null default 0,
  points_loss          int  not null default 0,
  allow_draws          boolean not null default false,
  use_progress_score   boolean not null default false,
  round_minutes        int  not null default 30,
  clock_minutes        int  not null default 0,
  default_category     text not null default 'adult',
  default_group_rounds int,
  default_knockout_size int,
  is_system            boolean not null default false,
  sort_order           int  not null default 0,
  created_at           timestamptz not null default now(),
  unique (org_id, sport_key)
);

create index org_sport_presets_org_idx on org_sport_presets(org_id, sort_order);

-- ---------------------------------------------------------------------------
-- Tournaments.
--   org_id    : owning organization (required).
--   season_id : optional link to a season/series.
--   format    : 'swiss_knockout' | 'progress_stepladder' | 'knockout' | 'round_robin'
--   category  : 'kids' | 'adult' | 'open'
--   status    : 'setup' | 'group' | 'knockout' | 'final' | 'completed'
--   result_mode: 'win_loss' (tap a winner) | 'score' (enter scores)
--   use_progress_score: chess-style round-by-round streak score
-- ---------------------------------------------------------------------------
create table tournaments (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null references organizations(id) on delete cascade,
  season_id          uuid references seasons(id) on delete set null,
  created_by         uuid references users(id) on delete set null,
  sport              text not null,
  name               text not null,
  category           text not null default 'open',
  format             text not null default 'swiss_knockout',
  num_group_rounds   int  not null default 3,
  knockout_size      int  not null default 4,
  status             text not null default 'setup',
  undo_remaining     int  not null default 3,
  -- scoring configuration
  result_mode        text not null default 'win_loss',
  score_label        text not null default 'Score',
  points_win         int  not null default 1,
  points_draw        int  not null default 0,
  points_loss        int  not null default 0,
  allow_draws        boolean not null default false,
  use_progress_score boolean not null default false,
  -- scheduling
  starts_at          timestamptz,
  round_minutes      int  not null default 30,
  clock_minutes      int  not null default 0, -- per-player match clock (0 = off)
  created_at         timestamptz not null default now()
);

create index tournaments_org_idx    on tournaments(org_id);
create index tournaments_season_idx on tournaments(season_id);

-- ---------------------------------------------------------------------------
-- Players / teams participating in a tournament.
-- ---------------------------------------------------------------------------
create table players (
  id              uuid primary key default gen_random_uuid(),
  tournament_id   uuid not null references tournaments(id) on delete cascade,
  name            text not null,
  seed            int  not null default 0,
  checked_in      boolean not null default true,
  image_url       text, -- optional logo / flag / photo (URL or data URI)
  created_at      timestamptz not null default now()
);

create index players_tournament_idx on players(tournament_id);

-- ---------------------------------------------------------------------------
-- Rounds.   stage: 'group' | 'playoff' | 'knockout' | 'final'
-- ---------------------------------------------------------------------------
create table rounds (
  id              uuid primary key default gen_random_uuid(),
  tournament_id   uuid not null references tournaments(id) on delete cascade,
  round_number    int  not null,
  stage           text not null default 'group',
  name            text not null,
  status          text not null default 'active',
  created_at      timestamptz not null default now()
);

create index rounds_tournament_idx on rounds(tournament_id);

-- ---------------------------------------------------------------------------
-- Matches.
-- ---------------------------------------------------------------------------
create table matches (
  id              uuid primary key default gen_random_uuid(),
  tournament_id   uuid not null references tournaments(id) on delete cascade,
  round_id        uuid not null references rounds(id) on delete cascade,
  board_number    int  not null default 1,
  player1_id      uuid references players(id) on delete set null,
  player2_id      uuid references players(id) on delete set null,
  winner_id       uuid references players(id) on delete set null,
  loser_id        uuid references players(id) on delete set null,
  player1_score   int,
  player2_score   int,
  is_draw         boolean not null default false,
  next_match_id   uuid references matches(id) on delete set null,
  next_slot       int,
  is_bye          boolean not null default false,
  status          text not null default 'ready',
  label           text,
  created_at      timestamptz not null default now()
);

create index matches_tournament_idx on matches(tournament_id);
create index matches_round_idx on matches(round_id);

-- ---------------------------------------------------------------------------
-- Event log for undo / reset (JSON snapshots of state before each action).
-- ---------------------------------------------------------------------------
create table match_events (
  id              uuid primary key default gen_random_uuid(),
  tournament_id   uuid not null references tournaments(id) on delete cascade,
  seq             int  not null,
  action          text not null,
  before_state    jsonb not null,
  undone          boolean not null default false,
  created_at      timestamptz not null default now()
);

create index match_events_tournament_idx on match_events(tournament_id, seq);

-- ---------------------------------------------------------------------------
-- Audit log: a human-readable record of every action (create, start,
-- record result, undo, reset, check-in). Survives undo/reset so the full
-- history is always available.
-- ---------------------------------------------------------------------------
create table audit_log (
  id              uuid primary key default gen_random_uuid(),
  tournament_id   uuid references tournaments(id) on delete cascade,
  actor           text,           -- organiser display name (null = system)
  action          text not null,  -- create|start|record_result|undo|reset|checkin
  summary         text not null,  -- human-readable description
  detail          jsonb,          -- structured payload
  created_at      timestamptz not null default now()
);

create index audit_log_tournament_idx on audit_log(tournament_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Seed data is created by scripts/apply-schema.ts (it hashes the demo
-- password with bcrypt and wires up a demo organization + owner membership).
-- ---------------------------------------------------------------------------
