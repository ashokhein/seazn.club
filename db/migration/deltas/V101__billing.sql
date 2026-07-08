-- ============================================================
-- 001 — Billing: plans, subscriptions, entitlements
-- Safe to run on an existing database (all idempotent).
-- ============================================================

-- 1. Org lifecycle columns
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS status      text NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS deleted_at  timestamptz,
  ADD COLUMN IF NOT EXISTS purge_after timestamptz;

-- 2. Plans catalog
CREATE TABLE IF NOT EXISTS plans (
  key                     text PRIMARY KEY,
  name                    text NOT NULL,
  stripe_price_id_monthly text,
  stripe_price_id_annual  text,
  is_public               boolean NOT NULL DEFAULT true,
  created_at              timestamptz NOT NULL DEFAULT now()
);

INSERT INTO plans (key, name) VALUES
  ('community', 'Community'),
  ('pro',       'Pro')
ON CONFLICT (key) DO NOTHING;

-- 3. Subscriptions — one per org, defaults to community
CREATE TABLE IF NOT EXISTS subscriptions (
  org_id                  uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  plan_key                text NOT NULL REFERENCES plans(key) DEFAULT 'community',
  status                  text NOT NULL DEFAULT 'active',
  stripe_customer_id      text,
  stripe_subscription_id  text,
  current_period_end      timestamptz,
  trial_end               timestamptz,
  cancel_at_period_end    boolean NOT NULL DEFAULT false,
  updated_at              timestamptz NOT NULL DEFAULT now()
);

-- Back-fill existing orgs onto community plan
INSERT INTO subscriptions (org_id, plan_key, status)
  SELECT id, 'community', 'active' FROM organizations
ON CONFLICT (org_id) DO NOTHING;

-- 4. Plan entitlement matrix
CREATE TABLE IF NOT EXISTS plan_entitlements (
  plan_key    text NOT NULL REFERENCES plans(key),
  feature_key text NOT NULL,
  bool_value  boolean,
  int_value   integer,  -- null = unlimited
  PRIMARY KEY (plan_key, feature_key)
);

INSERT INTO plan_entitlements (plan_key, feature_key, bool_value, int_value) VALUES
  -- Community (free)
  ('community', 'branding',                   false, null),
  ('community', 'exports',                    false, null),
  ('community', 'realtime',                   false, null),
  -- Pro ($20/mo)
  ('pro', 'branding',                         true,  null),
  ('pro', 'exports',                          true,  null),
  ('pro', 'realtime',                         true,  null)
ON CONFLICT (plan_key, feature_key) DO NOTHING;

-- 5. Per-org overrides (Enterprise deals / grandfathering)
CREATE TABLE IF NOT EXISTS org_entitlement_overrides (
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  feature_key text NOT NULL,
  bool_value  boolean,
  int_value   integer,
  reason      text,
  PRIMARY KEY (org_id, feature_key)
);

-- 6. Stripe webhook idempotency log
CREATE TABLE IF NOT EXISTS billing_events (
  id            text PRIMARY KEY,
  type          text NOT NULL,
  org_id        uuid REFERENCES organizations(id),
  payload       jsonb NOT NULL,
  received_at   timestamptz NOT NULL DEFAULT now(),
  processed_at  timestamptz
);
