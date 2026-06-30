-- =============================================================================
-- Migration 004: email deliverability — suppression list + queue
-- =============================================================================

-- Suppression list: emails that bounced or complained.
-- Never send non-transactional mail to these addresses.
create table if not exists email_suppressions (
  id           uuid primary key default gen_random_uuid(),
  email        text not null,
  type         text not null check (type in ('bounce', 'complaint', 'manual')),
  provider_id  text,   -- Resend message ID that caused the suppression
  created_at   timestamptz not null default now(),
  unique (email)
);

create index if not exists email_suppressions_email_idx on email_suppressions(lower(email));

-- Simple async email queue for retries without an external job runner.
-- Each row is picked up by the next request that calls processEmailQueue().
-- Replace with Inngest/Trigger.dev/pg-boss when job queue is set up (Phase 1.5).
create table if not exists email_queue (
  id           uuid primary key default gen_random_uuid(),
  to_email     text not null,
  subject      text not null,
  html         text not null,
  text         text not null,
  attempts     int  not null default 0,
  max_attempts int  not null default 3,
  last_error   text,
  scheduled_at timestamptz not null default now(),
  sent_at      timestamptz,
  created_at   timestamptz not null default now()
);

create index if not exists email_queue_pending_idx
  on email_queue(scheduled_at) where sent_at is null;
