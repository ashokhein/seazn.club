-- =============================================================================
-- Migration 017: Day-of device links (PROMPT-21, doc 13 §7).
--
-- device_links: fixture-scoped, account-less scoring tokens — sha256 stored,
-- secret shown once (api_keys pattern), end-of-day expiry, one live device
-- per fixture (enforced in the use-case: minting revokes prior links).
--
-- score_events.device_link_id rides OUTSIDE the hash-chain canonical string
-- (the trigger's concat_ws lists its fields explicitly), so existing chains
-- stay valid — proven by a migration test in device-links.test.ts.
--
-- Ordering note (014's pattern): guarded — on a fresh bootstrap apply-db runs
-- migrations BEFORE schema_v2.sql; the same shape is re-created there.
-- =============================================================================

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'fixtures') THEN
    CREATE TABLE IF NOT EXISTS device_links (
      id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      fixture_id  uuid NOT NULL REFERENCES fixtures(id) ON DELETE CASCADE,
      token_hash  text NOT NULL UNIQUE,          -- sha256, secret shown once
      label       text,                          -- 'Court 3 phone'
      issued_by   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at  timestamptz NOT NULL,          -- end of the fixture's local day
      revoked_at  timestamptz,
      created_at  timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS device_links_fixture_idx ON device_links(fixture_id);

    -- House pattern (migration 010 / schema_v2): org_id filled from the
    -- fixture parent + direct RLS policy.
    DROP TRIGGER IF EXISTS trg_set_org ON device_links;
    CREATE TRIGGER trg_set_org BEFORE INSERT ON device_links
      FOR EACH ROW EXECUTE FUNCTION set_org_from_parent('fixtures', 'fixture_id');

    ALTER TABLE device_links ENABLE ROW LEVEL SECURITY;
    ALTER TABLE device_links FORCE  ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS device_links_tenant ON device_links;
    CREATE POLICY device_links_tenant ON device_links FOR ALL TO app_user
      USING (org_id = current_org_id()) WITH CHECK (org_id = current_org_id());
    GRANT SELECT, INSERT, UPDATE, DELETE ON device_links TO app_user;

    -- Attribution rider (doc 13 §7): distinguishes hand-recorded from
    -- device-link events. NOT part of the hash-chain canonical.
    ALTER TABLE score_events ADD COLUMN IF NOT EXISTS
      device_link_id uuid REFERENCES device_links(id) ON DELETE SET NULL;
  END IF;
END $$;

-- Entitlement (doc 13 §7): Pro/Business only — Community keeps the one
-- account-scorer seat as the taste of delegation (doc 13 §5).
INSERT INTO plan_entitlements (plan_key, feature_key, bool_value, int_value) VALUES
  ('community', 'scoring.device_links', false, null),
  ('pro',       'scoring.device_links', true,  null),
  ('business',  'scoring.device_links', true,  null)
ON CONFLICT (plan_key, feature_key) DO NOTHING;
