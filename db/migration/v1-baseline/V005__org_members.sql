-- ---------------------------------------------------------------------------
-- Membership of a user in an organization.
--   role: 'owner' | 'admin' | 'viewer'
-- ---------------------------------------------------------------------------
create table org_members (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations(id) on delete cascade,
  user_id     uuid not null references users(id) on delete cascade,
  role        text not null default 'viewer',
  created_at  timestamptz not null default now(),
  unique (org_id, user_id)
);

create index org_members_user_idx on org_members(user_id);
create index org_members_org_idx  on org_members(org_id);
