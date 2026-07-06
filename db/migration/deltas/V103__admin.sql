-- =============================================================================
-- Migration 003: staff / admin console
-- Adds is_staff, staff_role to users + staff_audit_log.
-- Safe to re-run (idempotent).
-- =============================================================================

alter table users
  add column if not exists is_staff   boolean not null default false,
  add column if not exists staff_role text;   -- 'support' | 'superadmin' | null

create index if not exists users_staff_idx on users(is_staff) where is_staff = true;

-- Every sensitive admin action is recorded here for accountability.
create table if not exists staff_audit_log (
  id            uuid primary key default gen_random_uuid(),
  actor_id      uuid not null references users(id),
  action        text not null,
  target_type   text not null,   -- 'org' | 'user' | 'entitlement'
  target_id     text not null,   -- UUID of the affected row
  detail        jsonb,
  created_at    timestamptz not null default now()
);

create index if not exists staff_audit_log_actor_idx  on staff_audit_log(actor_id, created_at desc);
create index if not exists staff_audit_log_target_idx on staff_audit_log(target_id, created_at desc);

-- Impersonation sessions: short-lived, audited.
create table if not exists impersonation_sessions (
  id            uuid primary key default gen_random_uuid(),
  actor_id      uuid not null references users(id),
  target_id     uuid not null references users(id),
  token         text not null unique,
  expires_at    timestamptz not null,
  ended_at      timestamptz,
  created_at    timestamptz not null default now()
);

create index if not exists impersonation_actor_idx on impersonation_sessions(actor_id);
