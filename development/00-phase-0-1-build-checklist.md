# 00 — Phase 0 / 1 Build Checklist (Consolidated)

A single ordered, actionable list of the **must-do** items to get from today's app to a
**paid, production Pro launch** (beachhead: clubs/academies). It pulls the Phase 0 + Phase 1
items from docs 01–15 and sequences them. Later phases (realtime, storage, enterprise) are
out of scope here — see doc 09.

**How to use:** work top-down within each phase; items in the same sub-section can run in
parallel. Each line links the owning doc for detail. Check boxes as you go.

**Locked decisions (context):** Fly.io + Supabase · flat per-org pricing · Pro/clubs first,
Enterprise coming soon · Supabase Realtime (Phase 2) · Supabase Storage (Phase 2).

---

## Phase 0 — Production hardening (foundation)

> Goal: make the app a real, operable, safe-to-charge-on system. No new product features.

### 0.1 Environments & config — doc 07
- [ ] Create isolated **dev / staging / prod** (separate Postgres, secrets, domains).
- [ ] Move secrets to platform/secret store; remove any secrets from repo; gitleaks in repo.
- [ ] Stop using `apply-schema.ts` (drops data) anywhere but local dev; document this.

### 0.2 Database & tenancy — doc 03
- [ ] Put a **connection pooler** in front of Postgres (Supabase pooler / PgBouncer).
- [x] Add `withTenant()` wrapper that sets `app.current_org` / `app.user_id` / `app.role`. ✓ `src/lib/db.ts`
- [x] Enable **RLS** + isolation policies on every tenant table. ✓ `supabase/schema.sql`
- [ ] `org_id` denormalization on hot child tables (`players`, `rounds`, `matches`, `match_events`) — sub-select policies in place; add column when ready.
- [ ] CI check that fails if a table with `org_id` lacks an RLS policy.

### 0.3 Security baseline — doc 04
- [ ] `AUTH_SECRET` rotation support (`kid` + keyring); secret in managed store.
- [x] `AUTH_SECRET` throws in production if unset. ✓ `src/lib/auth.ts`
- [ ] **Server-side session revocation list** (Redis) — logout/role-change/disable invalidates now.
- [x] **Rate limiting** (DB-backed) on `/api/auth/*` (login, signup, forgot-password) + result writes. ✓ `src/lib/rate-limit.ts` + migration 008; upgrade to Upstash Redis when needed
- [x] Security headers (HSTS, X-Frame-Options, X-Content-Type-Options, Referrer-Policy, Permissions-Policy) in `next.config.ts`. ✓
- [x] **CSRF** protection — Origin header check on all mutating API routes. ✓ `src/middleware.ts`
- [x] Zod `.strict()` + size/array bounds on all input schemas. ✓ `src/lib/types.ts` + inline auth schemas
- [ ] Dependabot/Renovate + dependency audit in CI.

### 0.4 Observability & resilience — doc 07
- [x] **Sentry** (errors) with request id + org id, no PII bodies. ✓ `sentry.{client,server,edge}.config.ts`; `captureError()` in `src/lib/sentry.ts`; wired into `handler()`; `global-error.tsx`
- [ ] Structured JSON logging; OpenTelemetry traces (API → DB → cache).
- [ ] Metrics + uptime synthetic checks; SLO alerts → on-call.
- [ ] Automated backups + **PITR**; run one **tested restore drill**.
- [ ] **Status page** published.

### 0.5 Quality foundation — doc 12
- [x] Install **Vitest + fast-check**; add `test`, `test:watch`, `test:coverage` scripts. ✓ `package.json`, `vitest.config.ts`
- [x] Fix TypeScript errors; clean `npm run build` with zero warnings. ✓ `next.config.ts`, `src/lib/db.ts`, `src/proxy.ts` (migrated from deprecated middleware)
- [x] Port `engine-check.ts` assertions into Vitest. ✓ `src/lib/__tests__/pairing.test.ts`, `standings.test.ts`
- [x] Property tests for engine invariants P1–P6, S1–S3, L1–L2. ✓
- [ ] Install **Playwright** for E2E; add critical path tests.
- [ ] Extract pure lifecycle decisioning out of `tournament.ts` into a DB-free simulation driver.
- [ ] Golden-scenario suite (3/4/5/6 players, all four formats, odd counts) — integration.
- [ ] **CI merge gates:** lint + tsc + unit/property + integration + critical E2E + engine coverage ≥ 95% + security scans.
- [ ] Production **invariant assertions** behind a flag → log violations to Sentry.

### 0.6 Pre-launch trust/brand basics — doc 15 / 06
- [ ] Confirm product **name/trademark + domain**; brand kit (shared marketing/app).

**Phase 0 exit:** deploys are gated, observable, reversible, backed up; tenant isolation
enforced at the DB; engine guarded by property tests + CI; no secrets in repo.

---

## Phase 1 — Monetization (get paid) + must-fix product gaps

> Goal: a user can sign up, trial, pay, and be correctly entitled; legally launchable;
> no embarrassing account dead-ends.

### 1.1 Plans, entitlements & limits — doc 03 / 05
- [x] Create `plans`, `subscriptions`, `plan_entitlements`, `org_entitlement_overrides`, `billing_events`. ✓ `supabase/migrations/001_billing.sql`
- [x] Seed entitlement matrix — Free: 5 seasons, 10 tournaments/season, 32 players · Pro $20/mo: unlimited. ✓
- [x] Build **single gate** `src/lib/entitlements.ts`: `hasFeature`, `getLimit`, `withinLimit`, `requireFeature`. ✓ (DB-direct; Redis cache deferred to Phase 0.3)
- [x] Enforce server-side: `seasons.max` on create-season · `tournaments.per_season.max` + `players.max` on create-tournament. ✓
- [ ] `usage_counters` table + transactional increment/reconcile (deferred — using direct DB count queries for now).
- [x] `GET /api/orgs/[id]/entitlements` — resolved entitlements + usage for UI gating. ✓ `src/app/api/orgs/[id]/entitlements/route.ts`
- [x] `organizations.status` + `deleted_at` + `purge_after` lifecycle columns. ✓

### 1.2 Stripe billing — doc 05
- [ ] Stripe Products/Prices for **Pro** (monthly + annual) — create in Stripe dashboard, then `UPDATE plans SET stripe_price_id_monthly='price_xxx' WHERE key='pro'`.
- [x] `POST /api/billing/checkout` — creates Checkout Session; 14-day trial; Stripe Tax; `STRIPE_SECRET_KEY` + price IDs required. ✓ `src/app/api/billing/checkout/route.ts`
- [x] `POST /api/billing/portal` — Customer Portal session for subscription management. ✓ `src/app/api/billing/portal/route.ts`
- [x] `GET /api/orgs/[id]/subscription` — subscription state for UI. ✓
- [x] `POST /api/webhooks/stripe`: signature-verified, idempotent (`billing_events`); handles checkout.session.completed, subscription.{created,updated,deleted}, invoice.payment_{failed,succeeded}. ✓ `src/app/api/webhooks/stripe/route.ts`
- [x] Webhook exempt from CSRF proxy (uses Stripe signature). ✓ `src/proxy.ts`
- [x] **14-day trial, no card**; post-trial → Community limits apply. ✓
- [x] **Dunning** banner (past_due / suspended). ✓ `src/components/billing-banner.tsx`
- [x] **Stripe Tax** + `allow_promotion_codes` wired into checkout. ✓
- [x] Billing UI: `/settings/billing` plan page, usage bars, upgrade prompts. ✓ `src/app/settings/billing/page.tsx`
- [ ] Wire `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` in Fly.io env + Stripe dashboard webhook URL → `https://<domain>/api/webhooks/stripe`.

### 1.3 Account & org lifecycle (must-fix gaps) — doc 13
- [x] **Last-owner protection** — role-change and remove-member use `FOR UPDATE` transaction row locks. ✓
- [x] **Transfer org ownership** — `POST /api/orgs/[id]/transfer-owner`; owner→admin atomically. ✓ `src/app/api/orgs/[id]/transfer-owner/route.ts`
- [x] **Change email** — double opt-in; `email_change_requests` table; notify old address; 24h token. ✓ `src/app/api/auth/change-email/route.ts` + `/confirm`
- [x] **Password reset / forgot password** — single-use 1-hour token; `password_resets` table; `/forgot-password` + `/reset-password` pages + API routes. ✓
- [x] **Delete account** — blocks if sole owner of shared org; anonymizes PII; destroys session; 30-day soft-delete purge queue. ✓ `src/app/api/users/me/route.ts`
- [x] **Leave org** — `DELETE /api/orgs/[id]/members/me`; blocks if sole owner. ✓ `src/app/api/orgs/[id]/members/me/route.ts`
- [x] GDPR **data export** — `GET /api/users/me/export` returns JSON of profile, orgs, tournaments. ✓ `src/app/api/users/me/export/route.ts`
- [x] Account settings UI — `/settings/account`: change email, leave org, transfer ownership, delete account, export data. ✓ `src/app/settings/account/page.tsx`
- [ ] GDPR **delete** — hard-purge job that runs post-`purge_after` (deferred: needs job queue from Phase 1.5).

### 1.4 Internal admin / support console — doc 13
- [x] `is_staff` + `staff_role` on users; `staff_audit_log` + `impersonation_sessions` tables. ✓ `supabase/migrations/003_admin.sql`
- [x] `requireStaff()` / `requireSuperadmin()` + `logStaffAction()`. ✓ `src/lib/admin.ts`
- [x] `/admin` route group — dark-themed layout behind `requireStaff`. ✓ `src/app/admin/layout.tsx`
- [x] Admin dashboard — user/org/paid-sub counts + recent staff audit feed. ✓ `src/app/admin/page.tsx`
- [x] **Org 360 view** — subscription, members, tournaments, entitlement overrides, staff history. ✓ `src/app/admin/orgs/[id]/page.tsx`
- [x] **User 360 view** — account meta, orgs, staff history. ✓ `src/app/admin/users/[id]/page.tsx`
- [x] Support actions: resend verification email, **read-only impersonation** (1h token, one-time URL, audited). ✓ `src/app/api/admin/users/[id]/`
- [x] Billing actions: grant/extend trial (support+). ✓ `src/app/api/admin/orgs/[id]/grant-trial/`
- [x] Superadmin actions: suspend/reactivate org, entitlement override (reason required). ✓ `src/app/api/admin/orgs/[id]/suspend/` + `entitlement-override/`
- [ ] MFA gate on `/admin` — TOTP required for staff (deferred to Phase 0.3 security hardening).

### 1.5 Email deliverability + transactional reliability — doc 14
- [ ] **Verified sending domain** with SPF/DKIM/DMARC; dedicated sending subdomain. _(external: Resend dashboard + DNS)_
- [x] Separate **transactional vs lifecycle** streams; set `EMAIL_FROM` + reply-to. ✓ `src/lib/email.ts` (`transactional` flag bypasses suppression)
- [x] Bounce/complaint **webhooks → suppression list**; honor before non-transactional sends. ✓ `src/app/api/webhooks/resend/route.ts` + `email_suppressions` table
- [x] Email queue table in DB (`email_queue`). ✓ `supabase/migrations/004_email_deliverability.sql` _(processor deferred: needs job runner Phase 0 / Inngest)_
- [x] Reliable transactional emails: verify, reset, change-email, account-deletion, invite. ✓ `src/lib/email.ts`
- [ ] `RESEND_WEBHOOK_SECRET` set in Fly.io env + Resend dashboard webhook URL → `https://<domain>/api/webhooks/resend`.

### 1.6 Onboarding & activation (conversion) — doc 14
- [x] Instrument **activation funnel** events (first_tournament_created, tournament_started, tournament_completed). ✓ `src/lib/activation.ts` + `activation_events` table (migration 005)
- [x] First-run wizard (`/onboarding`) — sport preset cards → pre-filled `/tournaments/new?preset=<id>`. ✓ `src/app/onboarding/page.tsx`, `src/components/onboarding-wizard.tsx`
- [x] `users.onboarding_completed_at` — new users redirect to wizard; skip marks done. ✓ migration 005 + `POST /api/onboarding/complete`
- [x] Wizard sport selection uses system `org_sport_presets` as templates — no new tables needed. ✓
- [x] Strong **empty state** on dashboard — hero text + "New tournament" + "Customize presets" CTAs. ✓ `src/app/dashboard/page.tsx`
- [x] Trial banner — soft purple for >7 days, bold purple for ≤7 days, ended state. ✓ `src/components/billing-banner.tsx`

### 1.7 Marketing front door — doc 06
- [x] Marketing pages (static, no auth dep): home `/`, `/pricing`, `/use-cases/clubs|events|schools`. ✓
- [x] Legal pages: `/legal/privacy`, `/legal/terms`, `/legal/cookie-policy`, `/legal/dpa`, `/legal/sub-processors`. ✓
- [x] Cookie consent banner (essential-only; localStorage; no tracking). ✓ `src/components/cookie-consent.tsx`
- [x] SEO metadata on all pages; `src/app/sitemap.ts`; `src/app/robots.ts` (disallows app routes). ✓
- [x] Shared `MarketingNav` (auth-aware: Dashboard vs Login) + `MarketingFooter`. ✓
- [ ] Lighthouse perf & SEO ≥ 90 — run after deploying to Fly.io.

### 1.8 Accessibility & performance gates (carry-in) — doc 12 / 15
- [ ] **axe-core** checks in Playwright on dashboard/create/live/settings as a CI gate.
- [ ] Keyboard-only run-a-tournament path verified.
- [ ] Define API p95 + live-page budgets; lightweight load test in nightly CI.

**Phase 1 exit:** new user can sign up → trial → pay → correctly entitled; limits enforced
server-side; account/org lifecycle complete with last-owner protection; support console +
deliverable email live; marketing + legal pages published; a11y/perf gates green.

---

## Cross-cutting Definition of Done (every change) — doc 02 / 12
- [ ] Zod types in `types.ts`; thin API route via `handler()`; server-only effectful module.
- [ ] Entitlement-gated where applicable (server-enforced) + UI upgrade prompt.
- [ ] Tests: pure logic (Vitest/property) + flow (integration/E2E); CI green.
- [ ] Observability: logs/metrics/traces; errors to Sentry.
- [ ] Docs + changelog updated.

## Decisions to settle before/early in Phase 1
- [ ] Final **price points** + annual discount %.
- [ ] **Free public pages indexable** vs noindex (affects doc 06 SEO).
- [ ] **Ephemeral test DB** approach (Testcontainers vs Supabase branch).
- [ ] **Impersonation** read-only only vs read-write for superadmin.
- [ ] Managed **queue** (Inngest/Trigger.dev) vs pg-boss.

---

## Phase 2 — Stickiness (retention & PLG flywheel) — doc 09 Phase 2 / doc 01

> Goal: live updates, shareable public pages, branding, export gates. Reference: 01-product-strategy.md tier matrix.

### 2.1 Realtime scoreboards — doc 10
- [x] `@supabase/supabase-js` installed. ✓ `package.json`
- [x] `src/lib/supabase-admin.ts` — service-role client (server-only). ✓
- [x] `src/lib/realtime.ts` — `publishTournamentUpdate()` (broadcast REST) + `mintRealtimeToken()`. ✓
- [x] `src/lib/supabase-browser.ts` — browser client for subscriptions only. ✓
- [x] `src/hooks/use-tournament-realtime.ts` — subscribe + 250ms debounce + fallback on 403. ✓
- [x] `GET /api/tournaments/[id]/realtime-token` — mints JWT, gated by `realtime` entitlement. ✓
- [x] `publishTournamentUpdate` wired into start, result, undo, reset, checkin routes. ✓
- [x] `LiveTournament` — realtime replaces polling for Pro; Community keeps 5s polling. ✓
- [x] Fill Supabase Realtime env vars: `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_JWT_SECRET`. ✓ `.env.local` updated; broadcast + JWT verified
- [ ] Enable Realtime Broadcast in Supabase dashboard. _(broadcast API responds — verify channel subscriptions work end-to-end after deploy)_

### 2.2 Public tournament pages (PLG flywheel) — doc 06 §6 / doc 01
- [x] `tournaments.is_public`, `tournaments.public_slug` columns. ✓ migration 006
- [x] `PATCH /api/tournaments/[id]/public` — toggle is_public; generates slug on first make-public. ✓
- [x] `/t/[slug]` — public read-only page: standings + bracket, polls 10s, no auth required. ✓ `src/app/t/[slug]/page.tsx`
- [x] `src/components/public-tournament-view.tsx` — client standings + bracket, no edit controls. ✓
- [x] "Powered by S.A.F.E Tournaments" badge on Community public pages; hidden on Pro+ (`branding` entitlement check). ✓
- [x] SEO metadata on public tournament pages. ✓
- [x] Add "Share" button in `LiveTournament` UI to toggle `is_public` and copy link. ✓ `SharePanel` in `live-tournament.tsx`

### 2.3 Entitlement gates from product strategy
- [x] `exports` entitlement gates CSV download — Pro sees button; Community sees upgrade link. ✓ `LiveTournament` + `tournaments/[id]/page.tsx`
- [x] `realtime` entitlement passed as prop from server → `LiveTournament`. ✓
- [x] `public_pages` entitlement seeded for community + pro. ✓ migration 006
- [x] `tournaments.state_version bigint` column for realtime debounce. ✓ migration 006

### 2.4 Supabase Storage (branding / player photos) — doc 11
- [x] Create `assets` bucket (public read) in Supabase dashboard. ✓ Exists, public, 10MB limit
- [x] Migration: `players.image_storage_path`, `organizations.logo_storage_path`. ✓ migration 007 applied
- [x] `src/lib/supabase-storage.ts` — `getSignedUploadUrl()`, `publicStorageUrl()`, `deleteStorageObject()`. ✓
- [x] `POST /api/tournaments/[id]/upload-url` — signed upload URL for player avatar (Pro, `branding`). ✓
- [x] `POST /api/orgs/[id]/logo-upload-url` — org logo upload (Pro, `branding`). ✓
- [x] Update `new-tournament-form.tsx` + `live-tournament.tsx` to upload to storage instead of data URLs. ✓
- [x] Org logo shown in Nav, dashboard header, public pages. ✓ `src/components/nav.tsx`, `src/app/t/[slug]/page.tsx`

## Explicitly deferred to Phase 3+ (Enterprise)
- SSO/SCIM + custom roles + audit export (Enterprise, doc 04) · i18n/white-label ·
  analytics/ratings/leagues (Business tier) · Public API + webhooks · PWA offline ·
  Read replica + regional residency.
