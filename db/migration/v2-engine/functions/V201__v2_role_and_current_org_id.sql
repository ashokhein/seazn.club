-- =============================================================================
-- schema_v2.sql — Greenfield Engine v2 schema (design doc engine/07 v4)
-- =============================================================================
-- Creates the v2 competition tables ALONGSIDE the v1 tournament tables. v1 is
-- dropped only in PROMPT-15 (app cutover); here the two coexist so the engine
-- can be built and tested without disturbing the running app.
--
-- Applied by scripts/apply-db.ts AFTER schema.sql + all migrations, so it can
-- rely on: the `app_user` role, `current_org_id()`, `organizations`, `users`.
-- Both are (re)created defensively below so this file also applies standalone.
--
-- Conventions (doc 07): every tenant table carries a denormalized, trigger-
-- filled `org_id` + a direct RLS policy `org_id = current_org_id()` (the proven
-- migration 010 pattern). Append-only ledgers (score_events, division_events)
-- carry per-aggregate hash chains (the migration 011 pattern). Idempotent:
-- safe to re-run on a fresh or populated DB.
--
-- DEVIATIONS from doc 07's DDL sketches (documented in the doc itself):
--   * PK expressions `coalesce(org_id, …)` / `coalesce(pool_id, …)` are not
--     valid in a PRIMARY KEY — replaced by STORED generated columns
--     (`org_scope` / `pool_scope`) that the PK references.
--   * `create index … on fixtures(a), fixtures(b)` is not one statement —
--     split into two indexes.
--   * Gapless `seq` is assigned by the persistence adapter under the fixture /
--     division advisory lock (doc 07 note 3), NOT by a trigger; the hash-chain
--     trigger keys the chain per fixture / per division and orders by `seq`
--     (no separate chain_seq needed — seq already linearises the aggregate).
-- =============================================================================

-- Restricted application role (mirrors schema.sql; no-op if already present).
do $$ begin
  if not exists (select from pg_roles where rolname = 'app_user') then
    create role app_user nologin;
  end if;
end $$;

-- Tenant-context accessor (mirrors schema.sql; create-or-replace is idempotent).
create or replace function current_org_id() returns uuid
  language sql stable as $$
    select nullif(current_setting('app.current_org', true), '')::uuid
  $$;
