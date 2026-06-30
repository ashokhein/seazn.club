-- =============================================================================
-- Migration 005: onboarding + activation funnel
-- =============================================================================

-- Track when a user completes the first-run wizard.
alter table users add column if not exists onboarding_completed_at timestamptz;

-- Lightweight activation funnel log — one row per milestone per org per user.
-- Intentionally append-only (no updates); duplicates are ignored.
create table if not exists activation_events (
  id         uuid        primary key default gen_random_uuid(),
  user_id    uuid        not null references users(id) on delete cascade,
  org_id     uuid        not null references organizations(id) on delete cascade,
  event      text        not null,           -- 'signup','org_created','first_tournament_created','tournament_started','tournament_completed'
  meta       jsonb,
  created_at timestamptz not null default now(),
  unique (user_id, org_id, event)            -- only first occurrence counts
);

create index if not exists activation_events_org_idx on activation_events(org_id, created_at desc);
create index if not exists activation_events_user_idx on activation_events(user_id);
