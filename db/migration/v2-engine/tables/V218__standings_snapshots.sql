-- =============================================================================
-- Derived standings & structural ledger
-- =============================================================================
create table if not exists standings_snapshots (
  stage_id             uuid not null references stages(id) on delete cascade,
  pool_id              uuid,                    -- null for non-pool stages
  org_id               uuid not null,
  rows                 jsonb not null,          -- ordered StandingsRow[]
  computed_through_seq bigint not null,
  updated_at           timestamptz not null default now(),
  -- DEVIATION: doc 07 sketched `primary key (stage_id, coalesce(pool_id, ZERO))`.
  -- Same coalesce-in-PK problem as sport_variants; materialise as a generated
  -- column and key on that.
  pool_scope           uuid generated always as
                       (coalesce(pool_id, '00000000-0000-0000-0000-000000000000'::uuid)) stored,
  primary key (stage_id, pool_scope)
);
