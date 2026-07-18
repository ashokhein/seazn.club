-- ============================================================
-- V286 — v13 real-competition fidelity (PROMPT-60 + PROMPT-63)
-- 1) entrants.badge_url: lightweight per-entrant crest/badge/flag — an
--    external URL or an assets-bucket storage path. Sport- and club-
--    independent so free orgs get team imagery without clubs.hierarchy.
-- 2) scoring.audit_export: Pro feature key gating the signed per-match
--    audit-ledger download (JSON + PDF). The score_events hash chain
--    itself (V226) is unchanged and runs for every tier.
-- ============================================================

alter table entrants add column badge_url text;

insert into plan_entitlements (plan_key, feature_key, bool_value, int_value) values
  ('community', 'scoring.audit_export', false, null),
  ('pro',       'scoring.audit_export', true,  null),
  ('business',  'scoring.audit_export', true,  null)
on conflict (plan_key, feature_key) do nothing;
