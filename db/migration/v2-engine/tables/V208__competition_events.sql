-- Division-independent competition event ledger (doc 15 §1 — discovery
-- opt-in/out audit; append-only by grants, see the grant section).
create table if not exists competition_events (
  id             uuid primary key default gen_random_uuid(),
  competition_id uuid not null references competitions(id) on delete cascade,
  org_id         uuid not null,
  type           text not null,
  payload        jsonb not null default '{}',
  actor_id       uuid references users(id) on delete set null,
  created_at     timestamptz not null default now()
);
create index if not exists competition_events_comp_idx
  on competition_events(competition_id, created_at);
