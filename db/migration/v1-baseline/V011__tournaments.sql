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
