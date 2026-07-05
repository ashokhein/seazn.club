-- =============================================================================
-- Migration 013: Engine v1 cutover (PROMPT-15 task 3) — DESTRUCTIVE.
--
-- Run order on a live environment:
--   1. scripts/migrate-v1-to-v2.ts        (idempotent; verification must be clean)
--   2. this migration                     (archive audit_log, drop v1 tables)
--
-- On a fresh bootstrap (CI / new install) the v1 tables exist empty from
-- schema.sql and are simply dropped. Everything is guarded so re-runs are
-- harmless.
-- =============================================================================

-- Safety interlock: refuse to drop v1 data that was never migrated. A public,
-- decided tournament with no fixture mapping means migrate-v1-to-v2.ts has not
-- run (or failed) — abort rather than destroy.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'tournaments')
     AND EXISTS (SELECT 1 FROM tournaments)
     AND NOT EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'v1_migration_map')
  THEN
    RAISE EXCEPTION '013_v1_cutover: tournaments has rows but v1_migration_map is absent — run scripts/migrate-v1-to-v2.ts first';
  END IF;
END $$;

-- Public URL preservation (/t/{slug} 301s) — normally created and populated by
-- the migration script; ensure it exists so the redirect route always has a
-- table to read.
CREATE TABLE IF NOT EXISTS v1_slug_redirects (
  public_slug text PRIMARY KEY,
  target_path text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Archive the v1 audit log read-only (doc 07 note 5): rename, detach the FK
-- (its target table is about to go), and revoke writes.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'audit_log') THEN
    ALTER TABLE audit_log RENAME TO audit_log_v1;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'audit_log_v1') THEN
    -- Drop the tournaments FK so the drop below cannot cascade the archive.
    EXECUTE (
      SELECT coalesce(
        string_agg(format('ALTER TABLE audit_log_v1 DROP CONSTRAINT %I;', conname), ' '),
        'SELECT 1;'
      )
      FROM pg_constraint
      WHERE conrelid = 'audit_log_v1'::regclass AND contype = 'f'
    );
    REVOKE INSERT, UPDATE, DELETE ON audit_log_v1 FROM PUBLIC;
  END IF;
END $$;

-- Drop the v1 engine tables (doc 07: replaced by the greenfield v2 schema).
DROP TABLE IF EXISTS match_events;
DROP TABLE IF EXISTS matches;
DROP TABLE IF EXISTS rounds;
DROP TABLE IF EXISTS players;
DROP TABLE IF EXISTS tournaments;
DROP TABLE IF EXISTS seasons;
DROP TABLE IF EXISTS org_sport_presets;
