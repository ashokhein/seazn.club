# HANDOFF

## Status
Branch `feat/event-pass-e2e-and-entitlement-gaps`, worktree `.claude/worktrees/event-pass`.
Task 24 (help pages + final verification) COMPLETE. **Nothing deployed.**
Suite: `2622 passed / 0 failed / 11 skipped` (matches baseline @ 92a1c0cd).
Smoke: `517 passed / 4 failed` (4 pre-existing V310/V311 stale asserts in scripts/smoke.ts).

## Current task
Task 24 done. Plan's implementation tasks are finished. Remaining is owner review + the
two pre-existing test-fixture defects below (both OUT of Task 24 scope).

## Done
- `apps/web/content/help/billing/plans.md`: Pro "unlimited team members" → "15 team
  members" (live matrix: Pro `members.max`=15 via V270; only Pro Plus is unlimited).
- `apps/web/content/help/billing/event-pass.md`: realtime line now affirms the PUBLIC
  spectator surface (commit 711032d0), not just the venue screen.
- `apps/web/content/help/billing/downgrade.md`: reviewed against live matrix — no change
  needed (fee ladder 8/2/1, pass 5%, brand COLOUR Pro-only + logo free, fees run on Community).
- Verified every number in all three pages against `seazn_club.plan_entitlements` (live).
- Full report: `.superpowers/sdd/task-24-report.md` (gitignored).

## In progress
None.

## Next steps
1. Owner: fix stale e2e assertion `apps/web/e2e/event-pass.spec.ts:374` — anchored regex
   `/upgrade$` rejects the intended `?feature=` query the pass CTA now carries (added by
   76020eeb, which updated pricing-v3.spec.ts + upgrade-gate.test.tsx but not this file).
   U1 desktop+mobile red since then; 12 downstream serial tests cascade. Fix:
   `new RegExp(\`/c/${rig.compSlug}/upgrade(\\?|$)\`)`.
2. Owner: reconcile the 4 stale smoke asserts in `scripts/smoke.ts` (lines 578, 2181,
   3546, 4365) with the V310/V311 packaging, or accept them as known-fail.
3. Deploy chain V306–V313 (never deployed); Task 25 test-infra (CI/env/Redis/sweepRegistrations).

## Key decisions
- 2026-07-21 (append-only prior entries preserved below):
- Task 24: help copy is verified against the LIVE matrix, never the existing prose. Any
  number the matrix contradicts is a defect even if the V310/V311 repackaging didn't cause
  it (that is why Pro members 15-not-∞ was corrected).
- Task 24: did NOT edit `event-pass.spec.ts` / `scripts/smoke.ts` — brief scope is the 3
  billing help `.md` files only; both stale-fixture defects are reported, not worked around.
- Prior: see `docs/superpowers/specs/2026-07-21-event-pass-and-entitlement-gaps-design.md`
  D1-D24. Pre-launch, zero customers: no backfill/grandfathering. Full review rigour +
  Opus on every task (owner ruling).

## Gotchas
- **Env: ONE file, `<root>/.env.local`;** `apps/web/.env.local` is a gitignored symlink to
  it. Smoke needs `--env-file=.env.local` from repo root or DATABASE_URL is unset (~28 checks).
- **Never `pkill -f "next dev"`** — scope to port: `lsof -ti :3021 | xargs kill`. This
  branch's port is 3021; a prod server may already be running there.
- **Stale `apps/web/.next` = phantom 404s.** `rm -rf apps/web/.next` before a fresh build.
- **e2e needs a PROD build** (`next build && next start`) + `E2E_PROD_TARGET=1` +
  `PLAYWRIGHT_BASE`; `next dev`'s login_url path is not exposed in prod. Do NOT enable
  `.github/workflows/e2e.yml` (owner disables it deliberately).
- **Migration numbers claimed in `/tmp/seaznclub/RESERVATIONS.md`** — `feat/billing-groups`
  owns V309.

## Verify
cd apps/web && npx tsc --noEmit && npx vitest run
