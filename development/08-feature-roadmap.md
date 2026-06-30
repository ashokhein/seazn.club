# 08 — Feature Roadmap (Product Capabilities)

## 1. Goal

Define the user-facing capabilities (beyond infra) that make the product sticky and
enterprise-ready, each with enough design to implement later. Entitlement keys reference
doc 01; enforcement via doc 05.

## 2. Current state

- Engine: Swiss/knockout/round-robin/progress-stepladder, standings (points → progress →
  Buchholz → H2H), undo/reset, audit log.
- Live tournament UI refreshes via client fetch (no realtime). Player images are
  `image_url` strings (no managed upload). No notifications, analytics, public API, or
  scheduling beyond `clock_minutes`.

## 3. Capability backlog (prioritized)

### 3.1 Live realtime scoreboards — `realtime` — **highest UX value**
- **Why:** the "live tournament" promise; spectators/organizers expect instant updates.
- **Design (locked):** [10-supabase-realtime.md](10-supabase-realtime.md) — Supabase
  Realtime **broadcast** on `tournament:{id}`; server publishes after writes; client
  refetches `/state`. Community tier keeps 5 s polling.
- **Gating:** `requireFeature(org,'realtime')` on token endpoint; Community = polling only.
- **Acceptance:** result entered on one device appears on others < 1s without manual refresh.

### 3.2 Managed media uploads — `branding` — Supabase Storage (locked)
- **Why:** real photos/logos; current `image_url` data URLs bloat Postgres.
- **Design:** [11-supabase-storage.md](11-supabase-storage.md) — signed upload URLs,
  `assets` bucket, paths `orgs/{org_id}/...`, client resize to WebP, CDN serve.
- **Gating:** Pro+ / `branding` for storage uploads; Community keeps initials or small data URLs.
- **UI:** shared `ImageUploadField` in create form, live setup, org settings.

### 3.3 Public branded tournament pages — `public_pages`
- Covered in doc 06 §6 (SSR/ISR, OG images, schema.org, custom domain Business+,
  white-label Enterprise, public/private toggle). Realtime-aware when entitled.

### 3.4 Notifications — base (email) + `LATER` (SMS/push)
- **Triggers:** round start, "your match is ready", result posted, tournament completed,
  invite, billing (dunning).
- **Design:** event → job queue → channel adapters (Resend email now; SMS/web-push later).
  Per-user preferences table; unsubscribe/transactional split. Templated, localized.

### 3.5 Scheduling & resources — base/Business
- Courts/boards/tables + time slots; assign matches to resource + time; conflict detection;
  clock integration (extends `clock_minutes`). Printable/exportable schedule (doc adds to
  existing `/print`).

### 3.6 Analytics, ratings & reporting — `analytics`
- **Player ratings:** Elo and/or Glicko-2 computed from match results (pure module, like
  `standings.ts`); per-sport rating pools; history.
- **Org analytics:** participation, completion rates, no-shows, format usage.
- **Reports:** exportable (CSV/PDF) via worker; scheduled email reports (Business+).
- **Acceptance:** ratings update on result; org dashboard shows trends; export downloads.

### 3.7 Team & player management — base/Business
- Player profiles (history across tournaments/leagues), team rosters, bulk CSV import,
  dedupe/merge. Ties into leagues (doc 03 §5.5) for cross-event standings.

### 3.8 Public API + webhooks — `api`
- **REST API** mirroring internal capabilities (read tournament/state/standings; create
  tournaments; submit results) with **API tokens** (per-org, scoped, hashed at rest).
- **Outbound webhooks** to customer URLs on events (result, round, completion) with HMAC
  signatures, retries (queue), and SSRF egress controls (doc 04).
- Versioned (`/api/v1`), rate-limited per token, documented (OpenAPI).

### 3.9 Mobile experience — PWA first, native `LATER`
- **PWA:** installable, offline-tolerant score entry (queue writes, sync on reconnect),
  touch-first scorekeeper UI (builds on the enlarged score inputs already shipped).
- Native apps only if push + app-store presence justify it.

### 3.10 White-label — Enterprise
- Custom domain, logo, colors, remove all S.A.F.E branding, optional custom email sender.

### 3.11 Internationalization (i18n)
- Externalize strings; locale routing; date/number formatting (extend `ClientTime`); RTL
  support. Sports is global — meaningful TAM expansion.

### 3.12 Additional engine formats — `LATER`, demand-driven
- Double elimination, group stage → knockout (World-Cup style), pools + playoffs, Americano
  (padel), ladder/challenge. Each is a pure addition to `pairing.ts` with tests in
  `engine-check.ts` (keep the pure-core discipline).

## 4. Cross-cutting design rules

- New shapes → Zod in `types.ts` first.
- Pure logic (ratings, schedule conflict, new pairings) in DB-free modules with unit tests.
- Effects in transactional lib functions; publish realtime + enqueue notifications after commit.
- Every capability behind an entitlement key; enforced server-side, reflected in UI.

## 5. Suggested sequence (maps to doc 09)

1. Realtime + media uploads + public pages (stickiness; Phase 2).
2. Notifications + PWA (engagement; Phase 2/3).
3. Analytics/ratings + team mgmt + leagues (Business value; Phase 3).
4. Public API + webhooks + SSO-gated capabilities (Enterprise; Phase 3).
5. i18n, white-label, extra formats (expansion; Phase 4).

## 6. Acceptance criteria

- Each shipped capability: Zod types, server-side entitlement gate, tests (pure logic where
  applicable), UI with upgrade prompts when gated, and docs.
- Realtime, uploads, and public pages demonstrably work end-to-end before paid Phase 2 GA.

## 7. Decisions (locked vs open)

**Locked:**
- Realtime: Supabase Realtime broadcast (doc 10).
- Assets: Supabase Storage (doc 11).

**Still open:**
1. Ratings system: Elo, Glicko-2, or both per sport?
2. API priority: required for first Business customers or fast-follow?
3. PWA-only vs native mobile — based on push/offline demand?
