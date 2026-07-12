# Architecture & Performance Assessment — 2026-07-12

Scope: page performance, backend performance, and whether/how to separate services.
Status: **assessment + proposed approaches — nothing implemented yet.**

## 1. Current architecture (as found)

```
Browser ──► Fly.io (lhr, 1× shared-cpu-1x / 512MB, min 1 warm)
              └─ Next 16 standalone monolith
                  ├─ 87 pages, 163 API routes, proxy.ts (CSP nonce + CSRF)
                  ├─ packages/engine  (pure TS, in-process)
                  ├─ pdfkit / exceljs exports, satori OG images (in-process)
                  └─ posthog reverse proxy (/ingest rewrites)
       Supabase Postgres ◄─ postgres.js, transaction pooler :6543, max 5 conns,
                            RLS via withTenant (BEGIN + set_config + set role)
       Upstash Redis     ◄─ cache-aside fail-open: auth (300s/120s),
                            entitlements (300s), idempotency, rate limits
       Supabase Realtime ◄─ broadcast-only fan-out (already off-box ✔)
       Supabase Storage  ◄─ logos/avatars (raw <img>, no optimizer)
       GitHub Actions    ◄─ cron via HTTP + CRON_SECRET (hourly funnel sweep)
```

What is already right (keep):

- **Public read model**: consent-filtered `public_*_v` views + `unstable_cache`
  with tags + ISR 30s (`REVALIDATE_FAST`), `revalidateTag` fired from the same
  write paths that publish realtime (`server/public-site/data.ts`,
  `server/usecases/scoring.ts`). Standings are **precomputed snapshots** on
  write under a per-division advisory lock — reads never fold events.
- **Engine as a pure package** — deterministic, zero I/O; the most important
  "service boundary" already exists as a library boundary.
- **Realtime fan-out is already a separate service** (Supabase broadcast);
  the app never holds spectator websockets.
- Deliberate perf indexes (V254), statement-count budget tests, Redis
  fail-open discipline, `Promise.all` on the heavy organiser pages.

## 2. Findings

### Page performance

| # | Finding | Where | Impact |
|---|---------|-------|--------|
| P1 | No CDN. ISR pages are cached **in the box**, so every spectator request — the spiky, anonymous majority — still terminates in lhr. Next already emits `s-maxage`/`stale-while-revalidate` for ISR routes; nothing consumes them. | fly.toml, `next.config.mjs` | Global TTFB = RTT to London; box eats all spectator load |
| P2 | Zero `next/image`; 22 raw `<img>` sites serve Supabase Storage originals — no resize, no modern formats, no lazy hints. | app/, components/ | Mobile spectator pages pay full-size logo/avatar bytes |
| P3 | Slug resolution (`orgBySlug`/`compBySlug`/`divBySlug`) is React-`cache()` deduped per request but hits Postgres 2–4× on **every** authenticated navigation; no Redis layer, unlike auth. | `server/slug-resolve.ts` | Adds serial round-trips before any page data loads |
| P4 | `requireFixturePage` / `requireDivisionPage` chains are serial: user → org slug → memberships → comp slug → div slug → fixture (5–6 awaited queries) before page queries start. | `server/page-auth.ts` | Deep-link TTFB stacks pooler round-trips |
| P5 | Enforcing CSP (`CSP_MODE=enforce`) uses per-request nonces, which forces dynamic rendering and would silently kill ISR + any CDN caching for public pages. Currently report-only, so latent. | `src/proxy.ts` | Future security flip conflicts with the perf strategy |
| P6 | PostHog is reverse-proxied through the app origin — every analytics event is an extra request through the 512MB box. | next.config rewrites | Matchday event bursts compete with page serving |

### Backend performance

| # | Finding | Where | Impact |
|---|---------|-------|--------|
| B1 | One shared CPU core serves everything: requests, bcrypt logins, satori OG renders, pdfkit posters, exceljs workbooks, engine folds. 512MB + exceljs on a big division is an OOM candidate. | fly.toml, exports/OG routes | Tail latency spikes; single machine = no isolation, deploys briefly 1→0 |
| B2 | Transaction pooler (:6543) disables prepared statements, and `withTenant` spends 2 extra round-trips per write tx (`set_config` + `set local role`). But the app is a **persistent server**, not serverless — the pooler is solving a problem this app doesn't have. | `lib/db.ts` | Every query re-parses; writes pay +2 RTT; 5-conn cap under 500-conn HTTP concurrency |
| B3 | Scoring write path is fully synchronous in-request: idempotency check → rate limit → tx (advisory lock, gapless seq via `max(seq)+1`, fold, snapshot write) → realtime publish (HTTP) → revalidateTag → discovery invalidation. | `server/usecases/scoring.ts` | Courtside score-entry latency stacks every hop; realtime/revalidate could trail the response |
| B4 | No job runner. Cron = GitHub Actions hitting endpoints (imprecise, ≥ hourly practical). Exports/imports/digest-emails all live in request lifecycles. | `.github/workflows/funnel-reminders.yml` | Long work ties up request workers; planned digest email has no home |
| B5 | `min_machines_running = 1`, single machine: a deploy or crash-restart is a visible blip; no headroom for matchday concurrency. | fly.toml | Availability + burst capacity |

### Service separation — verdict

**Do not microservice by domain.** At this scale (single region, modest team,
one DB) a domain split buys distributed-systems tax and no throughput. The
monolith is modular in the right places already (engine package, usecase layer,
views-only public reads). The separations that pay are **by workload class**:

1. **Spectator reads → edge (CDN)** — anonymous, cacheable, spiky. This is the
   real "service extraction": the audience never needs to reach the box.
2. **CPU-heavy render (PDF/Excel/OG/imports) → worker process** — same image,
   second Fly process group, fed by a queue. Protects interactive latency.
3. **Scheduled work → real scheduler** — replace GHA-cron-over-HTTP as jobs grow
   (digest emails are already planned).

Realtime is already separated. The engine should stay in-process (pure, fast,
deterministic; a network hop would only add failure modes).

## 3. Approaches

### Approach A — Tune the monolith (recommended first)

No new services. Ordered by leverage:

1. **CDN in front of public + embed routes** (Cloudflare in front of Fly, or
   Fly's edge + `Cache-Control` respected by a proxy): honor the ISR
   `s-maxage`/`stale-while-revalidate` headers Next already sends; include the
   `_rsc` search param in the cache key (bundled Next guide:
   `02-guides/cdn-caching.md`); purge CDN keys alongside `revalidateTag` in
   `server/public-site/revalidate.ts`. Scope it to `/shared`, `/embed`, `/o/…`
   stays dynamic. Resolves P1; halves B1's traffic at the same time.
2. **DB connection mode**: point the always-on server at the **session pooler
   (Supavisor :5432) or direct connections**, re-enable prepared statements,
   keep `max: 5` (raise to ~10 if pool-wait metrics say so). Measure with the
   existing statement-count tests + a pgbench-style before/after. Resolves B2.
3. **Redis read-through for slug resolution** (`slug:{org}`,
   `slug:{org}:{comp}`, …, invalidated on rename — renames already write
   `slug_history`). Collapses P3; P4 shrinks to the user/org lookups that are
   already Redis-cached.
4. **Image handling**: adopt `next/image` (or Supabase image transforms) for
   logos/avatars with explicit sizes. Resolves P2. (Next's optimizer costs box
   CPU — with the CDN from step 1 caching `/_next/image`, that cost amortizes.)
5. **Machine right-size**: bump to 1GB / dedicated core *after* measuring; add
   a second machine (min 2) for deploy overlap + burst. Cheap, reversible.
6. **CSP decision**: for public routes prefer hash/`strict-dynamic` without
   per-request nonces (or keep report-only there) so enforcement never forces
   dynamic rendering. Locks in P5 before it bites.
7. **Async tail on scoring**: keep the tx synchronous, but fire realtime
   publish + revalidate + discovery invalidation with `after()` (Next 16) so
   the scorer's 201 returns at commit. Trims B3 latency with zero semantics
   change.

- **Cost**: days, not weeks; no new deployables. CDN purge wiring is the only
  genuinely new moving part.
- **Risk**: low; every step reversible and independently measurable.

### Approach B — Workload split on Fly (second wave)

Same codebase, same image — add a `worker` **process group** and a queue:

- Queue choice: **pg-boss** (Postgres-backed, zero new infra, transactional
  enqueue with the domain write) vs **Upstash QStash** (HTTP push, wakes
  auto-stop machines, no poller). pg-boss fits better: jobs enqueue inside the
  same DB tx as the triggering write, and a worker machine can stay tiny.
- Move: PDF posters, Excel exports, bulk imports, digest emails, funnel sweeps
  (replaces GHA cron), OG pre-render on write (optional).
- Web machines keep serving; worker machine absorbs CPU spikes. Resolves B1's
  isolation half, B4 entirely.
- **Cost**: ~a week including job UI/status plumbing for exports (they become
  "generate → notify/download" instead of request-blocking).
- **Risk**: moderate — introduces job lifecycle states users can see.

### Approach C — Bigger levers (defer until triggered)

- **Multi-region Fly + read replicas, `fly-replay` for writes** — trigger:
  sustained non-EU audience with p75 TTFB > ~600ms *after* CDN.
- **`cacheComponents` migration** (`use cache`/`cacheLife` replaces segment
  configs; PPR-style static shells with streamed dynamic holes) — trigger:
  after A, if organiser-page TTFB still hurts; touches UI-state behavior
  (`<Activity>` preservation) so it's a deliberate wave, not a drive-by.
- **Domain service extraction** (scoring API, registration service…) — trigger:
  team growth / independent scaling needs. Not before.

**Recommendation: A now; B when exports/digest emails next get touched; C on
triggers only.**

## 4. Out-of-the-box ideas (kept honest)

1. **Push the read model to storage**: standings/schedule snapshots are already
   JSON — publish per-division blobs to Supabase Storage (CDN-fronted) on every
   score write; embeds + live pages fetch the blob and use the existing
   realtime broadcast as the refetch signal. Spectator load on the box → ~zero,
   even without the full CDN story. Natural fit: `writeSnapshot` already owns
   the moment of truth.
2. **Calendar-aware capacity**: fixtures carry `scheduled_at` — a cron can
   scale Fly machines up before scheduled match windows and back down after
   (machines API), sized by fixtures-per-hour. A sports platform can *predict*
   its own load; almost nobody exploits that.
3. **OG images as write-time artifacts**: pre-render division/fixture OG PNGs
   to storage on result writes (they change only then), serve statically;
   satori leaves the request path.
4. **Session claims**: embed an org-memberships hash in the session JWT to skip
   the per-request membership lookup, verifying against DB only on writes.
   Staleness window equals what Redis already accepts (120s). Idea only —
   security-sensitive, needs its own design.
5. **Matchday mode**: when any division has an `in_play` fixture, drop that
   division's ISR window to 5s / raise otherwise. Tag-driven, tiny change,
   makes "live" feel live while quiet weeks cost nothing.

## 5. Measure first / prove after

Before A lands, capture a baseline week in Sentry (already wired):

- p50/p75/p95 TTFB split three ways: `/shared|/embed` (public), `/o/…`
  (organiser), `/api/v1` (writes).
- postgres.js pool wait time + statement counts on the scoring path (the
  `statementCount()` budget tests give the harness).
- Fly machine CPU steal + memory high-water during a matchday.
- Core Web Vitals (LCP/INP) for a public division page on mobile.

Each A-step then gets a before/after against the same panel. Regression tests
per repo convention accompany any code change (slug-cache invalidation on
rename, CDN purge on revalidate, pooler-mode statement budgets).

## 6. Open questions for the user

1. CDN preference: Cloudflare in front of Fly (free tier works, needs DNS move)
   vs staying Fly-only (skip P1's global win, keep step 2–7)? A custom domain
   is a prerequisite — fly.dev can't take a CDN in front cleanly.
2. Is global (non-EU) spectator traffic actually expected soon? Decides how
   hard to push P1 vs pure backend tuning.
3. Budget appetite for a second Fly machine (~$5–10/mo) now vs later?
