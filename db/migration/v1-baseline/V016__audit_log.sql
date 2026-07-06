-- ---------------------------------------------------------------------------
-- Audit log: a human-readable record of every action (create, start,
-- record result, undo, reset, check-in). Survives undo/reset so the full
-- history is always available.
-- ---------------------------------------------------------------------------
create table audit_log (
  id              uuid primary key default gen_random_uuid(),
  tournament_id   uuid references tournaments(id) on delete cascade,
  actor           text,           -- organiser display name (null = system)
  action          text not null,  -- create|start|record_result|undo|reset|checkin
  summary         text not null,  -- human-readable description
  detail          jsonb,          -- structured payload
  created_at      timestamptz not null default now()
);

create index audit_log_tournament_idx on audit_log(tournament_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Seed data is created by scripts/apply-schema.ts (it hashes the demo
-- password with bcrypt and wires up a demo organization + owner membership).
-- ---------------------------------------------------------------------------
