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
