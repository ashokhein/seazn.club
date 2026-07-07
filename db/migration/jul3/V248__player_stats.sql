-- =============================================================================
-- Jul3/07 §2 — player stat snapshots (PROMPT-27): a disposable projection of
-- the score-event ledger, rebuildable at any time (same discipline as
-- standings_snapshots).
-- =============================================================================
create table if not exists player_stat_snapshots (
  division_id uuid not null references divisions(id) on delete cascade,
  person_id   uuid not null references persons(id) on delete cascade,
  org_id      uuid not null,
  sport_key   text not null,
  stats       jsonb not null,           -- sport-keyed: {goals,assists,points,motm_awards,…}
  computed_through_seq bigint not null, -- watermark over contributing fixtures
  updated_at  timestamptz not null default now(),
  primary key (division_id, person_id)
);

drop trigger if exists trg_set_org on player_stat_snapshots;
create trigger trg_set_org before insert on player_stat_snapshots
  for each row execute function set_org_from_parent('divisions', 'division_id');

alter table player_stat_snapshots enable row level security;
alter table player_stat_snapshots force  row level security;
drop policy if exists player_stat_snapshots_tenant on player_stat_snapshots;
create policy player_stat_snapshots_tenant on player_stat_snapshots for all to app_user
  using (org_id = current_org_id()) with check (org_id = current_org_id());
grant select, insert, update, delete on player_stat_snapshots to app_user;
