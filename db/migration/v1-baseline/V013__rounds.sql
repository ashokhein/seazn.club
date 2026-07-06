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
