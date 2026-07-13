# PROMPT-54 — DB connection budget: explicit DB_POOL_MAX, rotation, runbook

**Read first:** `apps/web/src/lib/db.ts` (`connectionOptions()` — the `DB_POOL_MAX`
knob EXISTS since PERF-A: 1..50, default 5, `prepare` off only on `:6543`; this prompt
sets values and adds guardrails, it does NOT add the knob),
`docs/superpowers/specs/2026-07-12-architecture-performance-design.md` §7 (ops
checklist this closes), `fly.toml` + `fly.stg.toml` (machine counts × pool = the
budget), `.github/workflows/ci.yml` ~L210 (stale "session pooler 5432" comment —
contradicts the direct-only decision).
**Depends:** nothing. **No migrations.**

## Context

Remote Supabase is DIRECT connection only (user decision 2026-07-13 — never suggest
the Supavisor pooler). `max_connections=60` on the current instance. Live measurement
2026-07-13: 13/60 used — ~12 is Supabase baseline (pg_cron, postgres_exporter, pg_net,
PostgREST, background workers), app contribution at idle is 0 (`idle_timeout: 20`
closes pool connections). Steady state is nowhere near exhaustion: 2 machines × 5
default = 10 worst case on top of the baseline.

**Root cause found + fixed after this prompt was written** (PR #80,
`fix/db-client-singleton`): production builds never cached the postgres client —
`getClient()` constructed a fresh pool per sql-proxy access, so ONE page render held
25+ connections; the 2026-07-13 stg FATAL 53300 outage was this bug, with crash-loops
as the symptom. The tasks below remain valid as defense-in-depth (budget the pool
explicitly, rotate so any future leak ages out, one-command diagnosis) — verify PR #80
is merged/deployed first, and re-measure with `db-conn-report` before choosing values.

## Task

1. **Explicit per-env values** in `fly.stg.toml` and `fly.toml` `[env]`:
   `DB_POOL_MAX=5` (stg) / `DB_POOL_MAX=8` (prod) with a comment carrying the formula:
   `machines × DB_POOL_MAX + Flyway(1) + ops headroom(3) + Supabase baseline(~12)
   ≤ max_connections − superuser_reserved`. Assert both envs pass it in a comment
   table (stg: 2×5+16=26 ≤ ~55 ✓).
2. **Rotation guardrail** in `db.ts`: add `max_lifetime: 60 * 30` to the `postgres()`
   options so stale/leaked connections age out within 30 min, and surface it through
   `connectionOptions()` (env-tunable `DB_MAX_LIFETIME`, same clamp style as
   `DB_POOL_MAX`) so tests can pin it. Keep `idle_timeout: 20` as is.
3. **Diagnosis script** `scripts/db-conn-report.ts` (runs with whatever `DATABASE_URL`
   it's given, read-only): prints max_connections, total/active/idle,
   rollup by `usename`+`application_name`, and `pg_prepared_statements` count
   (>0 proves the direct/session connection keeps prepared statements — `:6543`
   silently disables them). npm script `db:conn-report`.
4. **Runbook** `docs/ops/db-connections.md`: the budget formula + current table, the
   53300 incident (symptom chain: crash loop → leak → 53300 → more crashes;
   resolution: stop flapping, wait for `max_lifetime`/server timeout to reap), the
   verification queries from the script, and the escalation ladder (bump machine size
   / `max_connections` BEFORE reaching for the pooler — direct-only is a standing
   decision).
5. **Comment hygiene**: fix the `ci.yml` ~L210 stale pooler comment to state
   direct-only + the IPv6 constraint (GH runners are IPv4-only — migrate step needs
   IPv4 add-on or Fly-side execution; do not silently re-point at the pooler).

## Acceptance

- `connectionOptions()` unit tests extended: `max_lifetime` default + clamp +
  override, existing `DB_POOL_MAX` clamps still pinned.
- `npm run db:conn-report` against the local dev DB prints all four sections;
  against stg (via `REMOTE_DATABASE_URL` or Supabase MCP query equivalents) shows
  prepared statements > 0.
- fly.toml diffs reviewed against the budget table; `npx tsc --noEmit` + unit green.
- Runbook exists and is linked from the PERF-A spec §7 checklist (mark the
  `DB_POOL_MAX` item done).

## Out of scope

Supavisor/pgbouncer (standing decision: direct only), Supabase IPv4 add-on purchase
(separate ops decision), Approach B worker/queue, connection-level metrics shipping
(PostHog/exporter dashboards), fixing the fly.toml app-name mismatch (separate ops
item — verify with `fly apps list` before any deploy).
