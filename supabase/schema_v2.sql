-- =============================================================================
-- schema_v2.sql — Greenfield Engine v2 schema (design doc engine/07 v4)
-- =============================================================================
-- Creates the v2 competition tables ALONGSIDE the v1 tournament tables. v1 is
-- dropped only in PROMPT-15 (app cutover); here the two coexist so the engine
-- can be built and tested without disturbing the running app.
--
-- Applied by scripts/apply-db.ts AFTER schema.sql + all migrations, so it can
-- rely on: the `app_user` role, `current_org_id()`, `organizations`, `users`.
-- Both are (re)created defensively below so this file also applies standalone.
--
-- Conventions (doc 07): every tenant table carries a denormalized, trigger-
-- filled `org_id` + a direct RLS policy `org_id = current_org_id()` (the proven
-- migration 010 pattern). Append-only ledgers (score_events, division_events)
-- carry per-aggregate hash chains (the migration 011 pattern). Idempotent:
-- safe to re-run on a fresh or populated DB.
--
-- DEVIATIONS from doc 07's DDL sketches (documented in the doc itself):
--   * PK expressions `coalesce(org_id, …)` / `coalesce(pool_id, …)` are not
--     valid in a PRIMARY KEY — replaced by STORED generated columns
--     (`org_scope` / `pool_scope`) that the PK references.
--   * `create index … on fixtures(a), fixtures(b)` is not one statement —
--     split into two indexes.
--   * Gapless `seq` is assigned by the persistence adapter under the fixture /
--     division advisory lock (doc 07 note 3), NOT by a trigger; the hash-chain
--     trigger keys the chain per fixture / per division and orders by `seq`
--     (no separate chain_seq needed — seq already linearises the aggregate).
-- =============================================================================

-- Restricted application role (mirrors schema.sql; no-op if already present).
do $$ begin
  if not exists (select from pg_roles where rolname = 'app_user') then
    create role app_user nologin;
  end if;
end $$;

-- Tenant-context accessor (mirrors schema.sql; create-or-replace is idempotent).
create or replace function current_org_id() returns uuid
  language sql stable as $$
    select nullif(current_setting('app.current_org', true), '')::uuid
  $$;

-- =============================================================================
-- Sport catalog (global, seeded by scripts/sync-sports.ts from the engine
-- registry — never hand-edited). `sports` has no org_id: it is global read.
-- =============================================================================
create table if not exists sports (
  key              text primary key,          -- 'cricket','football','volleyball',…
  name             text not null,
  module_version   text not null,             -- latest available; divisions pin their own
  position_catalog jsonb not null,            -- from SportModule.positions
  created_at       timestamptz not null default now()
);

create table if not exists sport_variants (
  sport_key  text not null references sports(key),
  key        text not null,                   -- 't20','odi','beach','blitz'
  name       text not null,
  config     jsonb not null,                  -- validated by module configSchema
  is_system  boolean not null default true,
  org_id     uuid references organizations(id) on delete cascade,  -- null = system preset
  -- DEVIATION: doc 07 sketched `primary key (…, coalesce(org_id, ZERO))`.
  -- A coalesce() expression is illegal in a PK, so we materialise it as a
  -- STORED generated column and key on that. NULL org_id (system presets)
  -- collapses to the zero uuid so (sport_key, key) is unique per scope.
  org_scope  uuid generated always as
             (coalesce(org_id, '00000000-0000-0000-0000-000000000000'::uuid)) stored,
  primary key (sport_key, key, org_scope)
);

-- =============================================================================
-- People & teams (org-scoped, persistent across competitions)
-- =============================================================================
create table if not exists persons (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references organizations(id) on delete cascade,
  full_name    text not null,
  dob          date,                           -- eligibility; NEVER exposed publicly
  gender       text check (gender in ('m','f','x')),
  photo_path   text,
  consent      jsonb not null default '{}',    -- {public_name: bool, public_photo: bool}
  user_id      uuid references users(id) on delete set null,
  external_ref text,
  created_at   timestamptz not null default now()
);
create index if not exists persons_org_idx on persons(org_id);

create table if not exists player_profiles (   -- per-sport attributes, sparse
  person_id  uuid not null references persons(id) on delete cascade,
  sport_key  text not null references sports(key),
  attributes jsonb not null default '{}',
  org_id     uuid not null,
  primary key (person_id, sport_key)
);

create table if not exists teams (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references organizations(id) on delete cascade,
  name       text not null,
  short_name text, logo_path text, colors jsonb,
  created_at timestamptz not null default now()
);

-- =============================================================================
-- Competition → Division → Stage
-- =============================================================================
create table if not exists competitions (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations(id) on delete cascade,
  name        text not null,
  slug        text not null,
  description text,
  starts_on   date, ends_on date,
  visibility  text not null default 'private' check (visibility in ('private','unlisted','public')),
  branding    jsonb not null default '{}',
  status      text not null default 'draft' check (status in ('draft','published','live','completed','archived')),
  created_by  uuid references users(id) on delete set null,
  created_at  timestamptz not null default now(),
  unique (org_id, slug)
);

create table if not exists divisions (
  id             uuid primary key default gen_random_uuid(),
  competition_id uuid not null references competitions(id) on delete cascade,
  org_id         uuid not null,
  name           text not null,
  slug           text not null,
  sport_key      text not null references sports(key),
  variant_key    text not null,
  config         jsonb not null,               -- merged variant + overrides (validated snapshot)
  module_version text not null,                -- PINNED engine module version
  eligibility    jsonb not null default '[]',
  tiebreakers    jsonb,                         -- override cascade; null = sport default
  status         text not null default 'setup' check (status in ('setup','scheduled','active','completed')),
  seq            int not null default 0,        -- division_events watermark
  created_at     timestamptz not null default now(),
  unique (competition_id, slug)
);
-- Doc 12 §1 state machine: 'scheduled' (published timetable, not yet started)
-- sits between setup and active. Re-assert on DBs created before PROMPT-17.
do $$ begin
  if exists (
    select 1 from pg_constraint c
    where c.conname = 'divisions_status_check'
      and pg_get_constraintdef(c.oid) not like '%scheduled%'
  ) then
    alter table divisions drop constraint divisions_status_check;
    alter table divisions add constraint divisions_status_check
      check (status in ('setup','scheduled','active','completed'));
  end if;
end $$;

create table if not exists stages (
  id            uuid primary key default gen_random_uuid(),
  division_id   uuid not null references divisions(id) on delete cascade,
  org_id        uuid not null,
  seq           int  not null,
  kind          text not null check (kind in ('league','group','swiss','knockout','double_elim','stepladder')),
  name          text not null,
  config        jsonb not null default '{}',
  qualification jsonb,
  status        text not null default 'pending' check (status in ('pending','active','complete')),
  unique (division_id, seq)
);

create table if not exists pools (
  id        uuid primary key default gen_random_uuid(),
  stage_id  uuid not null references stages(id) on delete cascade,
  org_id    uuid not null,
  key       text not null,
  name      text not null
);

-- =============================================================================
-- Entrants & rosters
-- =============================================================================
create table if not exists entrants (
  id           uuid primary key default gen_random_uuid(),
  division_id  uuid not null references divisions(id) on delete cascade,
  org_id       uuid not null,
  kind         text not null check (kind in ('team','individual','pair')),
  team_id      uuid references teams(id) on delete set null,
  display_name text not null,
  seed         int,
  status       text not null default 'registered'
               check (status in ('registered','confirmed','withdrawn','disqualified')),
  created_at   timestamptz not null default now()
);
create index if not exists entrants_division_idx on entrants(division_id);

create table if not exists entrant_members (
  entrant_id   uuid not null references entrants(id) on delete cascade,
  person_id    uuid not null references persons(id) on delete cascade,
  org_id       uuid not null,
  squad_number int,
  default_position_key text,
  is_captain   boolean not null default false,
  roles        jsonb not null default '[]',
  primary key (entrant_id, person_id)
);

-- =============================================================================
-- Fixtures
-- =============================================================================
create table if not exists fixtures (
  id                uuid primary key default gen_random_uuid(),
  stage_id          uuid not null references stages(id) on delete cascade,
  division_id       uuid not null,             -- denormalized for cheap queries
  org_id            uuid not null,
  pool_id           uuid references pools(id) on delete set null,
  round_no          int  not null,
  seq_in_round      int  not null,
  home_entrant_id   uuid references entrants(id) on delete set null,   -- null = TBD/bye
  away_entrant_id   uuid references entrants(id) on delete set null,
  winner_to_fixture uuid references fixtures(id) on delete set null,
  winner_to_slot    int check (winner_to_slot in (1,2)),
  loser_to_fixture  uuid references fixtures(id) on delete set null,
  loser_to_slot     int check (loser_to_slot in (1,2)),
  parent_fixture_id uuid references fixtures(id) on delete cascade,
  scheduled_at      timestamptz, venue text, court_label text,
  officials         jsonb not null default '[]',
  status            text not null default 'scheduled' check (status in
                    ('scheduled','in_play','decided','finalized','abandoned','forfeited','cancelled')),
  outcome           jsonb,                     -- MatchOutcome, written when decided
  created_at        timestamptz not null default now()
);
-- Generator identity (doc 08 §3 "generate # fixtures (idempotent, returns
-- diff)"): the pure scheduling layer emits stable fixture ids ('rr-r1-c2',
-- 'wb-r0-g1', …); persisting them lets regeneration upsert instead of
-- duplicate, and lets winner/loser feeds be wired by key. Null for manually
-- created fixtures.
alter table fixtures add column if not exists ext_key text;
create unique index if not exists fixtures_stage_ext_key_idx
  on fixtures(stage_id, ext_key) where ext_key is not null;

-- Scheduling provenance (doc 12 §3, PROMPT-17): where the assignment came
-- from ('manual' = hand-placed/pinned) and whether it is locked against
-- re-running the auto pass.
alter table fixtures add column if not exists schedule_source text not null default 'none';
alter table fixtures add column if not exists schedule_locked boolean not null default false;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'fixtures_schedule_source_check') then
    alter table fixtures add constraint fixtures_schedule_source_check
      check (schedule_source in ('none','auto','manual'));
  end if;
end $$;

create index if not exists fixtures_stage_idx    on fixtures(stage_id, round_no, seq_in_round);
create index if not exists fixtures_division_idx on fixtures(division_id, scheduled_at);
-- DEVIATION: doc 07 sketched one statement with two table refs — illegal.
create index if not exists fixtures_home_idx on fixtures(home_entrant_id);
create index if not exists fixtures_away_idx on fixtures(away_entrant_id);

create table if not exists lineups (
  fixture_id   uuid not null references fixtures(id) on delete cascade,
  entrant_id   uuid not null references entrants(id) on delete cascade,
  person_id    uuid not null references persons(id) on delete cascade,
  org_id       uuid not null,
  slot         text not null default 'starting' check (slot in ('starting','bench')),
  position_key text,
  order_no     int,
  roles        jsonb not null default '[]',
  primary key (fixture_id, entrant_id, person_id)
);

-- =============================================================================
-- Event ledger (source of truth) — hash-chained per fixture
-- =============================================================================
create table if not exists score_events (
  id             uuid primary key default gen_random_uuid(),
  fixture_id     uuid not null references fixtures(id) on delete cascade,
  org_id         uuid not null,
  seq            int  not null,                -- gapless per fixture (adapter-assigned)
  type           text not null,               -- 'cricket.ball','core.void',…
  payload        jsonb not null,
  recorded_by    uuid references users(id) on delete set null,
  recorded_at    timestamptz not null default now(),
  voids_event_id uuid references score_events(id),
  prev_hash      text, row_hash text,          -- tamper-evident chain (per fixture)
  unique (fixture_id, seq)
);
create index if not exists score_events_fixture_idx on score_events(fixture_id, seq);

create table if not exists match_states (       -- disposable cache = fold(score_events)
  fixture_id uuid primary key references fixtures(id) on delete cascade,
  org_id     uuid not null,
  last_seq   int  not null,
  state      jsonb not null,
  summary    jsonb not null,
  updated_at timestamptz not null default now()
);

-- =============================================================================
-- Derived standings & structural ledger
-- =============================================================================
create table if not exists standings_snapshots (
  stage_id             uuid not null references stages(id) on delete cascade,
  pool_id              uuid,                    -- null for non-pool stages
  org_id               uuid not null,
  rows                 jsonb not null,          -- ordered StandingsRow[]
  computed_through_seq bigint not null,
  updated_at           timestamptz not null default now(),
  -- DEVIATION: doc 07 sketched `primary key (stage_id, coalesce(pool_id, ZERO))`.
  -- Same coalesce-in-PK problem as sport_variants; materialise as a generated
  -- column and key on that.
  pool_scope           uuid generated always as
                       (coalesce(pool_id, '00000000-0000-0000-0000-000000000000'::uuid)) stored,
  primary key (stage_id, pool_scope)
);

-- Per-division scheduling settings (doc 12 §3, PROMPT-17). config carries
-- startAt, matchMinutes, gapMinutes, courts[], perEntrantMinRest, blackouts[],
-- sessionWindows[]; tz is the venue-local zone (doc 12 §6 — DST boundaries).
create table if not exists schedule_settings (
  division_id uuid primary key references divisions(id) on delete cascade,
  org_id      uuid not null,
  config      jsonb not null default '{}',
  tz          text not null default 'UTC',
  updated_at  timestamptz not null default now()
);

create table if not exists division_events (    -- structural ledger, hash-chained per division
  id          uuid primary key default gen_random_uuid(),
  division_id uuid not null references divisions(id) on delete cascade,
  org_id      uuid not null,
  seq         bigint not null,                 -- gapless per division (adapter-assigned)
  type        text not null,
  payload     jsonb not null,
  actor_id    uuid references users(id) on delete set null,
  created_at  timestamptz not null default now(),
  prev_hash   text, row_hash text,
  unique (division_id, seq)
);

-- =============================================================================
-- API keys (doc 08)
-- =============================================================================
-- Entitlement gate for the platform API (doc 08 §2): Pro only. Idempotent
-- seed alongside the existing plan matrix (schema.sql seeds the rest); guarded
-- so this file still applies standalone (without schema.sql's billing tables).
do $$ begin
  if exists (select from pg_tables where schemaname = 'public' and tablename = 'plan_entitlements') then
    insert into plan_entitlements (plan_key, feature_key, bool_value, int_value) values
      ('community', 'api.access', false, null),
      ('pro',       'api.access', true,  null)
    on conflict (plan_key, feature_key) do nothing;
  end if;
end $$;

create table if not exists api_keys (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references organizations(id) on delete cascade,
  name         text not null,
  key_hash     text not null unique,
  scopes       jsonb not null default '["read"]',
  last_used_at timestamptz, revoked_at timestamptz,
  created_by   uuid references users(id) on delete set null,
  created_at   timestamptz not null default now()
);

-- =============================================================================
-- org_id trigger — one GENERIC set_org_from_parent() (doc 07 note 1).
-- Passed (parent_table, fk_column) via TG_ARGV. SECURITY INVOKER (default): the
-- parent lookup runs under the caller's RLS, so a child row pointed at a parent
-- in another tenant finds no parent, leaves org_id null, and the policy's
-- WITH CHECK then rejects it (same guarantee as migration 010).
-- =============================================================================
create or replace function set_org_from_parent() returns trigger
  language plpgsql as $$
declare
  parent_table text := tg_argv[0];
  fk_column    text := tg_argv[1];
  fk_value     uuid;
  parent_org   uuid;
begin
  if new.org_id is not null then return new; end if;
  -- Extract the FK value generically (avoids dynamic composite-field access).
  fk_value := (to_jsonb(new) ->> fk_column)::uuid;
  if fk_value is null then return new; end if;
  execute format('select org_id from %I where id = $1', parent_table)
    into parent_org using fk_value;
  new.org_id := parent_org;
  return new;
end $$;

do $$
declare
  spec text[];
  specs text[][] := array[
    array['divisions',          'competitions', 'competition_id'],
    array['stages',             'divisions',    'division_id'],
    array['pools',              'stages',       'stage_id'],
    array['entrants',           'divisions',    'division_id'],
    array['entrant_members',    'entrants',     'entrant_id'],
    array['fixtures',           'stages',       'stage_id'],
    array['lineups',            'fixtures',     'fixture_id'],
    array['score_events',       'fixtures',     'fixture_id'],
    array['match_states',       'fixtures',     'fixture_id'],
    array['standings_snapshots','stages',       'stage_id'],
    array['division_events',    'divisions',    'division_id'],
    array['player_profiles',    'persons',      'person_id'],
    array['schedule_settings',  'divisions',    'division_id']
  ];
begin
  foreach spec slice 1 in array specs loop
    execute format('drop trigger if exists trg_set_org on %I', spec[1]);
    execute format(
      'create trigger trg_set_org before insert on %I
         for each row execute function set_org_from_parent(%L, %L)',
      spec[1], spec[2], spec[3]);
  end loop;
end $$;

-- =============================================================================
-- Hash chains (migration 011 pattern, re-keyed per aggregate).
-- score_events chains PER FIXTURE, division_events PER DIVISION. The append is
-- already serialised per aggregate by the adapter's advisory lock (doc 07 note
-- 2), and `seq` is gapless within the aggregate, so the chain simply links rows
-- in seq order — no separate chain_seq / advisory lock in the trigger.
-- =============================================================================
create or replace function v2_row_hash(prev text, canonical text) returns text
  language sql immutable as $$
    select encode(sha256(convert_to(coalesce(prev, '') || '|' || canonical, 'utf8')), 'hex')
  $$;

-- score_events chain (before insert; fires after trg_set_org — 'z' sorts last).
create or replace function score_events_hash_chain() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
declare prev text; canonical text;
begin
  select row_hash into prev from score_events
    where fixture_id = new.fixture_id order by seq desc limit 1;
  canonical := concat_ws('|',
    new.id::text, new.fixture_id::text, new.seq::text, new.type,
    new.payload::text, coalesce(new.voids_event_id::text, ''),
    coalesce(new.recorded_by::text, ''), new.recorded_at::text);
  new.prev_hash := prev;
  new.row_hash  := v2_row_hash(prev, canonical);
  return new;
end $$;

drop trigger if exists trg_zhash on score_events;
create trigger trg_zhash before insert on score_events
  for each row execute function score_events_hash_chain();

-- division_events chain
create or replace function division_events_hash_chain() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
declare prev text; canonical text;
begin
  select row_hash into prev from division_events
    where division_id = new.division_id order by seq desc limit 1;
  canonical := concat_ws('|',
    new.id::text, new.division_id::text, new.seq::text, new.type,
    new.payload::text, coalesce(new.actor_id::text, ''), new.created_at::text);
  new.prev_hash := prev;
  new.row_hash  := v2_row_hash(prev, canonical);
  return new;
end $$;

drop trigger if exists trg_zhash on division_events;
create trigger trg_zhash before insert on division_events
  for each row execute function division_events_hash_chain();

-- Verifiers: return the id of the first row (in seq order) whose recomputed
-- hash or prev-link doesn't match; null = chain intact.
create or replace function verify_score_events_chain(p_fixture uuid) returns uuid
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare r score_events%rowtype; expect_prev text := null; canonical text;
begin
  for r in select * from score_events where fixture_id = p_fixture order by seq loop
    if r.prev_hash is distinct from expect_prev then return r.id; end if;
    canonical := concat_ws('|',
      r.id::text, r.fixture_id::text, r.seq::text, r.type,
      r.payload::text, coalesce(r.voids_event_id::text, ''),
      coalesce(r.recorded_by::text, ''), r.recorded_at::text);
    if r.row_hash is distinct from v2_row_hash(r.prev_hash, canonical) then return r.id; end if;
    expect_prev := r.row_hash;
  end loop;
  return null;
end $$;

create or replace function verify_division_events_chain(p_division uuid) returns uuid
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare r division_events%rowtype; expect_prev text := null; canonical text;
begin
  for r in select * from division_events where division_id = p_division order by seq loop
    if r.prev_hash is distinct from expect_prev then return r.id; end if;
    canonical := concat_ws('|',
      r.id::text, r.division_id::text, r.seq::text, r.type,
      r.payload::text, coalesce(r.actor_id::text, ''), r.created_at::text);
    if r.row_hash is distinct from v2_row_hash(r.prev_hash, canonical) then return r.id; end if;
    expect_prev := r.row_hash;
  end loop;
  return null;
end $$;

-- =============================================================================
-- Row-Level Security — every tenant table: enable + force + direct policy.
-- =============================================================================
do $$
declare tbl text;
begin
  foreach tbl in array array[
    'sport_variants','persons','player_profiles','teams','competitions',
    'divisions','stages','pools','entrants','entrant_members','fixtures',
    'lineups','score_events','match_states','standings_snapshots',
    'division_events','api_keys','schedule_settings'
  ] loop
    execute format('alter table %I enable row level security', tbl);
    execute format('alter table %I force  row level security', tbl);
  end loop;
end $$;

-- sport_variants: system presets (org_id null) are world-readable to any
-- tenant; org variants are private. Writes are always org-scoped.
drop policy if exists sport_variants_tenant on sport_variants;
create policy sport_variants_tenant on sport_variants for all to app_user
  using (org_id is null or org_id = current_org_id())
  with check (org_id = current_org_id());

-- sports: global catalog, read-only for tenants (writes come from the
-- superuser sync script). RLS intentionally stays OFF here, but hosted
-- consoles (Supabase's "enable RLS" lint) may flip it on — the explicit read
-- policy keeps the catalog visible to app_user either way.
drop policy if exists sports_read on sports;
create policy sports_read on sports for select to app_user using (true);

-- Every other tenant table: the plain migration-010 direct policy.
do $$
declare tbl text;
begin
  foreach tbl in array array[
    'persons','player_profiles','teams','competitions','divisions','stages',
    'pools','entrants','entrant_members','fixtures','lineups','score_events',
    'match_states','standings_snapshots','division_events','api_keys',
    'schedule_settings'
  ] loop
    execute format('drop policy if exists %I on %I', tbl || '_tenant', tbl);
    execute format(
      'create policy %I on %I for all to app_user
         using (org_id = current_org_id()) with check (org_id = current_org_id())',
      tbl || '_tenant', tbl);
  end loop;
end $$;

-- =============================================================================
-- Public read model (doc 06 §4.7, doc 07 note 4, doc 09). Views are owned by
-- the migration superuser, so they bypass RLS and can serve unauthenticated
-- public dashboard reads across all orgs — but they expose ONLY
-- visibility in ('public','unlisted') data (doc 09 §1: unlisted = link-only,
-- rendered with noindex; private = 404 — the views simply never return it),
-- and person data is consent-filtered: initials when name consent is absent,
-- no DOB ever, photos only when consented.
-- =============================================================================

-- Entitlement check usable inside the public views (doc 10 §2 rule 3: public
-- read features are enforced at the view layer, never client-side). Mirrors
-- lib/entitlements.ts resolution: org override → plan entitlement → deny.
create or replace function org_has_feature(p_org_id uuid, p_feature_key text)
  returns boolean language sql stable as $$
    select coalesce(
      (select bool_value from org_entitlement_overrides
        where org_id = p_org_id and feature_key = p_feature_key),
      (select pe.bool_value from plan_entitlements pe
        where pe.feature_key = p_feature_key
          and pe.plan_key = coalesce(
            (select s.plan_key from subscriptions s where s.org_id = p_org_id),
            'community')),
      false)
  $$;

-- Consent-safe display name: full name only with explicit public_name consent,
-- otherwise initials ('John Smith' → 'J.S.'). Never leaks the full name.
create or replace function public_person_name(full_name text, consent jsonb) returns text
  language sql immutable as $$
    select case
      when coalesce((consent->>'public_name')::boolean, false) then full_name
      else (
        select string_agg(left(word, 1) || '.', '')
        from regexp_split_to_table(trim(full_name), '\s+') as word
        where word <> ''
      )
    end
  $$;

-- Branding is a Pro read feature (doc 10 §1, key `dashboard.branding` since
-- PROMPT-13) — nulled here, server-side, for non-entitled orgs. `visibility`
-- rides along so pages can render unlisted competitions with a noindex meta
-- and keep them out of the sitemap.
create or replace view public_competitions_v as
  select id, org_id, name, slug, description, starts_on, ends_on,
         case when org_has_feature(org_id, 'dashboard.branding') then branding
              else '{}'::jsonb end as branding,
         status, created_at, visibility
  from competitions
  where visibility in ('public','unlisted');

-- Divisions of public competitions (doc 08 §3 public competition detail).
-- module_version lets the dashboard resolve the pinned SportModule for
-- MetricSpec-driven standings columns (doc 09 §2 — zero per-sport UI code).
create or replace view public_divisions_v as
  select d.id, d.competition_id, d.name, d.slug, d.sport_key, d.variant_key,
         d.status, d.created_at, d.module_version, d.tiebreakers
  from divisions d
  join competitions c on c.id = d.competition_id
  where c.visibility in ('public','unlisted');

-- `summary` (render-agnostic score lines from the fold cache) rides along for
-- the live public fixture endpoint — it never contains person data.
-- Timetable fields are PUBLISH-GATED (doc 12 §1/PROMPT-17): while a division
-- is still in setup (plan-first draft, timetable not yet published) the
-- public read model nulls scheduled_at/venue/court_label, so the schedule tab
-- and .ics show nothing an organiser has not published. publish-schedule
-- moves the division to 'scheduled' (quick-start moves straight to 'active'),
-- which lights the fields up.
create or replace view public_fixtures_v as
  select f.id, f.division_id, f.stage_id, f.pool_id, f.round_no, f.seq_in_round,
         f.home_entrant_id, f.away_entrant_id,
         case when d.status = 'setup' then null else f.scheduled_at end as scheduled_at,
         case when d.status = 'setup' then null else f.venue end        as venue,
         case when d.status = 'setup' then null else f.court_label end as court_label,
         f.status, f.outcome, f.created_at,
         m.summary, m.last_seq
  from fixtures f
  left join match_states m on m.fixture_id = f.id
  join divisions d    on d.id = f.division_id
  join competitions c on c.id = d.competition_id
  where c.visibility in ('public','unlisted');

-- Stage skeleton (kind drives table vs bracket vs ladder rendering, doc 09 §2).
create or replace view public_stages_v as
  select st.id, st.division_id, st.seq, st.kind, st.name, st.status
  from stages st
  join divisions d    on d.id = st.division_id
  join competitions c on c.id = d.competition_id
  where c.visibility in ('public','unlisted');

create or replace view public_pools_v as
  select p.id, p.stage_id, p.key, p.name
  from pools p
  join stages st      on st.id = p.stage_id
  join divisions d    on d.id = st.division_id
  join competitions c on c.id = d.competition_id
  where c.visibility in ('public','unlisted');

create or replace view public_standings_v as
  select s.stage_id, s.pool_id, s.rows, s.updated_at, d.id as division_id
  from standings_snapshots s
  join stages st      on st.id = s.stage_id
  join divisions d    on d.id = st.division_id
  join competitions c on c.id = d.competition_id
  where c.visibility in ('public','unlisted');

-- Entrants with consent-filtered member data (individual/pair entrants expose
-- people; teams expose only the team display). No DOB; photos only if consented.
-- `person_id` is exposed ONLY with public_name consent: it is the link target
-- for the player card, and the card 404s without that consent (doc 06 §4.7) —
-- so a roster row without consent gets initials and no link.
-- Photos and player-card links are additionally Pro read features
-- (doc 10 §1 `dashboard.player_profiles`, PROMPT-13): consent makes them
-- publishable, the entitlement makes them published.
create or replace view public_entrants_v as
  select e.id, e.division_id, e.kind, e.display_name, e.seed, e.status,
         coalesce(
           (select jsonb_agg(jsonb_build_object(
              'name',  public_person_name(p.full_name, p.consent),
              'photo', case when coalesce((p.consent->>'public_photo')::boolean, false)
                             and org_has_feature(c.org_id, 'dashboard.player_profiles')
                            then p.photo_path else null end,
              'person_id', case when coalesce((p.consent->>'public_name')::boolean, false)
                                 and org_has_feature(c.org_id, 'dashboard.player_profiles')
                                then p.id else null end,
              'squad_number', em.squad_number,
              'position', em.default_position_key)
              order by em.squad_number nulls last, p.full_name)
            from entrant_members em
            join persons p on p.id = em.person_id
            where em.entrant_id = e.id),
           '[]'::jsonb) as members
  from entrants e
  join divisions d    on d.id = e.division_id
  join competitions c on c.id = d.competition_id
  where c.visibility in ('public','unlisted')
    and e.status in ('registered','confirmed');

-- Player card source (doc 09 §2): only persons who (a) gave public_name
-- consent AND (b) are rostered in an entrant of a publicly visible
-- competition AND (c) whose org holds `dashboard.player_profiles`
-- (doc 10 §1, PROMPT-13). Everyone else simply does not exist here — the
-- card 404s.
create or replace view public_players_v as
  select p.id, p.org_id, p.full_name as name,
         case when coalesce((p.consent->>'public_photo')::boolean, false)
              then p.photo_path else null end as photo
  from persons p
  where coalesce((p.consent->>'public_name')::boolean, false)
    and org_has_feature(p.org_id, 'dashboard.player_profiles')
    and exists (
      select 1 from entrant_members em
      join entrants e     on e.id = em.entrant_id
      join divisions d    on d.id = e.division_id
      join competitions c on c.id = d.competition_id
      where em.person_id = p.id
        and c.visibility in ('public','unlisted')
        and e.status in ('registered','confirmed'));

-- =============================================================================
-- Grants — re-grant across all tables/sequences so the v2 tables (created after
-- schema.sql's grant ran) are reachable by app_user under RLS. Views are
-- granted read to app_user; they are also readable by the superuser API path.
-- =============================================================================
grant usage on schema public to app_user;
grant select, insert, update, delete on all tables in schema public to app_user;
grant usage, select on all sequences in schema public to app_user;
grant app_user to postgres;
grant select on public_competitions_v, public_divisions_v, public_fixtures_v,
                public_standings_v, public_entrants_v, public_players_v,
                public_stages_v, public_pools_v to app_user;

-- Doc 10 §1 public-dashboard quota (PROMPT-12 item 7; the full v2 matrix is
-- seeded by migrations/012_entitlements_v2.sql, which apply-db runs BEFORE
-- this file): Community may hold 1 public competition at a time, Pro unlimited.
insert into plan_entitlements (plan_key, feature_key, bool_value, int_value) values
  ('community', 'dashboard.public.max', null, 1),
  ('pro',       'dashboard.public.max', null, null)
on conflict (plan_key, feature_key) do nothing;

-- Doc 12 §5 scheduling matrix (PROMPT-17; scheduling.constraints seeded by
-- 012): board editing is Pro (Community renders it view-only), the
-- competition-wide multi-division board is Pro.
insert into plan_entitlements (plan_key, feature_key, bool_value, int_value) values
  ('community', 'scheduling.board',          false, null),
  ('pro',       'scheduling.board',          true,  null),
  ('business',  'scheduling.board',          true,  null),
  ('community', 'scheduling.multi_division', false, null),
  ('pro',       'scheduling.multi_division', true,  null),
  ('business',  'scheduling.multi_division', true,  null)
on conflict (plan_key, feature_key) do nothing;
