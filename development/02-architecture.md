# 02 — Target Architecture

## 1. Goal

Define the system topology and runtime that supports paid, multi-tenant, enterprise usage:
real-time scoring, background work, caching, file storage, and observability — without a
premature rewrite. We evolve the existing modular monolith.

## 2. Current state

- Next.js 15 App Router monolith. Server Components render pages; route handlers under
  `src/app/api/**` expose REST JSON via `handler()` (`src/lib/http.ts`).
- Pure logic isolated: `pairing.ts`, `standings.ts`, `format.ts`. Effectful logic in
  `tournament.ts` using `sql.begin()` transactions (`src/lib/db.ts`, `postgres` package).
- No cache, no queue, no realtime, no object storage, no central observability.
- Live tournament UI (`src/components/live-tournament.tsx`) refreshes via client fetches.

## 3. Architectural principles

1. **Modular monolith first.** One deployable Next.js app. Extract a service only when a
   bottleneck is proven (realtime fan-out is the most likely first extraction).
2. **Pure core, effectful shell.** Keep engine math pure and DB-free; side effects live in
   server-only lib modules behind transactions.
3. **Stateless app tier.** All state in Postgres / Redis / object storage so we can scale
   horizontally and deploy with zero affinity.
4. **One entitlement gate.** Capability checks centralize in a single module (doc 05),
   consulted by API routes and UI.
5. **Everything observable.** Structured logs, traces, metrics from day one of Phase 0.

## 4. Target topology

```
                         ┌─────────────────────────┐
        Browsers ───────▶│  CDN / Edge              │
   (PWA, slideshow,      │  - marketing (static)    │
    public pages)        │  - cached public pages   │
                         └────────────┬─────────────┘
                                      │
                         ┌────────────▼─────────────┐
                         │  Next.js app (N replicas) │
                         │  - Server Components      │
                         │  - /api route handlers    │
                         │  - /api/webhooks/*         │
                         │  - SSE endpoint (realtime) │
                         └──┬───────┬───────┬─────┬──┘
            ┌───────────────┘       │       │     └───────────────┐
            ▼                       ▼       ▼                     ▼
   ┌─────────────────┐   ┌──────────────┐ ┌───────────────┐ ┌──────────────┐
   │ PostgreSQL      │   │ Redis        │ │ Object storage│ │ Job queue /  │
   │ (primary,       │   │ - cache      │ │ (player imgs, │ │ workers      │
   │  pooled via     │   │ - rate limit │ │  exports, PDFs│ │ (email,      │
   │  PgBouncer)     │   │ - pub/sub    │ │  via signed   │ │  exports,    │
   │ + read replica  │   │   for SSE    │ │  URLs)        │ │  billing     │
   │   (LATER)       │   │ - idempotency│ │               │ │  reconcile)  │
   └─────────────────┘   └──────────────┘ └───────────────┘ └──────────────┘
            │
            ▼
   ┌─────────────────┐
   │ Observability   │  logs (structured) → log sink
   │ Sentry (errors) │  traces (OTel) → tracing backend
   │ Metrics/uptime  │  status page
   └─────────────────┘
```

## 5. Components & responsibilities

### 5.1 App tier (Next.js)
- Pages (Server Components), API routes, webhook handlers, SSE endpoint.
- **No long-running work inline** — enqueue to the job queue and return fast.
- Reads entitlements + tenant context per request (doc 03).

### 5.2 PostgreSQL
- System of record. Add **connection pooling** (PgBouncer / Supabase pooler) because the
  `postgres` package opens direct connections — serverless/replicas will exhaust pools
  otherwise.
- Add **RLS** as defense-in-depth (doc 03).
- Read replica is `LATER` (only when read load demands).

### 5.3 Redis (new)
- **Rate limiting** (auth, invite, write endpoints).
- **Cache** of hot reads (standings, public pages, entitlements).
- **Idempotency keys** for billing webhooks and result submission.
- Not used for realtime fan-out (Supabase Realtime handles that — doc 10).

### 5.4 Object storage — Supabase Storage (locked)

Player avatars, org logos, and (later) export files. Full design:
[11-supabase-storage.md](11-supabase-storage.md).

Summary:
- Buckets: `assets` (public read), `exports` (private, Phase 3).
- Paths scoped `orgs/{org_id}/...` — server mints signed upload URLs; client PUTs direct.
- DB stores **path**, not bytes; legacy data URLs keep working.
- Shared `supabase-admin.ts` with Realtime (doc 10).
- Gated by `branding` / Pro+ for storage uploads; Community keeps initials or inline data URLs.

### 5.5 Job queue / workers (new)
- Email sending, export generation, billing reconciliation, scheduled reports, data export
  (GDPR), webhook retries to customers.
- Options: Inngest or Trigger.dev (managed, TS-native) or pg-boss/pg-cron (DB-backed).
  Recommend **Inngest/Trigger.dev** to avoid running our own worker infra early.

### 5.6 Realtime — Supabase (locked)

Use **Supabase Realtime broadcast channels** — not self-hosted WebSockets on Vercel.
Full design: [10-supabase-realtime.md](10-supabase-realtime.md).

Summary:
- Server keeps writing via `postgres` package + `tournament.ts`.
- After each mutation, server publishes `{ reason, v, at }` on `tournament:{id}` (service role).
- Client uses `@supabase/supabase-js` **for realtime only**; refetches `GET /state` on event.
- Subscriber JWT minted by `GET /api/tournaments/[id]/realtime-token` (custom auth + `SUPABASE_JWT_SECRET`).
- Community tier: no token → 5 s polling fallback. Pro+: `realtime` entitlement.

### 5.7 Realtime (original design note — superseded by doc 10)
- **Phase 2 priority.** Server-Sent Events endpoint `GET /api/tournaments/[id]/stream`
  subscribes a client to a Redis channel `tournament:{id}`. On `recordResult`/round
  generation, publish a compact event; clients refetch or patch state.
- Alternative: managed (Supabase Realtime, Ably, Pusher) if we want WebSockets + presence
  without managing fan-out. Decision in doc 08.

## 6. Request lifecycle (write path example: record result)

```
Client (live UI)
  └─ POST /api/tournaments/:id/result  (idempotency-key header)
       └─ handler():
            1. requireTournamentEditor(id)            // auth + RBAC (auth.ts)
            2. resolve tenant + entitlements           // doc 03 / 05
            3. begin tx:
                 - check idempotency key (Redis/DB)
                 - recordResult() in tournament.ts     // existing engine
                 - writeAudit()                          // existing
            4. publish realtime event to Redis channel  // new
            5. enqueue side-effects (notifications)      // new
            6. return { ok, data }
```

Reads (standings, public pages) go through a cache-aside pattern in Redis with short TTL +
explicit invalidation on writes.

## 7. Module layout (extends current `src/lib`)

```
src/lib/
  # existing
  types.ts, auth.ts, db.ts, http.ts, client.ts
  tournament.ts, pairing.ts, standings.ts, format.ts
  invites.ts, verification.ts, email.ts, oauth.ts
  # new (added as their docs are scheduled)
  tenant.ts        # tenant context resolution, SET LOCAL app.current_org (doc 03)
  entitlements.ts  # hasFeature / withinLimit single gate (doc 05)
  billing.ts       # Stripe wrappers, webhook reconciliation (doc 05)
  cache.ts         # Redis client + cache-aside helpers
  ratelimit.ts     # Redis token-bucket / sliding window
  realtime.ts      # publish/subscribe helpers (doc 10)
  storage.ts       # signed upload URLs, delete, exports (doc 11)
  assets.ts        # public/transform URL helpers (doc 11)
  jobs/            # queue client + job definitions
  observability.ts # logger, trace helpers, request IDs
```

## 8. Environments & config

- `dev` → `staging` → `prod`, each with isolated DB, Redis, storage bucket, Stripe mode.
- Secrets via managed secret store / platform env; `AUTH_SECRET` supports rotation (doc 04).
- Feature flags (simple table or LaunchDarkly-style) to dark-launch realtime, billing, SSO.

## 9. Build vs buy (recommended defaults)

| Concern | Build | Buy/managed (recommended) |
|---------|-------|---------------------------|
| Queue/jobs | pg-boss | **Inngest / Trigger.dev** |
| Realtime | self SSE + Redis | self SSE first; **Ably/Pusher** if WS/presence needed |
| Object storage | — | **S3 / Cloudflare R2 / Supabase Storage** |
| Errors | — | **Sentry** |
| Email | — | **Resend** (already) |
| Billing | — | **Stripe** (doc 05) |
| Auth/SSO | partial | **WorkOS / Auth0** for SAML/SCIM (doc 04) |

## 10. Failure modes & resilience

- **DB pool exhaustion:** mandatory pooler; cap per-instance connections; timeouts on `sql`.
- **Redis down:** cache + rate limit **fail open** for reads, **fail closed** for billing
  idempotency; realtime degrades to client polling (UI already supports refresh).
- **Queue backlog:** jobs idempotent + retryable; dead-letter queue + alert.
- **Webhook storms:** verify signatures, dedupe by event ID, process async.
- **Hot tournament (many spectators):** public page + standings cached at CDN/Redis;
  SSE fan-out via single Redis channel, not N DB reads.

## 11. Acceptance criteria

- Topology diagram and component responsibilities agreed.
- Pooling in front of Postgres before any horizontal scaling.
- `src/lib` extension points named and reserved.
- Build-vs-buy choices confirmed for queue, realtime, storage, auth.

## 12. Decisions (locked vs open)

**Locked:**
- **Hosting:** Vercel (app) + Supabase (Postgres + Realtime).
- **Realtime:** Supabase Realtime broadcast — see [10-supabase-realtime.md](10-supabase-realtime.md).

**Still open:**
1. Queue: managed (Inngest/Trigger.dev) vs pg-boss.
