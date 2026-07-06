-- ---------------------------------------------------------------------------
-- Email deliverability (migration 004)
-- ---------------------------------------------------------------------------

create table if not exists email_suppressions (
  id           uuid primary key default gen_random_uuid(),
  email        text not null,
  type         text not null check (type in ('bounce', 'complaint', 'manual')),
  provider_id  text,
  created_at   timestamptz not null default now(),
  unique (email)
);

create index if not exists email_suppressions_email_idx on email_suppressions(lower(email));
