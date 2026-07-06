-- =============================================================================
-- People & teams (org-scoped, persistent across competitions)
-- =============================================================================
create table if not exists persons (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references organizations(id) on delete cascade,
  full_name    text not null,
  dob          date,                           -- eligibility; NEVER exposed publicly
  gender       text check (gender in ('m','f','x')),
  photo_path   text,
  consent      jsonb not null default '{}',    -- {public_name: bool, public_photo: bool}
  user_id      uuid references users(id) on delete set null,
  external_ref text,
  created_at   timestamptz not null default now()
);
create index if not exists persons_org_idx on persons(org_id);
