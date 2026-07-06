create table if not exists divisions (
  id             uuid primary key default gen_random_uuid(),
  competition_id uuid not null references competitions(id) on delete cascade,
  org_id         uuid not null,
  name           text not null,
  slug           text not null,
  sport_key      text not null references sports(key),
  variant_key    text not null,
  config         jsonb not null,               -- merged variant + overrides (validated snapshot)
  module_version text not null,                -- PINNED engine module version
  eligibility    jsonb not null default '[]',
  tiebreakers    jsonb,                         -- override cascade; null = sport default
  status         text not null default 'setup' check (status in ('setup','scheduled','active','completed')),
  seq            int not null default 0,        -- division_events watermark
  created_at     timestamptz not null default now(),
  unique (competition_id, slug)
);
-- Scorer capabilities (doc 13 §2, PROMPT-18) — columns, not config keys: the
-- config snapshot is sport-module-validated and would strip foreign keys.
alter table divisions add column if not exists scorer_can_finalize      boolean not null default true;
alter table divisions add column if not exists scorer_can_enter_lineups boolean not null default true;
-- Doc 12 §1 state machine: 'scheduled' (published timetable, not yet started)
-- sits between setup and active. Re-assert on DBs created before PROMPT-17.
do $$ begin
  if exists (
    select 1 from pg_constraint c
    where c.conname = 'divisions_status_check'
      and pg_get_constraintdef(c.oid) not like '%scheduled%'
  ) then
    alter table divisions drop constraint divisions_status_check;
    alter table divisions add constraint divisions_status_check
      check (status in ('setup','scheduled','active','completed'));
  end if;
end $$;
