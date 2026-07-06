-- ---------------------------------------------------------------------------
-- Seasons / series (optional container within an org, e.g. Summer2026).
-- ---------------------------------------------------------------------------
create table seasons (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations(id) on delete cascade,
  name        text not null,
  slug        text not null,
  created_at  timestamptz not null default now(),
  unique (org_id, slug)
);

create index seasons_org_idx on seasons(org_id);
