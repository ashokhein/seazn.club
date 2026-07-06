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
