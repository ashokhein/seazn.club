# Monorepo Optimization + pnpm Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut Docker/Fly build time and CI minutes by removing duplicate CPU work (triple typecheck, unconditional engine sims, needless installs) and migrating npm → pnpm behind a benchmark gate.

**Architecture:** Two independent layers. Layer 1 (Tasks 1–3) removes duplicate work and is package-manager-agnostic. Layer 2 (Tasks 4–7) converts the workspace to pnpm — but only if the Task 4 benchmark shows ≥30 s saved per CI job or ≥1 min on a cold Docker install; otherwise Tasks 5–7 are skipped and Task 8/9 proceed with npm.

**Tech Stack:** npm workspaces → pnpm 10 (corepack), GitHub Actions, Docker BuildKit cache mounts, Next 16 standalone output, Fly.io remote builder.

**Spec:** `docs/superpowers/specs/2026-07-19-monorepo-optimization-design.md`

## Global Constraints

- Free/OSS tooling only — no paid caches or builders.
- pnpm ships **only** if the Task 4 benchmark gate passes (≥30 s per CI job warm, or ≥1 min cold Docker-style install). Otherwise skip Tasks 5–7.
- Phantom deps are fixed by **declaring the dependency** — never `shamefully-hoist`, never `public-hoist-pattern`.
- `e2e.yml` contents get migrated but the workflow **stays disabled** — never enable it (standing decision).
- `tsc --noEmit` in the CI test job remains the sole type gate; `next build` skips type-checking only where `SKIP_TYPECHECK=1` is explicitly set (CI smoke build, Docker build). Local builds keep checking.
- All branch work happens in a git worktree (`git worktree add .claude/worktrees/monorepo-opt -b feat/monorepo-opt`), never by switching branches in the main repo dir.
- Before any push: run typecheck + unit suites for both workspaces.
- There is an **uncommitted Dockerfile change** in the working tree (`NODE_OPTIONS=--max-old-space-size=6144` heap bump). Task 1 supersedes it — do not commit it separately.

---

### Task 1: Typecheck once — env-gated `ignoreBuildErrors`

**Files:**
- Modify: `apps/web/next.config.js` (the `nextConfig` object, after `poweredByHeader: false`)
- Modify: `.github/workflows/ci.yml` (smoke job, "Build (production)" step, ~line 201)
- Modify: `Dockerfile` (build RUN, line 39)

**Interfaces:**
- Produces: env contract `SKIP_TYPECHECK=1` disables the in-build type-check. Tasks 6/7 reuse the same variable name.

- [ ] **Step 1: Add the env-gated typescript block to next.config.js**

In `apps/web/next.config.js`, inside `nextConfig`, directly after the `poweredByHeader: false,` line, add:

```js
  // CI/Docker set SKIP_TYPECHECK=1: `tsc --noEmit` in the CI test job is the
  // sole type gate, so the in-build checker (a 6 GB-heap worker on Fly
  // builders) is duplicate work there. Local `next build` still checks.
  typescript: {
    ignoreBuildErrors: process.env.SKIP_TYPECHECK === "1",
  },
```

- [ ] **Step 2: Verify the gate with an injected type error**

```bash
echo 'const _skipCheckProbe: number = "not a number";' >> apps/web/src/lib/legal.ts
npm run typecheck --workspace apps/web        # Expected: FAIL (TS2322)
SKIP_TYPECHECK=1 npm run build --workspace apps/web   # Expected: build SUCCEEDS
npm run build --workspace apps/web            # Expected: build FAILS on types
git checkout apps/web/src/lib/legal.ts        # remove the probe
```

All three expectations must hold — they prove tsc still gates, the flag skips, and the default build still checks.

- [ ] **Step 3: Set the flag on the CI smoke build**

In `.github/workflows/ci.yml`, change the smoke job build step:

```yaml
      - name: Build (production)
        run: npm run build --workspace apps/web
        env:
          # tsc gate already ran in the test job — don't type-check twice.
          SKIP_TYPECHECK: "1"
```

- [ ] **Step 4: Set the flag in the Dockerfile and drop the heap bump**

Replace lines 37–39 of `Dockerfile` (the comment + `RUN NODE_OPTIONS=... npm run build ...`, including the uncommitted heap-bump edit) with:

```dockerfile
# tsc gates types in CI; the in-build checker (the 6 GB-heap worker that
# SIGKILLed on builder VMs) is skipped here.
RUN SKIP_TYPECHECK=1 npm run build --workspace apps/web
```

- [ ] **Step 5: Commit**

```bash
git add apps/web/next.config.js .github/workflows/ci.yml Dockerfile
git commit -m "perf(build): type-check once — SKIP_TYPECHECK gates in-build tsc in CI/Docker"
```

---

### Task 2: Path-filter the engine gates in CI

**Files:**
- Modify: `.github/workflows/ci.yml` (test job, steps at ~lines 47–66)

**Interfaces:**
- Consumes: nothing.
- Produces: step id `engine-changes` with output `engine` (`'true'`/`'false'`).

- [ ] **Step 1: Add the paths-filter step**

In the test job, immediately after `- uses: actions/checkout@v5`, add:

```yaml
      # Engine coverage + sim matrix only run when the engine (or the
      # dependency graph) changed — most PRs touch apps/web only.
      - uses: dorny/paths-filter@v3
        id: engine-changes
        with:
          filters: |
            engine:
              - 'packages/engine/**'
              - 'package-lock.json'
              - 'pnpm-lock.yaml'
```

(Both lockfile names listed so this works before and after the pnpm swap.)

- [ ] **Step 2: Gate the engine coverage and sim steps**

Add an `if:` to the coverage step and the sim matrix step (engine **typecheck** and `engine:boundary` stay unconditional — they are cheap and structural):

```yaml
      - run: npm run test:coverage --workspace packages/engine
        if: steps.engine-changes.outputs.engine == 'true'
      - name: Sim matrix (bounded CI profile)
        if: steps.engine-changes.outputs.engine == 'true'
        run: SIM_SEEDS=5 npm run sim:matrix --workspace packages/engine
```

The two artifact-upload steps keep their existing `if: always()` / `if: failure()` — `if-no-files-found: ignore` already handles the skipped case.

- [ ] **Step 3: Lint the workflow (best effort)**

```bash
command -v actionlint >/dev/null && actionlint .github/workflows/ci.yml || echo "actionlint not installed — CI run on the branch is the real check"
```

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "perf(ci): engine coverage + sim matrix run only on engine/lockfile changes"
```

---

### Task 3: Security job installs nothing

**Files:**
- Modify: `.github/workflows/ci.yml` (security job, lines 86–90)

- [ ] **Step 1: Delete the install**

`npm audit` resolves from `package.json` + lockfile + the registry advisory API — no `node_modules` needed. In the security job, replace:

```yaml
      - uses: actions/setup-node@v5
        with:
          node-version: 22
          cache: npm
      - run: npm ci
```

with:

```yaml
      - uses: actions/setup-node@v5
        with:
          node-version: 22
```

(No `cache:` either — nothing is installed.) The audit step itself is unchanged.

- [ ] **Step 2: Verify audit works without node_modules locally**

```bash
mv node_modules /tmp/nm-parked && npm audit --audit-level=high; mv /tmp/nm-parked node_modules
```

Expected: audit produces its normal report (exit code may be non-zero on advisories — that's fine, the CI step is `continue-on-error`).

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "perf(ci): security job audits from the lockfile — no install"
```

---

### Task 4: Benchmark gate — npm vs pnpm

**Files:**
- Create: `pnpm-lock.yaml` (generated, **not committed in this task**)
- No committed changes — measurement only. Record numbers in the PR description later.

**Interfaces:**
- Produces: GO/NO-GO decision for Tasks 5–7.

- [ ] **Step 1: Generate the pnpm lockfile from the npm one**

```bash
corepack enable
corepack use pnpm@10        # pins exact "packageManager" in package.json + installs
pnpm import                 # converts package-lock.json → pnpm-lock.yaml, same resolved versions
git checkout package.json   # undo the pin for now — Task 5 re-does it deliberately
```

- [ ] **Step 2: Time npm — warm cache (the CI-job case)**

```bash
rm -rf node_modules apps/web/node_modules packages/engine/node_modules
time npm ci                 # run twice; record the second (fully warm) time
```

- [ ] **Step 3: Time pnpm — warm store**

```bash
rm -rf node_modules apps/web/node_modules packages/engine/node_modules
time pnpm install --frozen-lockfile   # run twice; record the second time
```

- [ ] **Step 4: Time both cold (the Docker-layer case)**

```bash
rm -rf node_modules apps/web/node_modules packages/engine/node_modules
npm cache clean --force && time npm ci
rm -rf node_modules apps/web/node_modules packages/engine/node_modules
time pnpm install --frozen-lockfile --store-dir "$(mktemp -d)/pnpm-store"
```

- [ ] **Step 5: Decide**

GO if pnpm warm beats npm warm by ≥30 s, **or** pnpm cold beats npm cold by ≥1 min. Record all four numbers. On NO-GO: `rm pnpm-lock.yaml`, run `npm ci` to restore `node_modules`, skip Tasks 5–7, and in Task 6's place apply only the npm-fallback edits listed at the bottom of this plan ("NO-GO fallback").

---

### Task 5: pnpm workspace conversion

**Files:**
- Create: `pnpm-workspace.yaml`
- Modify: `package.json` (root — scripts, workspaces removal, packageManager pin, new deps)
- Modify: `apps/web/package.json` (`@seazn/engine` → `workspace:*`)
- Modify: `apps/web/playwright.config.ts:85`
- Delete: `package-lock.json`

**Interfaces:**
- Consumes: `pnpm-lock.yaml` from Task 4.
- Produces: `pnpm run <script>` at root, `pnpm --filter @seazn/web <script>` / `pnpm --filter @seazn/engine <script>` — the exact invocations Tasks 6/7 write into workflows and the Dockerfile.

- [ ] **Step 1: Create `pnpm-workspace.yaml`**

```yaml
packages:
  - "apps/*"
  - "packages/*"
```

- [ ] **Step 2: Pin the package manager and drop the workspaces field**

```bash
corepack use pnpm@10   # writes exact "packageManager": "pnpm@10.x.y" into package.json
```

Then in root `package.json` delete the `"workspaces": [...]` block (pnpm-workspace.yaml is the single source of truth).

- [ ] **Step 3: Declare the root scripts' real dependencies**

The root `scripts/*.ts` import `@anthropic-ai/sdk`, `stripe`, `bcryptjs`, `postgres`, and `@seazn/engine/sports` — today resolved via npm hoisting (phantom deps under pnpm). Add to root `package.json`:

```json
  "dependencies": {
    "@anthropic-ai/sdk": "^0.110.0",
    "@seazn/engine": "workspace:*",
    "bcryptjs": "^3.0.3",
    "postgres": "^3.4.9",
    "stripe": "^22.3.0"
  }
```

(`dependencies`, not dev — the deploy job installs `--prod` and runs `stripe-sync.ts` / `sync:sports`.)

- [ ] **Step 4: Rewrite root workspace-delegating scripts**

In root `package.json`, replace only these script values (all `node`/`bash` scripts stay untouched):

```json
    "dev": "pnpm --filter @seazn/web dev",
    "build": "pnpm --filter @seazn/web build",
    "start": "pnpm --filter @seazn/web start",
    "lint": "pnpm --filter @seazn/web lint",
    "test": "pnpm --filter @seazn/web test && pnpm --filter @seazn/engine test",
    "test:watch": "pnpm --filter @seazn/web test:watch",
    "test:coverage": "pnpm --filter @seazn/web test:coverage",
    "sim": "pnpm --filter @seazn/engine sim",
    "sim:replay": "pnpm --filter @seazn/engine sim:replay",
```

- [ ] **Step 5: workspace protocol + playwright webServer**

In `apps/web/package.json`: `"@seazn/engine": "*"` → `"@seazn/engine": "workspace:*"`.

In `apps/web/playwright.config.ts` line 85: `command: "npm run build && npm run start",` → `command: "pnpm run build && pnpm run start",`.

- [ ] **Step 6: Swap lockfiles and install**

```bash
git rm package-lock.json
pnpm install        # updates pnpm-lock.yaml with workspace:* + new root deps
```

- [ ] **Step 7: Full verification — this is where phantom deps surface**

```bash
pnpm --filter @seazn/web typecheck
pnpm --filter @seazn/engine typecheck
pnpm run engine:boundary
pnpm run openapi:gen && git diff --exit-code openapi/v1.json
pnpm run test                       # web + engine unit suites
SKIP_TYPECHECK=1 pnpm run build     # production build resolves every runtime import
```

Any "Cannot find module X" = phantom dep → add X explicitly to the importing workspace's `package.json`, `pnpm install`, re-run. Never hoist.

- [ ] **Step 8: Commit**

```bash
git add package.json pnpm-workspace.yaml pnpm-lock.yaml apps/web/package.json apps/web/playwright.config.ts
git commit -m "build: migrate workspace npm → pnpm (workspace protocol, root script deps declared)"
```

---

### Task 6: Workflows → pnpm

**Files:**
- Modify: `.github/workflows/ci.yml` (all four jobs)
- Modify: `.github/workflows/e2e.yml` (contents only — workflow stays disabled)
- Modify: `.github/workflows/help-shots.yml`
- Modify: `.github/workflows/sim-nightly.yml`
- (`funnel-reminders.yml`, `db-baseline.yml` contain no npm usage — untouched.)

**Interfaces:**
- Consumes: root/filter script invocations from Task 5; `SKIP_TYPECHECK` from Task 1; `engine-changes` from Task 2.

- [ ] **Step 1: Standard setup block, every job that installs**

Wherever a job has setup-node + `npm ci`, replace with (pnpm/action-setup **before** setup-node — the cache needs pnpm on PATH; version comes from the `packageManager` field):

```yaml
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v5
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install --frozen-lockfile
```

Applies to: ci.yml test + smoke jobs; e2e.yml both jobs; help-shots.yml; sim-nightly.yml.

- [ ] **Step 2: ci.yml command swaps**

| Old | New |
|---|---|
| `npm run typecheck --workspace apps/web` | `pnpm --filter @seazn/web typecheck` |
| `npm run typecheck --workspace packages/engine` | `pnpm --filter @seazn/engine typecheck` |
| `npm run engine:boundary` / `openapi:gen` / `db:apply` / `db:info` / `check:rls` / `sync:sports` / `stripe:sync` / `test:smoke` | same name via `pnpm run …` |
| `npm test --workspace apps/web` | `pnpm --filter @seazn/web test` |
| `npm run test:coverage --workspace packages/engine` | `pnpm --filter @seazn/engine test:coverage` |
| `SIM_SEEDS=5 npm run sim:matrix --workspace packages/engine` | `SIM_SEEDS=5 pnpm --filter @seazn/engine sim:matrix` |
| `npm test --workspace apps/web -- run src/server` | `pnpm --filter @seazn/web test run src/server` |
| `npm test --workspace apps/web -- run src/lib/__tests__/rate-limit.redis.test.ts` | `pnpm --filter @seazn/web test run src/lib/__tests__/rate-limit.redis.test.ts` |
| `npm run build --workspace apps/web` | `pnpm --filter @seazn/web build` |
| `npm run start --workspace apps/web` | `pnpm --filter @seazn/web start` |

Also: the OpenAPI drift error message text → `run 'pnpm run openapi:gen' and commit.`; both Next-cache `hashFiles('package-lock.json')` keys → `hashFiles('pnpm-lock.yaml')`.

- [ ] **Step 3: security job audit**

The security job (no install, per Task 3) needs pnpm for the audit:

```yaml
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v5
        with:
          node-version: 22
      - name: Dependency audit (high+)
        run: pnpm audit --audit-level=high
        continue-on-error: true
```

- [ ] **Step 4: deploy-staging job — prod-only install**

```yaml
      - run: pnpm install --frozen-lockfile --prod   # stripe-sync.ts imports postgres + stripe (root prod deps)
```

- [ ] **Step 5: e2e.yml / help-shots.yml / sim-nightly.yml**

Same table as Step 2 where commands appear, plus:

| Old | New |
|---|---|
| `npx playwright install --with-deps chromium` | `pnpm --filter @seazn/web exec playwright install --with-deps chromium` |
| `npm run test:e2e` | `pnpm --filter @seazn/web test:e2e` |
| `npm run dev` (help-shots) | `pnpm run dev` |
| `npm run sim --workspace packages/engine` | `pnpm --filter @seazn/engine sim` |
| comment `npm run sim:replay -- <seedToken>` | `pnpm run sim:replay <seedToken>` |

- [ ] **Step 6: Sweep + lint**

```bash
grep -rn "npm ci\|npm run\|npm test\|npx " .github/workflows/   # Expected: no hits
command -v actionlint >/dev/null && actionlint || true
```

- [ ] **Step 7: Commit**

```bash
git add .github/workflows/
git commit -m "ci: all workflows install and run via pnpm"
```

---

### Task 7: Dockerfile — pnpm fetch + BuildKit store cache

**Files:**
- Modify: `Dockerfile` (builder stage only; runner stage untouched)

**Interfaces:**
- Consumes: `pnpm-lock.yaml` + `pnpm-workspace.yaml` (Task 5), `SKIP_TYPECHECK` (Task 1).

- [ ] **Step 1: Rewrite the builder stage top**

Replace Dockerfile lines 1–9 (FROM through `RUN npm ci`) with:

```dockerfile
# ── Stage 1: install all deps (including devDeps for build) ──────────────────
FROM node:22-alpine AS builder
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /app

# `pnpm fetch` needs ONLY the lockfile — package.json edits no longer bust
# this layer. The BuildKit cache mount persists the store on the Fly builder
# disk between deploys (best effort — evicted when the builder VM recycles).
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm config set store-dir /pnpm/store && pnpm fetch

COPY package.json ./
COPY apps/web/package.json apps/web/
COPY packages/engine/package.json packages/engine/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --offline
```

The build RUN (already `SKIP_TYPECHECK=1 …` from Task 1) becomes:

```dockerfile
RUN SKIP_TYPECHECK=1 pnpm --filter @seazn/web build
```

Everything else — ARG/ENV blocks, runner stage, standalone copy, non-root user — unchanged.

- [ ] **Step 2: Local Docker build**

```bash
docker build -t seazn-pnpm-test \
  --build-arg NEXT_PUBLIC_SUPABASE_URL="$(grep '^NEXT_PUBLIC_SUPABASE_URL=' apps/web/.env.local | cut -d= -f2-)" \
  --build-arg NEXT_PUBLIC_SUPABASE_ANON_KEY="$(grep '^NEXT_PUBLIC_SUPABASE_ANON_KEY=' apps/web/.env.local | cut -d= -f2-)" \
  .
```

Expected: image builds; second run of the same command reuses the fetch layer. If Docker isn't available locally, this is verified by the staging deploy after merge (Task 9) — say so in the PR.

- [ ] **Step 3: Commit**

```bash
git add Dockerfile
git commit -m "build(docker): pnpm fetch off the lockfile + BuildKit store cache mount"
```

---

### Task 8: Docs

**Files:**
- Modify: `README.md` (lines 26, 133, 158–201 — every `npm` command)

- [ ] **Step 1: Update README**

- Line 26: "This is an npm workspace monorepo" → "This is a pnpm workspace monorepo (`corepack enable` once, then `pnpm install`)".
- `npm ci` → `pnpm install --frozen-lockfile`; every `npm run X` / `npm test` → `pnpm run X` / `pnpm test`; the CI description's "`npm audit` (advisory)" → "`pnpm audit` (advisory)".

Help pages (`content/help/*.md`) are user-facing product docs — a package-manager swap is not user-visible, so no help edits this branch (noted deliberately against the always-update-help rule).

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: README commands npm → pnpm"
```

---

### Task 9: Full verify, PR, staging watch

- [ ] **Step 1: Full local gate (per verify-before-push rule)**

```bash
pnpm --filter @seazn/web typecheck && pnpm --filter @seazn/engine typecheck
pnpm run test
SKIP_TYPECHECK=1 pnpm run build
pnpm run i18n:check
```

All green before push.

- [ ] **Step 2: Push branch, open PR**

```bash
git push -u origin feat/monorepo-opt
gh pr create --title "perf: monorepo CPU de-dupe + pnpm migration" --body "<benchmark table from Task 4, verification notes, rollback: single revert restores package-lock.json>"
```

- [ ] **Step 3: Watch CI on the PR**

This PR changes the lockfile → the `engine-changes` filter must fire **true** (engine coverage + sim run — proves the gate wiring). Confirm: test job green with all steps, security job green with no install step, smoke job green with `SKIP_TYPECHECK=1` build.

- [ ] **Step 4: After merge — staging deploy watch**

Confirm the Fly build succeeds **without** the heap bump and the staging app boots (`/api/health` 200). This closes the loop on the deleted `NODE_OPTIONS` workaround.

---

## NO-GO fallback (Task 4 fails the gate)

Skip Tasks 5–7. Instead:

- ci.yml deploy job: `npm ci` → `npm ci --omit=dev`.
- Dockerfile keeps npm but gains a cache mount: `RUN --mount=type=cache,id=npm,target=/root/.npm npm ci --prefer-offline` (plus the Task 1 `SKIP_TYPECHECK=1` build line, already landed).
- Task 8 README edits: skip (commands unchanged). Task 9 runs as written with npm commands.
