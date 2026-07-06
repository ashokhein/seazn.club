-- ---------------------------------------------------------------------------
-- Password reset tokens. Single-use, 1-hour TTL.
-- ---------------------------------------------------------------------------
create table password_resets (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users(id) on delete cascade,
  token       text not null unique,
  expires_at  timestamptz not null,
  used        boolean not null default false,
  created_at  timestamptz not null default now()
);

create index password_resets_user_idx on password_resets(user_id);
