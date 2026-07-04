# 07 — Greenfield PostgreSQL Schema (v4)

Replaces `supabase/schema.sql` tournament tables entirely (greenfield license). Retained
unchanged: `users`, `organizations`, `org_members`, `org_invites`, auth/email tables,
billing tables (`plans`, `subscriptions`, `plan_entitlements`, `org_entitlement_overrides`,
`billing_events`), `rate_limit_buckets`, storage columns, staff/admin tables. Dropped:
`seasons`, `tournaments`, `players`, `rounds`, `matches`, `match_events`, `audit_log`
(replaced by ledger + division events), `org_sport_presets` (replaced by variants/templates).

Conventions: every tenant table carries `org_id` (denormalized, trigger-filled — the
proven 010 pattern) + direct RLS policy `org_id = current_org_id()` to `app_user`,
enable+force RLS. All ids `uuid default gen_random_uuid()`. Timestamps `timestamptz`.
CHECK-constrained text enums (cheap to extend, still validated).

```sql
-- ── Sport catalog (global, seeded by engine registry sync) ──────────────────
create table sports (
  key            text primary key,          -- 'cricket','football','volleyball',...
  name           text not null,
  module_version text not null,             -- latest available; divisions pin their own
  position_catalog jsonb not null,          -- from SportModule.positions
  created_at     timestamptz not null default now()
);

create table sport_variants (
  sport_key  text not null references sports(key),
  key        text not null,                 -- 't20','odi','beach','blitz'
  name       text not null,
  config     jsonb not null,                -- validated by module configSchema
  is_system  boolean not null default true,
  org_id     uuid references organizations(id) on delete cascade,  -- null = system preset
  primary key (sport_key, key, coalesce(org_id, '00000000-0000-0000-0000-000000000000'::uuid))
);

-- ── People & teams (org-scoped, persistent across competitions) ─────────────
create table persons (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations(id) on delete cascade,
  full_name   text not null,
  dob         date,                          -- eligibility; NEVER exposed publicly
  gender      text check (gender in ('m','f','x')),
  photo_path  text,
  consent     jsonb not null default '{}',   -- {public_name: bool, public_photo: bool} — minors default false
  user_id     uuid references users(id) on delete set null,   -- optional self-service link
  external_ref text,                         -- federation id, school id
  created_at  timestamptz not null default now()
);
create index persons_org_idx on persons(org_id);

create table player_profiles (               -- per-sport attributes, sparse
  person_id  uuid not null references persons(id) on delete cascade,
  sport_key  text not null references sports(key),
  attributes jsonb not null default '{}',    -- {batting:'RHB', bowling:'leg-spin'} / {preferred_position:'CM'}
  org_id     uuid not null,
  primary key (person_id, sport_key)
);

create table teams (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references organizations(id) on delete cascade,
  name       text not null,
  short_name text, logo_path text, colors jsonb,
  created_at timestamptz not null default now()
);

-- ── Competition → Division → Stage ──────────────────────────────────────────
create table competitions (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations(id) on delete cascade,
  name        text not null,
  slug        text not null,                 -- public dashboard URL part
  description text,                          -- markdown, shown on open dashboard
  starts_on   date, ends_on   date,
  visibility  text not null default 'private' check (visibility in ('private','unlisted','public')),
  branding    jsonb not null default '{}',   -- Pro: theme, banner, sponsor logos
  status      text not null default 'draft' check (status in ('draft','published','live','completed','archived')),
  created_by  uuid references users(id) on delete set null,
  created_at  timestamptz not null default now(),
  unique (org_id, slug)
);

create table divisions (
  id             uuid primary key default gen_random_uuid(),
  competition_id uuid not null references competitions(id) on delete cascade,
  org_id         uuid not null,
  name           text not null,              -- 'U16 Boys T20'
  slug           text not null,
  sport_key      text not null references sports(key),
  variant_key    text not null,
  config         jsonb not null,             -- merged variant + overrides (validated snapshot)
  module_version text not null,              -- PINNED engine module version
  eligibility    jsonb not null default '[]',-- EligibilityRule[] (doc 06)
  tiebreakers    jsonb,                      -- override cascade; null = sport default
  status         text not null default 'setup' check (status in ('setup','active','completed')),
  seq            int not null default 0,
  created_at     timestamptz not null default now(),
  unique (competition_id, slug)
);

create table stages (
  id            uuid primary key default gen_random_uuid(),
  division_id   uuid not null references divisions(id) on delete cascade,
  org_id        uuid not null,
  seq           int  not null,
  kind          text not null check (kind in ('league','group','swiss','knockout','double_elim','stepladder')),
  name          text not null,
  config        jsonb not null default '{}', -- legs, pools, rounds, bracketSize, seeding, rngSeed
  qualification jsonb,                       -- null = all entrants (first stage)
  status        text not null default 'pending' check (status in ('pending','active','complete')),
  unique (division_id, seq)
);

create table pools (
  id        uuid primary key default gen_random_uuid(),
  stage_id  uuid not null references stages(id) on delete cascade,
  org_id    uuid not null,
  key       text not null,                   -- 'A','B'
  name      text not null
);

-- ── Entrants & rosters ───────────────────────────────────────────────────────
create table entrants (
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

create table entrant_members (
  entrant_id uuid not null references entrants(id) on delete cascade,
  person_id  uuid not null references persons(id) on delete cascade,
  org_id     uuid not null,
  squad_number int, default_position_key text,
  is_captain boolean not null default false,
  roles      jsonb not null default '[]',    -- ['wicketkeeper'] — validated vs position_catalog
  primary key (entrant_id, person_id)
);

-- ── Fixtures ─────────────────────────────────────────────────────────────────
create table fixtures (
  id              uuid primary key default gen_random_uuid(),
  stage_id        uuid not null references stages(id) on delete cascade,
  division_id     uuid not null,             -- denormalized for cheap queries
  org_id          uuid not null,
  pool_id         uuid references pools(id) on delete set null,
  round_no        int  not null,
  seq_in_round    int  not null,
  home_entrant_id uuid references entrants(id) on delete set null,   -- null = TBD/bye
  away_entrant_id uuid references entrants(id) on delete set null,
  winner_to_fixture uuid references fixtures(id) on delete set null,
  winner_to_slot  int check (winner_to_slot in (1,2)),
  loser_to_fixture  uuid references fixtures(id) on delete set null,
  loser_to_slot   int check (loser_to_slot in (1,2)),
  parent_fixture_id uuid references fixtures(id) on delete cascade,  -- team-tie sub-fixtures (reserved)
  scheduled_at    timestamptz, venue text, court_label text,
  officials       jsonb not null default '[]',
  status          text not null default 'scheduled' check (status in
                  ('scheduled','in_play','decided','finalized','abandoned','forfeited','cancelled')),
  outcome         jsonb,                     -- MatchOutcome, written when decided
  created_at      timestamptz not null default now()
);
create index fixtures_stage_idx    on fixtures(stage_id, round_no, seq_in_round);
create index fixtures_division_idx on fixtures(division_id, scheduled_at);
create index fixtures_entrant_idx  on fixtures(home_entrant_id), fixtures(away_entrant_id);

create table lineups (
  fixture_id   uuid not null references fixtures(id) on delete cascade,
  entrant_id   uuid not null references entrants(id) on delete cascade,
  person_id    uuid not null references persons(id) on delete cascade,
  org_id       uuid not null,
  slot         text not null default 'starting' check (slot in ('starting','bench')),
  position_key text,
  order_no     int,                          -- batting order / board order
  roles        jsonb not null default '[]',
  primary key (fixture_id, entrant_id, person_id)
);

-- ── Event ledger (source of truth) ───────────────────────────────────────────
create table score_events (
  id           uuid primary key default gen_random_uuid(),
  fixture_id   uuid not null references fixtures(id) on delete cascade,
  org_id       uuid not null,
  seq          int  not null,                -- gapless per fixture; (fixture_id, seq) unique
  type         text not null,                -- 'cricket.ball','core.void',...
  payload      jsonb not null,
  recorded_by  uuid references users(id) on delete set null,
  recorded_at  timestamptz not null default now(),
  voids_event_id uuid references score_events(id),
  -- tamper-evident hash chain (migration 011 pattern, per-fixture chains)
  prev_hash    text, row_hash text,
  unique (fixture_id, seq)
);
create index score_events_fixture_idx on score_events(fixture_id, seq);

create table match_states (                   -- disposable cache = fold(score_events)
  fixture_id uuid primary key references fixtures(id) on delete cascade,
  org_id     uuid not null,
  last_seq   int  not null,
  state      jsonb not null,
  summary    jsonb not null,
  updated_at timestamptz not null default now()
);

-- ── Derived standings & structural ledger ───────────────────────────────────
create table standings_snapshots (
  stage_id   uuid not null references stages(id) on delete cascade,
  pool_id    uuid,                            -- null for non-pool stages
  org_id     uuid not null,
  rows       jsonb not null,                  -- ordered StandingsRow[]
  computed_through_seq bigint not null,       -- division_events watermark
  updated_at timestamptz not null default now(),
  primary key (stage_id, coalesce(pool_id, '00000000-0000-0000-0000-000000000000'::uuid))
);

create table division_events (                -- structural ledger (doc 05 §5), hash-chained
  id          uuid primary key default gen_random_uuid(),
  division_id uuid not null references divisions(id) on delete cascade,
  org_id      uuid not null,
  seq         bigint not null,
  type        text not null,                  -- stage_opened|fixtures_generated|stage_completed|rank_lock|...
  payload     jsonb not null,
  actor_id    uuid references users(id) on delete set null,
  created_at  timestamptz not null default now(),
  prev_hash   text, row_hash text,
  unique (division_id, seq)
);

-- ── API keys (doc 08) ────────────────────────────────────────────────────────
create table api_keys (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations(id) on delete cascade,
  name        text not null,
  key_hash    text not null unique,           -- sha256 of secret; secret shown once
  scopes      jsonb not null default '["read"]',
  last_used_at timestamptz, revoked_at timestamptz,
  created_by  uuid references users(id) on delete set null,
  created_at  timestamptz not null default now()
);
```

## Notes

1. **`org_id` trigger** — one generic `set_org_from_parent()` per child table (from
   division/stage/fixture parent), same mechanism as migration 010. RLS policies identical
   in shape to 010's.
2. **Hash chains** — `score_events` chains **per fixture** (parallel-safe: advisory lock
   already held per fixture on append; chain key = fixture); `division_events` chains per
   division. Verify functions mirror migration 011.
3. **Gapless `seq`** — assigned inside the append transaction under the fixture advisory
   lock: `select coalesce(max(seq),0)+1`. Safe because appends serialize per fixture.
4. **Public read model** — the dashboard/API reads only: competitions(visibility='public'),
   divisions, stages, pools, fixtures(status, outcome, schedule), standings_snapshots,
   entrants(display), lineups filtered by consent. Implemented as SQL views
   (`public_fixtures_v`, …) so the consent/privacy filtering (doc 06 §4.7) lives in exactly
   one place.
5. **Migration path from v1** (PROMPT-15): tournament → competition(1) + division(1);
   rounds/matches → stages/fixtures; players → persons + entrants(kind=individual);
   match results → synthetic `generic.result` score_events; old audit_log preserved
   read-only in an `audit_log_v1` archive table.

## Deviations (implemented in `supabase/schema_v2.sql`, PROMPT-10)

The DDL sketches above are illustrative; the normative schema is `schema_v2.sql`.
Corrections made there (a PostgreSQL expression can't appear in a PRIMARY KEY, etc.):

- **`sport_variants` / `standings_snapshots` composite PKs** — the sketched
  `primary key (…, coalesce(org_id | pool_id, ZERO_UUID))` is invalid (no
  expressions in a PK). Materialised as a STORED generated column
  (`org_scope` / `pool_scope` = `coalesce(col, zero-uuid)`) and the PK keys on
  that column. Same uniqueness semantics; a null org/pool collapses to the zero
  uuid so `(sport_key, key)` / `(stage_id)` is unique per scope.
- **`fixtures` entrant index** — `create index … on fixtures(a), fixtures(b)` is
  not a single statement; split into `fixtures_home_idx` + `fixtures_away_idx`.
- **Gapless `seq`** — assigned by the persistence adapter *inside* the fixture /
  division advisory-lock transaction (`coalesce(max(seq),0)+1`), not by a
  trigger. The hash-chain trigger therefore needs no `chain_seq`: it keys the
  chain per fixture / per division and links rows in `seq` order (the aggregate
  is already serialised by the adapter's advisory lock — doc note 2).
- **`org_id` trigger** — one generic `set_org_from_parent(parent_table, fk_col)`
  parameterised via `TG_ARGV` and attached to every child table (010 pattern).
- **Public read model** — four views (`public_competitions_v`,
  `public_fixtures_v`, `public_standings_v`, `public_entrants_v`) plus a
  `public_person_name(full_name, consent)` helper: full name only with
  `consent.public_name`, else initials; photo only with `consent.public_photo`;
  DOB never selected.
- **`sport_variants` RLS** — system presets (`org_id is null`) are readable by
  any tenant (`using (org_id is null or org_id = current_org_id())`); writes stay
  org-scoped. The catalog is generated by `scripts/sync-sports.ts` from the
  engine registry, never hand-edited.

## Additions (PROMPT-11, `/api/v1`)

- **`fixtures.ext_key`** (nullable, unique per stage when present) — the pure
  scheduling generators emit stable fixture ids (`rr-r1-c2`, `wb-r0-g1`, …);
  persisting them makes `POST /stages/{id}/generate` idempotent (re-runs upsert
  by key and report a diff) and lets winner/loser feeds be wired by key.
- **`public_divisions_v`** — divisions of public competitions, for the public
  competition landing endpoint.
- **`public_fixtures_v` + `summary`/`last_seq`** — the render-agnostic score
  line from the `match_states` fold cache rides along for the live public
  fixture endpoint; it never contains person data.
- **`plan_entitlements` seed `api.access`** — community `false`, pro `true`
  (doc 08 §2: the platform API is Pro-gated). Guarded so `schema_v2.sql` still
  applies standalone.
- **Qualification seeding (doc 05 §3)** — `POST /stages/{id}/complete` resolves
  the *next* stage's `qualification` spec against the completed stage's
  standings snapshots (pool uuids translated back to their `pools.key`
  letters), snapshots the ordered result as the next stage's
  `config.qualified`, and records a `stage_seeded` division event. That stage's
  `/generate` then seeds from the list (order = seeds 1..k). Idempotent;
  bracket stages as a qualification *source* are not yet supported.
- **Pools (doc 05 §1)** — group stages with `config.pools.count = N` generate
  `pools` rows (`A`, `B`, …), distribute active entrants by seeded snake, and
  run one round robin per pool (`ext_key` prefix `p{key}-`); standings snapshot
  per pool. `assignment: manual|random_seeded` not yet implemented.
