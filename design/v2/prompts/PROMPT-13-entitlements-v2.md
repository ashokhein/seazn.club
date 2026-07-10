# PROMPT-13 — Entitlements v2

**Read first:** `engine/10-pro-entitlements.md` (normative matrix); existing
`src/lib/entitlements.ts`, `supabase/migrations/001_billing.sql`. Preamble: PROMPT-00.
Depends: PROMPT-10 (v2 tables), PROMPT-11 (gates live in use-cases).

## Task
1. Migration: seed the full doc 10 matrix into `plan_entitlements` (community/pro rows;
   `business` plan row with `is_public=false`, dark). Keep v1 keys until PROMPT-15 removes
   them.
2. Wire gates at the placements mandated by 10 §2:
   - quota checks (`withinLimit`) in creation use-cases: competitions, divisions,
     entrants, stages, public dashboards.
   - fidelity gates at the scoring endpoint: derive the event-type → feature map from
     each module's `fidelityTiers` declaration (`engine/14-score-granularity.md` §4),
     not a hand-kept table (`cricket.ball` → `scoring.ball_by_ball`, `*.rally` →
     `scoring.rally_by_rally`, timeline events → `scoring.match_timeline`); Tier 0/1
     events always pass. 402 payload carries `feature_key`.
   - `cricket.dls` gate on `revise` with computed target (manual umpire target always allowed).
   - public read model: branding/player-profile fields nulled server-side without
     `dashboard.branding` / `dashboard.player_profiles`.
   - API keys → `api.access`; write scopes + webhooks → `api.write` (Business).
3. `entitlement-freeze.ts` per 10 §2.4: downgrade ⇒ over-quota resources read-only with
   `frozen` flag in read models; no deletion ever; unit-test the freeze selector
   (which N resources stay active: most recently active first).
4. Upgrade-moment UX hooks: 402 responses include `feature_key` + human reason; add a
   single `<UpgradeGate feature>` client component consumed at the doc 10 §3 touchpoints.
5. Extend `/api/orgs/[id]/entitlements` read endpoint to the v2 key set (UI show/hide).

## Acceptance
- Matrix test: for each feature_key × plan, a table-driven test asserts allow/deny at the
  enforcement point (not just `hasFeature`).
- Downgrade simulation: pro → community org keeps data, over-quota frozen, coarse scoring
  still works.
- Redis-down path still fail-opens reads / fail-closes at documented points (existing
  invariants preserved).
