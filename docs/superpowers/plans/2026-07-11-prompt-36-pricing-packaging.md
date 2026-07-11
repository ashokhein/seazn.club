# PROMPT-36 — Pricing & Packaging v3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Plan matrix v3 + per-competition Event Pass ($39 one-time) + multi-currency/annual pricing + marketing home/pricing rewrite + no-auth `/start` funnel that converts a visitor into a live competition via one emailed link.

**Architecture:** Event Pass reuses `plan_entitlements` as a fourth column (`plan_key='event_pass'`, dark plan row) so the pricing table renders all offers from one table. Entitlement resolution gains an optional `competitionId`: override → (community org + pass on that comp → event_pass matrix) → plan → deny. Pass is deliberately ignored for non-community plans — that's how "pass becomes moot under Pro, revives on downgrade" falls out for free. Funnel uses a single emailed link whose draft token both proves email ownership (like `login_links`) and carries the competition payload.

**Tech Stack:** Next.js (repo version — read node_modules/next/dist/docs before route work), postgres.js, Flyway deltas (next: V270+), Stripe embedded checkout (`ui_mode: "embedded_page"` — NEVER rename), Resend via compose.ts, vitest (DB-backed on :54329), Playwright e2e, smoke.ts.

## Global Constraints

- `ui_mode: "embedded_page"` — do NOT change (stripe-node v22 name; prior revert).
- Reconcile-on-return is the source of truth; webhook optional.
- Zero "Business" strings on marketing surfaces (`scripts/check-plan-scrub.sh` gate).
- Every change ships a regression test that fails without it (house rule).
- smoke.ts extended: free + event-pass + pro paths.
- `tsc` + unit tests green before push; forms use `.input`/`.label` defaults.
- db: local dev DB :5432 `seazn`, schema `seazn_club` (`set search_path=seazn_club`); test DB recipe :54329.
- Non-USD prices are SET price points, not FX conversions.

---

### Task 1: Migrations V270–V272 (matrix v3, event_pass plan, passes, grandfather, funnel, currency)

**Files:**
- Create: `db/migration/deltas/V270__pricing_v3_matrix.sql`
- Create: `db/migration/deltas/V271__competition_passes.sql`
- Create: `db/migration/deltas/V272__funnel_drafts_and_currency.sql`

**V270** — plan numbers change with `on conflict … do update` (older seeds used `do nothing`; values here MUST overwrite):

```sql
-- v3/07 §2 plan matrix. Changed numbers only; unchanged rows not repeated.
insert into plan_entitlements (plan_key, feature_key, bool_value, int_value) values
  ('community', 'competitions.max_active',       null, 1),
  ('community', 'divisions.per_competition.max', null, 2),
  ('pro',       'orgs.max_owned',                null, 3),
  ('pro',       'divisions.per_competition.max', null, null),
  ('pro',       'entrants.per_division.max',     null, 256),
  ('pro',       'members.max',                   null, 15)
on conflict (plan_key, feature_key) do update
  set bool_value = excluded.bool_value, int_value = excluded.int_value;

-- Event Pass = dark plan row so plan_entitlements holds all offers (pricing
-- page renders from data). Not subscribable; resolution consults it only for
-- community orgs holding a pass on the competition in scope.
insert into plans (key, name, is_public) values ('event_pass', 'Event Pass', false)
on conflict (key) do nothing;

alter table plans add column if not exists stripe_price_id_onetime text;

insert into plan_entitlements (plan_key, feature_key, bool_value, int_value) values
  ('event_pass', 'divisions.per_competition.max', null, 10),
  ('event_pass', 'entrants.per_division.max',     null, 32),
  ('event_pass', 'members.max',                   null, 5),
  ('event_pass', 'formats.advanced',              true, null),
  ('event_pass', 'formats.double_elim',           true, null),
  ('event_pass', 'registration.paid',             true, null),
  ('event_pass', 'branding',                      true, null),
  ('event_pass', 'dashboard.branding',            false, null),
  ('event_pass', 'exports',                       true, null),
  ('event_pass', 'realtime',                      true, null)
on conflict (plan_key, feature_key) do update
  set bool_value = excluded.bool_value, int_value = excluded.int_value;

-- Per-plan platform fee on entry fees (v3/07 §2): pass 5%, pro 2%.
insert into plan_entitlements (plan_key, feature_key, bool_value, int_value) values
  ('event_pass', 'registration.fee_percent', null, 5),
  ('pro',        'registration.fee_percent', null, 2),
  ('business',   'registration.fee_percent', null, 2)
on conflict (plan_key, feature_key) do update
  set bool_value = excluded.bool_value, int_value = excluded.int_value;

-- Grandfather (v3/07 §2): free orgs already over the new active-comp cap keep
-- their current count via override (override → pass → plan chain).
insert into org_entitlement_overrides (org_id, feature_key, int_value, reason)
select o.id, 'competitions.max_active', least(count(c.id), 2)::int, 'v3 pricing grandfather (2026-07)'
from organizations o
left join subscriptions s on s.org_id = o.id
join competitions c on c.org_id = o.id and c.status in ('draft','published','live')
where coalesce(s.plan_key, 'community') = 'community'
group by o.id having count(c.id) > 1
on conflict (org_id, feature_key) do nothing;
```

**V271** — `competition_passes` (mirror tenant RLS pattern of a recent tenant table, e.g. V264):

```sql
create table competition_passes (
  competition_id uuid primary key references competitions(id) on delete cascade,
  org_id         uuid not null references organizations(id) on delete cascade,
  pass_key       text not null default 'event_pass' references plans(key),
  stripe_payment_intent text,
  purchased_at   timestamptz not null default now()
);
create index competition_passes_org_idx on competition_passes(org_id);
-- + RLS enable + tenant policy per repo pattern (copy from V264).
```

**V272** — funnel drafts (pre-auth, like login_links: no org, no RLS tenant policy) + subscription currency:

```sql
create table funnel_drafts (
  id          uuid primary key default gen_random_uuid(),
  token       text not null unique,
  email       text not null,
  payload     jsonb not null,
  expires_at  timestamptz not null,
  used_at     timestamptz,
  reminded_at timestamptz,
  created_at  timestamptz not null default now()
);
create index funnel_drafts_reminder_idx on funnel_drafts(created_at) where used_at is null and reminded_at is null;

alter table subscriptions add column if not exists currency text;
```

**Steps:** write SQL → `npm run db:apply` (Flyway incremental — safe per memory) against local dev DB → verify `select * from plan_entitlements where plan_key='event_pass'` → check-rls passes.

### Task 2: Comp-scoped entitlement resolution (`lib/entitlements.ts`)

**Files:**
- Modify: `apps/web/src/lib/entitlements.ts`
- Test: `apps/web/src/server/usecases/__tests__/entitlements-v2.test.ts` (extend)

**Interfaces (produced):**
- `hasFeature(orgId, featureKey, competitionId?)`, `getLimit(orgId, featureKey, competitionId?)`, `withinLimit(orgId, featureKey, wouldBe, competitionId?)`, `requireFeature(orgId, featureKey, competitionId?)` — all existing callers compile unchanged.
- Cache key: `ent:<org>:<comp>:<feature>` when comp given, else `ent:<org>:<feature>`; `invalidateOrgEntitlements` pattern `ent:<org>:*` already covers both.

Resolution in `resolveFromDb`: org override (unchanged, wins) → if `competitionId` AND org plan resolves to `community` AND `competition_passes` row exists for that comp → `plan_entitlements` row for the pass's `pass_key`; if the pass matrix misses the key, fall through → plan → null. Single SQL round-trip preferred (one query with lateral/CTE) but two queries acceptable.

**Tests (failing first):** free org + pass comp → `entrants.per_division.max` = 32; same org, other comp → 16; pro org + pass comp → 256 (pass moot); override beats pass; key absent from pass matrix (e.g. `stats.player`) falls through to community deny; insert pass + `invalidateOrgEntitlements` → new value visible (cache invalidation).

### Task 3: Per-plan platform fee

**Files:**
- Modify: `apps/web/src/server/usecases/registrations.ts` (platformFeePercent → org/comp-aware; call site ~:781)
- Test: `apps/web/src/server/usecases/__tests__/registrations.test.ts`

`platformFeePercent()` stays pure default (env fallback); new `feePercentFor(orgId, competitionId)` = `getLimit(orgId,'registration.fee_percent', competitionId)` → fallback `platformFeePercent()`. Checkout path uses `feePercentFor`. Tests: pro org → 2; community+pass comp → 5; env override respected when no entitlement row.

### Task 4: Event Pass checkout (config, sync, params, API, reconcile, webhook)

**Files:**
- Modify: `apps/web/src/config/stripe-plans.json` (add `passes` array + `currency_options` on all prices)
- Modify: `scripts/stripe-sync.ts` (one-time price ensure + currency_options idempotent update + write `plans.stripe_price_id_onetime`)
- Modify: `apps/web/src/lib/billing.ts` (`buildPassCheckoutParams`, `reconcilePassCheckout`)
- Create: `apps/web/src/app/api/billing/pass-checkout/route.ts`
- Modify: `apps/web/src/app/api/webhooks/stripe/route.ts` (checkout.session.completed, mode=payment, pass metadata → idempotent insert)
- Test: `apps/web/src/lib/__tests__/billing.test.ts` (extend snapshot suite)

Price points (SET, minor units): pass usd 3900 / eur 3900 / gbp 3300 / inr 299900 / aud 5900. Pro monthly usd 2000 / eur 1900 / gbp 1600 / inr 149900 / aud 2900; annual = 10× each.

`buildPassCheckoutParams({priceId, orgId, competitionId, returnUrl, currency?, customerId?, customerEmail?})` → `{ ui_mode:"embedded_page", mode:"payment", metadata:{org_id, competition_id, pass_key:"event_pass"}, line_items:[{price,quantity:1}], return_url, automatic_tax, tax_id_collection, allow_promotion_codes, ...(currency ? {currency} : {}) }`. Pure, snapshot-tested (usd default + eur variant).

API guards: owner role; comp belongs to org; org plan is community (Pro → 400 "Pro already covers this"); no existing pass (400); 503 if price unsynced. `reconcilePassCheckout(orgId, sessionId)`: session metadata must match org; `payment_status === "paid"` → insert `competition_passes` on conflict do nothing (+ payment_intent id) → `invalidateOrgEntitlements`. Never throws.

### Task 5: Two-button UpgradeGate + pass purchase page

**Files:**
- Modify: `apps/web/src/components/upgrade-gate.tsx` (optional `passHref` prop → two-button variant: "Upgrade this event — $39 one-time" + "Go Pro — $20/mo")
- Create: `apps/web/src/app/o/[orgSlug]/c/[compSlug]/upgrade/page.tsx` (embedded pass checkout, mirrors billing page checkout mount; reconciles on `?session_id` return; return_url = comp home `?pass=success&session_id=…`)
- Modify: `apps/web/src/lib/routes.ts` (`routes.compUpgrade(orgSlug, compSlug)`)
- Modify: in-competition gate call sites (divisions add, entrants add, formats picker, exports, schedule board — grep `<UpgradeGate` and pass `passHref` where a competition is in scope and the feature is in the pass matrix)
- Test: component render test (two buttons when passHref given, one otherwise); e2e in Task 8.

Comp home server component (or upgrade page itself) runs `reconcilePassCheckout` when `session_id` param present — same pattern as billing page.

### Task 6: Multi-currency + annual framing

**Files:**
- Create: `apps/web/src/lib/currency.ts` (SUPPORTED = usd/eur/gbp/inr/aud; `formatMinor(amount, currency)`; price-point lookup reading stripe-plans.json; Accept-Language → currency guess; cookie name `seazn_currency`)
- Modify: `apps/web/src/app/api/billing/checkout/route.ts` + `buildEmbeddedCheckoutParams` (optional `currency` → session currency)
- Modify: `apps/web/src/lib/billing.ts` `reconcileCheckout`/`syncSubscription` → persist `subscriptions.currency` from session/sub
- Create: `apps/web/src/components/currency-switcher.tsx` (client; sets cookie; router.refresh())
- Test: billing snapshot for currency param; currency.ts unit tests (format, language guess).

Annual toggle default-ON on pricing + billing: "$16.67/mo billed yearly — save 17%" (per-currency equivalent derived from price points).

### Task 7: Pricing page v3 + home hero + funnel wizard (design pass)

**Files:**
- Rewrite: `apps/web/src/app/pricing/page.tsx` — three columns Free / Event Pass / Pro rendered **from `plan_entitlements`** (server query, pivot by plan_key incl. event_pass; label map in new `apps/web/src/lib/pricing-matrix.ts` mapping feature_key → human row, ordered); annual toggle; currency switcher; FAQ rewrite (trial, downgrade/freeze, pass scope, fee %, annual); "Need more? Talk to us" mailto; zero Business.
- Rewrite hero of `apps/web/src/app/page.tsx` — funnel form as hero CTA (`sport ▾ / entrant count / start date` → `/start?…`), animated fixture-card strip (CSS keyframes, `prefers-reduced-motion` respected), three-offer pricing teaser, keep discovery strips.
- Test: pricing-matrix unit test (pivot + ordering; unknown keys dropped); e2e asserts no "Business" text + currency switch changes symbol.

Design (frontend-design): stay in the brand's purple/courtside system but the hero's signature is the *self-scheduling fixture card* animation — a real scorebug-styled card that fills in ("create → generate → live"), not a screenshot. Typography per existing marketing pages; one bold move only.

### Task 8: `/start` funnel (wizard, API, claim, reminder, analytics)

**Files:**
- Create: `apps/web/src/app/start/page.tsx` + `apps/web/src/components/start-wizard.tsx` (3 steps: name+sport → format recommendation via pure `recommendFormats` import → email; ~60s, no auth)
- Create: `apps/web/src/lib/funnel.ts` (token mint/consume à la login-link: single-use, 7d TTL; payload zod schema {name, sport, entrant_count, start_date, format_slug})
- Create: `apps/web/src/app/api/funnel/start/route.ts` (rate-limited; creates draft; sends email via compose.ts template "Your competition is ready to finish setting up" with `/start/claim?token=…`; dev/e2e returns `claim_url` — same trick as magic-link `login_url`)
- Create: `apps/web/src/app/start/claim/page.tsx` + `apps/web/src/app/api/funnel/claim/route.ts` (consume token in tx → find-or-create user by draft email, `email_verified=true` — the click proves ownership → `createSession` → org-if-none via `createOrgForUser` → competition + division from draft via existing usecases → redirect inside comp, entrants tab)
- Create: `apps/web/src/app/api/funnel/remind/route.ts` (POST, `x-cron-secret` == env CRON_SECRET; sweeps `used_at is null and reminded_at is null and created_at < now()-24h and expires_at > now()` → reminder email → set reminded_at)
- Create: email template in `apps/web/src/lib/email-templates/` via compose.ts (courtside HTML system per email memory)
- Modify: `apps/web/src/lib/analytics-events.ts` (+`FUNNEL_DRAFT_CREATED: "funnel_draft_created"`, `FUNNEL_CLAIMED: "funnel_claimed"`); server-capture both via posthog-server
- Test: funnel.ts unit (mint/consume single-use, expiry); claim idempotency (second consume → null); API zod rejects; e2e in Task 9.

### Task 9: E2E + smoke + verification + docs

**Files:**
- Create: `apps/web/e2e/pricing-v3.spec.ts` (pricing: 3 columns, no Business, currency switch; free org hits division cap → two-button gate → SQL-insert pass → gate lifted for that comp only, sibling comp still gated)
- Create: `apps/web/e2e/funnel.spec.ts` (wizard → `claim_url` → lands inside created comp; entrants tab)
- Modify: `scripts/smoke.ts` (free path: 402 at cap; event-pass path: SQL insert `competition_passes` → create allowed to pass caps; pro path: existing SQL pro-flip → beyond)
- Modify: `scripts/stripe-sync.ts` header comment documents idempotent re-run incl. currency_options update.

**Verify:** `tsc`, vitest suite, new e2e specs, smoke.ts against dev server; Playwright MCP screenshots (home, pricing, /start — desktop + 390px); `scripts/check-plan-scrub.sh`; update v3/README status on design/v3-corpus branch at the end.

## Self-review notes

- Spec coverage: §2→T1/T2, §3→T1/T2/T4/T5, §4→T4/T6, §5→T7, §6→T8, acceptance→T9. Fee % row → T3.
- Pass-moot-under-Pro handled by skipping pass lookup for non-community plans (survives downgrade automatically).
- `orgs.max_owned` pro 5→3: enforcement site checked during T1; if enforced, add same-grandfather override for pro orgs owning >3.
