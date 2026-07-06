create table if not exists sport_variants (
  sport_key  text not null references sports(key),
  key        text not null,                   -- 't20','odi','beach','blitz'
  name       text not null,
  config     jsonb not null,                  -- validated by module configSchema
  is_system  boolean not null default true,
  org_id     uuid references organizations(id) on delete cascade,  -- null = system preset
  -- DEVIATION: doc 07 sketched `primary key (…, coalesce(org_id, ZERO))`.
  -- A coalesce() expression is illegal in a PK, so we materialise it as a
  -- STORED generated column and key on that. NULL org_id (system presets)
  -- collapses to the zero uuid so (sport_key, key) is unique per scope.
  org_scope  uuid generated always as
             (coalesce(org_id, '00000000-0000-0000-0000-000000000000'::uuid)) stored,
  primary key (sport_key, key, org_scope)
);
