-- =============================================================================
-- Competition → Division → Stage
-- =============================================================================
create table if not exists competitions (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations(id) on delete cascade,
  name        text not null,
  slug        text not null,
  description text,
  starts_on   date, ends_on date,
  visibility  text not null default 'private' check (visibility in ('private','unlisted','public')),
  branding    jsonb not null default '{}',
  status      text not null default 'draft' check (status in ('draft','published','live','completed','archived')),
  created_by  uuid references users(id) on delete set null,
  created_at  timestamptz not null default now(),
  unique (org_id, slug)
);

-- Discovery opt-in + curation (doc 15, PROMPT-19; delta shipped as migration
-- 016 — re-asserted here for fresh bootstraps where migrations ran first).
alter table competitions add column if not exists discoverable boolean not null default false;
alter table competitions add column if not exists discovery jsonb not null default '{}';
alter table competitions add column if not exists discovery_blocked  boolean not null default false;
alter table competitions add column if not exists discovery_featured boolean not null default false;
create index if not exists competitions_discoverable_idx
  on competitions(discoverable) where discoverable;
