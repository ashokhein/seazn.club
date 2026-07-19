# HANDOFF

## Status
Monorepo optimization session COMPLETE. PR #158 (CI/Docker CPU de-dupe) and
PR #161 (i18n dead-key prune) both MERGED to main; staging deploys green.
pnpm migration evaluated and REJECTED by benchmark. No open branches from
this session; worktrees removed.

## Current task
None — session closed cleanly. Next session starts fresh.

## Done
- #158 (a4d645e5): SKIP_TYPECHECK env gate in next.config.js (tsc in CI test
  job = sole type gate; smoke build + Dockerfile set the flag; 6GB heap bump
  REMOVED from Dockerfile — never re-add); engine coverage + sim matrix gated
  by dorny/paths-filter `engine-changes` (needs job `permissions:
  pull-requests: read` — fix 21356589); security job installs nothing (audit
  reads lockfile); deploy job `npm ci --omit=dev`; Docker BuildKit npm cache
  mount + --prefer-offline. Staging deploy verified (/api/health 200).
- pnpm benchmark NO-GO: warm 26.9s npm vs 25.1s pnpm; cold 48.2s vs 52.2s
  (pnpm slower). Repo stays npm. Numbers in PR #158 body.
- #161 (5307effb): 31 dead ui.json keys pruned ×4 locales + i18n-keys.ts
  regen. Audit recipe in memory project_i18n_payload.md (plural rule!).
- i18n hashed-JSON browser-cache plan REJECTED — inline dict is load-bearing
  for island SSR (empty login-form problem). Spec records why:
  docs/superpowers/specs/2026-07-19-i18n-browser-cache-design.md (7fb49dac).

## In progress
Nothing. (Parallel sessions own: payments v179/#160, page-playoffs stg deploy
HELD by user — see their memory files, not this handoff.)

## Next steps
1. If page-load payload still matters: MEASURE first — console-page transfer
   size + PostHog full-load vs client-nav ratio; only then consider the
   ui.json per-surface split (project_i18n_payload.md has the ranked list).
2. Optional: drop dead `pnpm-lock.yaml` entry from ci.yml engine filter if
   pnpm is ruled out permanently (kept as future-proofing).

## Key decisions
- (clubs-w1 era decisions: see git history of this file @ 8bcd80f.)
- 2026-07-19: type-check once per PR — builds skip via SKIP_TYPECHECK=1;
  tsc gate lives in ci.yml test job only.
- 2026-07-19: pnpm rejected on measurement (gate was ≥30s/job or ≥1min
  Docker; best case 1.8s). Re-evaluate only for strictness/disk, not speed.
- 2026-07-19: i18n dict stays inline in RSC payload — client-fetch delivery
  breaks island SSR; any payload work goes through namespace splitting.

## Gotchas
- Node 26 dropped corepack; installed globally this session (pnpm 10.34.5
  shim exists but repo is npm).
- Main-checkout `npx tsc` may fail on corrupt .next/dev/types while other
  sessions' dev servers run (ports 3400/3800 live at close) — verify in a
  clean worktree or trust CI; do NOT rm .next under a live dev server.
- gh pr checks --watch exits "no checks reported" if started before checks
  register, and after any new push — restart it.
- rtk proxies git; `git -C` from a worktree cwd behaved unreliably once —
  cd to the target repo or use `rtk proxy git -C …` when state looks wrong.

## Verify
cd apps/web && npx tsc --noEmit && npx vitest run
# last (clean worktree @ 5307effb content): tsc clean, 1378 pass / 523 skip;
# i18n parity ×3 OK; PR #161 CI 3/3 green; staging deploy success.
