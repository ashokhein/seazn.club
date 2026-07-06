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
