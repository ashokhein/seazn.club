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
   │ PostgreSQL      │   │ Upstash Redis│ │ Object storage│ │ Inngest      │
   │ (primary,       │   │ - cache      │ │ (player imgs, │ │ (email,      │
   │  pooled via     │   │ - rate limit │ │  exports, PDFs│ │  exports,    │
   │  PgBouncer)     │   │ - idempotency│ │  via signed   │ │  billing     │
   │ + read replica  │   │ - session    │ │  URLs)        │ │  reconcile,  │
   │   (LATER)       │   │   cache      │ │               │ │  GDPR purge) │
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

### 5.3 Redis — Upstash (locked)

**Upstash Redis** — serverless, global, great free tier, works well with Fly.io and any platform.

Responsibilities:
- **Rate limiting** (auth, invite, write endpoints).
- **Cache** of hot reads (standings, public pages, entitlements).
- **Idempotency keys** for billing webhooks and result submission.
- **Session / cache data** as needed.

Redis is **completely out of the realtime path**. No pub/sub. Supabase Realtime handles all fan-out (§5.6).

### 5.4 Object storage — Supabase Storage (locked)

Player avatars, org logos, and (later) export files. Full design:
[11-supabase-storage.md](11-supabase-storage.md).

Summary:
- Buckets: `assets` (public read), `exports` (private, Phase 3).
- Paths scoped `orgs/{org_id}/...` — server mints signed upload URLs; client PUTs direct.
- DB stores **path**, not bytes; legacy data URLs keep working.
- Shared `supabase-admin.ts` with Realtime (doc 10).
- Gated by `branding` / Pro+ for storage uploads; Community keeps initials or inline data URLs.

### 5.5 Job queue / workers — Inngest (locked)

**Inngest** — native Next.js integration, works on Fly.io, durable retries, cron jobs, long-running workflows, no worker infra, excellent TypeScript support.

Responsibilities: email sending, export generation, billing reconciliation, scheduled reports, GDPR data purge, webhook retries.

### 5.6 Realtime — Supabase (locked)

Redis is **not in the realtime path**. Full flow:

```
Server mutation (start / result / undo / reset / checkin)
        │
        ▼
Postgres transaction (tournament.ts)
        │
        ▼
Supabase Realtime Broadcast  ← publishTournamentUpdate() via service role REST
        │
        ▼
Browser receives event (use-tournament-realtime.ts)
        │
        ▼
Refetch GET /api/tournaments/[id]/state
```

Full design: [10-supabase-realtime.md](10-supabase-realtime.md).

- Server writes via `postgres` package; publishes `{ reason, v, at }` on `tournament:{id}`.
- Client uses `@supabase/supabase-js` for realtime only; re-fetches `/state` on event.
- Subscriber JWT minted by `GET /api/tournaments/[id]/realtime-token` (gated by `realtime` entitlement).
- Community: no token → 5s polling fallback. Pro+: realtime push.

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

| Concern | Build | Buy/managed (locked) |
|---------|-------|----------------------|
| Queue/jobs | pg-boss | **Inngest** ✓ |
| Realtime | self SSE + Redis pub/sub | **Supabase Realtime Broadcast** ✓ |
| Redis | — | **Upstash Redis** ✓ |
| Object storage | — | **Supabase Storage** ✓ |
| Errors | — | **Sentry** ✓ |
| Email | — | **Resend** ✓ |
| Billing | — | **Stripe** (doc 05) |
| Auth/SSO | partial | **WorkOS / Auth0** for SAML/SCIM (doc 04, Enterprise) |

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
- **Hosting:** Fly.io (app) + Supabase (Postgres + Realtime).
- **Realtime:** Supabase Realtime broadcast (no Redis pub/sub) — see [10-supabase-realtime.md](10-supabase-realtime.md).
- **Queue/jobs:** Inngest.
- **Redis:** Upstash Redis (cache, rate limiting, idempotency — not realtime).
