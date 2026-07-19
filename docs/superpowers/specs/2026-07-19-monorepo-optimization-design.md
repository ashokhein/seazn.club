# Monorepo optimization + pnpm migration — design

**Date:** 2026-07-19
**Status:** Approved (brainstorm session)
**Goals (ranked):** 1) Docker/Fly build speed, 2) CI wall time + billed minutes.
Local CPU is a secondary beneficiary. Free/OSS tooling only. pnpm ships only if
it passes the benchmark gate in §4.

## Context

- Two workspaces: `apps/web` (Next 16, standalone output) and `packages/engine`
  (pure TS, zero runtime deps). npm workspaces, 576 KB `package-lock.json`,
  1.0 GB hoisted `node_modules`.
- Per PR, `npm ci` runs in three jobs (test, security, smoke); the deploy job
  and the Docker build each run it again.
- The same TypeScript check runs three times per merge: `tsc --noEmit` in the
  test job, then again inside `next build` in the smoke job, then again inside
  `next build` in the Docker build. The in-build check is the 6 GB-heap worker
  that SIGKILLed on Fly builders (currently patched by an uncommitted
  `NODE_OPTIONS=--max-old-space-size=6144` in the Dockerfile).
- Engine sim matrix + coverage gate run on every PR, though most PRs touch only
  `apps/web`.

## §1 — Kill duplicate CPU (independent of pnpm)

1. **Typecheck once.** `next.config.js` adds
   `typescript: { ignoreBuildErrors: process.env.SKIP_TYPECHECK === "1" }`.
   The smoke-job build and the Docker build set `SKIP_TYPECHECK=1`;
   `tsc --noEmit` in the test job remains the sole type gate (both
   workspaces). Local `next build` is unchanged and still type-checks.
   The Dockerfile heap bump is removed in the same PR; the first staging
   deploy after merge verifies the build survives without it.
   (`ignoreBuildErrors` is confirmed present in the bundled Next 16 docs:
   `node_modules/next/dist/docs/.../01-next-config-js/typescript.md`.)
2. **Path-filter engine gates.** A `dorny/paths-filter` step gates engine
   coverage + sim matrix: they run only when `packages/engine/**` or the
   lockfile changed. Web unit tests and both typechecks always run. Skipped
   steps still leave the job green so required checks are unaffected.
3. **Security job installs nothing.** `audit --audit-level=high` resolves from
   the lockfile + registry advisory API; the job's `npm ci` is deleted.
4. **Deploy job installs prod-only.** `stripe-sync.ts` / `sync:sports` /
   `flyway.sh` need runtime deps only → `--prod` install.

## §2 — pnpm migration

- Pin `"packageManager": "pnpm@10"` in root `package.json`; enable via
  corepack in CI and Docker.
- `pnpm import` converts `package-lock.json` → `pnpm-lock.yaml`, preserving
  resolved versions (no surprise upgrades). Then delete `package-lock.json`,
  add `pnpm-workspace.yaml` (`apps/*`, `packages/*`), remove the `workspaces`
  field (single source of truth).
- `"@seazn/engine": "*"` → `"@seazn/engine": "workspace:*"`.
- Root scripts: `npm run X --workspace apps/web` → `pnpm --filter @seazn/web X`
  (same for `packages/engine`). All six workflows updated — including the
  disabled `e2e.yml` (contents only; it stays disabled per standing decision).
  README dev commands updated.
- CI installs: `pnpm/action-setup` (reads the `packageManager` field) +
  `actions/setup-node` with `cache: pnpm` + `pnpm install --frozen-lockfile`.
- **Phantom-dep policy:** pnpm's strict `node_modules` may surface imports of
  undeclared packages. The fix is always adding the explicit dependency —
  never `shamefully-hoist` or `public-hoist-pattern`.
- Next standalone output with pnpm's symlinked layout is officially supported;
  `outputFileTracingRoot` already points at the repo root. The runner stage of
  the Dockerfile is untouched.

## §3 — Dockerfile rewrite

- Builder stage: `corepack enable`; dependency layer becomes `pnpm fetch`
  driven by the **lockfile only** (a `package.json` script edit no longer
  busts the layer — today it does), followed by `pnpm install --offline`.
- `RUN --mount=type=cache,id=pnpm,target=/pnpm/store` — Fly's remote builder
  is BuildKit; the store persists on the builder disk between deploys (best
  effort: evicted if the builder VM is recycled).
- Build step sets `SKIP_TYPECHECK=1`; the heap bump is gone.
- Runner stage (standalone copy, non-root user) unchanged.

## §4 — Benchmark gate, verification, rollback

- **Benchmark before the swap ships:** time cold + warm `npm ci` vs
  `pnpm install --frozen-lockfile` locally and in one branch CI run. pnpm
  ships only if it saves ≥ 30 s per CI job or ≥ 1 min on a lockfile-busted
  Docker build; otherwise §1 ships alone and §2/§3 are dropped.
- **Verification (before push):** `tsc` + unit suites in both workspaces,
  production `next build`, smoke suite locally; local `docker build` to
  validate the Dockerfile; staging deploy watched after merge.
- **Rollback:** one revert commit restores `package-lock.json` from history;
  npm works again immediately.
- **Expected wins:** a web-only PR sheds the sim matrix, engine coverage, two
  full installs, and the in-build typecheck — several minutes per PR. Docker
  deploys shed the typecheck and gain a warm dependency store.

## Out of scope / rejected

- **Turborepo/Nx:** two workspaces; path filters capture most of the caching
  win with zero new dependencies. Revisit if workspace count grows.
- **Bun:** runtime remains Node; PM-only swap adds risk for marginal gain over
  pnpm.
- **Paid caching services** (Depot, Turbo remote cache): excluded by
  constraint.
- **Fly autostop of staging** (surfaced during session): expected behavior,
  not a defect; `min_machines_running = 1` is the knob if always-on staging is
  ever wanted.
