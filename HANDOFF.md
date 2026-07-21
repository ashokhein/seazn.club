# HANDOFF

## Status
Event Pass + entitlement branch `feat/event-pass-e2e-and-entitlement-gaps`, 36 commits
off `origin/main` @ `4125922a`. Worktree `.claude/worktrees/event-pass`.
Suite: 2423 passed / 11 skipped / 1 failed (known global `sweepRegistrations()` flake).
Migrations V306-V312 applied locally. **Nothing deployed.**

## Current task
Phases 1-3 complete and reviewed. Help articles + chips done. Remaining: Phase 4 (copy
surfaces), Phase 5 (discovery + upgrade-page UI), Phase 6 (E2E/smoke), Task 25 (test infra).

## Done
- V306 `org_has_feature` gains a competition arg + override expiry, `comped_until`,
  `past_due` grace. 2-arg delegating wrapper retained (drop in Task 25).
- Deleted two duplicate app-side resolvers (`api/orgs/[id]/entitlements`, `lib/auth.ts`).
- V307 moved the `public_players_v` entitlement gate to its caller (outside `unstable_cache`).
- V308 pass grants `dashboard.player_profiles`. V310 community gets `branding` +
  `registration.paid`, fee ladder 8/5/2/1. V311 community 32 entrants / 5 comps, pass 64.
  V312 deleted V270's grandfather `competitions.max_active` overrides.
- `pass-scoping-guard.test.ts` — AST guard, derives lifted keys from the live matrix, plus a
  counter-rule flagging `hasFeatureOnAnyPass` in enforcement layers. GREEN.
- Phase 2 swept all 6 remaining unscoped call sites.
- Pass purchases now link the Stripe customer, create a named Invoice, and pin
  `subscriptions.currency`. Help articles rewritten (20 files).

## In progress
`track-tips` worktree — in-app help chips for the new pricing model.

## Next steps
1. Merge `track-tips`; **copy its `.superpowers/sdd/*.md` out BEFORE removing the worktree.**
2. Phase 4 copy: `upgrade-gate.tsx` PASS_FEATURES (3 dead keys, 4 missing), `pricing-cards.ts`,
   `stripe-plans.json` descriptions + `npm run stripe:sync`, `feature-copy.ts`, dictionaries ×4,
   add `dashboard.player_profiles` + `scheduling.ai.runs_per_division.max` to
   `ENTITLEMENT_DOMAINS`, relabel the `/pricing` fee row to "Platform fee on entry fees".
3. 3 queued Minors in `lib/billing.ts` — see `.superpowers/sdd/progress.md`.
4. Phase 5 UI, Phase 6 suites, Task 25 (CI/env/Redis/`sweepRegistrations` scoping).

## Key decisions
- See `docs/superpowers/specs/2026-07-21-event-pass-and-entitlement-gaps-design.md` D1-D24.
- Pre-launch, zero customers: no backfill or grandfathering anywhere.
- Full review rigour on every task (owner ruling), Opus for every subagent.

## Gotchas
- **vitest does NOT read `apps/web/.env.local`** — export `DATABASE_URL` or ~692 DB tests
  silently skip and the run reports green. Same hole in CI.
- **`REDIS_URL` unset locally** makes the entitlement cache inert; two staleness bugs shipped
  because of it.
- **Reports in `.superpowers/sdd/` are gitignored and die with a removed worktree.**
- `isolation: "worktree"` branches from `origin/main`, NOT your branch HEAD. Same for
  `git worktree add … HEAD` run from the main repo. Always name the branch.
- **Migration numbers are claimed in `/tmp/seaznclub/RESERVATIONS.md`** — a concurrent session
  (`feat/billing-groups`) shares this repo and owns V309. Scanning the tree is not a claim.
- Stripe Tax: `automatic_tax` enabled with **zero registrations** = silently collects nothing.
  Owner/advisor decision, untouched.
- Fresh-database apply of this chain has never been tested (`baselineVersion = "240"`).

## Verify
cd apps/web && npx tsc --noEmit && npx vitest run   # export DATABASE_URL first
