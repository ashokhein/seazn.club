# PROMPT-36 — Pricing & Packaging v3: Plan Matrix, Event Pass, Multi-Currency, Marketing, Funnel

**Read first:** `v3/07-pricing-packaging-v3.md` (normative); `engine/10-pro-entitlements.md`;
billing-map memory gotchas (`ui_mode: "embedded_page"` — do NOT rename; reconcile-on-return;
`stripe:sync` lookup keys). Preamble: PROMPT-00.

## Task
1. **Plan matrix** (v3/07 §2): update `plan_entitlements` seed to the v3 numbers (orgs,
   active comps, divisions/comp, entrants/div, members, badge removal, fee %); new
   entitlement keys where missing; grandfather existing over-cap free orgs via
   `entitlement_overrides` backfill migration; freeze machinery must honour new keys.
2. **Event Pass** (v3/07 §3): `competition_passes` table; resolution order org-override →
   comp-pass → plan → deny with `competition_id` context in `checkFeature()` + cache key
   `ent:<org>:<comp>:<feature>`; one-time Stripe checkout (embedded + reconcile-on-return,
   `stripe-plans.json` + sync extension for one-time price); `<UpgradeGate>` two-button
   variant ($39 pass / $20 Pro) on every in-competition 402; Pro-org purchase blocked;
   passes survive downgrade.
3. **Multi-currency + annual** (v3/07 §4): `currency_options` on all prices (USD/EUR/GBP/
   INR/AUD, set price points from doc); org-country selection + pricing-page switcher;
   `subscriptions.currency`; annual toggle default-on with "billed yearly — save 17%".
4. **Marketing** (v3/07 §5): home hero rewrite + three-offer pricing teaser; pricing page
   three columns rendered **from `plan_entitlements` data**, currency switcher, FAQ; zero
   "Business" mentions (PROMPT-32 grep gate covers).
5. **Start funnel** (v3/07 §6): `/start` 3-step wizard (no auth) with live format-preview
   recommendation; `funnel_drafts` {payload, single-use token, 7d expiry};
   `POST /api/funnel/start` → magic link carrying draft token; post-auth draft →
   org(if-none)+comp+division creation → land in comp; +24h reminder; conversion events
   into audit/analytics path.

## Acceptance
- Unit matrix: entitlement resolution (override × pass × plan) for free/pass/pro incl.
  cache invalidation on pass purchase; `buildEmbeddedCheckoutParams` currency/one-time
  snapshots (keep pure + unit-tested).
- E2E: hit division cap on free → two-button gate → pass checkout (test mode or SQL
  analogue per test-infra memory) → reconcile on return lifts gate for that comp only;
  funnel wizard → magic-link `login_url` → lands inside created competition; pricing page
  switches currency and shows no Business column.
- smoke.ts: free, event-pass, and pro paths (house rule); `npm test` + `tsc` green;
  `stripe:sync` idempotent re-run documented; update v3/README status.
