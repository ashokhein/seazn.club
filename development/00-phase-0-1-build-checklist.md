# 00 — Phase 0 / 1 Build Checklist (Consolidated)

A single ordered, actionable list of the **must-do** items to get from today's app to a
**paid, production Pro launch** (beachhead: clubs/academies). It pulls the Phase 0 + Phase 1
items from docs 01–15 and sequences them. Later phases (realtime, storage, enterprise) are
out of scope here — see doc 09.

**How to use:** work top-down within each phase; items in the same sub-section can run in
parallel. Each line links the owning doc for detail. Check boxes as you go.

**Locked decisions (context):** Vercel + Supabase · flat per-org pricing · Pro/clubs first,
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
- [ ] Add `withTenant()` wrapper that sets `app.current_org` / `app.user_id` / `app.role`.
- [ ] Enable **RLS** + isolation policies on every tenant table; decide + apply `org_id`
      denormalization on hot child tables (`players`, `rounds`, `matches`, `match_events`).
- [ ] CI check that fails if a table with `org_id` lacks an RLS policy.

### 0.3 Security baseline — doc 04
- [ ] `AUTH_SECRET` rotation support (`kid` + keyring); secret in managed store.
- [ ] **Server-side session revocation list** (Redis) — logout/role-change/disable invalidates now.
- [ ] **Rate limiting** (Redis) on `/api/auth/*`, invites, result writes, webhooks.
- [ ] Security headers (CSP, HSTS, X-Frame-Options, etc.) in `middleware.ts` / `next.config`.
- [ ] **CSRF** protection on cookie-based mutations (origin checks + double-submit token).
- [ ] Zod `.strict()` + size/array bounds on all input schemas.
- [ ] Dependabot/Renovate + dependency audit in CI.

### 0.4 Observability & resilience — doc 07
- [ ] **Sentry** (errors) with request id + org id, no PII bodies.
- [ ] Structured JSON logging; OpenTelemetry traces (API → DB → cache).
- [ ] Metrics + uptime synthetic checks; SLO alerts → on-call.
- [ ] Automated backups + **PITR**; run one **tested restore drill**.
- [ ] **Status page** published.

### 0.5 Quality foundation — doc 12
- [ ] Install **Vitest + fast-check + Playwright**; add `test*` scripts to `package.json`.
- [ ] Extract pure lifecycle decisioning out of `tournament.ts` into a DB-free module +
      in-memory **simulation driver**.
- [ ] Port `engine-check.ts` / `smoke.ts` assertions into Vitest.
- [ ] Property tests for engine **invariants** (P1–P6, S1–S4, L1–L5), incl. the **stepladder
      P6 regression** derived from the real bug.
- [ ] Golden-scenario suite (3/4/5/6 players, all four formats, odd counts).
- [ ] **CI merge gates:** lint + tsc + unit/property + integration + critical E2E + engine
      coverage ≥ 95% + security scans.
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
- [ ] Create `plans`, `subscriptions`, `plan_entitlements`, `org_entitlement_overrides`,
      `usage_counters`, `billing_events` (greenfield).
- [ ] Seed entitlement matrix from doc 01 (stable `feature_key`s).
- [ ] Build **single gate** `src/lib/entitlements.ts`: `hasFeature`, `getLimit`,
      `withinLimit`, `requireFeature` (Redis-cached, invalidated on change).
- [ ] Enforce server-side: create-tournament (`tournaments.active.max`), `players.max`.
- [ ] Maintain `usage_counters` in the same tx as create/complete/delete + nightly reconcile.
- [ ] `GET /api/orgs/[id]/entitlements` for UI gating + upgrade prompts.

### 1.2 Stripe billing — doc 05
- [ ] Stripe Products/Prices for **Pro** (monthly + annual); flat per-org.
- [ ] `POST /api/billing/checkout` (Checkout) + `POST /api/billing/portal` (Customer Portal).
- [ ] `POST /api/webhooks/stripe`: **signature-verified, idempotent** (`billing_events`),
      handle subscription created/updated/deleted + invoice paid/failed; invalidate
      entitlement cache.
- [ ] **14-day trial, no card**; post-trial → Community (read-only beyond limits, no data loss).
- [ ] **Dunning:** past_due banner; final failure → `suspended` (read-only).
- [ ] **Stripe Tax** + billing address.
- [ ] Billing UI: plan page, upgrade prompts, dunning banner.

### 1.3 Account & org lifecycle (must-fix gaps) — doc 13
- [ ] **Last-owner protection** across role-change / remove-member / leave (tx + row locks).
- [ ] **Transfer org ownership** (`POST /api/orgs/[id]/transfer-owner`).
- [ ] **Change email** (double opt-in; notify old address).
- [ ] **Password reset / forgot password** (single-use, short-TTL token; invalidate sessions).
- [ ] **Delete account** (block if sole owner of shared org; revoke sessions; enqueue purge).
- [ ] **Leave org** + immediate access invalidation on removal.
- [ ] GDPR **data export + delete** flows (doc 03) for EU GA.

### 1.4 Internal admin / support console — doc 13
- [ ] `is_staff` + `staff_role`; `/admin` route group behind `requireStaff` + MFA; `staff_audit`.
- [ ] Org/User **360 views** (plan, entitlements, usage, members, tournaments, audit).
- [ ] Support actions: resend verification, **read-only impersonation** (time-boxed, audited).
- [ ] Billing actions: grant/extend trial, manage Stripe; superadmin: suspend/reactivate,
      entitlement override (reason required).

### 1.5 Email deliverability + transactional reliability — doc 14
- [ ] **Verified sending domain** with SPF/DKIM/DMARC; dedicated sending subdomain.
- [ ] Separate **transactional vs lifecycle** streams; set `EMAIL_FROM` + reply-to.
- [ ] Bounce/complaint **webhooks → suppression list**; honor before non-transactional sends.
- [ ] Send via **job queue** (retries + dead-letter); app actions never blocked by email failure.
- [ ] Reliable transactional emails: verify, reset, invite, ownership transfer, billing receipts/dunning.

### 1.6 Onboarding & activation (conversion) — doc 14
- [ ] Instrument **activation funnel** events (signup → … → tournament_started → completed).
- [ ] First-run wizard (sport + format) → pre-filled create form.
- [ ] **Templates** (reuse `org_sport_presets`) + optional **sample tournament**.
- [ ] Strong **empty states** (dashboard, setup, team) with primary CTAs.
- [ ] Trial banner (days left + what's kept on Free).

### 1.7 Marketing front door — doc 06
- [ ] Marketing **route group** (static + CDN, no auth dep): home, **pricing**, ≥3 use-case pages.
- [ ] Legal pages: **Privacy, Terms, DPA, sub-processors, cookie policy + consent**.
- [ ] SEO basics: metadata, sitemap, robots; privacy-friendly analytics + consent.
- [ ] Lighthouse perf & SEO ≥ 90 on marketing routes.

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

## Explicitly deferred to Phase 2+ (do not build now)
- Realtime scoreboards (doc 10) · Supabase Storage uploads (doc 11) · public branded
  tournament pages (doc 06 §6) · notifications/PWA (doc 08) · analytics/ratings/leagues ·
  SSO/SCIM + custom roles + audit export (Enterprise, doc 04) · i18n/white-label.
