# Pro Plus Tier — Design (Spec 1 of 2)

Date: 2026-07-18. Status: approved.
Companion: Spec 2 (custom domains — DNS verify, Fly certs, Host routing) is a
SEPARATE spec/branch that starts after this ships. This spec only *seeds* its
entitlement key.

## Goal

Introduce a third self-serve plan **Pro Plus** (`pro_plus`, $39/mo · $390/yr)
above Pro, re-tier two existing features onto it, add two new quota gates
(officials per fixture, schedule save points), expand the public pricing page
to a full 4-plan feature matrix, and add an `/admin/entitlements` reference
page. One migration (V286). The ladder becomes:

Community (free) → Event Pass ($39 one-time/comp) → Pro ($20/mo) → **Pro Plus
($39/mo)** → Enterprise (mailto, unchanged).

## Background facts (verified 2026-07-18)

- Entitlements resolve from `plan_entitlements(plan_key, feature_key,
  bool_value, int_value)` via `apps/web/src/lib/entitlements.ts`:
  override → Event Pass (community orgs only) → plan row → **null = deny**.
  `int_value null = unlimited`. 5-min cache; `invalidateOrgEntitlements` on
  writes. **A missing row denies** — every new plan needs a full column.
- Bool gates: `hasFeature`/`requireFeature` (402 carrying the key). Quotas:
  `getLimit`/`withinLimit`. Paywall copy: `lib/feature-copy.ts`
  (`featureReason`), rendered by 402 handlers and `components/upgrade-gate.tsx`
  identically. `featurePlan()` + `PlanBadge` name the cheapest unlocking plan.
- Pricing page (`app/[lang]/(marketing)/pricing/page.tsx`) renders its
  comparison table FROM `plan_entitlements` via `lib/pricing-matrix.ts`
  (currently 3 columns, ~15 hardcoded-English rows).
- Prices live in `apps/web/src/config/stripe-plans.json`; `npm run
  stripe:sync` creates products/prices (matched by lookup_key) and writes ids
  into `plans`. `planKeyForPrice` (lib/billing.ts) resolves any price id →
  plan_key generically, so checkout/webhook/reconcile are already
  plan-agnostic.
- Downgrade = freeze, never delete (`server/usecases/entitlement-freeze.ts`):
  over-quota resources stay readable, new creates blocked.
- A dark `business` plan (is_public=false, no prices, no subscribers) remains
  from pre-v3; comments call it retired. Its column is INCOMPLETE (no
  `embeds.enabled`/`public_pages` rows).
- Six keys are defined + have copy but are enforced nowhere:
  `officials.assignment`, `public_pages`, `dashboard.player_profiles`,
  `eligibility.enforced`, `stats.club_championship`, `api.write`.
- Save points today: `history.ts` checkpoint create allows 1 free, more
  requires bool `schedule.versioning` (Pro). Officials today: manual
  single-role assignment is UNGATED (free, unlimited); `officials.roles_multi`
  gates a 2nd role per fixture; `officials.auto` gates the solver.

## Decisions (user-approved)

| # | Decision |
|---|---|
| D1 | New plan key `pro_plus` (display "Pro Plus"). The dark `business` plan is fully retired: delete its `plan_entitlements` rows and `plans` row. |
| D2 | Price $39/mo, $390/yr. Currency set points (not FX): monthly eur 3700, gbp 3300, aud 5900, inr 299900; annual ×10. |
| D3 | Pro Plus = everything Pro has, plus: unlimited scale (`orgs.max_owned`, `members.max`, `scorers.max`, `stages.per_division.max`, `entrants.per_division.max`, `dashboard.public.max` already ∞ at pro, `import.bulk` cap), `registration.fee_percent = 1`, `api.write`, `scheduling.ai`, `officials.auto`, `domains.custom` (seed only), `support.priority`. |
| D4 | `scheduling.ai` and `officials.auto` MOVE up: `pro` → false. **Hard move, no grandfather** (pre-launch; only demo orgs hold Pro). |
| D5 | Free officials limited: new int key `officials.per_fixture.max` (community 1, pro ∞, pro_plus ∞). The never-enforced `officials.assignment` key is DELETED (matrix, copy, pricing row). |
| D6 | Save points quota-fied: new int key `schedule.checkpoints.max` (community 1 — unchanged behavior, pro 5, pro_plus ∞). `schedule.versioning` bool stays for scope locks. |
| D7 | Never move `dashboard.branding` (the "Powered by seazn.club" removal) — free badge is the PLG ad network; badge removal stays the Pro trigger. |
| D8 | The "?" above Pro Plus stays contact-sales Enterprise (existing mailto line). |
| D9 | Vestigial keys `public_pages`, `dashboard.player_profiles`, `eligibility.enforced`, `stats.club_championship` stay seeded (incl. pro_plus rows) but remain unenforced — out of scope. |
| D10 | Event Pass unchanged. It lifts nothing officials/checkpoints-related (its column stays as-is; missing keys fall through to community by design). |

## §1 Migration V286 (`db/migration/deltas/V286__pro_plus_plan.sql`)

Idempotent (upserts / `on conflict`), one file:

1. `insert into plans (key, name, is_public) values ('pro_plus','Pro Plus',true)`
   on conflict do nothing.
2. **Full `pro_plus` column** — a row for EVERY feature key (see matrix below).
3. Plan moves: update `pro` rows `scheduling.ai` → false, `officials.auto` →
   false.
4. New keys, all plans:
   - `officials.per_fixture.max`: community 1, pro ∞(null), pro_plus ∞.
   - `schedule.checkpoints.max`: community 1, pro 5, pro_plus ∞.
   - `domains.custom`: community false, pro false, pro_plus true.
   - `support.priority`: community false, pro false, pro_plus true.
   (No event_pass rows — deliberate fall-through to community.)
5. Retire business: `delete from plan_entitlements where plan_key='business'`;
   `delete from plans where key='business'` (no subscriptions reference it —
   guard with `not exists (select 1 from subscriptions where
   plan_key='business')` and leave a comment).
6. Delete `officials.assignment` rows from `plan_entitlements` (all plans).

### Full pro_plus column (int keys: null = unlimited)

Bool = true for: `api.access`, `api.write`, `branding`, `clubs.hierarchy`,
`cricket.dls`, `dashboard.branding`, `dashboard.player_profiles`,
`discovery.branding`, `discovery.featured`, `discovery.listed`,
`domains.custom`, `eligibility.enforced`, `embeds.enabled`, `exports`,
`exports.branded`, `formats.advanced`, `formats.double_elim`, `logos.bulk`,
`officials.auto`, `officials.roles_multi`, `public_pages`, `realtime`,
`registration.enabled`, `registration.paid`, `schedule.versioning`,
`scheduling.ai`, `scheduling.board`, `scheduling.constraints`,
`scheduling.multi_division`, `scoring.ball_by_ball`, `scoring.device_links`,
`scoring.match_timeline`, `scoring.rally_by_rally`, `sponsors.monetize`,
`sponsors.tiers`, `standings.carry_over`, `standings.custom_points`,
`stats.club_championship`, `stats.player`,
`support.priority`, `tiebreakers.custom`.

Int (null=∞) for: `competitions.max_active` ∞, `dashboard.public.max` ∞,
`divisions.per_competition.max` ∞, `entrants.per_division.max` ∞,
`members.max` ∞, `officials.per_fixture.max` ∞, `orgs.max_owned` ∞,
`registration.fee_percent` **1**, `schedule.checkpoints.max` ∞,
`scorers.max` ∞, `stages.per_division.max` ∞.

`import.bulk`: bool true + int null (community keeps bool true + int 20).

## §2 Enforcement changes

- **Officials per-fixture limit** (`server/usecases/officials.ts`): in every
  path that adds an official to a fixture (single assign + bulk/auto), count
  existing non-declined `fixture_officials` rows for that fixture and check
  `withinLimit(orgId, "officials.per_fixture.max", n + 1)` → 402 with the key.
  Existing over-limit rows are never removed (freeze principle). Copy:
  "Community includes one official per fixture — more need Pro."
- **Save points** (`server/usecases/history.ts` checkpoint create): replace
  the hardcoded 1-free + `schedule.versioning` check with `withinLimit(orgId,
  "schedule.checkpoints.max", n + 1)`. `schedule.versioning` keeps gating
  scope locks only. Copy updated in `feature-copy.ts` and `config/tips.ts`
  ("One save point is free; Pro includes five; Pro Plus is unlimited.").
- **api.write re-armed** (`server/usecases/api-keys.ts`): creating an API key
  with any write scope requires `requireFeature(orgId, "api.write")`. Read
  scopes stay `api.access`. Copy: "Write access via the API is a Pro Plus
  feature."
- Fee 1%, unlimited scale, AI/auto moves: matrix-only, zero code.

## §3 Billing & checkout

- `stripe-plans.json`: add `pro_plus` plan entry (lookup keys
  `seazn_pro_plus_monthly` / `seazn_pro_plus_annual`, amounts per D2) — the
  existing `stripe:sync` handles create + id writeback with no code change.
- `lib/currency.ts`: add `proPlusPrice(interval, currency)` beside `proPrice`.
- Org billing page (`app/o/[orgSlug]/settings/billing/page.tsx`): offer both
  paid plans. New checkouts pick Pro or Pro Plus (embedded checkout —
  `buildEmbeddedCheckoutParams` already takes any priceId). Existing
  subscription changes plan via the in-app manage flow (v3/11 proration,
  pinned proration_date) — extend the plan-change options with Pro Plus.
- Trial: unchanged — 14-day no-card, one per org (`trial_used_at`), applies
  to whichever paid plan is chosen first.
- `feature-copy.ts`: `BUSINESS_FEATURES`/`PaidPlan` become
  `PLUS_FEATURES: Set(["api.write","scorers.max","scheduling.ai",
  "officials.auto","domains.custom","support.priority"])`,
  `PaidPlan = "pro" | "pro_plus"`. `PlanBadge` renders "Pro Plus".
  `UpgradeGate` unchanged structurally (badge + reason + links).
- **Priority support**: when `support.priority`, the billing page shows a
  "Priority support" row with `plus@seazn.club`. Copy-level only.

## §4 Pricing page — 3 offers + Pro Plus reveal + full matrix

- **Cards**: Community / Event Pass / Pro stay the 3-up hero grid. Pro Plus is
  **progressively disclosed** (user decision 2026-07-18): below the grid a
  teaser card — "Need more scale? Unlimited seats, 1% platform fee,
  AI-assisted scheduling." with a **"Show Pro Plus"** button — and clicking it
  swaps in the full Pro Plus card ("Everything in Pro, plus…"). Client island
  `components/marketing/plus-reveal.tsx` (server-rendered card passed as
  children; `useState` starts hidden on both server and client — no hydration
  hazard). Reveal click fires new analytics event `pricing_plus_revealed`
  (canonical entry in `lib/analytics-events.ts`). New dictionary keys
  `pricing.plus.*` incl. teaser/reveal ×4 locales (en/fr/es/nl parity gate).
- The comparison **table always shows all four plan columns** — the reveal
  gates only the hero cards, never the data. Billing page (§3) keeps both
  paid plans visible (in-app buyers are qualified).
- **Comparison table = ALL feature keys**, grouped with sub-header rows:
  Scale · Formats & standings · Scheduling · Scoring & stats · Officials ·
  Public & brand · Registration & money · Data & platform. Columns:
  Community | Event Pass | Pro | Pro Plus. Pass column keeps its fall-through
  rendering (`passCell`).
- `lib/pricing-matrix.ts`: `PricingRow` gains `plus: string`; `ROWS` becomes
  grouped sections covering every customer-meaningful key (vestigial D9 keys
  are NOT listed — never advertise unenforced features); row labels move to
  dictionary keys (`pricing.matrix.<slug>`) — fixes today's EN-only labels.
  `loadMatrix` adds `pro_plus`.
- FAQ: new entry `pricing.faq.proPlus` (what's in Plus vs Pro) ×4 locales.
- Officials row becomes two honest rows: "Officials per fixture" (1 / — / ∞ /
  ∞) and "Multi-role & auto-assign officials" (— / — / multi-role / multi-role
  + auto).

## §5 /admin/entitlements reference page

New `app/admin/entitlements/page.tsx` + link in the admin nav:

- One live table straight from `plan_entitlements`, grouped by the §4 domains.
- Columns: feature key (mono) | type (bool/int) | Community | Event Pass |
  Pro | Pro Plus | description (`featureReason(key)`) | active overrides
  (count from `org_entitlement_overrides` where not expired, per key).
- Renders whatever keys exist in the DB (no hardcoded list) so it can't
  drift; unknown keys get the fallback reason string.
- English-only (admin console convention).

## §6 Downgrade semantics (Plus → Pro / → Community)

Existing freeze machinery, no new code beyond the two quota gates:
members over 15 freeze (existing), competitions unchanged (∞ both paid
plans), extra scorers stay but new scorer invites blocked (invite-time
enforcement — existing behavior), checkpoints/officials over the new limits
are kept but new creates are blocked, `scheduling.ai`/`officials.auto`
re-lock instantly, fee returns to 2%. Nothing is deleted.

## §7 Tests, smoke, help (repo mandates)

- Regression test per change (each fails without its change):
  resolver/matrix (pro_plus column complete — a test asserting every
  community key has a pro_plus row), officials 2nd-assign 402 on community /
  allowed on pro, checkpoint ladder (1/5/∞), api.write write-scope 402,
  `feePercentFor` = 1 for pro_plus, `buildPricingRows` 4-column output,
  admin entitlements page render, `featurePlan` mapping.
- `scripts/smoke.ts`: `proPlusSuite` — SQL plan-flip org → pro_plus (same
  trick as the pro flip), assert: officials 2nd assign blocked on community
  and allowed on pro_plus, checkpoint create past 1 blocked on community,
  fee resolution, pricing page shows 4 columns.
- Help (`apps/web/content/help/`): update pricing/billing article + officials
  + save-points articles for the new ladder; register any new slugs.
- i18n parity en/fr/es/nl for every new dictionary key.

## Out of scope

- Custom-domain infrastructure (Spec 2: `org_domains`, CNAME verification,
  Fly cert API, Host-routing middleware). Only the `domains.custom` key is
  seeded here.
- Enforcement for D9 vestigial keys.
- Any change to Event Pass contents or the attribution badge (D7).
- Scorer-seat freeze-on-downgrade (invite-time enforcement stays).
