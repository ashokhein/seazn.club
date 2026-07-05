# 08 — Separate API (`/api/v1`)

## 1. Three surfaces, one service layer

```
packages/engine            pure rules (no HTTP, no DB)
apps/web/src/server/       service layer: engine-db adapter + use-cases (the ONLY writer)
        ├── /api/v1/**     versioned REST — UI, third parties (API keys), public reads
        └── Server Components → read models directly (same service layer, no HTTP hop)
```

Old `/api/**` BFF routes are deleted at cutover (PROMPT-15). Rules:
- Route handlers stay ≤ ~20 lines: parse (Zod) → auth → call use-case → shape response.
- `handler()` wrapper retained; extended to map `EngineError.code → HTTP`
  (`SEQ_CONFLICT→409`, `LINEUP_INVALID→422`, `ELIGIBILITY→422`, entitlement→402).
- Every response: `{ ok, data | error, requestId }`. List endpoints: cursor pagination
  (`?cursor=&limit=`, opaque base64 cursor), `X-Total-Count` omitted (expensive), `?fields=` sparse fieldsets later.

## 2. Authentication modes

| Mode | Who | How |
|------|-----|-----|
| Session cookie | our web UI | existing `seazn_session` JWT |
| **API key** | Pro orgs' integrations | `Authorization: Bearer sk_live_…`; sha256 lookup in `api_keys`; scopes `read`/`write`; entitlement `api.access`; rate limit per key |
| None | public reads | only `visibility='public'` resources, via the consent-filtered views (doc 07 note 4) |

## 3. Resource map

```
# Org-scoped (session or API key)
GET/POST        /api/v1/competitions
GET/PATCH/DELETE /api/v1/competitions/{id}
GET/POST        /api/v1/competitions/{id}/divisions
GET/PATCH       /api/v1/divisions/{id}
POST            /api/v1/divisions/{id}/entrants            # + bulk import (CSV)
GET/PATCH       /api/v1/entrants/{id}                      # withdraw, seed, members
GET/POST        /api/v1/persons                            # + merge endpoint (dedupe)
GET/PUT         /api/v1/persons/{id}/profiles/{sport}
POST            /api/v1/divisions/{id}/stages              # define stage graph
POST            /api/v1/stages/{id}/generate               # fixtures (idempotent, returns diff)
POST            /api/v1/stages/{id}/complete               # progression (guarded)
GET/PATCH       /api/v1/fixtures/{id}                      # schedule, venue, officials
PUT             /api/v1/fixtures/{id}/lineups/{entrantId}
POST            /api/v1/fixtures/{id}/events               # THE scoring endpoint (§4)
GET             /api/v1/fixtures/{id}/events?since_seq=
GET             /api/v1/fixtures/{id}/state                # summary + live state
GET             /api/v1/stages/{id}/standings
POST            /api/v1/fixtures/{id}/finalize
GET/POST/DELETE /api/v1/orgs/{id}/api-keys

# Public (no auth, cacheable, consent-filtered)
GET /api/v1/public/orgs/{orgSlug}/competitions/{slug}                 # description, divisions
GET /api/v1/public/.../divisions/{slug}/schedule
GET /api/v1/public/.../divisions/{slug}/standings
GET /api/v1/public/.../divisions/{slug}/entrants
GET /api/v1/public/fixtures/{id}                                      # live summary
```

## 4. The scoring endpoint (hot path)

```
POST /api/v1/fixtures/{id}/events
Body: { expected_seq: number, type: 'cricket.ball', payload: {...},
        idempotency_key?: string }
201 → { seq, state_summary, outcome? }
409 SEQ_CONFLICT → { current_seq }        # client refetches events since its seq, replays UI
422 INVALID_EVENT → { code, message }     # engine rejected; nothing persisted
```
- `expected_seq` = optimistic concurrency (doc 02 §8). Two scorekeepers stay consistent.
- `idempotency_key` in Redis (existing cache module), 24 h — retry-safe on flaky venue Wi-Fi.
  **This matters more than anything: scoring happens courtside on bad networks.**
- Undo: `POST events {type: 'core.void', payload: {event_id}}` — same path, same audit.
- Server publishes realtime `fixture:{id}` after commit (existing broadcast pattern).

## 5. Versioning, spec & webhooks

- **Contract-first:** `openapi.yaml` in repo; route types generated from it (or zod-to-openapi
  from the shared Zod schemas — pick in PROMPT-11); spec served at `/api/v1/openapi.json`;
  docs page rendered from it.
- Additive changes in-place; breaking changes → `/api/v2`. Sunset headers on deprecation.
- **Webhooks (Pro):** org registers URLs; events `fixture.decided`, `standings.updated`,
  `stage.completed`; HMAC-signed payloads; retries with backoff via email-queue-style table
  (Inngest when it lands).

## 6. Caching & rate limits

- Public GETs: `Cache-Control: public, s-maxage=30, stale-while-revalidate=300` + Redis
  cache-aside keyed by resource+updated watermark; invalidated by the same writes that
  publish realtime.
- Authed GETs: no shared cache; ETag on `state` (`last_seq`).
- Rate limits (existing `rate-limit.ts`): per-key for API keys (Pro: 10 rps sustained),
  per-IP for public (60/min), scoring endpoint per-fixture (10/s — one scorer's cadence).
