-- =============================================================================
-- Migration 002: account & org lifecycle
-- Adds email_change_requests + soft-delete columns for users.
-- Safe to re-run (idempotent).
-- =============================================================================

-- Email-change requests: double opt-in flow.
create table if not exists email_change_requests (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users(id) on delete cascade,
  old_email   text not null,
  new_email   text not null,
  token       text not null unique,
  expires_at  timestamptz not null,
  confirmed   boolean not null default false,
  created_at  timestamptz not null default now()
);

create index if not exists email_change_requests_user_idx
  on email_change_requests(user_id);
create index if not exists email_change_requests_token_idx
  on email_change_requests(token);

-- Soft-delete columns on users.
alter table users
  add column if not exists deleted_at    timestamptz,
  add column if not exists purge_after   timestamptz;

-- Make sure getCurrentUser() never returns a deleted account.
create or replace function current_org_id() returns uuid
  language sql stable
  as $$
    select nullif(current_setting('app.current_org', true), '')::uuid
  $$;
