-- =============================================================================
-- API keys (doc 08)
-- =============================================================================
-- Entitlement gate for the platform API (doc 08 §2): Pro only. Idempotent
-- seed alongside the existing plan matrix (schema.sql seeds the rest); guarded
-- so this file still applies standalone (without schema.sql's billing tables).
do $$ begin
  if exists (select from pg_tables where schemaname = 'public' and tablename = 'plan_entitlements') then
    insert into plan_entitlements (plan_key, feature_key, bool_value, int_value) values
      ('community', 'api.access', false, null),
      ('pro',       'api.access', true,  null)
    on conflict (plan_key, feature_key) do nothing;
  end if;
end $$;

create table if not exists api_keys (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references organizations(id) on delete cascade,
  name         text not null,
  key_hash     text not null unique,
  scopes       jsonb not null default '["read"]',
  last_used_at timestamptz, revoked_at timestamptz,
  created_by   uuid references users(id) on delete set null,
  created_at   timestamptz not null default now()
);
