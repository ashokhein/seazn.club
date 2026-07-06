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
