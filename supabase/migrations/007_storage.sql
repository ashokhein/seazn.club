-- =============================================================================
-- Migration 007: Supabase Storage paths for assets
-- =============================================================================

-- Players: store storage path separately; keep image_url for legacy data URLs
ALTER TABLE players
  ADD COLUMN IF NOT EXISTS image_storage_path text;

-- Orgs: logo via Storage (branding entitlement, Pro+)
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS logo_storage_path text;

-- Index for fast cleanup queries (delete player images when player removed)
CREATE INDEX IF NOT EXISTS players_image_storage_path_idx
  ON players(image_storage_path) WHERE image_storage_path IS NOT NULL;
