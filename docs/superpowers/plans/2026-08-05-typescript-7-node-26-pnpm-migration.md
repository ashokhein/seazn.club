# TypeScript 7 + Node 26 + pnpm — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the repo's typecheck onto the native TypeScript 7 compiler (54.05s -> 8.21s, and no V8 heap ceiling), on a Node 26 floor, then convert package management to pnpm so a fresh worktree install is near-free.

**Architecture:** Three independently revertible PRs. `typescript` keeps the bare specifier at 6.0.3 because typescript-eslint, `next build`'s in-build checker, and three compiler-API tests all resolve it by name and TS 7 publishes no `main`; TS 7 arrives under an npm alias and is invoked by explicit binary path because the two packages collide on `.bin/tsc`. Node lands before TypeScript because it changes the same Docker base image that the TS 7 musl question falls on.

**Tech Stack:** npm workspaces (-> pnpm in stage 3), Turborepo, Next 16.2.9, React 19.2.4, vitest 4, Playwright, typescript-eslint 8, postgres.js, Fly.io + Docker (alpine), GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-08-05-typescript-7-node-26-pnpm-migration-design.md`

---

## Global Constraints

Every task's requirements implicitly include this section.

- **Exact pins, no carets** for both compilers: `"typescript": "6.0.3"`, `"typescript-native": "npm:typescript@7.0.2"`.
- **Never invoke bare `tsc`.** Both packages declare `bin.tsc`; which one wins `node_modules/.bin/tsc` is install-order dependent. Verified: with both installed, `.bin/tsc -> ../typescript/bin/tsc` (v7) and `.bin/tsserver -> ../typescript6/bin/tsserver` (v6).
- **`typescript` (bare) must stay 6.x.** `typescript@7.0.2` has no `main`, no `types`, no `tsserver` bin — exports are `./lib/version.cjs` and `./unstable/{ast,sync,async,fs,proto}` only.
- **Node target is 26** (`node:26-alpine` exists on Docker Hub; local dev is already v26.4.0). Node 26 is LTS on 2026-10-28; it is Current until then, and this is accepted.
- **Node 26 has no corepack.** Stage 3 installs pnpm explicitly.
- **Every task ships four test types:** unit, regression (fails without the change), e2e, smoke. Unit + regression are per-task and land in the same commit. e2e + smoke are satisfied by the stage gate.
- **Before every commit:** run `openapi:gen` and `i18n:gen-keys`, then `git status --porcelain` must be empty. Both are CI-only gates; a green local test run says nothing about them.
- **Work in a worktree**, never the main checkout. `cd <abs worktree> &&` must be in the **same shell call** as every command — shell cwd resets to the main checkout between calls and a verify run that executes on `main` returns a false green.
- **Never `git stash` in a worktree.** The stash stack is shared with the main checkout; a no-op push/pop pops a *foreign* stash and leaves `package.json` unmerged, blocking every commit in the tree.
- **Never set `UPDATE_GOLDEN=1`.** The 11 `<key>.golden.json` corpora are frozen and are the additive-only proof.
- **Never enable `.github/workflows/e2e.yml`** — do not change its enabled/disabled state in either direction.
- **All three stages land on the long-lived `typescript7` base branch, never directly on `main`.** `main` is touched once, at the end, by a single `typescript7 -> main` PR raised after everything is verified locally. `typescript7` was created at `6847b3c6`.
  - This is safe because `ci.yml`'s `pull_request:` trigger is **unfiltered** — a PR into `typescript7` runs typecheck, unit, smoke, and security in full, exactly as a PR into `main` would.
  - `push: branches: [main]` drives the staging deploy, so a base branch also keeps staging off a half-migrated toolchain, and `e2e.yml` runs on push to main — it fires once, against the fully migrated tree, at integration.
  - **Consequence:** smoke CI runs on **PRs only**. A stage merged locally into `typescript7` with no PR gets no CI smoke, so its local smoke run is the only one it will ever have. Never skip a local smoke on the grounds that "CI will catch it" — here, it will not.
  - Rebase `typescript7` onto `main` at the start of every stage. Another session commits to `main` continuously; drift is the standing cost of this model.
- **Unrelated failures are not chased.** A red test in files this programme did not touch is skipped, noted in the summary, and left for CI.

---

## Verified Baseline

Facts established by direct measurement on 2026-08-05. Do not re-derive these.

| Fact | Value | How it was established |
| --- | --- | --- |
| `apps/web` typecheck, TS 5.9.3 | 54.05s wall, 2.80 GB peak RSS, **0 errors** | `/usr/bin/time -l tsc --noEmit -p tsconfig.json` |
| `apps/web` typecheck, TS 7.0.2 | 8.21s wall, 2.54 GB peak RSS, **1 error** | same |
| `packages/engine`, TS 7.0.2 | **0 errors**, exit 0 | same |
| `tsconfig.scripts.json`, TS 7.0.2 | **0 errors**, exit 0 | same |
| The one error | `apps/web/src/lib/pass-vs-plan.ts:135` TS2769 | see Task 2.3 |
| `@ts-ignore` in tracked source | **0** | `git grep -c` over `apps/**`, `packages/**`, `scripts/**` |
| `@ts-expect-error` in tracked source | **0** | same |
| `const enum` / `namespace` | **0 / 0** | grep over the three source trees |
| typescript-eslint 8.66.0 peer | `typescript: ">=4.8.4 <6.1.0"` | `npm view` — **cannot run on TS 7** |
| `node-version: 22` sites | **9**, in 5 files | listed in Task 1.1 |
| Heap ceiling | `ci.yml:82` `NODE_OPTIONS: --max-old-space-size=6144` | grep |
| Container runtime on dev machine | **none** (`docker`/`colima`/`nerdctl`/`lima` absent; `podman` is x86, won't exec on arm64) | `command -v` |

**Why RSS barely moved:** it does not need to. TS 7 is a Go binary, so `--max-old-space-size` stops applying at all. The OOM class dies because the cap disappears, not because the appetite shrank.

---

## File Structure

**Stage 1 — platform floor**

| File | Responsibility | Change |
| --- | --- | --- |
| `.github/workflows/ci.yml` | main CI | 4x `node-version` |
| `.github/workflows/e2e.yml` | e2e CI | 2x `node-version` (content only — never touch its enabled state) |
| `.github/workflows/db-baseline.yml` | flyway baseline | 1x `node-version` |
| `.github/workflows/help-shots.yml` | help screenshots | 1x `node-version` |
| `.github/workflows/sim-nightly.yml` | nightly sim | 1x `node-version` |
| `Dockerfile` | prod image | 2x base image (lines 2, 44) |
| `package.json` | root manifest | new `engines` field |
| `apps/web/package.json` | web manifest | `@types/node` |
| `packages/engine/package.json` | engine manifest | `@types/node` |
| `apps/web/tsconfig.json` | web compiler options | `target` |
| `apps/web/eslint.config.mjs` | web lint | `ban-ts-comment` |
| `packages/engine/eslint.config.mjs` | engine lint | `ban-ts-comment` |
| `apps/web/src/__tests__/toolchain.test.ts` | **new** — toolchain invariants | created here, extended in stage 2 |

**Stage 2 — TypeScript 7**

| File | Responsibility | Change |
| --- | --- | --- |
| `package.json` | root manifest | both compiler pins; `typecheck` scripts |
| `apps/web/package.json` | web manifest | `typecheck` script -> explicit v7 path |
| `packages/engine/package.json` | engine manifest | `typecheck` script -> explicit v7 path |
| `apps/web/src/lib/pass-vs-plan.ts:128-143` | pass-vs-plan query | hoist the array literal |
| `apps/web/src/lib/__tests__/pass-vs-plan-sql.test.ts` | **new** — regression for the fix | created |
| `apps/web/src/__tests__/toolchain.test.ts` | toolchain invariants | compiler-identity assertions |
| `.github/workflows/ci.yml` | main CI | drop `NODE_OPTIONS`; new container job |

**Stage 3 — pnpm**

| File | Responsibility | Change |
| --- | --- | --- |
| `pnpm-workspace.yaml` | **new** — workspace definition | created |
| `package.json` | root manifest | `workspace:*`, root script deps, `packageManager` |
| `apps/web/package.json` | web manifest | `@seazn/engine: workspace:*` |
| `apps/web/next.config.js` | Next config | z3 wasm trace glob |
| `Dockerfile` | prod image | pnpm install + store cache mount |
| `.github/workflows/*.yml` | all CI | 7x `npm ci` -> pnpm; audit; deploy install |
| `docs/superpowers/plans/2026-08-05-pnpm-benchmark-results.md` | **new** — the numbers this stage exists to produce | created |

---

# STAGE 1 — Platform floor (node 22 -> 26)

Branch: `ts-migration-stage-1-node-26`. One PR.

### Task 1.1: Raise the Node floor across CI and the manifests

**Files:**
- Modify: `.github/workflows/ci.yml:59`, `:180`, `:262`, `:501`
- Modify: `.github/workflows/e2e.yml:102`, `:238`
- Modify: `.github/workflows/db-baseline.yml:20`
- Modify: `.github/workflows/help-shots.yml:42`
- Modify: `.github/workflows/sim-nightly.yml:30`
- Modify: `package.json` (add `engines`)
- Modify: `apps/web/package.json`, `packages/engine/package.json` (`@types/node`)
- Test: `apps/web/src/__tests__/toolchain.test.ts` (create)

**Interfaces:**
- Produces: `apps/web/src/__tests__/toolchain.test.ts`, extended by Task 2.2. It reads manifests and workflow YAML as text — it must not import from `next/*` or anything requiring a DB.

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/__tests__/toolchain.test.ts`:

```ts
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = join(import.meta.dirname, "../../../..");

/**
 * The Node floor is stated in four places that have no way to check each other:
 * the root `engines` field, every `setup-node` step, the Dockerfile base images,
 * and `@types/node`. They drifted before this test existed — the dev machine ran
 * v26.4.0 while CI and prod ran 22, so every local verification executed on a
 * runtime nothing else used.
 */
const NODE_MAJOR = 26;

describe("toolchain: node floor", () => {
  it("root package.json declares the engines floor", () => {
    const pkg = JSON.parse(
      readFileSync(join(REPO_ROOT, "package.json"), "utf8"),
    ) as { engines?: { node?: string } };
    expect(pkg.engines?.node).toBe(`>=${NODE_MAJOR}`);
  });

  it("every setup-node step pins the same major", () => {
    const dir = join(REPO_ROOT, ".github/workflows");
    const offenders: string[] = [];
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".yml"))) {
      const text = readFileSync(join(dir, file), "utf8");
      for (const [i, line] of text.split("\n").entries()) {
        const m = /^\s*node-version:\s*(\S+)\s*$/.exec(line);
        if (m && m[1] !== String(NODE_MAJOR)) {
          offenders.push(`${file}:${i + 1} -> ${m[1]}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("both Dockerfile stages use the same major", () => {
    const text = readFileSync(join(REPO_ROOT, "Dockerfile"), "utf8");
    const bases = [...text.matchAll(/^FROM\s+node:(\S+?)-alpine/gm)].map(
      (m) => m[1],
    );
    expect(bases.length).toBe(2);
    expect(bases).toEqual([String(NODE_MAJOR), String(NODE_MAJOR)]);
  });

  it("@types/node tracks the runtime major in both workspaces", () => {
    for (const ws of ["apps/web", "packages/engine"]) {
      const pkg = JSON.parse(
        readFileSync(join(REPO_ROOT, ws, "package.json"), "utf8"),
      ) as { devDependencies?: Record<string, string> };
      expect(
        pkg.devDependencies?.["@types/node"],
        `${ws} @types/node`,
      ).toBe(`^${NODE_MAJOR}`);
    }
  });
});
```

- [ ] **Step 2: Run it and confirm all four cases fail**

```bash
cd <abs worktree> && npm test --workspace apps/web -- src/__tests__/toolchain.test.ts \
  --reporter=json --outputFile=/tmp/t1.json
```

Expected: 4 failed. Read `numFailedTests` from `/tmp/t1.json` — do **not** trust the terminal summary; `rtk` prints `PASS(0) FAIL(0)` for a suite that failed to collect.

- [ ] **Step 3: Make the changes**

Nine `node-version: 22` -> `node-version: 26`, at exactly these locations:

```
.github/workflows/ci.yml:59
.github/workflows/ci.yml:180
.github/workflows/ci.yml:262
.github/workflows/ci.yml:501
.github/workflows/e2e.yml:102
.github/workflows/e2e.yml:238
.github/workflows/db-baseline.yml:20
.github/workflows/help-shots.yml:42
.github/workflows/sim-nightly.yml:30
```

Root `package.json`, after `"packageManager"`:

```json
  "engines": {
    "node": ">=26"
  },
```

In `apps/web/package.json` and `packages/engine/package.json` devDependencies:

```json
    "@types/node": "^26",
```

- [ ] **Step 4: Run the test and confirm three of four now pass**

```bash
cd <abs worktree> && npm test --workspace apps/web -- src/__tests__/toolchain.test.ts \
  --reporter=json --outputFile=/tmp/t1.json
```

Expected: `numPassedTests: 3`, `numFailedTests: 1`. The **Dockerfile case stays red** — it is Task 1.2's deliverable, and Task 1.2 Step 1 consumes it in that state. Do not merge the two tasks to get a green commit here; that collapses two separately revertible changes into one.

**Never write `-- run <path>` here.** The package script is already `vitest run`, so a second `run` is not a subcommand — it is parsed as a **filename filter**, and it matches every file whose path contains "run". Measured: `npm test --workspace apps/web -- run --reporter=json` ran 46 suites / 151 tests instead of the full suite, and the same form against `packages/engine` matched nothing at all and exited 1 with `0/0` suites — which reads exactly like a collection failure. The correct form passes the path alone.

Even then, positionals are filters and not exact paths, so this still pulls in sibling suites. Read the per-file `.testResults[]` entry for `toolchain.test.ts` rather than the top-level totals.

- [ ] **Step 5: Reinstall and confirm the tree still typechecks on TS 5**

```bash
cd <abs worktree> && npm install && npx turbo run typecheck 2>&1 | tail -20
```

`@types/node` 20 -> 26 is the only change here that can move types. Expected: clean. If new errors appear they are real and belong to this task — fix them here, not later.

- [ ] **Step 6: Commit**

```bash
cd <abs worktree> && npm run openapi:gen && npm run i18n:gen-keys && git status --porcelain
# must show only your intended files — if a generator moved something, commit that too
git add -A && git commit -m "chore: raise the node floor to 26

Local dev already ran v26.4.0 while CI and Docker ran 22, so every
local verification executed on a runtime nothing else used. Node 22
has been in maintenance since 2025-10-21; 26 is LTS on 2026-10-28.

toolchain.test.ts is the regression: the floor is stated in four
places that previously had no way to check each other."
```

---

### Task 1.2: Move both Dockerfile stages to node:26-alpine

**Files:**
- Modify: `Dockerfile:2`, `Dockerfile:44`
- Test: `apps/web/src/__tests__/toolchain.test.ts` (already asserts this — written in Task 1.1)

**Interfaces:**
- Consumes: the `both Dockerfile stages use the same major` case from Task 1.1, which is currently failing.

- [ ] **Step 1: Confirm the test case is red**

```bash
cd <abs worktree> && npm test --workspace apps/web -- src/__tests__/toolchain.test.ts \
  --reporter=json --outputFile=/tmp/t2.json
```

Expected: the Dockerfile case fails with `["22","22"]`.

- [ ] **Step 2: Change both stages**

`Dockerfile:2`:
```dockerfile
FROM node:26-alpine AS builder
```

`Dockerfile:44`:
```dockerfile
FROM node:26-alpine AS runner
```

Both tags are verified to exist on Docker Hub (`26-alpine`, `26-alpine3.24`, `26-alpine3.23`). Change nothing else in this file — the `npm ci` line and the BuildKit cache mount belong to stage 3.

- [ ] **Step 3: Confirm the test case is green**

```bash
cd <abs worktree> && npm test --workspace apps/web -- src/__tests__/toolchain.test.ts \
  --reporter=json --outputFile=/tmp/t2.json
```

Expected: `numFailedTests: 0`.

- [ ] **Step 4: Commit**

```bash
cd <abs worktree> && git add Dockerfile && git commit -m "chore: node:26-alpine in both Dockerfile stages"
```

The image itself is verified by the stage gate (Task 1.5), not here — there is no container runtime on the dev machine, so `docker build` runs in CI and on Fly.

---

### Task 1.3: Raise the apps/web compile target to ES2022

**Files:**
- Modify: `apps/web/tsconfig.json` (`"target"`)
- Test: `apps/web/src/__tests__/toolchain.test.ts` (add one case)

**Interfaces:**
- Consumes: `REPO_ROOT` and the file's existing imports from Task 1.1.

This is a real downlevel-output change, not cosmetic — it gets its own commit so it can be reverted alone if a bundle-size or browser-support regression shows up.

- [ ] **Step 1: Add the failing test case**

Append to `apps/web/src/__tests__/toolchain.test.ts`:

```ts
describe("toolchain: compile target", () => {
  it("apps/web targets ES2022, matching the engine", () => {
    const stripJsonComments = (s: string) =>
      s.replace(/^\s*\/\/.*$/gm, "");
    const web = JSON.parse(
      stripJsonComments(
        readFileSync(join(REPO_ROOT, "apps/web/tsconfig.json"), "utf8"),
      ),
    ) as { compilerOptions: { target: string } };
    const engine = JSON.parse(
      stripJsonComments(
        readFileSync(join(REPO_ROOT, "packages/engine/tsconfig.json"), "utf8"),
      ),
    ) as { compilerOptions: { target: string } };
    expect(web.compilerOptions.target).toBe("ES2022");
    expect(web.compilerOptions.target).toBe(engine.compilerOptions.target);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
cd <abs worktree> && npm test --workspace apps/web -- src/__tests__/toolchain.test.ts \
  --reporter=json --outputFile=/tmp/t3.json
```

Expected: fails, `expected 'ES2017' to be 'ES2022'`.

- [ ] **Step 3: Change the target**

In `apps/web/tsconfig.json`:

```json
    "target": "ES2022",
```

- [ ] **Step 4: Run the test and a full typecheck**

```bash
cd <abs worktree> && npm test --workspace apps/web -- src/__tests__/toolchain.test.ts \
  --reporter=json --outputFile=/tmp/t3.json && npx turbo run typecheck 2>&1 | tail -20
```

Expected: test green, typecheck clean.

- [ ] **Step 5: Confirm the production build still succeeds**

```bash
cd <abs worktree> && rm -rf apps/web/.next && npm run build 2>&1 | tail -25; echo "EXIT=$?"
```

`rm -rf apps/web/.next` first: a stale `.next/types` fails tsc for pages you never touched.

- [ ] **Step 6: Commit**

```bash
cd <abs worktree> && git add apps/web/tsconfig.json apps/web/src/__tests__/toolchain.test.ts \
  && git commit -m "chore: target ES2022 in apps/web, matching the engine

Next transpiles per browserslist regardless, but this is a real
downlevel-output change, so it lands on its own commit."
```

---

### Task 1.4: Ban `@ts-ignore` in both lint configs

**Files:**
- Modify: `apps/web/eslint.config.mjs`
- Modify: `packages/engine/eslint.config.mjs`
- Test: `apps/web/src/__tests__/toolchain.test.ts` (add one case)

**Why now:** tracked source contains **zero** `@ts-ignore` and zero `@ts-expect-error` today, verified by `git grep`. Adopting the rule is free at exactly this moment and never will be again. It matters for what comes next: `@ts-ignore` silently absorbs whatever error appears under it, so a future suppression could hide precisely the kind of compiler-delta error that Task 2.3 exists to fix. `@ts-expect-error` errors when unused, so it cannot hide a delta — it reports one.

- [ ] **Step 1: Add the failing test case**

Append to `apps/web/src/__tests__/toolchain.test.ts`:

```ts
describe("toolchain: suppression policy", () => {
  it("both lint configs ban @ts-ignore", () => {
    for (const cfg of [
      "apps/web/eslint.config.mjs",
      "packages/engine/eslint.config.mjs",
    ]) {
      const text = readFileSync(join(REPO_ROOT, cfg), "utf8");
      expect(text, cfg).toContain("@typescript-eslint/ban-ts-comment");
      expect(text, cfg).toMatch(/["']ts-ignore["']\s*:\s*true/);
    }
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
cd <abs worktree> && npm test --workspace apps/web -- src/__tests__/toolchain.test.ts \
  --reporter=json --outputFile=/tmp/t4.json
```

Expected: fails on the first config.

- [ ] **Step 3: Add the rule to the engine config**

In `packages/engine/eslint.config.mjs`, inside the existing rules block that already sets `no-console` (the one containing `"@typescript-eslint/no-unused-vars"`), add:

```js
      // A suppression must announce itself. `@ts-ignore` silently absorbs
      // whatever error appears under it; `@ts-expect-error` errors when it
      // stops being needed, which is what makes a compiler upgrade report a
      // behaviour delta instead of swallowing it. Zero of either existed when
      // this rule went in — it is a ratchet, not a cleanup.
      "@typescript-eslint/ban-ts-comment": [
        "error",
        { "ts-ignore": true, "ts-expect-error": "allow-with-description" },
      ],
```

- [ ] **Step 4: Add the rule to the web config**

In `apps/web/eslint.config.mjs`, in the first `rules` block (the one turning off `react/no-unescaped-entities`), add the identical rule:

```js
      // See packages/engine/eslint.config.mjs for the rationale.
      "@typescript-eslint/ban-ts-comment": [
        "error",
        { "ts-ignore": true, "ts-expect-error": "allow-with-description" },
      ],
```

- [ ] **Step 5: Run both lint tasks and the test**

```bash
cd <abs worktree> && rtk proxy npm run lint 2>&1 | tail -15
cd <abs worktree> && rtk proxy npm run lint --workspace packages/engine 2>&1 | tail -15
cd <abs worktree> && npm test --workspace apps/web -- src/__tests__/toolchain.test.ts \
  --reporter=json --outputFile=/tmp/t4.json
```

Read `✖ N problems` from the lint output. `rtk` hides `npm run lint` output entirely and "ESLint output (JSON parse failed)" is the wrapper losing the result, not a clean run — that is why these go through `rtk proxy`. Both must be at or below their pre-change counts (root baseline: 0 errors / 79 warnings).

Run both: the root `lint` script covers `apps/web` and `packages/engine` separately, and a clean root run says nothing about the engine.

- [ ] **Step 6: Commit**

```bash
cd <abs worktree> && git add apps/web/eslint.config.mjs packages/engine/eslint.config.mjs \
  apps/web/src/__tests__/toolchain.test.ts \
  && git commit -m "chore: ban @ts-ignore in favour of @ts-expect-error

Tracked source has zero of either today, so this is a free ratchet.
@ts-ignore absorbs whatever error appears under it; @ts-expect-error
errors when unused, so it reports a compiler delta instead of hiding
one."
```

---

### Task 1.5: Stage 1 gate and PR

**Files:** none modified — this is the gate.

- [ ] **Step 1: Prove the tree you are testing is the tree you edited**

```bash
cd <abs worktree> && pwd && git status --porcelain && readlink -f node_modules/@seazn/engine
```

`readlink` must resolve **inside the worktree**. If it points at the main checkout, every `apps/web` typecheck, test, and build has been compiling main's engine and every green so far is void. Fix with a real `npm ci` in the worktree before continuing. `git status` must be quiet — a sibling agent's uncommitted files read as your failures.

- [ ] **Step 2: Bring up a fresh database**

Follow the `seazn-local-env` skill. Both commands, in order:

```bash
cd <abs worktree> && npm run db:apply && npm run sync:sports
```

`db:apply` alone is **not** a fresh schema — without `sync:sports`, `funnel.test.ts` fails with `expected 'generic' to be 'badminton'`.

- [ ] **Step 3: Run the full unit gate**

```bash
cd <abs worktree> && npm test --workspace apps/web -- --reporter=json --outputFile=/tmp/g1-web.json 2>&1 | tail -5
cd <abs worktree> && npm test --workspace packages/engine -- --reporter=json --outputFile=/tmp/g1-eng.json 2>&1 | tail -5
```

Judge only from the JSON: `numPassedTests`, `numTotalTests`, `numPendingTests`. A worktree with no `.env.local` silently skips ~1772 DB tests with `numTotalTests` **unchanged** — only `numPendingTests` moves. Confirm `pending` did not jump. Confirm `.testResults[].name` paths resolve inside the worktree.

- [ ] **Step 4: Typecheck, lint, and drift**

```bash
cd <abs worktree> && npx turbo run typecheck 2>&1 | tail -20
cd <abs worktree> && rtk proxy npm run lint 2>&1 | tail -10
cd <abs worktree> && rtk proxy npm run lint --workspace packages/engine 2>&1 | tail -10
cd <abs worktree> && npm run openapi:gen && npm run i18n:gen-keys && npm run i18n:check && git status --porcelain
```

`git status --porcelain` must be **empty**. Both generators are CI-only gates — a green local run proves nothing without this check, and it has been missed five times.

- [ ] **Step 5: Build, smoke, sim matrix**

```bash
cd <abs worktree> && rm -rf apps/web/.next && npm run build 2>&1 | tail -10
cd <abs worktree> && npm run test:smoke 2>&1 | tail -20
cd <abs worktree> && npm run sim:matrix --workspace packages/engine 2>&1 | tail -20
```

- [ ] **Step 6: e2e against a real production server**

Follow `project_local_e2e_recipe`. Production build, `E2E_PROD_TARGET` on **`localhost`** — never `127.0.0.1`. Under `NODE_ENV=production` the session cookie is `Secure`, and the request context will not send it to `127.0.0.1`: every API call 401s while the browser still looks signed in.

Run this in the main thread. Do **not** dispatch it to a subagent — two have died to the 600s watchdog.

- [ ] **Step 7: Open the PR**

```bash
cd <abs worktree> && git push -u origin ts-migration-stage-1-node-26
gh pr create --base typescript7 --title "Raise the platform floor: node 26, ES2022, @ts-ignore banned" --body "$(cat <<'EOF'
Stage 1 of 3. Spec: `docs/superpowers/specs/2026-08-05-typescript-7-node-26-pnpm-migration-design.md`

Node 22 has been in maintenance since 2025-10-21, and local dev was already
on v26.4.0 while CI and Docker ran 22 — so every local verification executed
on a runtime nothing else used. This closes that drift and raises the floor
to 26 (LTS on 2026-10-28).

Also lands two things that are free right now and get more expensive later:
`target: ES2022` in apps/web (matching the engine), and an ESLint ban on
`@ts-ignore` — tracked source has zero suppressions of either kind today.

Nothing here touches the compiler. TypeScript 7 is stage 2; it lands after
this because it shares the Docker base image, and a musl failure with two
suspects is not diagnosable.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 8: Watch CI to green**

```bash
cd <abs worktree> && gh pr checks --watch
```

If a new push resets checks mid-watch, `gh pr checks --watch` dies with "no checks reported" — restart the watch, it is not a failure. Smoke runs on PRs only, so this PR run is the only smoke signal before merge.

---

# STAGE 2 — TypeScript 7

Branch: `ts-migration-stage-2-typescript-7`, cut from **`typescript7`** after stage 1 merges into it. One PR, `--base typescript7`. Rebase `typescript7` onto `main` first.

### Task 2.1: Install the dual-compiler pair

**Files:**
- Modify: `package.json`, `apps/web/package.json`, `packages/engine/package.json`

**Interfaces:**
- Produces: `node_modules/typescript` at 6.0.3 (bare specifier) and `node_modules/typescript-native` at 7.0.2. Tasks 2.2 and 2.3 depend on both resolving.

- [ ] **Step 1: Replace the compiler devDependencies**

In **both** `apps/web/package.json` and `packages/engine/package.json`, replace `"typescript": "^5"` with:

```json
    "typescript": "6.0.3",
    "typescript-native": "npm:typescript@7.0.2",
```

Exact pins, no carets, in both workspaces. This ordering is forced, not stylistic:

- `typescript@7.0.2` publishes **no `main`, no `types`, no `tsserver`** — its exports are `./lib/version.cjs` and `./unstable/{ast,sync,async,fs,proto}`.
- typescript-eslint 8.66.0 peers `typescript: ">=4.8.4 <6.1.0"` and imports `typescript` by bare specifier for its type-aware rules — `packages/engine/eslint.config.mjs` uses `recommendedTypeChecked` with `projectService`, so this is load-bearing, not incidental.
- `next build`'s in-build checker resolves `typescript` by bare specifier.
- Three tests import it by bare specifier: `apps/web/src/__tests__/app-module-exports.test.ts`, `apps/web/src/lib/__tests__/_help-copy.ts`, `apps/web/src/lib/__tests__/pass-scoping-guard.test.ts`.

Those three files need **no changes**. Porting them to `typescript/unstable/ast` is explicitly out of scope.

- [ ] **Step 2: Install and inspect what the bin collision did**

```bash
cd <abs worktree> && npm install && ls -l node_modules/.bin/tsc node_modules/.bin/tsserver \
  && node -p "require('typescript/package.json').version" \
  && node node_modules/typescript-native/bin/tsc --version
```

Expected: `typescript` reports `6.0.3`, the aliased binary reports `Version 7.0.2`. `.bin/tsc` will point at one of them and **which one is install-order dependent** — this was verified in a scratch install, where v7 won `.bin/tsc` while v6 won `.bin/tsserver`. Record what you see; do not rely on it.

- [ ] **Step 3: Commit**

```bash
cd <abs worktree> && git add package.json apps/web/package.json packages/engine/package.json package-lock.json \
  && git commit -m "build: install typescript 6.0.3 + typescript-native (7.0.2) side by side

typescript@7 publishes no main/types/tsserver, and typescript-eslint
peers <6.1.0 — so the bare specifier has to stay 6.x for lint, the
in-build checker, the three compiler-API tests, and the editor. 7
arrives under an alias and is invoked by explicit path."
```

---

### Task 2.2: Point the typecheck scripts at TS 7, and assert which compiler ran

**Files:**
- Modify: `package.json` (root `typecheck`), `apps/web/package.json`, `packages/engine/package.json`
- Test: `apps/web/src/__tests__/toolchain.test.ts` (extend)

**Interfaces:**
- Consumes: both compilers installed (Task 2.1).
- Produces: `npm run typecheck` in every workspace runs TS 7.

- [ ] **Step 1: Write the failing test**

Append to `apps/web/src/__tests__/toolchain.test.ts`:

```ts
import { execFileSync } from "node:child_process";

describe("toolchain: which compiler gates types", () => {
  /**
   * Both packages declare `bin.tsc`, so `node_modules/.bin/tsc` resolves to
   * whichever installed last. Verified real: in a scratch install v7 won
   * `.bin/tsc` while v6 won `.bin/tsserver`. Every typecheck script therefore
   * names an explicit path, and this test is what stops a silent swap back.
   */
  const NATIVE = join(REPO_ROOT, "node_modules/typescript-native/bin/tsc");

  it("the aliased binary is TypeScript 7", () => {
    const out = execFileSync(process.execPath, [NATIVE, "--version"], {
      encoding: "utf8",
    });
    expect(out).toMatch(/Version 7\./);
  });

  it("the bare specifier is still TypeScript 6, for lint and the editor", () => {
    const pkg = JSON.parse(
      readFileSync(join(REPO_ROOT, "node_modules/typescript/package.json"), "utf8"),
    ) as { version: string };
    expect(pkg.version.startsWith("6.")).toBe(true);
  });

  it("no typecheck script invokes bare tsc", () => {
    const offenders: string[] = [];
    for (const p of ["package.json", "apps/web/package.json", "packages/engine/package.json"]) {
      const pkg = JSON.parse(readFileSync(join(REPO_ROOT, p), "utf8")) as {
        scripts?: Record<string, string>;
      };
      for (const [name, body] of Object.entries(pkg.scripts ?? {})) {
        if (!name.startsWith("typecheck")) continue;
        if (/(^|[^-\w/])tsc(\s|$)/.test(body)) offenders.push(`${p} :: ${name} -> ${body}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it and confirm the third case fails**

```bash
cd <abs worktree> && npm test --workspace apps/web -- src/__tests__/toolchain.test.ts \
  --reporter=json --outputFile=/tmp/t21.json
```

Expected: the first two pass (Task 2.1 installed both), the third fails listing all three bare-`tsc` scripts.

- [ ] **Step 3: Repoint the scripts**

`apps/web/package.json`:

```json
    "typecheck": "node ../../node_modules/typescript-native/bin/tsc --noEmit && node ../../node_modules/typescript-native/bin/tsc -p ../../tsconfig.scripts.json",
```

`packages/engine/package.json`:

```json
    "typecheck": "node ../../node_modules/typescript-native/bin/tsc --noEmit",
```

Root `package.json` `typecheck` is unchanged in shape — it still delegates to both workspaces:

```json
    "typecheck": "npm run typecheck --workspace apps/web && npm run typecheck --workspace packages/engine",
```

The `../../node_modules/...` path assumes npm hoists the alias to the root, which it does with a single version and no conflict. **Verify it**, because stage 3 changes the linker:

```bash
cd <abs worktree> && ls -d apps/web/node_modules/typescript-native packages/engine/node_modules/typescript-native 2>/dev/null; echo "---"; ls -d node_modules/typescript-native
```

If either workspace got its own copy, switch all three scripts to a resolver shim instead of a relative path:

```json
    "typecheck": "node -e \"process.argv.splice(1,1);require(require.resolve('typescript-native/bin/tsc'))\" --noEmit"
```

- [ ] **Step 4: Run the test and a real typecheck**

```bash
cd <abs worktree> && npm test --workspace apps/web -- src/__tests__/toolchain.test.ts \
  --reporter=json --outputFile=/tmp/t21.json
cd <abs worktree> && npm run typecheck --workspace packages/engine 2>&1 | tail; echo "ENGINE_EXIT=$?"
```

Expected: test green; engine typecheck **clean, exit 0** — measured at 0 errors under TS 7.0.2.

`apps/web` will still fail with exactly one error. That is Task 2.3, not a defect here.

- [ ] **Step 5: Commit**

```bash
cd <abs worktree> && git add package.json apps/web/package.json packages/engine/package.json \
  apps/web/src/__tests__/toolchain.test.ts \
  && git commit -m "build: gate types with TypeScript 7 via explicit binary path

Never bare tsc: both packages declare bin.tsc and the winner is
install-order dependent (verified — v7 took .bin/tsc, v6 took
.bin/tsserver). toolchain.test.ts asserts the resolved compiler's
major so a silent swap cannot pass."
```

---

### Task 2.3: Fix the one TS 7 error in `pass-vs-plan.ts`

**Files:**
- Modify: `apps/web/src/lib/pass-vs-plan.ts:128-143`
- Test: `apps/web/src/lib/__tests__/pass-vs-plan-sql.test.ts` (create)

**The error, verbatim:**

```
src/lib/pass-vs-plan.ts(135,30): error TS2769: No overload matches this call.
  The last overload gave the following error.
    Property 'raw' is missing in type 'string[]' but required in type 'TemplateStringsArray'.
```

**Root cause, established empirically.** postgres.js steers its overloads with conditional types (`First<T,K,TT>` / `Rest<T>` in `node_modules/postgres/types/index.d.ts:155-190`), including a branch commented `force fallback to the tagged template function overload`. An array literal built with a spread, passed **inline** as the argument inside a template hole, makes TS 7 infer `T` differently than TS 5 did, and resolution falls through to the tagged-template signature.

A probe file compiled under TS 7 tested four shapes at once. Only the inline form failed:

| shape | result |
| --- | --- |
| `sql([...passKeys, planKey])` inline | **error** |
| hoisted `const keys = [...passKeys, planKey]` | passes |
| `sql(passKeys.concat(planKey))` | passes |
| hoisted with explicit `: string[]` | passes |

Take the hoist. No cast, no annotation, no `@ts-expect-error` — those would all be more change than the defect warrants, and a cast would suppress a future real error at this site.

Note this is a **checker delta, not a product bug**: the emitted query and its runtime behaviour are identical before and after.

- [ ] **Step 1: Write the regression test**

Create `apps/web/src/lib/__tests__/pass-vs-plan-sql.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * TS 7 resolves postgres.js's overload set differently for an array literal
 * built with a spread and passed INLINE inside a template hole: it falls
 * through to the tagged-template signature and reports
 *   TS2769 ... Property 'raw' is missing in type 'string[]'
 * The fix is to hoist the array to a local first. Runtime behaviour is
 * identical either way, so nothing but the compiler can catch a regression
 * here — which is why this test reads the source.
 */
describe("rungsExceedingPlan: TS 7 overload resolution", () => {
  it("does not build the sql() array inline inside the template hole", () => {
    const src = readFileSync(
      join(import.meta.dirname, "../pass-vs-plan.ts"),
      "utf8",
    );
    expect(src).not.toMatch(/\$\{sql\(\[\.\.\./);
  });

  it("hoists the key list to a local before the query", () => {
    const src = readFileSync(
      join(import.meta.dirname, "../pass-vs-plan.ts"),
      "utf8",
    );
    expect(src).toMatch(/const\s+ladderKeys\s*=\s*\[\.\.\.passKeys,\s*planKey\]/);
  });
});
```

- [ ] **Step 2: Run it and confirm the first case fails**

```bash
cd <abs worktree> && npm test --workspace apps/web -- src/lib/__tests__/pass-vs-plan-sql.test.ts \
  --reporter=json --outputFile=/tmp/t23.json
```

Expected: both cases fail.

- [ ] **Step 3: Apply the fix**

In `apps/web/src/lib/pass-vs-plan.ts`, replace the body of `rungsExceedingPlan`:

```ts
export async function rungsExceedingPlan(
  passKeys: readonly string[],
  planKey: string,
): Promise<string[]> {
  // Hoisted deliberately. Inlining this spread inside the template hole makes
  // TS 7 resolve postgres.js's overload set to the tagged-template signature
  // and fail with TS2769 ("Property 'raw' is missing in type 'string[]'").
  // Runtime behaviour is identical — see pass-vs-plan-sql.test.ts.
  const ladderKeys = [...passKeys, planKey];
  const rows = await sql<(EntitlementRow & { plan_key: string })[]>`
    select plan_key, feature_key, bool_value, int_value
      from plan_entitlements
     where plan_key in ${sql(ladderKeys)}`;
  const planRows = rows.filter((r) => r.plan_key === planKey);
  return passKeys.filter((k) =>
    passBeatsPlan(
      rows.filter((r) => r.plan_key === k),
      planRows,
    ),
  );
}
```

- [ ] **Step 4: Confirm the whole repo now typechecks clean on TS 7**

```bash
cd <abs worktree> && npm test --workspace apps/web -- src/lib/__tests__/pass-vs-plan-sql.test.ts \
  --reporter=json --outputFile=/tmp/t23.json
cd <abs worktree> && npx turbo run typecheck 2>&1 | tail -20; echo "EXIT=$?"
```

Expected: test green, **zero** typecheck errors across all three configs. If any other error appears it is new since the 2026-08-05 measurement — fix it here and record it in the state file.

- [ ] **Step 5: Confirm the query itself still behaves**

```bash
cd <abs worktree> && npm test --workspace apps/web -- pass-vs-plan --reporter=json --outputFile=/tmp/t23b.json
```

The existing pass-vs-plan suites exercise the real query against the database. Positionals are **filename filters**, not exact paths, so a typo silently runs a subset and reports green — and a stray `run` (the package script already supplies it) filters on the literal string "run". Confirm `numTotalTests` is non-zero and matches what those suites contained before.

- [ ] **Step 6: Commit**

```bash
cd <abs worktree> && git add apps/web/src/lib/pass-vs-plan.ts apps/web/src/lib/__tests__/pass-vs-plan-sql.test.ts \
  && git commit -m "fix: hoist the sql() key list so TS 7 picks the right overload

The only TypeScript 7 error in the repo. postgres.js steers its
overloads with conditional types; an array literal built with a
spread and passed inline inside a template hole makes TS 7 fall
through to the tagged-template signature. Hoisting to a local
resolves it — measured against three candidate shapes, all of
which pass; the inline form is the only one that fails.

Checker delta, not a product bug: emitted query unchanged."
```

---

### Task 2.4: Remove the CI heap ceiling

**Files:**
- Modify: `.github/workflows/ci.yml:82` and the comment block above `npx turbo run typecheck`
- Test: `apps/web/src/__tests__/toolchain.test.ts` (extend)

**Why this is the headline.** `ci.yml:82` sets `NODE_OPTIONS: --max-old-space-size=6144` solely because `apps/web`'s tsc peaks ~2.8 GB against the runner's ~2 GB default V8 heap — the run died with the heap at 2041/2088 MB. TS 7 is a Go binary. `--max-old-space-size` does not apply to it at all, so the ceiling stops meaning anything. Measured peak RSS actually barely moved (2.80 -> 2.54 GB); what disappears is the *cap*, not the appetite.

- [ ] **Step 1: Add the failing test case**

Append to `apps/web/src/__tests__/toolchain.test.ts`:

```ts
describe("toolchain: no V8 heap ceiling for typecheck", () => {
  /**
   * The 6 GB ceiling existed only because apps/web's tsc peaked ~2.8 GB against
   * the runner's ~2 GB default V8 heap. TS 7 is a Go binary — the flag has no
   * effect on it — so carrying the ceiling forward would be cargo cult, and
   * worse, would mask a regression back to a V8 compiler.
   */
  it("ci.yml sets no max-old-space-size", () => {
    const text = readFileSync(
      join(REPO_ROOT, ".github/workflows/ci.yml"),
      "utf8",
    );
    expect(text).not.toContain("max-old-space-size");
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
cd <abs worktree> && npm test --workspace apps/web -- src/__tests__/toolchain.test.ts \
  --reporter=json --outputFile=/tmp/t24.json
```

- [ ] **Step 3: Delete the ceiling and rewrite the comment**

Remove the `env:` block containing `NODE_OPTIONS: --max-old-space-size=6144` at `ci.yml:82`. Replace the long comment above `npx turbo run typecheck` — it documents a constraint that no longer exists — with:

```yaml
      # Both workspaces in one graph-ordered pass, restored from the Remote
      # Cache when neither TS tree changed. turbo.json's globalDependencies
      # pull in scripts/** + tsconfig.scripts.json, which apps/web's typecheck
      # reads via its second `tsc -p ../../tsconfig.scripts.json` half — without
      # that, a scripts/ edit would restore a stale green.
      #
      # This step used to carry NODE_OPTIONS=--max-old-space-size=6144: apps/web
      # peaked ~2.8 GB against the runner's ~2 GB default V8 heap and died at
      # 2041/2088 MB. TypeScript 7 is a native Go binary, so there is no V8 heap
      # to raise — peak RSS is ~2.5 GB of ordinary process memory. Do not
      # reintroduce the flag; if it ever looks necessary again, that means
      # something has fallen back to a JS compiler.
      - run: npx turbo run typecheck
```

- [ ] **Step 4: Confirm green**

```bash
cd <abs worktree> && npm test --workspace apps/web -- src/__tests__/toolchain.test.ts \
  --reporter=json --outputFile=/tmp/t24.json
```

- [ ] **Step 5: Commit**

```bash
cd <abs worktree> && git add .github/workflows/ci.yml apps/web/src/__tests__/toolchain.test.ts \
  && git commit -m "ci: drop the 6 GB heap ceiling — TS 7 has no V8 heap

The flag existed only because apps/web's tsc peaked ~2.8 GB against
the runner's ~2 GB default. A Go binary ignores it. Peak RSS is
~2.5 GB of ordinary process memory; the cap is what disappeared,
not the appetite. Test asserts it stays gone."
```

---

### Task 2.5: Prove the TS 7 binary runs on musl, in CI

**Files:**
- Modify: `.github/workflows/ci.yml` (new job)

**The trap this exists for.** `typescript@7.0.2` pulls **20 platform binaries** (`@typescript/typescript-linux-x64`, `-linux-arm64`, `-darwin-arm64`, …), declared under **both** `dependencies` and `optionalDependencies`, ~28 MB unpacked each. None of them declare a `libc` field, so npm will not filter musl from glibc — the alpine builder gets the linux binary regardless of whether it can execute there. Go binaries are usually static, so this probably works; "probably" is exactly what needs a gate.

And it cannot be a passive gate. The builder stage runs `SKIP_TYPECHECK=1 npm run build`, so **`docker build` never invokes `tsc` at all**. A musl-incompatible binary produces a perfectly clean build and fails the first time anything runs a typecheck. The job must therefore `docker run` the image and *execute* the compiler.

Fly builds amd64, so `ubuntu-latest` is the correct arch to test on. There is no container runtime on the dev machine — this gate lives in CI and on Fly, by design.

- [ ] **Step 1: Add the job to `.github/workflows/ci.yml`**

Add as a top-level job alongside `test`, `security`, `smoke`:

```yaml
  container:
    name: docker build + TS 7 musl exec
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5

      # The builder stage installs devDeps, so the 20 platform-conditional
      # TypeScript 7 binaries land in that layer. None of them declare a `libc`
      # field, so npm cannot filter musl from glibc: alpine gets the linux
      # binary whether or not it can execute there.
      - name: Build the builder stage
        run: docker build --target builder -t seazn-builder:ci .

      # The whole point. `docker build` runs the app build with SKIP_TYPECHECK=1
      # and never invokes tsc, so a musl-incompatible Go binary builds perfectly
      # clean and only fails at first use. Execute it here instead.
      - name: Execute the TypeScript 7 binary inside the image
        run: |
          set -euo pipefail
          VERSION=$(docker run --rm seazn-builder:ci \
            node /app/node_modules/typescript-native/bin/tsc --version)
          echo "reported: $VERSION"
          echo "$VERSION" | grep -qE '^Version 7\.' || {
            echo "::error::TS 7 binary did not execute on musl"; exit 1; }

      # A full typecheck inside the image: proves the binary not only starts but
      # reads the real project. This is the check that would have caught a
      # partially-working binary.
      - name: Typecheck inside the image
        run: docker run --rm seazn-builder:ci npx turbo run typecheck

      - name: Report image size
        run: docker images seazn-builder:ci --format '{{.Size}}'

      - name: Build the full image, including the runner stage
        run: docker build -t seazn:ci .
```

**Standing cost, decide before merging stage 2.** As written this job runs a full
`docker build` on *every* PR, forever. During stage 2 that is exactly what we
want — it is the gate for the highest-risk unknown in the programme. Afterwards
it is a multi-minute job on PRs that touch nothing it can detect.

The repo already has the mechanism: `dorny/paths-filter` gates the engine
coverage jobs. Once stage 2 is merged and the musl question is settled, gate this
job the same way on `Dockerfile`, `package.json`, `package-lock.json` /
`pnpm-lock.yaml`, and `.github/workflows/ci.yml` — the only inputs that can
change the answer. Note the filter job needs `permissions: pull-requests: read`
on PRs, or it fails with "Resource not accessible by integration".

Do **not** apply that gating inside stage 2 itself. Its whole purpose is to run
on the PR that introduces the platform binaries.

- [ ] **Step 2: Push and confirm the job runs and passes**

```bash
cd <abs worktree> && git add .github/workflows/ci.yml && git commit -m "ci: build the image and execute the TS 7 binary on musl

SKIP_TYPECHECK=1 means docker build never invokes tsc, so a
musl-incompatible Go binary would build clean and fail at first use.
The 20 platform packages declare no libc field, so npm cannot filter
musl from glibc. Run the compiler inside the image instead."
cd <abs worktree> && git push && gh pr checks --watch
```

- [ ] **Step 3: If the binary will not exec on musl**

This is the rollback the spec names. Change **only** the builder stage in `Dockerfile:2`:

```dockerfile
FROM node:26-slim AS builder
```

The runner stage stays `node:26-alpine` — `typescript` is a devDependency and never reaches it. Re-run the job. Record the outcome in the state file either way; this is the single highest-risk unknown in the programme and its answer should not have to be rediscovered.

- [ ] **Step 4: Confirm on the real builder**

```bash
cd <abs worktree> && fly deploy --build-only --remote-only --config fly.stg.toml
```

Fly's builder is what actually ships the image. A green `ubuntu-latest` job is strong evidence, not proof.

---

### Task 2.6: Stage 2 gate and PR

**Files:** none modified — this is the gate.

- [ ] **Step 1: Run the identical gate from Task 1.5, Steps 1-6**

Same commands, same traps, same evidentiary bar. Do not skip the `readlink -f node_modules/@seazn/engine` provenance check: this stage changed `node_modules` contents, so a stale symlink is *more* likely here, not less.

- [ ] **Step 2: Record the improvement**

```bash
cd <abs worktree> && rm -rf apps/web/.next
cd <abs worktree>/apps/web && /usr/bin/time -l node ../../node_modules/typescript-native/bin/tsc --noEmit -p tsconfig.json 2>&1 | grep -E "real|maximum resident"
```

Expected, from the 2026-08-05 baseline: ~8s wall against 54s before. Put the number in the PR body and the state file.

- [ ] **Step 3: Open the PR**

```bash
cd <abs worktree> && git push -u origin ts-migration-stage-2-typescript-7
gh pr create --base typescript7 --title "TypeScript 7 gates types; 6.0.3 stays for lint and the editor" --body "$(cat <<'EOF'
Stage 2 of 3. Spec: `docs/superpowers/specs/2026-08-05-typescript-7-node-26-pnpm-migration-design.md`

apps/web typecheck: **54.05s -> 8.21s**, and the 6 GB CI heap ceiling is gone —
TypeScript 7 is a native Go binary, so `--max-old-space-size` no longer applies.
Peak RSS barely moved (2.80 -> 2.54 GB); what disappeared is the cap.

`typescript` keeps the bare specifier at 6.0.3 because typescript-eslint peers
`<6.1.0`, `next build`'s in-build checker resolves it by name, and three
compiler-API tests import it — and TS 7 publishes no `main` at all. TS 7 comes
in under an alias, invoked by explicit path: both packages declare `bin.tsc` and
the winner is install-order dependent. Editors keep resolving tsserver from 6.x,
so the language service and the `next` TS plugin are unaffected.

One error in the whole repo, at `pass-vs-plan.ts:135` — postgres.js overload
resolution against an inline spread inside a template hole. Fixed by hoisting.
Emitted query unchanged.

New CI job builds the real Dockerfile and **executes** the TS 7 binary inside
the image: `SKIP_TYPECHECK=1` means `docker build` never invokes tsc, so a
musl-incompatible binary would otherwise build clean and fail at first use.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
cd <abs worktree> && gh pr checks --watch
```

---

# STAGE 3 — pnpm

Branch: `ts-migration-stage-3-pnpm`, cut from **`typescript7`** after stage 2 merges into it. One PR, `--base typescript7`. Rebase `typescript7` onto `main` first.

**Why this stage exists.** Not pipeline speed — #158 measured that and pnpm lost cold (52.2s vs 48.2s npm). The case is **worktree cost**: pnpm's content-addressed store hardlinks into `node_modules`, so the Nth worktree on a warm store is near-free in time and disk. npm has no CAS, so `npm ci --prefer-offline` still copies every file and worktree #5 costs what worktree #1 did.

That is not an ergonomics nicety. Two recorded failure modes exist *because* a real `npm ci` in a worktree is slow enough that people symlink `node_modules` instead: the `@seazn/engine` trap, where a symlinked tree resolves to **main's** engine and silently compiles the wrong branch, and `next build` failing outright in a symlinked worktree. Make the honest install cheap and the reason to symlink is gone.

**This cutover is one-shot.** npm errors `EUNSUPPORTEDPROTOCOL` on `workspace:*`, so the two lockfiles cannot coexist and there is no dual-run period.

### Task 3.1: Convert the workspace to pnpm

**Files:**
- Create: `pnpm-workspace.yaml`
- Modify: `package.json` (root: `packageManager`, script deps), `apps/web/package.json` (`@seazn/engine`)
- Test: `apps/web/src/__tests__/toolchain.test.ts` (extend)

- [ ] **Step 1: Write the failing test**

Append to `apps/web/src/__tests__/toolchain.test.ts`:

```ts
describe("toolchain: pnpm workspace", () => {
  it("declares the workspace and uses the workspace protocol", () => {
    const ws = readFileSync(join(REPO_ROOT, "pnpm-workspace.yaml"), "utf8");
    expect(ws).toContain("apps/*");
    expect(ws).toContain("packages/*");
    const web = JSON.parse(
      readFileSync(join(REPO_ROOT, "apps/web/package.json"), "utf8"),
    ) as { dependencies: Record<string, string> };
    // `"*"` makes pnpm hit the registry for a private package and fail with
    // "No authorization header" — it must be the workspace protocol.
    expect(web.dependencies["@seazn/engine"]).toBe("workspace:*");
  });

  it("root declares every dependency its scripts import", () => {
    /**
     * Root scripts run from the repo root under --experimental-strip-types and
     * import postgres/stripe/zod/@anthropic-ai/sdk. Under npm they resolved via
     * hoisting from apps/web. pnpm's strict linker gives root only what root
     * declares, so every one of the 12 scripts breaks unless they are declared
     * here.
     */
    const root = JSON.parse(
      readFileSync(join(REPO_ROOT, "package.json"), "utf8"),
    ) as { devDependencies?: Record<string, string> };
    const declared = new Set(Object.keys(root.devDependencies ?? {}));
    for (const dep of ["postgres", "stripe", "zod", "@anthropic-ai/sdk"]) {
      expect(declared.has(dep), `root must declare ${dep}`).toBe(true);
    }
  });
});
```

- [ ] **Step 2: Run it and confirm both cases fail**

```bash
cd <abs worktree> && npm test --workspace apps/web -- src/__tests__/toolchain.test.ts \
  --reporter=json --outputFile=/tmp/t31.json
```

- [ ] **Step 3: Create `pnpm-workspace.yaml`**

```yaml
packages:
  - "apps/*"
  - "packages/*"
```

- [ ] **Step 4: Switch the internal dependency to the workspace protocol**

In `apps/web/package.json`:

```json
    "@seazn/engine": "workspace:*",
```

`"*"` makes pnpm resolve a private package from the registry and fail with "No authorization header". From this commit forward `npm ci` will refuse the tree with `EUNSUPPORTEDPROTOCOL` — that is expected and is why this is one PR with no partial state.

- [ ] **Step 5: Declare the root scripts' real dependencies**

Root `package.json` currently declares `turbo` **only**, while 12 root scripts import from `apps/web`'s dependency tree by hoisting. Add to root `devDependencies`, matching the versions already in `apps/web/package.json`:

```json
    "@anthropic-ai/sdk": "^0.110.0",
    "postgres": "^3.4.9",
    "stripe": "^22.3.0",
    "zod": "^4.4.3"
```

Before finalising this list, confirm it against reality rather than trusting the four names:

```bash
cd <abs worktree> && grep -rhoE 'from "[^@.][^"]*"|from "@[^/]+/[^"]+"' scripts/*.ts scripts/**/*.ts \
  | sed 's/from "//;s/"//' | grep -v '^node:' | sort -u
```

Every bare specifier that comes back must be declared at root. Add any the grep finds that the list above misses.

- [ ] **Step 6: Set the package manager and install**

Root `package.json`:

```json
  "packageManager": "pnpm@10.34.5",
```

```bash
cd <abs worktree> && rm -rf node_modules apps/web/node_modules packages/engine/node_modules \
  && pnpm install 2>&1 | tail -20
```

Then confirm every root script still resolves its imports:

```bash
cd <abs worktree> && npm run sync:sports 2>&1 | tail -5
cd <abs worktree> && npm run openapi:gen && npm run i18n:gen-keys && npm run i18n:check && git status --porcelain
```

An `ERR_MODULE_NOT_FOUND` here means Step 5's list is incomplete. Fix it in Step 5 rather than adding a hoist pattern — the declaration is the correct fix, the hoist is the workaround.

- [ ] **Step 7: Delete the npm lockfile and commit**

```bash
cd <abs worktree> && rm -f package-lock.json
cd <abs worktree> && git add -A && git commit -m "build: convert the workspace to pnpm

The case is worktree cost, not pipeline speed — #158 measured speed
and npm won cold. pnpm hardlinks from a content-addressed store, so
the Nth worktree is near-free; npm copies every file every time.
That slowness is why people symlink node_modules in worktrees, which
is what makes a worktree silently compile main's engine.

One-shot cutover: npm errors EUNSUPPORTEDPROTOCOL on workspace:*, so
the two lockfiles cannot coexist.

Root now declares the deps its 12 scripts previously got by hoisting."
```

---

### Task 3.2: Repoint the z3 WASM trace path

**Files:**
- Modify: `apps/web/next.config.js` (`outputFileTracingIncludes`)
- Test: `apps/web/src/__tests__/toolchain.test.ts` (extend)

**The silent failure this prevents.** `next.config.js` traces the z3 WASM blob via the literal hoisted path `../../node_modules/z3-solver/build/**/*`. Under pnpm the file lives at `node_modules/.pnpm/z3-solver@5.0.0/node_modules/z3-solver/build/`, so the glob matches nothing. The standalone server then ENOENTs on every solve — and the scheduler falls back to LLM repair, which is a *designed* path, so nothing errors. Minimal-movement repair silently becomes a no-op in production while still spending a model round.

No unit test can see this: unit tests import from the source `node_modules`, which always has the file. Only e2e against a real standalone build catches it. Both halves are load-bearing — `serverExternalPackages: ["pdfkit","exceljs","z3-solver"]` must stay too; tracing the `.wasm` without it was measured and still aborted every solve.

- [ ] **Step 1: Write the failing test**

Append to `apps/web/src/__tests__/toolchain.test.ts`:

```ts
describe("toolchain: z3 wasm tracing survives the linker change", () => {
  it("resolves the wasm path rather than hardcoding a hoisted layout", () => {
    const cfg = readFileSync(join(REPO_ROOT, "apps/web/next.config.js"), "utf8");
    expect(cfg).not.toContain("../../node_modules/z3-solver");
    expect(cfg).toContain("z3-solver/build");
    // Tracing the .wasm is necessary but NOT sufficient — this was measured.
    expect(cfg).toContain('serverExternalPackages');
    expect(cfg).toContain('"z3-solver"');
  });

  it("the wasm file is actually where the config will look", async () => {
    const { createRequire } = await import("node:module");
    const require = createRequire(join(REPO_ROOT, "apps/web/next.config.js"));
    const pkg = require.resolve("z3-solver/package.json");
    const wasm = join(pkg, "../build/z3-built.wasm");
    const { existsSync } = await import("node:fs");
    expect(existsSync(wasm), `expected z3 wasm at ${wasm}`).toBe(true);
  });
});
```

- [ ] **Step 2: Run it and confirm the first case fails**

```bash
cd <abs worktree> && npm test --workspace apps/web -- src/__tests__/toolchain.test.ts \
  --reporter=json --outputFile=/tmp/t32.json
```

- [ ] **Step 3: Resolve the path instead of hardcoding it**

At the top of `apps/web/next.config.js`, beside the existing `import path from "node:path"`:

```js
import { createRequire } from "node:module";

// z3-solver is a WASM build whose emscripten glue reads build/z3-built.wasm
// from disk at runtime; nothing in the import graph mentions the .wasm, so
// tracing cannot infer it. The path used to be written as the literal hoisted
// location, which pnpm's store layout breaks — and it breaks SILENTLY: the
// standalone server ENOENTs on every solve and the scheduler falls back to LLM
// repair, a designed path, so nothing surfaces an error. Resolve it instead.
const require = createRequire(import.meta.url);
const z3BuildDir = path.join(
  path.dirname(require.resolve("z3-solver/package.json")),
  "build",
);
```

Then replace the entry in `outputFileTracingIncludes`:

```js
  outputFileTracingIncludes: {
    "/*": [
      "src/lib/email-templates/html/**/*",
      "content/help/**/*",
      path.relative(import.meta.dirname, path.join(z3BuildDir, "**/*")),
    ],
  },
```

Leave `serverExternalPackages` exactly as it is.

- [ ] **Step 4: Confirm the trace actually contains the wasm**

```bash
cd <abs worktree> && npm test --workspace apps/web -- src/__tests__/toolchain.test.ts \
  --reporter=json --outputFile=/tmp/t32.json
cd <abs worktree> && rm -rf apps/web/.next && npm run build 2>&1 | tail -10
cd <abs worktree> && find apps/web/.next/standalone -name "z3-built.wasm" | head
```

The `find` must return a path. An empty result means the glob still misses and the production scheduler would be a silent no-op — do not proceed past this step on an empty result.

- [ ] **Step 5: Commit**

```bash
cd <abs worktree> && git add apps/web/next.config.js apps/web/src/__tests__/toolchain.test.ts \
  && git commit -m "fix: resolve the z3 wasm trace path instead of hardcoding npm's layout

pnpm's store puts the file under .pnpm/, so the literal
../../node_modules/z3-solver glob matched nothing. That failure is
silent: the standalone server ENOENTs on every solve and the
scheduler falls back to LLM repair, a designed path. Minimal-movement
repair becomes a production no-op that still spends a model round.
Verified by finding z3-built.wasm inside .next/standalone."
```

---

### Task 3.3: Convert every install site

**Files:**
- Modify: `.github/workflows/ci.yml` (3x `npm ci`, 1x `npm ci --omit=dev`, `npm audit`, `cache: npm`, the new `container` job)
- Modify: `.github/workflows/e2e.yml` (2x), `help-shots.yml` (1x), `sim-nightly.yml` (1x)
- Modify: `Dockerfile` (manifest COPY, cache mount, install)

- [ ] **Step 1: Convert the workflows**

In every workflow, before `actions/setup-node`:

```yaml
      - uses: pnpm/action-setup@v4
        with:
          version: 10.34.5
```

`pnpm/action-setup` is required rather than optional here: **node 26 dropped corepack**, so there is no bundled shim to activate.

Then in each `actions/setup-node` block:

```yaml
        with:
          node-version: 26
          cache: pnpm
```

And each install step:

| was | becomes |
| --- | --- |
| `npm ci` | `pnpm install --frozen-lockfile` |
| `npm ci --omit=dev` | `pnpm install --frozen-lockfile --prod` |
| `npm audit` | `pnpm audit --audit-level=high` |

The security job installs nothing and reads the lockfile only — keep that property; it now reads `pnpm-lock.yaml`.

Also update the `dorny/paths-filter` `engine` filter: it already lists both `package-lock.json` and `pnpm-lock.yaml` as future-proofing, so drop the now-nonexistent `package-lock.json` entry.

- [ ] **Step 2: Convert the Dockerfile**

Replace lines 5-11:

```dockerfile
# Workspace manifests first so the install layer caches across source changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/
COPY packages/engine/package.json packages/engine/
# node 26 dropped corepack, so pnpm is installed explicitly rather than activated.
RUN npm i -g pnpm@10.34.5
# BuildKit cache mount over pnpm's content-addressed store: it persists on the
# Fly builder disk between deploys, so a lockfile change re-fetches only what
# actually changed.
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm config set store-dir /pnpm/store && pnpm install --frozen-lockfile
```

Change nothing else — the base images are already node 26 from stage 1, and `SKIP_TYPECHECK=1 npm run build --workspace apps/web` still works because pnpm provides `npm`-compatible workspace script running via `pnpm --filter`. If that line fails, change it to:

```dockerfile
RUN SKIP_TYPECHECK=1 pnpm --filter @seazn/web build
```

- [ ] **Step 3: Add hoist patterns only if something actually breaks**

Do not pre-emptively add these. Run the gate first; if `eslint-config-next`, `@types/*`, `sharp`, or `@playwright/test` fail to resolve, add a `.npmrc`:

```ini
public-hoist-pattern[]=*eslint*
public-hoist-pattern[]=@types/*
```

Each pattern added must be justified by a specific error message recorded in the state file. A blanket `node-linker=hoisted` defeats the entire purpose of the stage and is not an acceptable fix.

- [ ] **Step 4: Commit**

```bash
cd <abs worktree> && git add -A && git commit -m "ci: convert every install site to pnpm

7 npm ci sites, the deploy job's --omit=dev, the lockfile-only audit,
and the Dockerfile's BuildKit cache mount (now over pnpm's store).
pnpm/action-setup is required, not optional: node 26 dropped corepack."
```

---

### Task 3.4: Measure what the stage was for

**Files:**
- Create: `docs/superpowers/plans/2026-08-05-pnpm-benchmark-results.md`

#158 rejected pnpm on a benchmark. This stage re-opens it on a different metric, so it owes a benchmark of that metric — otherwise it is the same unevidenced claim in the opposite direction.

- [ ] **Step 1: Measure, on a warm store**

```bash
cd <abs worktree> && pnpm store path && du -sh "$(pnpm store path)"

# Cold: empty store
cd <abs worktree> && pnpm store prune && rm -rf node_modules apps/web/node_modules packages/engine/node_modules
cd <abs worktree> && /usr/bin/time -p pnpm install --frozen-lockfile 2>&1 | tail -5

# Warm: same tree, store populated
cd <abs worktree> && rm -rf node_modules apps/web/node_modules packages/engine/node_modules
cd <abs worktree> && /usr/bin/time -p pnpm install --frozen-lockfile 2>&1 | tail -5
cd <abs worktree> && du -sh node_modules
```

Then the number the stage exists to produce — a **second worktree** against the warm store:

```bash
cd /Users/ashokhein/github/seazn.club && git worktree add /tmp/pnpm-bench-wt main
cd /tmp/pnpm-bench-wt && /usr/bin/time -p pnpm install --frozen-lockfile 2>&1 | tail -5
cd /tmp/pnpm-bench-wt && du -sh node_modules
cd /Users/ashokhein/github/seazn.club && git worktree remove /tmp/pnpm-bench-wt
```

- [ ] **Step 2: Write the results down**

Record cold install, warm install, second-worktree install, `node_modules` disk per worktree, and store disk — against the npm baseline from #158 (warm 26.9s, cold 48.2s) and against `du -sh node_modules` under npm. State plainly whether the worktree case delivered; if it did not, say so, because that was the entire justification.

- [ ] **Step 3: Commit**

```bash
cd <abs worktree> && git add docs/superpowers/plans/2026-08-05-pnpm-benchmark-results.md \
  && git commit -m "docs: pnpm worktree-install benchmark results"
```

---

### Task 3.5: Stage 3 gate, live billing, and PR

- [ ] **Step 1: Run the identical gate from Task 1.5, Steps 1-6**

e2e matters more in this stage than in either previous one — it is the only gate that can see the z3 WASM regression, and Task 3.2 is exactly the change that threatens it. Do not accept a skipped e2e here.

- [ ] **Step 2: Confirm the standalone server actually solves**

```bash
cd <abs worktree> && find apps/web/.next/standalone -name "z3-built.wasm" | head
```

Non-empty. Then run the e2e scheduling flow against the standalone server specifically, not a dev server.

- [ ] **Step 3: Run the live-Stripe billing suite, once**

Per the spec, live billing runs once at the end of the programme rather than per stage. `BILLING_LIVE=1` with the `sk_test` key from the **main** repo's `.env.local`, 30s timeout. Never print the key.

- [ ] **Step 4: Open the PR**

```bash
cd <abs worktree> && git push -u origin ts-migration-stage-3-pnpm
gh pr create --base typescript7 --title "Convert to pnpm: near-free worktree installs" --body "$(cat <<'EOF'
Stage 3 of 3. Spec: `docs/superpowers/specs/2026-08-05-typescript-7-node-26-pnpm-migration-design.md`

Not a speed change — #158 benchmarked pipeline install and npm won cold
(48.2s vs 52.2s). This is about **worktree cost**. pnpm hardlinks from a
content-addressed store, so the Nth worktree is near-free in time and disk;
npm copies every file every time. See the benchmark doc in this PR for the
measured numbers.

That slowness is not a nuisance, it is the root cause of two recorded
failure modes: people symlink `node_modules` into worktrees to avoid a real
`npm ci`, which makes the worktree silently compile **main's** engine, and
breaks `next build` outright.

One-shot cutover — npm errors `EUNSUPPORTEDPROTOCOL` on `workspace:*`, so
the two lockfiles cannot coexist.

Two changes carry real risk and are individually verified:
- Root now declares the deps its 12 `scripts/*.ts` previously got by npm
  hoisting; root had only `turbo`.
- The z3 WASM trace path is resolved rather than hardcoded to npm's layout.
  Getting this wrong is silent in production: the standalone server ENOENTs
  on every solve and the scheduler falls back to LLM repair, a designed path,
  so minimal-movement repair becomes a no-op that still spends a model round.
  Verified by locating `z3-built.wasm` inside `.next/standalone` and by e2e
  against a real standalone server.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
cd <abs worktree> && gh pr checks --watch
```

---

# INTEGRATION — `typescript7` -> `main`

Raised only after all three stages are merged into `typescript7` **and** verified
locally. This is the single PR that touches `main`.

- [ ] **Step 1: Rebase onto current main and re-verify**

```bash
cd /Users/ashokhein/github/seazn.club && git fetch origin && git log --oneline main -5
cd <abs worktree> && git rebase main
```

Another session commits to `main` continuously, so this rebase is not a
formality. After it, **re-run the entire Task 1.5 gate** — every count, from a
fresh DB. A rebase can silently reintroduce a conflict that no stage gate saw,
because no stage gate ever ran against this combination of trees.

- [ ] **Step 2: Confirm the whole programme's claims on the merged tree**

```bash
cd <abs worktree>/apps/web && /usr/bin/time -l node ../../node_modules/typescript-native/bin/tsc --noEmit -p tsconfig.json 2>&1 | grep -E "real|maximum resident"
cd <abs worktree> && grep -c "max-old-space-size" .github/workflows/ci.yml   # must be 0
cd <abs worktree> && find apps/web/.next/standalone -name "z3-built.wasm" | head   # must be non-empty
```

- [ ] **Step 3: Open the integration PR**

```bash
cd <abs worktree> && git push -u origin typescript7
gh pr create --base main --title "Toolchain: TypeScript 7, Node 26, pnpm" --body "$(cat <<'EOF'
Integration of the three staged PRs already reviewed on `typescript7`.
Spec: `docs/superpowers/specs/2026-08-05-typescript-7-node-26-pnpm-migration-design.md`

- `apps/web` typecheck **54.05s -> 8.21s**, and the 6 GB CI heap ceiling is gone.
- Node floor 22 -> 26, closing a local/CI/prod split where dev ran v26.4.0 against CI's 22.
- pnpm: the Nth worktree install is near-free, which removes the reason people
  symlink `node_modules` and thereby compile main's engine from a branch.

`typescript` stays 6.0.3 for typescript-eslint, the in-build checker and three
compiler-API tests; TypeScript 7 is an aliased binary invoked by explicit path.

This is the first push to `main`, so it is also the first run of the staging
deploy and `e2e.yml` against the migrated toolchain.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
cd <abs worktree> && gh pr checks --watch
```

- [ ] **Step 4: After merge, watch the two things a PR could not prove**

The staging deploy and `e2e.yml` both trigger on push to `main` and have never
run against this toolchain. Watch both to completion before calling the
programme done, and confirm `/api/health` returns 200 on staging.

---

## State file

Sessions here are compacted regularly, so progress lives on disk, not in conversation. Create `.claude/ts7-migration-state.md` at the start of stage 1 and update it **at every task boundary**:

```markdown
# TS 7 / node 26 / pnpm migration — state

Spec: docs/superpowers/specs/2026-08-05-typescript-7-node-26-pnpm-migration-design.md
Plan: docs/superpowers/plans/2026-08-05-typescript-7-node-26-pnpm-migration.md

## Current
Stage: <1|2|3>   Task: <n.n>   Branch: <name>   Worktree: <abs path>

## Done
- [x] 1.1 node floor      — commit <sha>
- [ ] ...

## Gate results (raw counts, never "passed")
| Stage | web tests | engine tests | lint | typecheck | build | smoke | e2e | container |
|---|---|---|---|---|---|---|---|---|

## Decisions made mid-flight
<date> — <decision> — <why>

## Open questions for the owner
```

The gate table records raw numbers. "Tests pass" is not an acceptable entry — a suite that failed to collect reports `PASS(0) FAIL(0)`, and a worktree missing `.env.local` skips ~1772 DB tests without moving the total.

---

## Self-Review

**Spec coverage.** D1 (pnpm last, own PR) -> stage 3 cut after stage 2 merges. D2 (TS 7 gates, TS 6 for lint) -> Tasks 2.1, 2.2. D3 (no shipped TS 6 stage) -> there is none. D4 (node 26) -> Tasks 1.1, 1.2. D5 (container gate in CI + Fly) -> Task 2.5. D6 (e2e + sim every stage, live-Stripe once) -> Tasks 1.5, 2.6, 3.5. D7 (ban `@ts-ignore`) -> Task 1.4. Compiler layout -> 2.1/2.2. The one error -> 2.3. Heap ceiling -> 2.4. Every gate-table row appears in Task 1.5 and is referenced by 2.6 and 3.5. Root-script deps, z3 trace, install sites, benchmark -> 3.1, 3.2, 3.3, 3.4.

**Placeholders.** None. Two steps are deliberately conditional rather than vague — Task 2.2 Step 3's resolver-shim fallback and Task 3.3 Step 3's hoist patterns — and both state the exact trigger condition and the exact code to use.

**Type consistency.** `toolchain.test.ts` is created in Task 1.1 and extended in 1.3, 1.4, 2.2, 2.4, 3.1, 3.2; `REPO_ROOT` is defined once in 1.1 and reused throughout. `ladderKeys` is the name asserted by the Task 2.3 test and used by the Task 2.3 implementation. `typescript-native` is the alias in 2.1 and the path in 2.2, 2.5, and 2.6.

**Known gap, stated rather than hidden.** `apps/web/src/__tests__/toolchain.test.ts` grows across all three stages and ends up covering node, target, lint policy, compiler identity, CI config, pnpm, and WASM tracing. That is one file with several responsibilities. It stays one file because every assertion in it answers the same question — "is the toolchain configured the way we decided" — and splitting it would spread that question across files that get read separately and drift apart. If it passes ~200 lines, split by stage rather than by topic.
