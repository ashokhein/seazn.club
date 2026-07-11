-- =============================================================================
-- Admin plan tools (v3/08 §1)
-- =============================================================================
-- Comp-to-Pro with an end date: plan resolution treats an expired comp as
-- community at read time (lib/entitlements) — no scheduler needed.
alter table subscriptions
  add column if not exists comped_until timestamptz;

-- Entitlement overrides gain an expiry (the grandfathering tool): an expired
-- override is ignored at resolution time and swept opportunistically.
alter table org_entitlement_overrides
  add column if not exists expires_at timestamptz;
