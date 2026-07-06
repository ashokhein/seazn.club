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
