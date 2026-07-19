# HANDOFF

## Status
Clubs W1 foundation COMPLETE on `feat/clubs-w1` (worktree .claude/worktrees/clubs-w1,
rebased onto origin/main, merge-base 8bcd80f). All 13 tasks reviewed+approved.
Final whole-branch review in flight; then battery → PR → CI → merge (pre-authorized).

## Current task
Final review findings fix pass → full battery → PR → watch CI → merge → walkthrough artifact.

## Done
V292 clubs profile (slug/home_ground/website/notes, colors flat home_/away_ keys) +
club_contacts w/ tenant RLS · caps clubs.max 2/2/20/∞, teams.max 2/2/40/∞,
teams.squad_max 20/20/∞/∞ via withinLimit→402 feature_key→UpgradeGate; clubs.hierarchy
all plans · club/team create + contacts CRUD APIs (key-scopes+openapi gated) · import
cap guards · /admin/entitlements numeric editor (DENY-aware, dual-value) · thin
Clubs & Teams directory list (clubs-teams-list.tsx, partitionDirectory) · club hub
/clubs/[id] tabs overview/teams/entries, kit stripe+chips, squad editor moved to
club-hub/team-squad-editor.tsx, crest upload pinned to hub club (pinFilesToClub/
finalizeMapping) · legacy clubs-panel.tsx DELETED · help content/help/directory/
clubs-and-teams.md · pricing matrix cap rows + orgs.max_owned relabel · smoke 371/0
(clubsSuite pro+free 402) · e2e clubs 12/0 incl 375px ≥44px gates.

## In progress
Final whole-branch review (opus, package .superpowers/sdd/review-8bcd80f..a1f9f7e.diff);
minors triage list .superpowers/sdd/final-review-minors.md; ledger MAIN repo
.superpowers/sdd/progress.md.

## Next steps
1. Apply final-review MUST-FIX findings via ONE fix subagent, re-verify, then:
   cd apps/web && npx tsc --noEmit && npx vitest run; smoke + e2e; push; gh pr create
   (base main); watch CI; MERGE (user pre-authorized on green).
2. Playwright visual walkthrough artifact (desktop+375px: directory, hub tabs,
   quick-add, 402 gate, admin editor) → claude.ai artifact.
3. Post-merge deploy backlog: stg/prod db:apply (V285..V292 pending), stripe:sync,
   smoke; V292 renumber note: main's v4 docs branch owns V292.

## Key decisions
- (v13 era, see git history: draw-guard in-wave; badge=URL+upload; V288/V289 renumber.)
- 2026-07-18: clubs = ladder model — entrant-only → standalone team (club_id null) →
  club hierarchy; nothing forced. Caps int rows, admin-overridable; hierarchy free.
- 2026-07-18: colors = FLAT record keys home_primary/…/away_secondary (no nesting).
- 2026-07-19: zod errors are 400 repo-wide (spec's 422 wording corrected in spec).
- 2026-07-19: division chips in hub tabs are plain (id-hrefs lint-banned, no slugs
  in payload); wire routes.division() when payload carries slugs (W3/W4).
- 2026-07-19: rebase onto origin/main at every task boundary (user standing order);
  merge on green CI pre-authorized.

## Gotchas
- vitest from apps/web cwd only (@/ aliases); i18n parity spans 8 namespaces —
  per-script counts differ, both must pass ×4 (ui now ~2635-scope).
- team_display_v does NOT inherit RLS — always filter org_id explicitly.
- bulkAssignLogos: truthy manual mapping overrides stem-match; "" is falsy → stem-match
  (why hub pins + finalizeMapping coerce).
- e2e vs prod build (:3200) + ephemeral PG :54329 db seazn_clubs_w1, DATABASE_SSL=disable;
  shared-DB poison → namespace names per run.
- .superpowers/ is gitignored — reports/briefs are local artifacts only.

## Verify
cd apps/web && npx tsc --noEmit && npx vitest run   # last: 1248 pass / 0 fail
smoke: 371 passed / 0 failed · clubs e2e: 12/0 · i18n parity ×4 OK · openapi:gen no drift
