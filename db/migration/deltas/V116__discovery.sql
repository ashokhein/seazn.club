-- =============================================================================
-- Migration 016: Public discovery & homepage showcase (PROMPT-19, doc 15).
--
-- competitions gain the opt-in consent flag (`discoverable`), the organiser-
-- entered presentation blob (`discovery` — {city?, country?, tagline?,
-- hero_image_path?}), and the staff curation flags (`discovery_blocked`,
-- `discovery_featured`). public_discovery_v is the ONLY read model discovery
-- surfaces touch (doc 15 §4) — it never exposes person data.
--
-- Ordering note (014's pattern): on a fresh bootstrap apply-db runs migrations
-- BEFORE schema_v2.sql, so v2-touching blocks are guarded and no-op; the same
-- shape is (re)created idempotently by schema_v2.sql.
-- =============================================================================

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'competitions') THEN
    -- Doc 15 §1: public ≠ discoverable. Opt-in defaults OFF.
    ALTER TABLE competitions ADD COLUMN IF NOT EXISTS discoverable boolean NOT NULL DEFAULT false;
    ALTER TABLE competitions ADD COLUMN IF NOT EXISTS discovery jsonb NOT NULL DEFAULT '{}';
    -- Staff curation (doc 15 §3): abuse block + the curated featured row.
    ALTER TABLE competitions ADD COLUMN IF NOT EXISTS discovery_blocked  boolean NOT NULL DEFAULT false;
    ALTER TABLE competitions ADD COLUMN IF NOT EXISTS discovery_featured boolean NOT NULL DEFAULT false;

    CREATE INDEX IF NOT EXISTS competitions_discoverable_idx
      ON competitions(discoverable) WHERE discoverable;

    -- Division-independent competition event ledger (doc 15 §1: opt-in/out is
    -- "recorded as a division-independent competition event, audited
    -- who/when"). Append-only by grants: no UPDATE/DELETE for app_user.
    CREATE TABLE IF NOT EXISTS competition_events (
      id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      competition_id uuid NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
      org_id         uuid NOT NULL,
      type           text NOT NULL,               -- 'discovery.opt_in' | 'discovery.opt_out' | …
      payload        jsonb NOT NULL DEFAULT '{}',
      actor_id       uuid REFERENCES users(id) ON DELETE SET NULL,
      created_at     timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS competition_events_comp_idx
      ON competition_events(competition_id, created_at);

    DROP TRIGGER IF EXISTS trg_set_org ON competition_events;
    CREATE TRIGGER trg_set_org BEFORE INSERT ON competition_events
      FOR EACH ROW EXECUTE FUNCTION set_org_from_parent('competitions', 'competition_id');

    ALTER TABLE competition_events ENABLE ROW LEVEL SECURITY;
    ALTER TABLE competition_events FORCE  ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS competition_events_tenant ON competition_events;
    CREATE POLICY competition_events_tenant ON competition_events FOR ALL TO app_user
      USING (org_id = current_org_id()) WITH CHECK (org_id = current_org_id());
    REVOKE ALL ON competition_events FROM app_user;
    GRANT SELECT, INSERT ON competition_events TO app_user;

    -- ---------------------------------------------------------------------
    -- public_discovery_v (doc 15 §4): discoverable ∧ public ∧ not blocked ∧
    -- org active ∧ quality floor (org email-verified owner + ≥1 decided
    -- fixture or a published schedule — a division past 'setup'). Joined to
    -- minimal live info only; NO person data rides on this view, ever.
    -- Superuser-owned: bypasses RLS to serve anonymous homepage traffic.
    -- ---------------------------------------------------------------------
    CREATE OR REPLACE VIEW public_discovery_v AS
    SELECT c.id,
           c.name,
           c.slug,
           c.starts_on,
           c.ends_on,
           c.status,
           c.created_at,
           c.discovery->>'city'    AS city,
           c.discovery->>'country' AS country,
           -- Presentation depth is the paid layer (doc 15 §5): tagline/hero
           -- render only with `discovery.branding`.
           CASE WHEN org_has_feature(c.org_id, 'discovery.branding')
                THEN c.discovery->>'tagline' END AS tagline,
           CASE WHEN org_has_feature(c.org_id, 'discovery.branding')
                THEN c.discovery->>'hero_image_path' END AS hero_image_path,
           -- Featured slot: staff-curated flag, honoured only while the org
           -- holds the Pro perk (doc 15 §3 — eligible, not guaranteed).
           (c.discovery_featured
             AND org_has_feature(c.org_id, 'discovery.featured')) AS featured,
           o.name AS org_name,
           o.slug AS org_slug,
           (SELECT array_agg(DISTINCT d.sport_key)
              FROM divisions d WHERE d.competition_id = c.id)     AS sports,
           (SELECT count(*)::int FROM entrants e
              JOIN divisions d ON d.id = e.division_id
             WHERE d.competition_id = c.id
               AND e.status IN ('registered','confirmed'))        AS entrant_count,
           (SELECT count(*)::int FROM fixtures f
             WHERE f.division_id IN (SELECT id FROM divisions d WHERE d.competition_id = c.id)
               AND f.status = 'in_play')                          AS in_play_count,
           (SELECT min(f.scheduled_at) FROM fixtures f
              JOIN divisions d ON d.id = f.division_id
             WHERE d.competition_id = c.id
               AND d.status <> 'setup'                            -- publish-gated (doc 12 §1)
               AND f.status = 'scheduled'
               AND f.scheduled_at >= now())                       AS next_fixture_at
    FROM competitions c
    JOIN organizations o ON o.id = c.org_id
    WHERE c.discoverable
      AND c.visibility = 'public'
      AND NOT c.discovery_blocked
      AND o.status = 'active'
      -- Quality floor (doc 15 §3): email-verified owner…
      AND EXISTS (SELECT 1 FROM org_members m JOIN users u ON u.id = m.user_id
                   WHERE m.org_id = o.id AND m.role = 'owner' AND u.email_verified)
      -- …and ≥1 decided fixture OR a published schedule (division past setup).
      AND (EXISTS (SELECT 1 FROM fixtures f JOIN divisions d ON d.id = f.division_id
                    WHERE d.competition_id = c.id
                      AND f.status IN ('decided','finalized'))
        OR EXISTS (SELECT 1 FROM divisions d
                    WHERE d.competition_id = c.id
                      AND d.status IN ('scheduled','active','completed')));

    GRANT SELECT ON public_discovery_v TO app_user;
  END IF;
END $$;

-- Entitlements (doc 15 §5). Listing stays free deliberately — every Community
-- tournament on the homepage sells the platform; depth of presentation and the
-- featured row are the paid layer.
INSERT INTO plan_entitlements (plan_key, feature_key, bool_value, int_value) VALUES
  ('community', 'discovery.listed',   true,  null),
  ('pro',       'discovery.listed',   true,  null),
  ('business',  'discovery.listed',   true,  null),
  ('community', 'discovery.featured', false, null),
  ('pro',       'discovery.featured', true,  null),
  ('business',  'discovery.featured', true,  null),
  ('community', 'discovery.branding', false, null),
  ('pro',       'discovery.branding', true,  null),
  ('business',  'discovery.branding', true,  null)
ON CONFLICT (plan_key, feature_key) DO NOTHING;
