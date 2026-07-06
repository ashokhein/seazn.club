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
