-- ============================================================
-- V285 — Free plain exports (v12).
-- Community orgs may now export documents (order of play, standings, roster,
-- participants, match sheets, officials rota, admit tickets). The courtside
-- chrome — masthead, org logo, tier-grouped sponsor line, live-page QR — stays
-- gated on `exports.branded` (Pro, V247), so community exports render PLAIN:
-- clean tables + a "Powered by seazn.club" footer. Branded print stays the Pro
-- upsell. Idempotent.
-- ============================================================

UPDATE plan_entitlements
   SET bool_value = true
 WHERE plan_key = 'community' AND feature_key = 'exports';
