-- ---------------------------------------------------------------------------
-- Email verification tokens for email/password sign-ups. A token is
-- consumed (deleted) when the link is opened; Google logins skip this.
-- ---------------------------------------------------------------------------
create table email_verifications (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users(id) on delete cascade,
  token       text not null unique,
  expires_at  timestamptz not null,
  created_at  timestamptz not null default now()
);

create index email_verifications_user_idx on email_verifications(user_id);
