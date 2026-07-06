create table if not exists teams (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references organizations(id) on delete cascade,
  name       text not null,
  short_name text, logo_path text, colors jsonb,
  created_at timestamptz not null default now()
);
