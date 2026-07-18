# HANDOFF

## Status
DONE — v13 wave (PROMPT-59..66) fully built on branch `worktree-v13` (worktree
.claude/worktrees/v13, base 42267fe). All local gates green; PR not yet opened.

## Current task
Open the PR, then post-merge follow-ups below.

## Done
61 draw-guard (supportsDraws enforced at finalize + stage-scoped shootout/extraTime
overlay in append-event/fold) · 59 CombinedQualification + slotOrder + pool-key
hardening + typed qualification zod · 66 addFixture (league/group/swiss, console
Add-match) · 60 entrants.badge_url (V288) + resolver + console/public/embed/PDF
render + V289 public view + inline new_person members + badge upload route ·
62 twoSidedBracket engine geometry + console BracketPanel + public tree +
landscape poster PDF (Documents menu) · 63 signed audit (JSON+PDF on
/fixtures/{id}/audit, Ed25519, /.well-known/seazn-audit-keys, console verified
strip, Pro scoring.audit_export in V288, runbook
docs/superpowers/runbooks/audit-signing.md) · 64 bracket slide + in-play pinned
rotation on the EXISTING /slideshow + public no-login /present (comp+div,
noindex) · 65 public profile stats (free) + leaderboard links + /me self photo ·
closing: 8 new help articles + slideshow article, i18n ×4 (2480 keys), smoke
v13Suite, README status table, this file.

## In progress
(none)

## Next steps
1. Open the PR: `gh pr create` from worktree-v13 (base main), title
   "v13: real-competition fidelity — draw guard, combined qualification,
   brackets, badges, signed audit, presentation (PROMPT-59..66)".
2. Deploy backlog AFTER merge: stg+prod `npm run db:apply` (V284→V289; note
   dev DB has a foreign V286 "pro plus plan" from the payments branch —
   Flyway on stg/prod needs BOTH branches merged or ignoreMissing), then
   `fly secrets set AUDIT_SIGNING_KEY=… AUDIT_SIGNING_KEY_ID=k1` per app
   (runbook), plus the still-pending v10 webhook events + V284/V285.
3. FIFA capstone on stg (plan Task 22): re-record 4 stuck R32 fixtures,
   re-seed with combine+slotOrder+badge flags, export the real bracket poster.

## Key decisions
- 2026-07-16: free = public flat chip strip; board/tiers/monetize = Pro (v10).
- 2026-07-18: PROMPT-61 built in-wave (no separate hotfix); wave = ONE branch.
- 2026-07-18: profile stat block FREE for consented players; leaderboard stays Pro.
- 2026-07-18: badge = URL string + upload reuse (assets bucket, svg allowed).
- 2026-07-18: PROMPT-64 re-scoped onto the existing v3 /slideshow (corpus had
  missed it) + public /present wrappers; audit PDF on the per-fixture route.
- 2026-07-18: migrations renumbered V286/V287→V288/V289 (payments session's
  "pro plus plan" V286 already applied to shared dev DB).

## Gotchas
- vitest from apps/web cwd only (@/ aliases); rtk tee log is stale when output
  is redirected — trust the visible tail line.
- FootballCfg is NOT schema-defaulted by engine-db folds: seed COMPLETE config.
- generate returns {fixtures}; divisions need /start before scoring over HTTP.
- ConsentCard must stay router-free (markup tests); photo state flips from the
  API response.
- publicStorageUrl returns "" without NEXT_PUBLIC_SUPABASE_URL (stub in tests).

## Verify
cd apps/web && npx tsc --noEmit && npx vitest run   # 1135 pass / 0 fail
cd packages/engine && npx vitest run                 # 880 pass
DB suites: DATABASE_URL=postgresql://postgres@127.0.0.1:54329/seazn_v13 DATABASE_SSL=disable
Full smoke (last run): 343 passed, 0 failed (ephemeral seazn_smoke13 + next dev :3013)
