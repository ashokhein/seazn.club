-- ---------------------------------------------------------------------------
-- Email-change requests: double opt-in when a user changes their address.
-- ---------------------------------------------------------------------------
create table email_change_requests (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users(id) on delete cascade,
  old_email   text not null,
  new_email   text not null,
  token       text not null unique,
  expires_at  timestamptz not null,
  confirmed   boolean not null default false,
  created_at  timestamptz not null default now()
);

create index email_change_requests_user_idx  on email_change_requests(user_id);
create index email_change_requests_token_idx on email_change_requests(token);
