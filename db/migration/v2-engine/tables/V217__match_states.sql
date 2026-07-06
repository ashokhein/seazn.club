create table if not exists match_states (       -- disposable cache = fold(score_events)
  fixture_id uuid primary key references fixtures(id) on delete cascade,
  org_id     uuid not null,
  last_seq   int  not null,
  state      jsonb not null,
  summary    jsonb not null,
  updated_at timestamptz not null default now()
);
