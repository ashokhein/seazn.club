# PROMPT-11 — Platform API `/api/v1`

**Read first:** `engine/08-api-design.md` (normative); `engine/03-engine-architecture.md`
§7 (error mapping). Preamble: PROMPT-00. Depends: PROMPT-08, PROMPT-10.

## Task
1. Service layer `apps/web/src/server/usecases/` — one module per aggregate
   (competitions, divisions, entrants, persons, stages, fixtures, scoring, standings).
   Auth (`requireOrgRole`-family), entitlement gates, then engine-db adapter calls.
   Route handlers and Server Components both call these — no logic in routes.
2. Routes per the resource map in 08 §3, `handler()`-wrapped, Zod-validated, cursor
   pagination. `EngineError → HTTP` mapping table in one place.
3. **Scoring endpoint** per 08 §4: expected_seq concurrency, Redis idempotency-key
   (24 h, reuse `cache.ts`), 201/409/422 contract exactly as specced.
4. **API keys**: `api_keys` CRUD under org settings; `sk_live_` secrets (32B random,
   sha256 stored, shown once); bearer auth middleware resolving key → org + scopes;
   entitlement `api.access`; per-key rate limit (reuse `rate-limit.ts`).
5. Public endpoints reading only the `public_*_v` views; `Cache-Control` per 08 §6 +
   Redis cache-aside with watermark invalidation.
6. OpenAPI: generate from the shared Zod schemas (zod-to-openapi or equivalent — pick,
   justify in PR); serve `/api/v1/openapi.json`; CI gate: spec drift fails the build.
7. Smoke additions to `scripts/smoke.ts`: auth'd CRUD happy path, scoring append+void,
   public standings fetch, API-key auth, 402 on gated feature.

## Acceptance
- Full fixture lifecycle drivable via curl: create competition → division → entrants →
  generate stage → append events → outcome → standings → public read, all against the
  contract in 08.
- Concurrency test: parallel scorers converge, no lost events.
- OpenAPI spec validates and matches implemented routes.
