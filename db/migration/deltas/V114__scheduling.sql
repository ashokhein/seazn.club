-- =============================================================================
-- Migration 014: Scheduling console (PROMPT-17, doc 12 §3).
--
-- Adds the schedule provenance columns to fixtures, the per-division
-- schedule_settings table, the 'scheduled' division state (doc 12 §1 state
-- machine) and the scheduling entitlement seeds (doc 12 §5).
--
-- Ordering note: on a FRESH bootstrap apply-db runs migrations BEFORE
-- schema_v2.sql, so the v2 tables do not exist yet — every v2-touching block
-- is guarded and no-ops; schema_v2.sql (idempotent) then creates the same
-- shape. On a LIVE environment the v2 tables exist and this applies the delta.
-- =============================================================================

-- fixtures.schedule_source / schedule_locked (doc 12 §3; manual = pinned).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'fixtures') THEN
    ALTER TABLE fixtures ADD COLUMN IF NOT EXISTS schedule_source text NOT NULL DEFAULT 'none';
    ALTER TABLE fixtures ADD COLUMN IF NOT EXISTS schedule_locked boolean NOT NULL DEFAULT false;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fixtures_schedule_source_check') THEN
      ALTER TABLE fixtures ADD CONSTRAINT fixtures_schedule_source_check
        CHECK (schedule_source IN ('none','auto','manual'));
    END IF;
  END IF;
END $$;

-- Division state machine gains 'scheduled' (doc 12 §1:
-- setup → schedule→publish → scheduled → start → active).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'divisions') THEN
    ALTER TABLE divisions DROP CONSTRAINT IF EXISTS divisions_status_check;
    ALTER TABLE divisions ADD CONSTRAINT divisions_status_check
      CHECK (status IN ('setup','scheduled','active','completed'));
  END IF;
END $$;

-- Per-division scheduling settings (doc 12 §3). config carries startAt,
-- matchMinutes, gapMinutes, courts[], perEntrantMinRest, blackouts[],
-- sessionWindows[]; tz is the venue-local zone (doc 12 §6 — DST boundaries).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'divisions') THEN
    CREATE TABLE IF NOT EXISTS schedule_settings (
      division_id uuid PRIMARY KEY REFERENCES divisions(id) ON DELETE CASCADE,
      org_id      uuid NOT NULL,
      config      jsonb NOT NULL DEFAULT '{}',
      tz          text NOT NULL DEFAULT 'UTC',
      updated_at  timestamptz NOT NULL DEFAULT now()
    );

    -- House pattern (migration 010 / schema_v2): denormalized org_id filled by
    -- the generic parent trigger + direct RLS policy.
    DROP TRIGGER IF EXISTS trg_set_org ON schedule_settings;
    CREATE TRIGGER trg_set_org BEFORE INSERT ON schedule_settings
      FOR EACH ROW EXECUTE FUNCTION set_org_from_parent('divisions', 'division_id');

    ALTER TABLE schedule_settings ENABLE ROW LEVEL SECURITY;
    ALTER TABLE schedule_settings FORCE  ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS schedule_settings_tenant ON schedule_settings;
    CREATE POLICY schedule_settings_tenant ON schedule_settings FOR ALL TO app_user
      USING (org_id = current_org_id()) WITH CHECK (org_id = current_org_id());
    GRANT SELECT, INSERT, UPDATE, DELETE ON schedule_settings TO app_user;
  END IF;
END $$;

-- Entitlements (doc 12 §5). scheduling.constraints already seeded by 012;
-- scheduling.board (drag-and-drop editing; Community = view-only) and the
-- competition-wide multi-division board are new.
INSERT INTO plan_entitlements (plan_key, feature_key, bool_value, int_value) VALUES
  ('community', 'scheduling.board',          false, null),
  ('pro',       'scheduling.board',          true,  null),
  ('business',  'scheduling.board',          true,  null),
  ('community', 'scheduling.multi_division', false, null),
  ('pro',       'scheduling.multi_division', true,  null),
  ('business',  'scheduling.multi_division', true,  null)
ON CONFLICT (plan_key, feature_key) DO NOTHING;
