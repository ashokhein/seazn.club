-- V276 — Player accounts (PROMPT-53): claim invites + per-fixture availability.
-- persons.user_id + persons.consent exist since V204 — claiming only fills them.

-- Claim invites: token hashed at rest (device-links pattern, doc 13 §7).
-- Rows are never deleted — claimed_at/revoked_at/invited_by ARE the audit
-- trail for claim/unlink (an org-wide person has no competition_events grain).
create table person_claims (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations(id) on delete cascade,
  person_id   uuid not null references persons(id) on delete cascade,
  email       text not null,
  token_hash  text not null unique,
  invited_by  uuid references users(id) on delete set null,
  expires_at  timestamptz not null,
  claimed_at  timestamptz,
  revoked_at  timestamptz,
  created_at  timestamptz not null default now()
);
create index person_claims_person_idx on person_claims(person_id);
create index person_claims_org_idx on person_claims(org_id);
-- One OPEN claim per person: minting a new invite revokes the previous one.
create unique index person_claims_open_uq on person_claims(person_id)
  where claimed_at is null and revoked_at is null;

alter table person_claims enable row level security;
alter table person_claims force  row level security;
create policy person_claims_tenant on person_claims for all to app_user
  using (org_id = current_org_id()) with check (org_id = current_org_id());
grant select, insert, update on person_claims to app_user;

-- Player RSVP + QR self-check-in, one row per (fixture, person). Presence
-- lives here (checked_in_at), not on lineups — a player can check in before
-- the organiser has picked any lineup. Player-side writes go through the
-- superuser connection (cross-org; the player is not an org member); the
-- tenant policy serves organiser-console reads.
create table fixture_availability (
  fixture_id    uuid not null references fixtures(id) on delete cascade,
  person_id     uuid not null references persons(id) on delete cascade,
  org_id        uuid not null,
  status        text not null check (status in ('in','out','maybe')),
  note          text,
  checked_in_at timestamptz,
  updated_at    timestamptz not null default now(),
  primary key (fixture_id, person_id)
);
create index fixture_availability_person_idx on fixture_availability(person_id);

alter table fixture_availability enable row level security;
alter table fixture_availability force  row level security;
create policy fixture_availability_tenant on fixture_availability for all to app_user
  using (org_id = current_org_id()) with check (org_id = current_org_id());
grant select on fixture_availability to app_user;
