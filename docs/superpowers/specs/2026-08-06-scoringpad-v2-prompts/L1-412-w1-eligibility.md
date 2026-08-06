# L1 — #412 (W1): eligibility enforcement — shared usecase, 7 gates, audited override

Paste this whole file as the session opener. Read `_RULES.md`, then `_INDEX.md`,
then this. Server + UI session, disjoint from the S-chain — run it any time.

Branch `feat/l1-w1-eligibility` in a fresh worktree. One PR. Issue #412.
Design: `../2026-08-03-scoringpad-v2-design.md` (Part I, WS1). Closes #407 WS1.

**Unblocked**: this was held while another session owned registrations/persons
(#402, #404). Both are closed. But those waves **changed `registrations.ts` and
the persons model** — every line number below predates them. Scout re-pins first,
and expect the duplicate-person merge work to have touched the same files.

## Why

Divisions can declare age/gender eligibility, but **only the public registration
submit enforces it** — every organiser-side path bypasses it, and the UI claims
otherwise (`components/v2/entrants-panel.tsx:224`, re-pin).

`eligibilityIssues` (`server/usecases/registrations.ts:146`) runs at
`submitRegistration:808` and nowhere else. Organiser entrant create
(`entrants.ts:208`), roster add (`insertMembers:155`), `patchEntrant:380`,
`syncEntrantRosterFromSquad:410`, team squad set (`teams.ts:208`), CSV import
(`imports.ts:297`), lineup submit (`fixtures.ts:80`) and team-registration
`players[]` at confirm/materialise (`registrations.ts:405-418` — dob stored,
never checked) all accept ineligible people silently.

Deferred on purpose once (`design/v1/DEFERRED.md:82-84`); #407 confirms closing
it now: **block, with an audited override-with-reason.**

## Scope

1. **New `server/usecases/eligibility.ts`** (+ new `usecases/audit.ts`): move
   `ageAt`/`isMinor`/`requiresDob`/rule types out of `registrations.ts`
   (re-export for compat; `registrations.ts` imports `eligibility.ts`, never the
   reverse).
   `evaluateEligibility(rules, {dob, gender}, seasonStartYear) → {violations, missing}`
   — codes `AGE_TOO_OLD | AGE_TOO_YOUNG | GENDER_NOT_ALLOWED`, warnings
   `MISSING_DOB | MISSING_GENDER`, unknown rule kinds skipped.
   `gateRosterEligibility(tx, {divisionId, personIds, context, override, actorId}) → warnings[]`
   — throws `HttpError(422, msg, "ELIGIBILITY_VIOLATION", {violations, warnings})`
   without an override; with `override.reason` writes a `competition_events` row
   of type `eligibility.overridden` (via `audit.ts`, moved from
   `registrations.ts:313`) and proceeds.
2. **Zod (`server/api-v1/schemas.ts`)**: a typed `AgeRuleS`/`GenderRuleS`/
   `OtherRuleS` union replaces the untyped eligibility arrays on CreateDivision
   and PatchDivision (write-time only). Optional `EligibilityOverride {reason: 3..500}`
   on CreateEntrant / PatchEntrant / PutLineup / roster-sync / confirm / waive
   bodies. `NewPersonMemberInput` gains optional `dob`/`gender`, threaded through
   `resolveInlineMembers`.
3. **Gate wiring — 7 points**: `createEntrants` after final roster resolution
   (covers copy_roster + squad seed); `patchEntrant`; `syncEntrantRosterFromSquad`;
   `setTeamSquad` — **warnings only** (division-agnostic, evaluated per enrolled
   division); `putLineup` (catches pre-feature rosters); imports (`planImport`
   emits error/warning issues, `commitImport` accepts one override and audits
   once); registration confirm/waive/mark-paid before `materialise` — where team
   `players[]` dob is finally checked.
   **The Stripe-webhook materialise path is NOT gated** — payment is already
   taken. Public submit keeps today's stricter behaviour: missing dob/gender
   blocks there, because the registrant can supply it.
4. **UI**: new `components/v2/eligibility-override-dialog.tsx` — on
   `ELIGIBILITY_VIOLATION`, list the violations, take a reason, retry with the
   override. Wire into `entrants-panel.tsx` and the registrations confirm panel;
   amber warning chips for `MISSING_*`; the `:224` banner finally becomes true.
5. Delete `design/v1/DEFERRED.md:82-84`.

No migration — rules stay in `divisions.eligibility` jsonb, audit reuses
`competition_events`. (Greenfield rules allow a column if the jsonb turns out to
be the wrong shape — if you conclude that, say so and ask before adding one.)

## Acceptance criteria

- [ ] All 7 gate points reject an over-age or wrong-gender person with 422 code
      `ELIGIBILITY_VIOLATION` — assert the **code**, never a bare `{status: 422}`
- [ ] The same request with `override.reason` succeeds and writes **exactly one**
      `eligibility.overridden` audit row naming actor and reason
- [ ] Missing dob/gender on organiser paths is an amber warning, never a block;
      public submit still blocks
- [ ] `setTeamSquad` never hard-blocks (warnings only)
- [ ] Stripe-webhook materialise path unchanged — regression test
- [ ] `npm run openapi:gen` run and `openapi/*.json` committed (schemas changed);
      `i18n:gen-keys`; then `git status --porcelain` **empty**
- [ ] i18n: new keys in all 4 dictionaries, `i18n:check` green
- [ ] Dialog screenshots at desktop **and 375px**, no horizontal scroll,
      touch-sized targets
- [ ] Vitest counts from the JSON reporter with paths confirmed in
      `.testResults[].name`

### Test types

- **Unit** — `eligibility.test.ts`: cutoff boundaries, gender rules,
  missing-data, lenient parse of unknown rule kinds.
- **DB integration** — `entrants-eligibility.test.ts`: 422 with code, override
  path, audit row, warning paths, patch/sync/squad-seed; extend the team-squad,
  imports and registrations suites; a lineup-gate test.
- **E2E (Playwright)** — over-age roster add → dialog appears → blocked without a
  reason → succeeds with one. Desktop + 375px.
- **Smoke** — extend `scripts/smoke.ts` so an organiser path exercises a gate
  (pro and free).
- **Regression** — the Stripe-webhook path stays ungated; the `:224` banner claim
  is now true.

## Gotchas

- `HttpError` assertions must pin the error **code** — a bare 422 is satisfied by
  every other guard on the path.
- Roster persons often have null dob/gender (inline input captures `full_name`
  only). That is the warning state, not a bug.
- `entrants-panel.tsx` strings feed e2e assertions — `git grep -a` new and changed
  text across both e2e phases before merge.
- #404's merge tool rewrote parts of the persons model. If a gate needs a person
  identity, note that the persons identity index is scoped to `lane='player'` —
  officials mint unconditionally and cannot dedupe.
- Follow `seazn-local-env`: a fresh schema needs `db:apply` **and** `sync:sports`.

## Execution

One coherent file set (schemas + usecases + UI) → **one inline implementer pass**.
Do not parallelise.

**Scout (sonnet) brief:** re-pin every line reference in the Why and Scope
sections above against current `main` (they predate #402/#404), and report any
that no longer exist or moved into a different function. Also locate
`competition_events` write helpers and the registrations confirm panel.
file:line table only, under 30 lines, no file contents. Flag mismatches loudly —
a moved gate point is a finding, not a footnote.

**Implementer (opus, high):** brief carries the re-pinned table, the 7 gate list,
the "Stripe path NOT gated" rule, and the code-assertion requirement.
Load `frontend-design:frontend-design` for the dialog.

**Reviewer (sonnet):** does every gate assert the **code**? Is the audit row
written exactly once per overridden request (not per person)? Is `setTeamSquad`
truly warning-only? Gap list only.

## On close

`_INDEX.md`: L1 → DONE, the 7 gate points as actually wired (they may differ from
this brief), the override audit shape. Update help pages for the override flow.
Memory + `scripts/agent-memory-snapshot.sh`.
