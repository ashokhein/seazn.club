create table if not exists division_events (    -- structural ledger, hash-chained per division
  id          uuid primary key default gen_random_uuid(),
  division_id uuid not null references divisions(id) on delete cascade,
  org_id      uuid not null,
  seq         bigint not null,                 -- gapless per division (adapter-assigned)
  type        text not null,
  payload     jsonb not null,
  actor_id    uuid references users(id) on delete set null,
  created_at  timestamptz not null default now(),
  prev_hash   text, row_hash text,
  unique (division_id, seq)
);
