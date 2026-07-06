-- =============================================================================
-- Migration 015: Scorer role, scoped assignments & seat quotas (PROMPT-18,
-- doc 13). Idempotent; v2-table blocks are guarded because on a fresh
-- bootstrap apply-db runs migrations BEFORE schema_v2.sql (see 014's note).
-- =============================================================================

-- org_members.role gains 'scorer' (doc 13 §2). The column had no CHECK — add
-- one covering the full v2 enum.
ALTER TABLE org_members DROP CONSTRAINT IF EXISTS org_members_role_check;
ALTER TABLE org_members ADD CONSTRAINT org_members_role_check
  CHECK (role IN ('owner','admin','viewer','scorer'));

ALTER TABLE org_invites DROP CONSTRAINT IF EXISTS org_invites_role_check;
ALTER TABLE org_invites ADD CONSTRAINT org_invites_role_check
  CHECK (role IN ('owner','admin','viewer','scorer'));

-- Scorer invites can carry a default scope (doc 13 §4): accepting creates
-- membership + assignment in one step. {type: 'competition'|'division'|
-- 'fixture', id: uuid}.
ALTER TABLE org_invites ADD COLUMN IF NOT EXISTS default_scope jsonb;

-- Scoped scorer assignments (doc 13 §3, verbatim shape). References
-- organizations/users which exist from schema.sql, so no guard needed.
CREATE TABLE IF NOT EXISTS scorer_assignments (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope_type text NOT NULL CHECK (scope_type IN ('competition','division','fixture')),
  scope_id   uuid NOT NULL,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, user_id, scope_type, scope_id)
);
CREATE INDEX IF NOT EXISTS scorer_assignments_user_idx
  ON scorer_assignments(user_id, org_id);

-- House RLS pattern (migration 010): org_id is set explicitly by the invite/
-- assignment writers (no parent FK to derive it from), direct tenant policy.
ALTER TABLE scorer_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE scorer_assignments FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS scorer_assignments_tenant ON scorer_assignments;
CREATE POLICY scorer_assignments_tenant ON scorer_assignments FOR ALL TO app_user
  USING (org_id = current_org_id()) WITH CHECK (org_id = current_org_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON scorer_assignments TO app_user;

-- Division-level scorer capabilities (doc 13 §2). DEVIATION from the doc's
-- "division config keys": divisions.config is the sport-module-validated
-- snapshot (unknown keys are stripped by the module schema), so these live as
-- columns instead.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'divisions') THEN
    ALTER TABLE divisions ADD COLUMN IF NOT EXISTS scorer_can_finalize      boolean NOT NULL DEFAULT true;
    ALTER TABLE divisions ADD COLUMN IF NOT EXISTS scorer_can_enter_lineups boolean NOT NULL DEFAULT true;
  END IF;
END $$;

-- Seat quotas (doc 13 §5) were seeded by 012 (orgs.max_owned 1/5/∞,
-- members.max 3/10/∞, scorers.max 1/1/∞); no `seats.scorekeepers` row ever
-- shipped, so there is nothing to replace. Enforcement lands in code with
-- this migration.
