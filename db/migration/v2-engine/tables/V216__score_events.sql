-- =============================================================================
-- Event ledger (source of truth) — hash-chained per fixture
-- =============================================================================
create table if not exists score_events (
  id             uuid primary key default gen_random_uuid(),
  fixture_id     uuid not null references fixtures(id) on delete cascade,
  org_id         uuid not null,
  seq            int  not null,                -- gapless per fixture (adapter-assigned)
  type           text not null,               -- 'cricket.ball','core.void',…
  payload        jsonb not null,
  recorded_by    uuid references users(id) on delete set null,
  recorded_at    timestamptz not null default now(),
  voids_event_id uuid references score_events(id),
  prev_hash      text, row_hash text,          -- tamper-evident chain (per fixture)
  unique (fixture_id, seq)
);
create index if not exists score_events_fixture_idx on score_events(fixture_id, seq);
