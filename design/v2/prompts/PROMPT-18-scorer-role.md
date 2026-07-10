# PROMPT-18 — Scorer Role, Scoped Scoring & Seat Quotas

**Read first:** `engine/13-roles-and-scorer.md` (normative); `engine/10-pro-entitlements.md`
§2; existing `src/lib/auth.ts` role machinery, `org_invites` flow. Preamble: PROMPT-00.
Depends: PROMPT-10 (schema), PROMPT-11 (use-case layer), PROMPT-13 (entitlement wiring).
**Blocker to resolve first:** doc 13 §5 billing decision (a) vs (b) for `orgs.max_owned`
— get the call from the owner before implementing that quota; implement the rest regardless.

## Task
1. **Schema**: extend `org_members.role` check with `scorer`; `scorer_assignments` table
   per doc 13 §3 (RLS + org_id per house pattern); division config keys
   `scorerCanFinalize` (default true), `scorerCanEnterLineups` (default true).
2. **AuthZ**: `requireScorable(fixtureId)` in the use-case layer — editor roles pass;
   scorer passes iff a covering assignment exists (fixture/division/competition
   resolution). Wire into: append event, void own-fixture pre-finalize, finalize
   (config-gated), lineup entry (config-gated). Everything else 403 for scorers.
   Table-driven authz test: role × capability matrix from doc 13 §2 asserted end-to-end.
3. **Sport labels**: add `officialLabel` to `SportModule` (cricket Umpire, football
   Referee, chess Arbiter, volleyball Referee, carrom Umpire, setbased Umpire, generic
   Scorer); surface in invite UI, scorer console, fixture officials display.
4. **Invite flow**: `org_invites.role = 'scorer'` + `default_scope`; accept creates
   membership + assignment atomically; QR/share link reuse. Scorer post-login landing →
   "My matches".
5. **Scorer console** (`apps/web`): assigned fixtures for today/upcoming
   (`GET /api/v1/me/assigned-fixtures`), per-fixture scoring pad (reuse PROMPT-15 sport
   pads), undo-own, finalize where allowed. No org nav, no admin surface. Realtime on
   assigned fixtures regardless of plan (doc 13 §6).
6. **Quotas** per doc 13 §5 matrix: seed `members.max` (3/10/∞), `scorers.max` (1/1/∞),
   `orgs.max_owned` (1/5/∞ — pending billing decision) into `plan_entitlements`;
   **replace** the old `seats.scorekeepers` row. Enforce at invite-accept, role-change,
   org-create. Downgrade freeze rule for over-quota members (doc 10 §2.4).
7. Update `engine/10-pro-entitlements.md` table (remove `seats.scorekeepers`, point to
   doc 13 §5) if not already done.

## Acceptance
- E2E: owner invites scorer scoped to a division via QR → scorer signs up → lands on My
  matches → scores a fixture (winner/draw), voids a mistake, finalizes → cannot open org
  settings, other divisions, or entrant editing (403s asserted).
- Quota tests: 4th member invite on Community → 402 with feature_key; 2nd scorer → 402;
  2nd org on Community → blocked at creation.
- Authz matrix test green; `check:rls` covers `scorer_assignments`.
