-- =============================================================================
-- V284 — Official onboarding (PROMPT-57 / design v11).
-- The officials engine (V243) has no human on the other end: nothing sets
-- officials.person_id from the official's side. v11 points the player claim
-- rail (V276) at officials and adds the two states a referee actually needs:
-- a per-assignment response and blackout dates.
-- =============================================================================

-- Invite target for the claim rail. The claim itself binds via person_id
-- (already on officials) — email is where the invite goes and the address the
-- accept is bound to (person_claims rule).
alter table officials add column email text;

-- Assignment response: an official can accept or decline a specific
-- assignment. Existing rows were manually placed by the organiser — treat as
-- agreed (backfill 'accepted') so no console lights up red on deploy.
alter table fixture_officials
  add column response text not null default 'pending'
    check (response in ('pending', 'accepted', 'declined')),
  add column responded_at timestamptz,
  add column decline_reason text;
update fixture_officials set response = 'accepted';

-- Blackout dates ("can't do Sunday"). Written by the official through the
-- superuser connection (cross-org — an official is not an org member; the
-- fixture_availability pattern from V276). The tenant policy serves
-- organiser-console reads.
create table official_availability (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations(id) on delete cascade,
  official_id uuid not null references officials(id) on delete cascade,
  date        date not null,
  status      text not null default 'unavailable' check (status in ('unavailable')),
  note        text,
  created_at  timestamptz not null default now(),
  unique (official_id, date)
);
create index official_availability_org_idx on official_availability(org_id);

alter table official_availability enable row level security;
alter table official_availability force  row level security;
create policy official_availability_tenant on official_availability for all to app_user
  using (org_id = current_org_id()) with check (org_id = current_org_id());
grant select on official_availability to app_user;

-- No new entitlements: the officiating portal is free on every plan (onboarding
-- a volunteer ref must not require Pro). officials.auto / officials.roles_multi
-- (V243) stay the only Pro gates.
