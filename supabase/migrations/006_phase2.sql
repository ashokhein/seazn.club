-- =============================================================================
-- Migration 006: Phase 2 — public pages + branding + realtime column
-- =============================================================================

-- Public tournament pages
ALTER TABLE tournaments
  ADD COLUMN IF NOT EXISTS is_public   boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS public_slug text UNIQUE;

CREATE INDEX IF NOT EXISTS tournaments_public_slug_idx ON tournaments(public_slug) WHERE public_slug IS NOT NULL;

-- Org branding
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS logo_url text;

-- Realtime state version (monotonic counter for debounce)
ALTER TABLE tournaments
  ADD COLUMN IF NOT EXISTS state_version bigint NOT NULL DEFAULT 0;

-- Entitlements: public_pages (missing from 001_billing.sql seed)
INSERT INTO plan_entitlements (plan_key, feature_key, bool_value, int_value) VALUES
  ('community', 'public_pages', true,  null),  -- basic, with "Powered by" badge
  ('pro',       'public_pages', true,  null)   -- full, no badge
ON CONFLICT (plan_key, feature_key) DO NOTHING;
