-- =============================================================================
-- Sport catalog (global, seeded by scripts/sync-sports.ts from the engine
-- registry — never hand-edited). `sports` has no org_id: it is global read.
-- =============================================================================
create table if not exists sports (
  key              text primary key,          -- 'cricket','football','volleyball',…
  name             text not null,
  module_version   text not null,             -- latest available; divisions pin their own
  position_catalog jsonb not null,            -- from SportModule.positions
  created_at       timestamptz not null default now()
);
