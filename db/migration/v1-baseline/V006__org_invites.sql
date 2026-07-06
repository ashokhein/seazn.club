-- ---------------------------------------------------------------------------
-- Shareable invite links. A logged-in user opens /join/<token> to join the
-- org with the embedded role.
--   max_uses   : 0 = unlimited, otherwise the link expires after N joins.
--   expires_at : optional absolute expiry.
-- ---------------------------------------------------------------------------
create table org_invites (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations(id) on delete cascade,
  role        text not null default 'viewer',
  token       text not null unique,
  created_by  uuid references users(id) on delete set null,
  expires_at  timestamptz,
  max_uses    int  not null default 1,
  used_count  int  not null default 0,
  revoked     boolean not null default false,
  created_at  timestamptz not null default now()
);

create index org_invites_org_idx on org_invites(org_id, created_at desc);
