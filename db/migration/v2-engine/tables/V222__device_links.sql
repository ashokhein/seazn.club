-- =============================================================================
-- Day-of device links (doc 13 §7, PROMPT-21; delta shipped as migration 017).
-- Fixture-scoped account-less scoring: sha256-stored token (api_keys pattern),
-- end-of-day expiry, one live device per fixture (use-case revokes priors).
-- =============================================================================
create table if not exists device_links (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations(id) on delete cascade,
  fixture_id  uuid not null references fixtures(id) on delete cascade,
  token_hash  text not null unique,          -- sha256, secret shown once
  label       text,                          -- 'Court 3 phone'
  issued_by   uuid not null references users(id) on delete cascade,
  expires_at  timestamptz not null,          -- end of the fixture's local day
  revoked_at  timestamptz,
  created_at  timestamptz not null default now()
);
create index if not exists device_links_fixture_idx on device_links(fixture_id);

-- Attribution rider (doc 13 §7): distinguishes hand-recorded from device-link
-- events. Deliberately OUTSIDE the hash-chain canonical — old chains stay valid.
alter table score_events add column if not exists
  device_link_id uuid references device_links(id) on delete set null;
