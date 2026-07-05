-- =============================================================================
-- Seazn Club Tournament Platform — Supabase / PostgreSQL schema (v3)
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
  created_at     timestamptz not null default now(),
  deleted_at     timestamptz,
  purge_after    timestamptz,
  is_staff       boolean not null default false,
  staff_role     text   -- 'support' | 'superadmin'
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
-- Email-change requests: double opt-in when a user changes their address.
-- ---------------------------------------------------------------------------
create table email_change_requests (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users(id) on delete cascade,
  old_email   text not null,
  new_email   text not null,
  token       text not null unique,
  expires_at  timestamptz not null,
  confirmed   boolean not null default false,
  created_at  timestamptz not null default now()
);

create index email_change_requests_user_idx  on email_change_requests(user_id);
create index email_change_requests_token_idx on email_change_requests(token);

-- ---------------------------------------------------------------------------
-- Password reset tokens. Single-use, 1-hour TTL.
-- ---------------------------------------------------------------------------
create table password_resets (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users(id) on delete cascade,
  token       text not null unique,
  expires_at  timestamptz not null,
  used        boolean not null default false,
  created_at  timestamptz not null default now()
);

create index password_resets_user_idx on password_resets(user_id);

-- ---------------------------------------------------------------------------
-- Seasons / series (optional container within an org, e.g. Summer2026).
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

-- =============================================================================
-- Row Level Security (RLS) — tenant isolation
-- =============================================================================
-- The app connects as the `postgres` superuser, which bypasses RLS by default.
-- To enforce policies, `withTenant(orgId)` in db.ts switches the transaction
-- to the `app_user` role (non-superuser) and sets `app.current_org` before
-- any mutation runs. Reads via `loadState`/`loadBundle` stay as superuser
-- since they are already guarded by the API auth layer.
-- =============================================================================

-- Restricted application role (non-superuser so RLS is enforced).
do $$ begin
  if not exists (select from pg_roles where rolname = 'app_user') then
    create role app_user nologin;
  end if;
end $$;

grant usage on schema public to app_user;
grant select, insert, update, delete on all tables in schema public to app_user;
grant usage, select on all sequences in schema public to app_user;

-- Allow the connection role to switch into app_user (required for SET ROLE).
grant app_user to postgres;

-- ---------------------------------------------------------------------------
-- Enable RLS + FORCE on every tenant table.
-- FORCE means even the table owner is subject to policies when acting as
-- app_user (superuser sessions still bypass — that is intentional for migrations).
-- ---------------------------------------------------------------------------
alter table organizations      enable row level security;
alter table organizations      force row level security;
alter table org_members        enable row level security;
alter table org_members        force row level security;
alter table org_invites        enable row level security;
alter table org_invites        force row level security;
alter table org_sport_presets  enable row level security;
alter table org_sport_presets  force row level security;
alter table seasons            enable row level security;
alter table seasons            force row level security;
alter table tournaments        enable row level security;
alter table tournaments        force row level security;
alter table players            enable row level security;
alter table players            force row level security;
alter table rounds             enable row level security;
alter table rounds             force row level security;
alter table matches            enable row level security;
alter table matches            force row level security;
alter table match_events       enable row level security;
alter table match_events       force row level security;
alter table audit_log          enable row level security;
alter table audit_log          force row level security;

-- Helper: extract the current org UUID from the session config, or NULL.
-- Returns NULL (not empty string) when the setting is absent, which causes
-- the USING expression to evaluate to NULL (= no access) rather than error.
create or replace function current_org_id() returns uuid
  language sql stable
  as $$
    select nullif(current_setting('app.current_org', true), '')::uuid
  $$;

-- ---------------------------------------------------------------------------
-- RLS policies for app_user
-- All policies are PERMISSIVE (default). A row is visible/writable if ANY
-- policy allows it. Superuser sessions see everything (bypasses RLS).
-- ---------------------------------------------------------------------------

-- organizations: accessible when it is the active org
create policy orgs_tenant on organizations
  for all to app_user
  using (id = current_org_id())
  with check (id = current_org_id());

-- org_members: accessible when they belong to the active org
create policy org_members_tenant on org_members
  for all to app_user
  using (org_id = current_org_id())
  with check (org_id = current_org_id());

-- org_invites: accessible within the active org
create policy org_invites_tenant on org_invites
  for all to app_user
  using (org_id = current_org_id())
  with check (org_id = current_org_id());

-- org_sport_presets: scoped to active org
create policy org_sport_presets_tenant on org_sport_presets
  for all to app_user
  using (org_id = current_org_id())
  with check (org_id = current_org_id());

-- seasons: scoped to active org
create policy seasons_tenant on seasons
  for all to app_user
  using (org_id = current_org_id())
  with check (org_id = current_org_id());

-- tournaments: scoped to active org
create policy tournaments_tenant on tournaments
  for all to app_user
  using (org_id = current_org_id())
  with check (org_id = current_org_id());

-- players / rounds / matches / match_events / audit_log:
-- denormalize org_id onto these hot tables so the policy is a cheap index scan,
-- not a join. Until that migration lands, use a sub-select to the parent tournament.
create policy players_tenant on players
  for all to app_user
  using (
    tournament_id in (
      select id from tournaments where org_id = current_org_id()
    )
  );

create policy rounds_tenant on rounds
  for all to app_user
  using (
    tournament_id in (
      select id from tournaments where org_id = current_org_id()
    )
  );

create policy matches_tenant on matches
  for all to app_user
  using (
    tournament_id in (
      select id from tournaments where org_id = current_org_id()
    )
  );

create policy match_events_tenant on match_events
  for all to app_user
  using (
    tournament_id in (
      select id from tournaments where org_id = current_org_id()
    )
  );

create policy audit_log_tenant on audit_log
  for all to app_user
  using (
    tournament_id in (
      select id from tournaments where org_id = current_org_id()
    )
  );

-- ---------------------------------------------------------------------------
-- Billing: plans, subscriptions, entitlements
-- Billing tables are accessed via the superuser connection only (not app_user),
-- so no RLS or GRANT to app_user is needed here.
-- ---------------------------------------------------------------------------

alter table organizations
  add column if not exists status      text not null default 'active',
  add column if not exists deleted_at  timestamptz,
  add column if not exists purge_after timestamptz;

create table if not exists plans (
  key                     text primary key,
  name                    text not null,
  stripe_price_id_monthly text,
  stripe_price_id_annual  text,
  is_public               boolean not null default true,
  created_at              timestamptz not null default now()
);

insert into plans (key, name) values
  ('community', 'Community'),
  ('pro',       'Pro')
on conflict (key) do nothing;

create table if not exists subscriptions (
  org_id                  uuid primary key references organizations(id) on delete cascade,
  plan_key                text not null references plans(key) default 'community',
  status                  text not null default 'active',
  stripe_customer_id      text,
  stripe_subscription_id  text,
  current_period_end      timestamptz,
  trial_end               timestamptz,
  cancel_at_period_end    boolean not null default false,
  updated_at              timestamptz not null default now()
);

insert into subscriptions (org_id, plan_key, status)
  select id, 'community', 'active' from organizations
on conflict (org_id) do nothing;

create table if not exists plan_entitlements (
  plan_key    text not null references plans(key),
  feature_key text not null,
  bool_value  boolean,
  int_value   integer,
  primary key (plan_key, feature_key)
);

insert into plan_entitlements (plan_key, feature_key, bool_value, int_value) values
  ('community', 'seasons.max',                null,  5),
  ('community', 'tournaments.per_season.max', null, 10),
  ('community', 'players.max',                null, 32),
  ('community', 'formats.all',                true,  null),
  ('community', 'branding',                   false, null),
  ('community', 'exports',                    false, null),
  ('community', 'realtime',                   false, null),
  ('pro', 'seasons.max',                      null, null),
  ('pro', 'tournaments.per_season.max',       null, null),
  ('pro', 'players.max',                      null, null),
  ('pro', 'formats.all',                      true,  null),
  ('pro', 'branding',                         true,  null),
  ('pro', 'exports',                          true,  null),
  ('pro', 'realtime',                         true,  null)
on conflict (plan_key, feature_key) do nothing;

create table if not exists org_entitlement_overrides (
  org_id      uuid not null references organizations(id) on delete cascade,
  feature_key text not null,
  bool_value  boolean,
  int_value   integer,
  reason      text,
  primary key (org_id, feature_key)
);

create table if not exists billing_events (
  id            text primary key,
  type          text not null,
  org_id        uuid references organizations(id),
  payload       jsonb not null,
  received_at   timestamptz not null default now(),
  processed_at  timestamptz
);

-- ---------------------------------------------------------------------------
-- Email deliverability (migration 004)
-- ---------------------------------------------------------------------------

create table if not exists email_suppressions (
  id           uuid primary key default gen_random_uuid(),
  email        text not null,
  type         text not null check (type in ('bounce', 'complaint', 'manual')),
  provider_id  text,
  created_at   timestamptz not null default now(),
  unique (email)
);

create index if not exists email_suppressions_email_idx on email_suppressions(lower(email));

create table if not exists email_queue (
  id           uuid primary key default gen_random_uuid(),
  to_email     text not null,
  subject      text not null,
  html         text not null,
  text         text not null,
  attempts     int  not null default 0,
  max_attempts int  not null default 3,
  last_error   text,
  scheduled_at timestamptz not null default now(),
  sent_at      timestamptz,
  created_at   timestamptz not null default now()
);

create index if not exists email_queue_pending_idx
  on email_queue(scheduled_at) where sent_at is null;
