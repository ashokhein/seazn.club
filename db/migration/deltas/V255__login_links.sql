-- ---------------------------------------------------------------------------
-- Passwordless "magic link" sign-in tokens. Single-use, 15-minute TTL.
-- Clicking the emailed link proves control of the address, so consuming a
-- token both signs the user in and verifies their email.
-- ---------------------------------------------------------------------------
create table login_links (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users(id) on delete cascade,
  token       text not null unique,
  expires_at  timestamptz not null,
  used        boolean not null default false,
  created_at  timestamptz not null default now()
);

create index login_links_user_idx on login_links(user_id);
