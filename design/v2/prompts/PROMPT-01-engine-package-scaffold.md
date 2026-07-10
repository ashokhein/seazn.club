# PROMPT-01 — Workspace & Engine Package Scaffold

**Read first:** `engine/03-engine-architecture.md` §1. Preamble: PROMPT-00.

## Task
Convert the repo to an npm workspace and scaffold the pure engine package. No engine
logic yet — structure, tooling, and the import-boundary gate.

1. Root `package.json`: `"workspaces": ["apps/*", "packages/*"]`. Move the Next.js app to
   `apps/web/` (git mv; fix `tsconfig.json` paths, `fly.toml`/`Dockerfile` build context,
   CI workflow paths, vitest config). App must build and deploy exactly as before.
2. Create `packages/engine/` per the layout in 03 §1: `package.json` name
   `@seazn/engine`, `"type": "module"`, exports map for subpaths (`./core`, `./sport`,
   `./sports/*`, `./competition`, `./scheduling`, `./testkit`), only runtime dep `zod`
   (peer), dev deps `vitest`, `fast-check`, `typescript`. Own `tsconfig` (strict, no DOM lib).
3. Empty module stubs for every file named in 03 §1 with header comments pointing at
   their spec sections.
4. **Boundary gate:** extend `scripts/engine-check.ts` (or add `scripts/engine-boundary.ts`
   wired into CI) to fail if `packages/engine/src` imports any of: `postgres`, `next`,
   `react`, `ioredis`, `server-only`, `node:crypto`, `apps/`, or contains `Date.now(`,
   `Math.random(`, `new Date()` outside `core/clock.ts` tests.
5. CI: add `npm -w packages/engine test` + boundary gate to `.github/workflows/ci.yml`.

## Acceptance
- `npm run build` (web) green from fresh clone; fly deploy config paths valid.
- `npm -w packages/engine test` runs (empty suite ok).
- Boundary gate demonstrably fails on a seeded violation (include a test for the gate itself).
