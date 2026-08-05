# TypeScript 7 + Node 26 + pnpm — migration design

Date: 2026-08-05
Status: approved, ready for planning

## Why

`apps/web`'s typecheck takes **54 seconds** and peaks at **2.8 GB** of V8 heap.
That heap peak is why typecheck runs PR-only rather than on every push
(`reference_apps_web_typecheck_heap`) — engine ships as raw TS source (#438), so
the app compiles the whole engine on every check.

TypeScript 7 is a native Go compiler and is already `latest` on npm
(`typescript@7.0.2`). It has no V8 heap to exhaust. Measured on this repo, on
this machine:

| | TS 5.9.3 | TS 7.0.2 |
| --- | --- | --- |
| `apps/web` typecheck wall | 54.05 s | **8.21 s** (6.6x) |
| peak RSS | 2.80 GB | 2.54 GB |
| `apps/web` errors | 0 | **1** |
| `packages/engine` errors | 0 | **0** |
| `tsconfig.scripts.json` errors | 0 | **0** |

Note the honest framing on memory: RSS barely moved. What disappears is the
**V8 heap cap** — a Go binary has no `--max-old-space-size`, so 2.5 GB of RSS is
unremarkable on any runner. The OOM class dies; the memory appetite does not.

The single error is `apps/web/src/lib/pass-vs-plan.ts:135`:

```
error TS2769: No overload matches this call.
  The last overload gave the following error.
    Property 'raw' is missing in type 'string[]' but required in type 'TemplateStringsArray'.
```

`sql([...passKeys, planKey])` — TS 7 resolves postgres.js's overload set to the
tagged-template signature instead of the dynamic-values helper. A checker delta,
not a product bug. Runtime is unaffected.

Two adjacent changes ride along because they are entangled with the above:

- **Node 22 -> 26.** Node 22 has been in *maintenance* since 2025-10-21. The
  developer machine already runs v26.4.0 while CI and Docker run node 22, so
  every local verification today executes on a different runtime than CI and
  prod. Node 26 changes the Docker base image, which is the same surface the TS 7
  musl question lands on — so it must be settled first or a container failure has
  two suspects.
- **npm -> pnpm.** Rejected once on a CI-install benchmark (#158). Re-opened on a
  different metric: **worktree install cost**. See "Stage 4".

## Decisions

| # | Decision | Rationale |
| --- | --- | --- |
| D1 | pnpm is in scope, but only **after** TS 7 is merged and stable, never in the same PR | TS 7 introduces 20 platform-conditional deps; pnpm's strict linker is exactly where those break. One at a time or a musl failure has two suspects. |
| D2 | Land on TS 7 as the typecheck gate; keep TS 6 for type-aware lint, the compiler-API tests, and the editor | typescript-eslint 8.66.0 peers `typescript: ">=4.8.4 <6.1.0"` — it cannot run on TS 7 today. Dual-compiler is forced, not chosen. |
| D3 | Skip TS 6 as a *shipped* stage | TS 6 is installed permanently anyway (D2), so "migrate to 6" is not a separate migration — it arrives as part of the TS 7 layout. With 1 error repo-wide there is nothing for an intermediate merged stage to de-risk. |
| D4 | Node 26, not 24 | Local/CI/prod become identical, and 26 is LTS on 2026-10-28 (12 weeks out). Accepted cost: prod runs Current for a quarter, and node 26 dropped corepack, so stage 4 installs pnpm without it. |
| D5 | The container gate runs in **CI + Fly**, not locally | No container runtime exists on the dev machine (`docker`, `colima`, `nerdctl`, `lima` all absent; `podman` is an x86 binary that will not exec on arm64). Fly builds amd64, which is the arch that actually matters. |
| D6 | e2e and the engine sim matrix run in **every** stage gate; live-Stripe billing runs **once**, after stage 4 | e2e is the only thing that catches the z3 wasm / standalone class of failure, which is precisely what the pnpm stage threatens. A compiler bump cannot plausibly break Stripe. |

## Compiler layout

The load-bearing piece of the design.

```
typescript          = 6.0.3                    (JS compiler — owns the bare specifier)
typescript-native   = npm:typescript@7.0.2     (Go compiler — merge gate only)
```

Both pinned **exact**, no carets.

It must be this way round and not the reverse. `typescript@7.0.2` publishes **no
`main`, no `types`, and no `tsserver` bin** — its exports are `./lib/version.cjs`
plus `./unstable/{ast,sync,async,fs,proto}`. So `import ts from "typescript"`
does not resolve under 7, and three consumers resolve it by bare specifier:

1. typescript-eslint 8.66.0 — type-aware rules in both lint tasks
2. `next build`'s in-build checker
3. `apps/web/src/__tests__/app-module-exports.test.ts`,
   `apps/web/src/lib/__tests__/_help-copy.ts`,
   `apps/web/src/lib/__tests__/pass-scoping-guard.test.ts`

Those three test files therefore need **no rewrite** — they keep importing
`typescript`, which is now 6.0.3. Porting them to `typescript/unstable/ast` is
explicitly out of scope.

Bonus: editors resolve `typescript/lib/tsserver.js` -> TS 6, so the language
service and the `plugins: [{ name: "next" }]` entry in `apps/web/tsconfig.json`
keep working exactly as today. No editor regression.

### The bin collision is real, not theoretical

Verified by installing both side by side in a scratch directory:

```
node_modules/.bin/tsc      -> ../typescript/bin/tsc        (v7)
node_modules/.bin/tsserver -> ../typescript6/bin/tsserver   (v6)
```

Both packages declare `bin.tsc`, so which one wins `.bin/tsc` is install-order
dependent. **Every typecheck script invokes an explicit binary path, never
`tsc`.** A test asserts the resolved compiler's `--version` so a silent swap
cannot pass.

### Accepted consequence

Two answers to "does this compile": TS 7 is the merge gate, TS 6 is the
editor/lint host and is not gated. Exact pins make the divergence at least
reproducible.

## Stages

Four PRs. Each is independently revertible. Order is load-bearing.

### Stage 1 — Prep

No version changes. Useful on its own even if everything after it is abandoned.

- Flip all 28 `@ts-ignore` to `@ts-expect-error` (repo currently has 28 and 0).
  An unused `@ts-expect-error` is itself an error, so the later compiler swap
  *reports* instead of silently absorbing.
- `apps/web` `target: "ES2017"` -> `"ES2022"`, as its own commit — it is a real
  downlevel-output change, not cosmetic.

Repo is already clean of the constructs that make this painful: **zero
`const enum`, zero `namespace`**, zero deprecated compiler flags across all three
tsconfigs, `moduleResolution` is `bundler`/`nodenext` (never `node10`/`classic`),
and every config is `noEmit` — so emit-parity risk is nil.

### Stage 2 — Node 22 -> 26

- 7 workflow files: `node-version: 22` -> `26`.
- `Dockerfile`: `node:22-alpine` -> `node:26-alpine` in **both** the builder and
  runner stages. Tag verified to exist on Docker Hub.
- `@types/node` `^20` -> `^26` in both workspaces (26.1.2 is latest; it carries a
  `ts6.0` dist-tag and no `ts7.0` tag yet, but both workspaces already typecheck
  clean under TS 7 on `@types/node@20`, so this is not load-bearing).
- Leave `--experimental-strip-types` on the 12 root `scripts/*.ts` invocations.
  Verified on v26.4.0: the flag is still accepted, and bare `.ts` also runs
  without it. Removing it is a separate, optional cleanup.

### Stage 3 — TypeScript 7

- Add the alias pair from "Compiler layout".
- Repoint the three `typecheck` scripts to the explicit v7 binary. The exact form
  (a direct `node <root>/node_modules/typescript-native/bin/tsc` path vs a small
  resolver shim) is settled during implementation — npm workspace hoisting
  decides which is robust.
- Fix `pass-vs-plan.ts:135`.
- Land the CI typecheck step **non-blocking** (`continue-on-error: true`) for at
  least one merged PR, then flip it to the gate in a follow-up commit.
- Container: the builder stage installs devDeps, so 20 platform binaries
  (~28 MB unpacked each, declared under **both** `dependencies` and
  `optionalDependencies`) land in the build layer. Check image size. Critically,
  `SKIP_TYPECHECK=1` means `docker build` never invokes `tsc` on its own — a
  musl-incompatible Go binary would build perfectly clean and fail only at first
  use. The CI job therefore `docker run`s the built image and **execs the TS 7
  binary**. That exec step is the entire point of the container gate.

### Stage 4 — pnpm

Only after stage 3 is merged and stable.

The case is **not** pipeline speed — #158 measured that and pnpm lost cold
(52.2 s vs 48.2 s). The case is **worktree cost**: pnpm's content-addressed store
hardlinks into `node_modules`, so the Nth worktree on a warm store is near-free
in both time and disk. npm has no CAS; `npm ci --prefer-offline` still copies
every file, so worktree #5 costs the same as worktree #1 and burns 5x the disk.

That attacks two recorded failure modes at the root, not just ergonomics:

- The `@seazn/engine` worktree trap — a symlinked `node_modules` resolving to
  **main's** engine, silently compiling the wrong branch
  (`reference_worktree_node_modules_resolves_main_engine`).
- `next build` failing in worktrees with a symlinked `node_modules`
  (`reference_run_server_and_db_recipe`).

Both exist *because* a real `npm ci` in a worktree is slow enough that people
symlink instead. Make the real install cheap and the reason to symlink is gone.

Work:

- `pnpm-workspace.yaml`; `@seazn/engine: "*"` -> `workspace:*`. Note this makes
  the cutover **one-shot**: npm errors `EUNSUPPORTEDPROTOCOL` on `workspace:*`,
  so the two lockfiles cannot coexist and there is no dual-run period.
- Root `package.json` gains the deps its 12 `scripts/*.ts` currently receive by
  npm hoisting. Root devDeps today are `turbo` **only**, while those scripts
  import `postgres`, `stripe`, `@anthropic-ai/sdk`, and `zod` from `apps/web`.
  Under a strict linker every one of them breaks.
- Repoint the z3 wasm trace glob in `next.config.js`. It is currently the literal
  hoisted path `../../node_modules/z3-solver/build/**/*`; under pnpm the file
  lives at `node_modules/.pnpm/z3-solver@5.0.0/node_modules/z3-solver/build/`.
  If this is missed the standalone server ENOENTs on every solve and the
  scheduler falls back to LLM repair **silently** — no unit test can see it,
  because unit tests import from the source `node_modules`, which always has the
  file.
- Convert all 7 `npm ci` sites, the deploy job's `npm ci --omit=dev`, the
  security job's lockfile-only `npm audit`, and the Dockerfile's BuildKit cache
  mount (`--mount=type=cache,id=npm,target=/root/.npm`) to their pnpm forms.
- Node 26 dropped corepack, so CI installs pnpm explicitly.
- Hoist patterns for `eslint-config-next`, `@types/*`, `sharp`, `@playwright/test`
  as needed.
- **Then measure** and record: cold-store install, warm-store second-worktree
  install, and disk per worktree, against `npm ci` on the same box. This is the
  number the stage exists to produce.

## The merge gate

Every stage passes all of this before merge. Run in a worktree, with
`cd <abs worktree> &&` in the **same** shell call as every command — shell cwd
resets to the main checkout between calls, and a verify run that silently
executes on `main` returns a false green.

| Gate | Command shape | How it lies if you are careless |
| --- | --- | --- |
| Typecheck | `tsc --noEmit` x 3 configs, explicit binary path | `.bin/tsc` resolves to the wrong compiler |
| Unit | vitest x 3 with `--reporter=json --outputFile` | `rtk` prints `PASS(0) FAIL(0)` for a suite that failed to *collect*; a worktree with no `.env.local` skips ~1772 DB tests with `total` unchanged — check `pending` moved |
| Provenance | `readlink -f node_modules/@seazn/engine`; `.testResults[].name` | a symlinked `node_modules` compiles **main's** engine |
| Lint | `npm run lint` **and** `@seazn/engine#lint`, via `rtk proxy`, read `x N problems` | root lint does not cover engine; `rtk` swallows lint output entirely |
| Drift | `openapi:gen`, `i18n:gen-keys`, `i18n:check`, then `git status --porcelain` **empty** | both generators are CI-only gates; a green local run proves nothing without the porcelain check |
| DB | `db:apply` **and** `sync:sports` | `db:apply` alone leaves `funnel.test.ts` failing `expected 'generic' to be 'badminton'` |
| Build + smoke | `rm -rf apps/web/.next`, prod build, `test:smoke` | a stale `.next/types` fails tsc for untouched pages |
| e2e | prod build + `E2E_PROD_TARGET` on **`localhost`** | `127.0.0.1` 401s every API call — the session cookie is `Secure` under `NODE_ENV=production` — while the browser still looks signed in |
| Sim matrix | `sim:matrix` | golden corpus is frozen; `UPDATE_GOLDEN=1` is never set |
| Container | CI job on `ubuntu-latest`: `docker build` **then** `docker run` execing the TS 7 binary; plus `fly deploy --build-only --remote-only` | `SKIP_TYPECHECK=1` means the build never invokes `tsc`, so a musl-incompatible binary builds clean |
| Live-Stripe | once, after stage 4 | — |

Every stage merges **via PR**. Smoke CI runs on PRs only, so merging locally and
pushing to `main` skips it. e2e is never dispatched to a subagent — two have died
to the 600s watchdog. `git stash` is never used in a worktree; the stash stack is
shared with the main checkout and a no-op push/pop pops a *foreign* stash and
leaves `package.json` unmerged.

## Risks and rollback

| Risk | Detection | Rollback |
| --- | --- | --- |
| TS 7 linux-x64 binary will not exec on musl | CI `docker run` exec step | pin the builder stage to `node:26-slim` (glibc); the runner stage can stay alpine |
| More TS 7 errors than the one found | stage 3 typecheck | fix inline; `@ts-expect-error` only with an issue link |
| TS 6 and TS 7 disagree (editor green, gate red) | unavoidable by design | both pinned exact, no carets |
| `.bin/tsc` resolves to the wrong compiler | proven real — v7 won the collision | explicit paths everywhere, asserted by a `--version` test |
| Node 26 is Current until 2026-10-28 | — | accepted; stage 2 reverts on its own |
| Builder image grows by ~28 MB x N platform binaries | stage 3 image-size check | prune via `--omit=optional` if the runner stage is affected (it should not be — typescript is a devDep) |
| pnpm breaks the z3 wasm trace silently | stage 4 e2e against a real standalone server | revert stage 4; stages 1-3 unaffected |
| pnpm breaks the 12 root `scripts/*.ts` | stage 4 drift gates + smoke | same |

## Out of scope

- Porting the three compiler-API test files to `typescript/unstable/ast`.
- Removing `--experimental-strip-types` from the root scripts.
- Dropping type-aware ESLint rules to escape the TS 6 pin.
- Any local container runtime install.
