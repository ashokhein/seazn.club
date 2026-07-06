-- =============================================================================
-- Migration 018: Online registration & entry fees (PROMPT-20a, doc 16 §1.1).
--
-- registration_settings: per-division registration window, capacity, entry fee
-- and the bounded custom-form definition. registrations: the public-submitted
-- rows that materialise into entrants on confirm (idempotent — entrant_id set
-- once). Stripe Connect columns land on organizations (Express account; the
-- platform takes an application fee % on entry-fee checkouts).
--
-- Ordering note (014's pattern): guarded — on a fresh bootstrap apply-db runs
-- migrations BEFORE schema_v2.sql; the same shape is re-created there.
-- =============================================================================

-- organizations is v1 (always present): Stripe Connect Express onboarding
-- state. charges_enabled mirrors Stripe's flag via account.updated webhooks +
-- reconcile-on-return; it gates paid registration checkout, never free flows.
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS stripe_account_id text;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS stripe_charges_enabled boolean NOT NULL DEFAULT false;
CREATE UNIQUE INDEX IF NOT EXISTS organizations_stripe_account_idx
  ON organizations(stripe_account_id) WHERE stripe_account_id IS NOT NULL;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'divisions') THEN
    -- -----------------------------------------------------------------------
    -- Per-division registration settings (doc 16 §1.1): open/close window,
    -- fee, capacity, custom form fields. One row per division; absence =
    -- registration not configured. form_fields is the BOUNDED builder output:
    -- [{key, label, kind: 'text'|'select'|'checkbox', options?, required}].
    -- refund_lock_at: withdrawals auto-refund before it, organiser-discretion
    -- after (doc 16 §1.1 refund policy).
    -- -----------------------------------------------------------------------
    CREATE TABLE IF NOT EXISTS registration_settings (
      division_id    uuid PRIMARY KEY REFERENCES divisions(id) ON DELETE CASCADE,
      org_id         uuid NOT NULL,
      enabled        boolean NOT NULL DEFAULT false,
      entrant_kind   text NOT NULL DEFAULT 'individual'
                     CHECK (entrant_kind IN ('team','individual','pair')),
      opens_at       timestamptz,
      closes_at      timestamptz,
      capacity       int CHECK (capacity > 0),
      fee_cents      int NOT NULL DEFAULT 0 CHECK (fee_cents >= 0),
      currency       text NOT NULL DEFAULT 'usd',
      refund_lock_at timestamptz,
      form_fields    jsonb NOT NULL DEFAULT '[]',
      updated_at     timestamptz NOT NULL DEFAULT now()
    );

    DROP TRIGGER IF EXISTS trg_set_org ON registration_settings;
    CREATE TRIGGER trg_set_org BEFORE INSERT ON registration_settings
      FOR EACH ROW EXECUTE FUNCTION set_org_from_parent('divisions', 'division_id');

    ALTER TABLE registration_settings ENABLE ROW LEVEL SECURITY;
    ALTER TABLE registration_settings FORCE  ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS registration_settings_tenant ON registration_settings;
    CREATE POLICY registration_settings_tenant ON registration_settings FOR ALL TO app_user
      USING (org_id = current_org_id()) WITH CHECK (org_id = current_org_id());
    GRANT SELECT, INSERT, UPDATE, DELETE ON registration_settings TO app_user;

    -- -----------------------------------------------------------------------
    -- Registrations (doc 16 §1.1). Status machine:
    --   pending    — submitted; awaiting payment (paid divisions) or organiser
    --                approval; holds a capacity spot
    --   paid       — Stripe checkout completed, entrant not yet materialised
    --                (transient: confirm runs in the same webhook handling)
    --   confirmed  — entrant materialised (entrant_id set exactly once)
    --   waitlisted — over capacity; auto-promoted on withdrawal (oldest first)
    --   withdrawn  — terminal; frees the spot, may trigger auto-refund
    -- dob/gender collected for eligibility (doc 06) — NEVER exposed publicly.
    -- access_token_hash: registrant self-service (status page / withdraw /
    -- resume payment) without an account — sha256, secret shown once.
    -- Public submissions insert via the service role (superuser sql), like
    -- the public read models; organiser access rides RLS as usual.
    -- -----------------------------------------------------------------------
    CREATE TABLE IF NOT EXISTS registrations (
      id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      division_id         uuid NOT NULL REFERENCES divisions(id) ON DELETE CASCADE,
      org_id              uuid NOT NULL,
      status              text NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending','paid','confirmed','waitlisted','withdrawn')),
      display_name        text NOT NULL,
      contact_email       text NOT NULL,
      dob                 date,
      gender              text CHECK (gender IN ('m','f','x')),
      guardian_name       text,
      guardian_consent    boolean NOT NULL DEFAULT false,
      answers             jsonb NOT NULL DEFAULT '{}',
      amount_cents        int NOT NULL DEFAULT 0,
      currency            text,
      checkout_session_id text,
      payment_intent_id   text,
      refunded_cents      int NOT NULL DEFAULT 0,
      refunded_at         timestamptz,
      access_token_hash   text NOT NULL UNIQUE,
      entrant_id          uuid REFERENCES entrants(id) ON DELETE SET NULL,
      promoted_at         timestamptz,
      withdrawn_at        timestamptz,
      created_at          timestamptz NOT NULL DEFAULT now(),
      updated_at          timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS registrations_division_idx
      ON registrations(division_id, status, created_at);
    CREATE INDEX IF NOT EXISTS registrations_org_idx ON registrations(org_id);
    CREATE INDEX IF NOT EXISTS registrations_checkout_idx
      ON registrations(checkout_session_id) WHERE checkout_session_id IS NOT NULL;

    DROP TRIGGER IF EXISTS trg_set_org ON registrations;
    CREATE TRIGGER trg_set_org BEFORE INSERT ON registrations
      FOR EACH ROW EXECUTE FUNCTION set_org_from_parent('divisions', 'division_id');

    ALTER TABLE registrations ENABLE ROW LEVEL SECURITY;
    ALTER TABLE registrations FORCE  ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS registrations_tenant ON registrations;
    CREATE POLICY registrations_tenant ON registrations FOR ALL TO app_user
      USING (org_id = current_org_id()) WITH CHECK (org_id = current_org_id());
    GRANT SELECT, INSERT, UPDATE ON registrations TO app_user;
  END IF;
END $$;

-- Entitlements (doc 16 §1.1): free-event registration on every plan — it fills
-- the funnel; charging entry fees (Stripe Connect) is the paid layer.
INSERT INTO plan_entitlements (plan_key, feature_key, bool_value, int_value) VALUES
  ('community', 'registration.enabled', true,  null),
  ('pro',       'registration.enabled', true,  null),
  ('business',  'registration.enabled', true,  null),
  ('community', 'registration.paid',    false, null),
  ('pro',       'registration.paid',    true,  null),
  ('business',  'registration.paid',    true,  null)
ON CONFLICT (plan_key, feature_key) DO NOTHING;
