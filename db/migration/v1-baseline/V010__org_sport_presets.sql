-- ---------------------------------------------------------------------------
-- Per-organization sport presets — default tournament settings per sport.
-- Seeded when an org is created; editors customize in Settings.
-- ---------------------------------------------------------------------------
create table org_sport_presets (
  id                   uuid primary key default gen_random_uuid(),
  org_id               uuid not null references organizations(id) on delete cascade,
  sport_key            text not null,
  sport_name           text not null,
  entity_label         text not null default 'Players',
  format               text not null default 'swiss_knockout',
  result_mode          text not null default 'win_loss',
  score_label          text not null default 'Score',
  points_win           int  not null default 1,
  points_draw          int  not null default 0,
  points_loss          int  not null default 0,
  allow_draws          boolean not null default false,
  use_progress_score   boolean not null default false,
  round_minutes        int  not null default 30,
  clock_minutes        int  not null default 0,
  default_category     text not null default 'adult',
  default_group_rounds int,
  default_knockout_size int,
  is_system            boolean not null default false,
  sort_order           int  not null default 0,
  created_at           timestamptz not null default now(),
  unique (org_id, sport_key)
);

create index org_sport_presets_org_idx on org_sport_presets(org_id, sort_order);
