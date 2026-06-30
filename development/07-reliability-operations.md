# 07 — Reliability, Scale & Operations

## 1. Goal

Run the product like a real SaaS: separate environments, automated CI/CD, observability,
backups/DR, and SLAs — so we can promise uptime and recover from failure.

## 2. Current state

- Single-environment dev workflow. Schema applied via `scripts/apply-schema.ts` which
  **drops and recreates** (dev-only). Tests: `engine-check.ts` (pure), `smoke.ts` (E2E vs a
  running dev server). No CI/CD, monitoring, backups, or status page documented.
- Known footgun: running `next build` while `next dev` is active corrupts `.next`.

> Per scope, this doc does **not** define a migration tool to convert existing data; it
> assumes greenfield environment setup. (When schema versioning is wanted, pick one tool and
> standardize — noted under Open questions.)

## 3. Environments

| Env | Purpose | Data | Stripe | Notes |
|-----|---------|------|--------|-------|
| `dev` | Local | disposable | test | `apply-schema.ts` ok here only |
| `staging` | Pre-prod, mirrors prod | seeded/anonymized | test | runs full CI suite, preview of releases |
| `prod` | Live | real | live | gated deploys, backups, alerting |

- Each env: isolated Postgres, Redis, object storage bucket, secrets, domains.
- Config via platform env / secret store (doc 04). No shared credentials across envs.

## 4. CI/CD pipeline

**On every PR:**
1. `npm ci`
2. `npm run lint` + `npx tsc --noEmit`
3. `node --experimental-strip-types scripts/engine-check.ts` (pure logic)
4. Spin ephemeral DB → `scripts/smoke.ts` against a built app
5. Security: dependency audit, gitleaks secret scan, SAST
6. Preview deploy (per-PR URL)

**On merge to main:**
1. Build artifact
2. Deploy to `staging` → run smoke + critical-path E2E
3. Manual or automated promotion to `prod`
4. Post-deploy health checks; auto-rollback on failure

**Release safety:** schema changes are **expand/contract** (additive first, backfill, then
remove) so deploys are zero-downtime and reversible. Avoid `next build` during local `dev`
(documented footgun).

## 5. Scaling

- **App tier:** stateless → horizontal autoscale on CPU/RPS.
- **DB:** connection pooler (PgBouncer/Supabase pooler) is mandatory before scaling out
  (the `postgres` package opens direct connections). Tune pool sizes; statement timeouts.
- **Caching:** cache-aside in Redis for standings, public pages, entitlements; CDN for
  static + public pages. Explicit invalidation on writes.
- **Read replica:** `LATER`, when read load proves it (public pages, analytics).
- **Hot-event handling:** a viral public tournament is served from cache/CDN; realtime via a
  single Redis pub/sub channel per tournament, not per-client DB reads.

## 6. Observability

| Signal | Tooling | What |
|--------|---------|------|
| **Errors** | Sentry | Exceptions w/ request id, org id (no PII bodies). |
| **Logs** | Structured JSON → log sink | request id, org id, route, latency, status. |
| **Traces** | OpenTelemetry | API → DB → cache → queue spans. |
| **Metrics** | Platform/Prometheus | RPS, p50/p95/p99 latency, error rate, DB pool usage, queue depth, cache hit rate. |
| **Uptime** | External checks | Synthetic checks on `/`, login, create-tournament; feeds status page. |
| **Product analytics** | (doc 06/08) | Activation, conversion funnels. |

- **Alerting (SLO-based):** page on error-rate/latency SLO burn, DB pool saturation, queue
  backlog, webhook failures, backup failure. Route to on-call.
- **Dashboards:** golden signals per service + business KPIs.

## 7. Backups & disaster recovery

- **Backups:** automated daily + **PITR** (point-in-time recovery) on Postgres; object
  storage versioning. Encrypted; retention per policy.
- **Targets:** define **RPO** (e.g. ≤ 5 min via PITR) and **RTO** (e.g. ≤ 1 h).
- **Restore drills:** quarterly tested restore into a scratch env (a backup you haven't
  restored is not a backup).
- **DR plan:** documented failover; multi-AZ managed DB; region failover `LATER`.

## 8. SLAs & support

| Tier | Uptime SLA | Support response |
|------|-----------|------------------|
| Community | none | community/docs |
| Pro | best-effort | email, 1–2 business days |
| Business | 99.9% | priority email, next business day |
| Enterprise | 99.95% + credits | dedicated channel, severity-based (e.g. Sev1 ≤ 1h) |

- Public **status page** with incident history + subscribe.
- **Incident management:** severity matrix, on-call rotation, comms templates, blameless
  post-mortems with action items tracked.

## 9. Cost & capacity

- Track cost per tenant (DB, storage, egress, realtime) to keep pricing (doc 01) healthy.
- Quotas/limits (doc 03) protect infra from abuse and runaway usage.
- Periodic capacity review tied to growth metrics.

## 10. Operational runbooks (to author)

- Deploy & rollback; schema expand/contract.
- Restore from backup; failover.
- Rotate `AUTH_SECRET` / Stripe / IdP secrets (doc 04).
- Suspend/reactivate tenant; process data-export & deletion (doc 03).
- Replay/repair failed billing webhooks (doc 05).

## 11. Acceptance criteria

- Three isolated environments with separate data/secrets.
- CI runs lint, typecheck, engine-check, smoke, security scans on every PR; staging gate to prod.
- Sentry + structured logs + metrics + uptime checks live; SLO alerts wired to on-call.
- Automated backups + PITR with a tested restore drill.
- Status page published; incident + on-call process documented.
- Connection pooler in front of Postgres before horizontal scaling.

## 12. Open questions / decisions

1. Hosting/runtime (Vercel vs GCP Cloud Run/GKE) — drives autoscaling, pooling, DR specifics.
2. If/when we adopt schema versioning, which tool (Drizzle / Prisma Migrate / node-pg-migrate)?
3. Managed queue/realtime vs self-hosted (from doc 02) — affects ops burden.
4. SLA credit structure for Enterprise contracts.
