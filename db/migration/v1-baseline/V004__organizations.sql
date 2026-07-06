-- ---------------------------------------------------------------------------
-- Organizations — a "board" that owns seasons and tournaments. A user creates
-- one and becomes its owner; others join via invite with a role.
-- ---------------------------------------------------------------------------
create table organizations (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  slug        text not null unique,
  created_by  uuid references users(id) on delete set null,
  created_at  timestamptz not null default now()
);
