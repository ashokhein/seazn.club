# #407 programme — wave prompts (posted 2026-08-03)

Index: #411. Waves: #412–#422. Design: `2026-08-03-scoringpad-v2-design.md`.
The GitHub issues are the execution source of truth; these are the committed copies.

## #411 — index

Execution index for #407. Design: `docs/superpowers/specs/2026-08-03-scoringpad-v2-design.md`. Prompts also committed at `docs/superpowers/specs/2026-08-03-scoringpad-v2-wave-prompts.md`.

Covers all four #407 workstreams plus the greenfield ScoringPad v2 rebuild. Owner rulings 2026-08-03: (1) pad is rebuilt greenfield, superseding #407 WS2 step 6; (2) programme covers everything in #407; (3) not only the UI layer — every sport's data model is audited against the sport's real scoring domain per variant and extended where it falls short, then the pad feeds all of it.

The completeness chain, each link enforced:

```
sport reality ⊇(audit W4) eventSchema/Cfg ⊇(conformance W5) PadSpec ⊇(renderer W8) pad UI
```

## Waves

| Wave | Issue | Scope | Depends on |
|---|---|---|---|
| W1 | #412 | Eligibility enforcement: shared usecase, 7 gates, audited override | — |
| W2 | #413 | Date hardening: V345 division dates, bounds, scheduler `endAt` | W1 (files) |
| W3 | #414 | Formats: enum drift, placement snapshots, qualification from every stage kind | — |
| W4 | #415 | Sport domain audit: DOMAIN.md ×11, schema extensions, person attribution | — |
| W5 | #416 | PadSpec contract + bidirectional conformance, all 11 modules | W4 |
| W6 | #417 | Player-stat models for every sport, prefer-person-fields | W5 (files) |
| W7 | #418 | Career rollup: plumbing, `/me` career, public card scope | W6 |
| W8 | #419 | Pad chassis + universal renderer (flag off) | W5 |
| W9 | #420 | Sport skins: cricket, racquet family, football | W8 |
| W10 | #421 | Integration behind flag: one registry, both entry points, offline e2e | W9 |
| W11 | #422 | Cutover: default on, delete v1 pads, help + smoke | W10 |

**Safe parallel groups** (provably disjoint file sets): {W1→W2} ∥ {W3} ∥ {W4→W5→W6} from the start; after W6: {W7} ∥ {W8→W9→W10→W11}. Everything else sequential. Rebase at wave boundaries only, never mid-agent. One PR per wave — smoke CI runs on PRs only.

## Standing execution rules (apply to every wave)

Read `docs/agent-playbook.md` before running a wave. Then:

- **Workspace**: new branch in a worktree, never a checkout in the main repo dir. Symlink `node_modules` and `.claude/agent-memory` into the worktree (playbook §6 — a bare worktree has no agent memory and vitest can't resolve deps without the link).
- **Orchestration**: `scout` (sonnet) for all read fan-out — never pull file dumps into the main thread. If the wave's tasks touch the same set of files (the common case inside one wave), implement **inline** in the main thread; only dispatch parallel `implementer` agents when file sets are provably disjoint (W4's per-family split is the worked example). Otherwise run the loop sequentially: `implementer` (TDD-shaped, tight brief) → `reviewer` on the diff → inline fixes → inline full gate. Every dispatch carries: exact paths, acceptance criteria, what NOT to touch, the verbatim verify command, and an output cap ("final message under 15 lines — counts, paths, deviations, blockers; no file contents or diffs").
- **Skills**: load `superpowers:test-driven-development` before writing code (every change ships a test that fails without it); `superpowers:verification-before-completion` before claiming done; `superpowers:systematic-debugging` on any unexpected red. UI waves additionally load `frontend-design:frontend-design` and verify by Playwright MCP screenshot at desktop **and 375px** (no horizontal scroll). DB-migration waves load `supabase:supabase-postgres-best-practices` first.
- **Verification** (repo wrappers lie — AGENTS.md traps):
  - vitest green only from `npx vitest run --reporter=json --outputFile=/tmp/r.json <paths>` then `jq '{total:.numTotalTests,passed:.numPassedTests,failed:.numFailedTests}' /tmp/r.json`. `PASS(0) FAIL(0)` means failed-to-collect.
  - `tsc --noEmit` runs write `EXIT=$?` themselves; never two concurrently.
  - lint via `rtk proxy npm run lint`, read `✖ N problems`.
  - grep with `-a` (binary-file masking).
- **OpenAPI drift**: if any api-v1 zod schema moved, run `npm run openapi:gen` and commit `openapi/*.json` **before** the PR — the drift gate is CI-only and a green local run proves nothing (hit 4× already).
- **Unrelated failures**: a failing suite whose files/refs the wave did not touch → do not chase it; rerun once alone (file-parallel DB sweeps flake absolute-count tests), then skip and note it in the PR body for CI to adjudicate.
- **i18n**: every new/changed user-facing string in all 4 dictionaries (`en,es,fr,nl`, flat dotted keys) + `gen-keys` + `i18n:check`. `content/help/**` is the exception: one English tree.
- **e2e**: never enable `.github/workflows/e2e.yml`; verify locally (prod build + `E2E_PROD_TARGET` on :3100, `whsec_e2e_payments`). Before merging any UI-text change, grep the text across e2e specs (both phases).
- **Close of wave**: reviewer findings fixed, gate rerun inline (you own the number), PR opened, memory written (decision + any new gotcha), `scripts/agent-memory-snapshot.sh` run.

## Deferred (not in any wave)

Org custom-variant editor UI; DOMAIN.md lines classified deferred (each needs a follow-up issue when picked up); service worker; #407 WS2's PAD_FOR registry (superseded by W10's registry).

## #412 — W1: eligibility enforcement

Wave 1 of #411. Design: `docs/superpowers/specs/2026-08-03-scoringpad-v2-design.md` (Part I, WS1). Depends on nothing; W2 must wait for this wave (shared `schemas.ts`/`registrations.ts`).

Closes #407 WS1. Divisions can declare age/gender eligibility, but only the public registration submit enforces it — every organiser-side path bypasses, and the UI claims otherwise (`components/v2/entrants-panel.tsx:224`).

## Why

`eligibilityIssues` (`server/usecases/registrations.ts:146`) runs at `submitRegistration:808` and nowhere else. Organiser entrant create (`entrants.ts:208`), roster add (`insertMembers:155`), `patchEntrant:380`, `syncEntrantRosterFromSquad:410`, team squad set (`teams.ts:208`), CSV import (`imports.ts:297`), lineup submit (`fixtures.ts:80`) and team-registration `players[]` at confirm/materialise (`registrations.ts:405-418` — dob stored, never checked) all accept ineligible people silently. Deferred on purpose once (`design/v1/DEFERRED.md:82-84`); #407 confirms the decision to close it now: **block with audited override-with-reason**.

## Changes

1. **New `apps/web/src/server/usecases/eligibility.ts`** (+ new `usecases/audit.ts`): move `ageAt`/`isMinor`/`requiresDob`/rule types out of `registrations.ts` (re-export for compat; `registrations.ts` imports `eligibility.ts`, never the reverse). New `evaluateEligibility(rules, {dob,gender}, seasonStartYear) → {violations, missing}` — codes `AGE_TOO_OLD|AGE_TOO_YOUNG|GENDER_NOT_ALLOWED`, warnings `MISSING_DOB|MISSING_GENDER`, unknown rule kinds skipped. `gateRosterEligibility(tx, {divisionId, personIds, context, override, actorId}) → warnings[]` — throws `HttpError(422, msg, "ELIGIBILITY_VIOLATION", {violations, warnings})` without override; with `override.reason` writes `competition_events` type `eligibility.overridden` (via `audit.ts`, moved from `registrations.ts:313`) and proceeds.
2. **Zod (`server/api-v1/schemas.ts`)**: typed `AgeRuleS`/`GenderRuleS`/`OtherRuleS` union replaces the untyped eligibility arrays on CreateDivision:117 / PatchDivision:127 (write-time only, backward compatible). Optional `EligibilityOverride {reason: 3..500}` on CreateEntrant / PatchEntrant / PutLineup / roster-sync / confirm / waive bodies. `NewPersonMemberInput` gains optional `dob`/`gender`, threaded through `resolveInlineMembers` (`entrants.ts:44`).
3. **Gate wiring (7 points)**: `createEntrants` after final roster resolution (~`entrants.ts:312`, covers copy_roster + squad seed); `patchEntrant:380`; `syncEntrantRosterFromSquad:397`; `setTeamSquad` — **warnings only** (division-agnostic, evaluated per enrolled division); `putLineup` (`fixtures.ts:70`, catches pre-feature rosters); imports (`planImport` emits error/warning issues, `commitImport` accepts one override, audits once); registration confirm/waive/mark-paid before `materialise` — team `players[]` dob finally checked. **Stripe-webhook materialise is NOT gated** (payment already taken). Public submit keeps today's stricter behaviour (missing dob/gender blocks there — the registrant can supply it).
4. **UI**: new `components/v2/eligibility-override-dialog.tsx` — on `ELIGIBILITY_VIOLATION`, list violations, reason textarea, retry with override. Wire into `entrants-panel.tsx` (:188-211) and the registrations confirm panel; amber warning chips for `MISSING_*`; the :224 banner becomes true. Strings in all 4 dictionaries.
5. **Tests**: unit `eligibility.test.ts` (cutoff boundaries, gender, missing-data, lenient parse); DB usecase `entrants-eligibility.test.ts` (422 with code + override + audit row + warning paths, patch/sync/squad-seed); extend team-squad/imports/registrations suites; lineup gate test; e2e over-age roster add → dialog → blocked without reason → succeeds with reason. Remove `design/v1/DEFERRED.md:82-84`.

No migration — rules stay in `divisions.eligibility` jsonb, audit reuses `competition_events`.

## Acceptance criteria

- [ ] All 7 gate points reject an over-age/wrong-gender person with 422 code `ELIGIBILITY_VIOLATION` (assert the **code**, never bare `{status: 422}`)
- [ ] Same request with `override.reason` succeeds and writes exactly one `eligibility.overridden` audit row naming actor + reason
- [ ] Missing dob/gender on organiser paths = amber warning, never a block; public submit still blocks
- [ ] `setTeamSquad` never hard-blocks (warnings only)
- [ ] Stripe-webhook materialise path unchanged (regression test)
- [ ] e2e: override dialog flow end-to-end
- [ ] `npm run openapi:gen` run and `openapi/*.json` committed (schemas.ts changed)
- [ ] i18n: new keys in all 4 dictionaries, `i18n:check` green
- [ ] Vitest counts pasted from `--reporter=json` output; dialog screenshot at desktop + 375px

## Gotchas

- `HttpError` asserts must pin the error **code** — a bare 422 is satisfied by every guard on the path (playbook §4).
- Roster persons often have null dob/gender (inline input captures `full_name` only) — that is the warning state, not a bug.
- `entrants-panel.tsx` strings feed e2e assertions — grep new/changed text across e2e specs before merge.

## Execution

Inline or single implementer→reviewer loop (one coherent file set — do **not** parallelise). Scout (sonnet) first to re-pin the line numbers above against current main. Load `superpowers:test-driven-development` before code; `frontend-design:frontend-design` for the dialog; verify per the index issue's standing rules (JSON-reporter vitest, `rtk proxy` lint, openapi drift, unrelated-failure skip note in PR).

## #413 — W2: date-constraint hardening

Wave 2 of #411. Design: `docs/superpowers/specs/2026-08-03-scoringpad-v2-design.md` (Part I, WS4). **Needs W1 merged first** — file-overlap sequencing on `schemas.ts`/`registrations.ts`, not a logical dependency.

Closes #407 WS4. Nothing constrains competition ⊇ division ⊇ schedule/fixture dates today; `ScheduleConfig.endAt` is never read server-side, so the auto-scheduler can run past the stated end.

## Why

Exactly two date validations exist in the whole platform: `opens_at < closes_at` (`registrations.ts:587`) and the runtime `windowOpen()` gate (:377). Divisions have **no date columns at all**. Policy per #407: **block with 422 + structured `extra.violations[]`** on shrinking edits (warn-only would persist an invalid hierarchy; the list lets forms deep-link offenders). Null division dates inherit the competition window.

## Changes

1. **Migration `db/migration/deltas/V345__division_dates.sql`** (verify V345 is still the next free number at execution time — renumber if the sequence moved): nullable `divisions.starts_on/ends_on date`, no backfill. Row-local CHECKs added `NOT VALID` then `VALIDATE` after a violation scan: `starts_on <= ends_on` on competitions and divisions; `opens_at < closes_at`, `refund_lock_at <= closes_at` on registration_settings. Hierarchy checks need joins → usecase layer only.
2. **Zod superRefines (`schemas.ts`)**: Create/PatchCompetition date order; Create/PatchDivision gain `starts_on/ends_on` + order refine; PutRegistrationSettings window order + refund-lock-within-window; ScheduleConfig `startAt<endAt`, blackouts/sessionWindows `from<to`, startWindows `notBefore<=notAfter`. AddFixture/PatchFixture stay format-only (cross-entity → usecase).
3. **New `server/usecases/date-bounds.ts`**: `divisionWindow(tx, divisionId) → {division, competition, effective}` (null-coalescing inherit); `assertWithin(label, atIso, bounds)` → `HttpError(422, …, "DATE_OUT_OF_RANGE", {violations})`; `dateShrinkViolations(tx, scope)` listing offending divisions/fixtures/schedule/registration rows for `DATE_RANGE_CONFLICT`.
4. **Usecase wiring**: `competitions.ts` patch (shrink checks divisions + fixtures; clearing to null allowed); `divisions.ts` create/patch (⊆ competition; shrink checks fixtures/schedule/registration); `registrations.ts` putSettings — `closes_at <= effective division start`, **exempt all-ladder/americano divisions** (late join is by design → warn only); `schedule.ts` config window ⊆ division window and **`toSlotConfig:319` derives `horizonMinutes` from `endAt`** so `calendar.ts:232` finally bounds auto-scheduling (overflow → existing `warn.no_slot`); `patchFixture` + `stages.ts:1417 addFixture` + `competition-schedule-apply.ts:441` call `assertWithin` on `scheduled_at`.
5. **Forms**: `competition-wizard.tsx:41-131`, `competition-settings.tsx:93-278` (min/max + violation rendering); `division-builder.tsx:743-761` + `division-settings.tsx` (new date inputs bounded by competition); `registration-settings.tsx:129-142,322` (closes_at max = division start); `board/settings-panel.tsx:175-182` + `schedule-board.tsx:350,688-702`. Strings in all 4 dictionaries.
6. **Tests**: zod unit per refine; date-bounds unit (coalescing, shrink listing); DB integration per rule — division outside competition; competition shrink vs existing fixture; addFixture past division end; tight `endAt` → `no_slot` instead of overflow; registration close-after-start rejected + ladder exemption honoured; migration violation-scan test.

## Acceptance criteria

- [ ] Division dates outside competition window → 422 `DATE_OUT_OF_RANGE` with violations naming the bound
- [ ] Competition shrink over an existing fixture → 422 `DATE_RANGE_CONFLICT` listing the fixture
- [ ] Auto-schedule with tight `endAt` produces `warn.no_slot`, never a slot past `endAt`
- [ ] Registration close-after-division-start rejected; same config on an all-ladder division only warns
- [ ] Null division dates behave as competition window everywhere (`effective` tested)
- [ ] CHECKs land `NOT VALID`→`VALIDATE`; migration applies on a copy with pre-existing violating rows (scan test)
- [ ] `npm run openapi:gen` + commit (schemas changed); i18n ×4 green; forms screenshot desktop + 375px
- [ ] Vitest counts pasted from JSON reporter

## Gotchas

- `db:apply` is Flyway — test against the ephemeral PG on :54329 with `DB_SCHEMA` set (unset under-reports, memory `local-test-db`); fresh schema needs `db:apply` **and** `sync:sports`.
- Load `supabase:supabase-postgres-best-practices` before writing the migration.
- Symmetric fixtures can't catch first-row-wins bugs in `dateShrinkViolations` — parameterise the windows.
- Form min/max is a hint, not the gate — every rule needs its server-side 422 test.

## Execution

Inline or single implementer→reviewer loop (schemas + usecases + forms interlock — no parallel agents). Scout (sonnet) re-pins line numbers and confirms the next migration number. TDD skill first; frontend-design for form states; standing rules from the index issue apply.

## #414 — W3: formats / qualification

Wave 3 of #411. Design: `docs/superpowers/specs/2026-08-03-scoringpad-v2-design.md` (Part I, WS3). No dependencies — safe in parallel with W1/W2 and W4+ (disjoint engine dirs).

Closes #407 WS3. Owner decision: qualification must work **out of every stage kind** — brackets by placements (including losers, for plates), americano by personal points, ladder by ladder order — into any next stage.

## Why

The engine's `StageKind` (`packages/engine/src/core/types.ts:37-45`) is missing `americano`, `ladder`, `page_playoff` — papered over by a lying cast at `engine-db/competition.ts:104`. `stages.ts:1192-1198` throws "qualification from a bracket stage is not supported yet", so KO→plate and qualifying-KO→main don't exist. Ladder has zero engine unit tests; americano only indirect; page_playoff layout-only.

## Changes

1. **Enum drift**: add the three kinds to `StageKind` (`core/types.ts:37-44`); widen `BracketStage.kind` (`competition/stage.ts:71`) to include `page_playoff`. `TableStage` stays league|group|swiss (americano→league adapter mapping stands). Delete the cast at `engine-db/competition.ts:104`.
2. **Qualification extensions** (`competition/qualification.ts`, all pure): `StageTables` gains optional `bracket?: BracketFixture[]`; new spec `RoundLosers {from?, losersOfRound: {round, count?}}` in `QualificationSpec` + `qualificationSize` + `resolveQualification` — losers of bracket round R ordered by bracket position then seed, `STAGE_NOT_READY`/`QUALIFICATION_INVALID` errors, composing inside `combine` (dedupe exists). New `placementTable(finalRanks) → PoolTable` so `topN` works over bracket placements unchanged.
3. **Completion writes placement snapshots for every kind** (`engine-db/competition.ts:270-331`): bracket branch rebuilds `BracketFixture[]` from `outcome` jsonb (winner/loser; lane/thirdPlace recovered from `ext_key`), calls `bracketRanks` (`stage.ts:278` — already handles losers/3rd-place/DE-reset/page-playoff) → full `finalRanks` + `writeSnapshot(placementTable(...).rows)`. New ladder branch: complete when zero open fixtures, `finalRanks = config.ladder_order`. Americano display snapshot unchanged.
4. **`seedNextStage`** (`server/usecases/stages.ts:1176-1273`): delete the :1192-1198 throw; route by source kind — table/bracket/ladder read the now-written snapshot; `losersOfRound` additionally loads source fixtures into `tables.bracket`; americano ranks by personal points — extract shared `americanoLeaderboard` from `usecases/americano.ts:85-98`, map person→individual entrant. Carry-over guard (`points.ts:164`): only from true table kinds.
5. **Schemas/UI**: `RoundLosersS` added to `QualificationSpecSchema` union (`schemas.ts:439-468`); `qualifierCount` (`stages.ts:677`) handles it. New templates in `components/v2/format-templates.ts`: `ko_plate` (main KO → plate via `losersOfRound:{round:1}`) and `qualifying_main` (KO → KO topN); extend `detectTemplate`. Template names/descriptions in all 4 dictionaries.
6. **Tests**: engine — new `scheduling/americano.test.ts`; `qualification.test.ts` additions (losersOfRound, topN-over-placements, combine dedupe); `stage.test.ts` (page_playoff/stepladder/DE-reset bracketRanks). Server DB integration — KO→plate, qualifying-KO→main, americano→KO, ladder→KO, ladder refuses completion with an open challenge, auto-advance through a bracket source, league→KO regression. Revisit `skipIf(!HAS_DB)` format tests where a pure path now exists.

No migration.

## Acceptance criteria

- [ ] `StageKind` complete; no cast at `engine-db/competition.ts:104`; tsc green (`EXIT=0` written by the command itself)
- [ ] KO→plate: losers of round 1 seed the plate in bracket-position order
- [ ] Qualifying KO→main via `topN` over placements; americano→KO by personal points; ladder→KO by ladder order
- [ ] Ladder stage with an open challenge refuses completion (`STAGE_NOT_READY`)
- [ ] Every stage kind writes a placement snapshot at completion (one test per kind)
- [ ] Both new templates create + `detectTemplate` round-trips them
- [ ] `npm run openapi:gen` + commit (QualificationSpec union changed)
- [ ] Engine purity gate green (`scripts/engine-boundary.ts`); vitest counts from JSON reporter
- [ ] Templates picker screenshot desktop + 375px

## Gotchas

- Bracket rounds number sparsely (1,2,3 winners / 7-10 losers / 14 grand final) — round numbers are display labels; ordering authority is bracket wiring, never arithmetic on `round`.
- `ext_key` is the only place lane/thirdPlace survive — parse, don't re-derive.
- Absolute-count DB tests flake under file-parallel sweeps — rerun alone before treating red as regression.

## Execution

Engine steps 1–4 then server/UI 5–6; inline or one sequential implementer→reviewer loop (shared `stages.ts` forbids parallel). Scout (sonnet) re-pins all line refs first. TDD skill before code; standing rules from the index issue apply.

## #415 — W4: sport domain audit

Wave 4 of #411. Design: `docs/superpowers/specs/2026-08-03-scoringpad-v2-design.md` (Part II, "sport domain audit"). No dependencies; W5 and W6 build on this wave.

The owner's core ruling: **not only the UI layer**. Whether a sport's schemas can even represent what a real scorebook records has never been verified — cricket is the best case and still unproven; the other ten modules are unaudited. This wave establishes and closes the Layer-1 gap: `sport reality ⊇ eventSchema/Cfg`, per sport, per variant.

## Why

The pad can only feed what the schema can hold. Cricket's config is rich (`CricketCfgBase`, `sports/cricket/cricket.ts:29-56`: DLS, follow-on, super over…) but the event side (`'cricket.ball'`) may lack dismissal-mode detail, fielder credit on catches/run-outs, the extras breakdown, free-hit state, review outcomes. The entrant-only families (setbased/nested/boardgame/carrom/generic) cannot attribute any event to a person — the root cause of `requires_detailed_scoring` for 8 of 11 sports. Every extension here is a **payload/config shape** change only: `score_events.payload` is jsonb, no ledger migration exists or is allowed.

## Changes

1. **Domain dossier per sport** — new `packages/engine/src/sports/<key>/DOMAIN.md` ×11. For each: enumerate the sport's scorable facts from its laws and standard scorebook conventions (events, participants-in-event, states, config knobs), **per declared variant** (t20 vs test differ; classical vs blitz differ). Map every fact to its schema path (`Cfg`/`Ev`/`State`/`summary`/`metrics`) or classify: **gap → extend now** (additive) or **deferred** (reason stated: niche / wrong fidelity / needs product decision). A mapping table is mandatory; the audit PR review is where dossier truth is established.
2. **Schema extensions** for every "extend now" line: additive optional fields/branches on `eventSchema`/`configSchema`, fold + `summary` updated so new events change state meaningfully, **minor version bump per touched module** — divisions pinned to older versions must keep folding (additive-only rule; never a required field, never a removed branch).
3. **Person attribution fields** across the entrant-only families: optional PersonId fields (`by`, `assist`, sport-specific participants — e.g. fielder on a cricket dismissal, scorer/assist split already present in period sports). Cricket names the pattern; extend it wherever the dossier shows a person participates in an event.
4. **Conformance kit**: assert every builtin module ships `DOMAIN.md` containing a mapping table; regenerate/extend event streams so new branches are exercised; existing conformance stays green for old streams (back-compat proof).
5. **No UI in this wave.** The enriched vocabulary reaches scorers in W5/W8+.

## Suggested internal split (the one place parallel agents are correct)

Per-family agents own provably disjoint dirs: {cricket}, {football}, {setbased kernel + volleyball/badminton/tabletennis + tennis via nested kernel}, {period kernel + icehockey/hockey}, {boardgame}, {carrom}, {generic}. Kernel edits stay inside the family that owns the kernel — that is why the racquet trio and tennis travel together. `sport/module.ts` and the conformance kit are shared: single inline pass after the family agents land.

## Acceptance criteria

- [ ] 11 `DOMAIN.md` dossiers with mapping tables; every row is `modelled`, `extended`, or `deferred + reason` — no blank cells
- [ ] Cricket dossier explicitly resolves (at minimum): dismissal modes incl. fielder credit, extras breakdown, free hit, reviews, powerplay, retired/returned, declaration, new ball — each modelled, extended, or deferred with a stated reason
- [ ] Every extension is additive + optional; per-module minor version bumps; old-stream conformance green (back-compat)
- [ ] Entrant-only families accept optional PersonId attribution and fold it without error
- [ ] Fold/summary reflect new events (a test per new branch that fails without the fold change)
- [ ] Engine purity gate green; conformance asserts DOMAIN.md presence; vitest counts from JSON reporter
- [ ] No web-side files touched; no api-v1 change (engine payloads are opaque jsonb) — verify `git diff --stat` confirms engine-only

## Gotchas

- The additive rule is absolute: a required field or renamed branch breaks pinned divisions' folds silently — the conformance back-compat stream is the tripwire, keep it honest.
- Family agents must not "clean up" shared kernels beyond their family's needs — name the blast radius in each brief.
- Dossier research is knowledge work: write facts a scorebook records, not broadcast trivia; when a fact's fidelity is debatable, prefer `deferred + reason` over speculative schema.

## Execution

This wave is the worked example of parallel dispatch: per-family `implementer` agents (disjoint dirs, briefs per playbook §2 with output caps), then one inline pass for shared files, then `reviewer` over the whole diff. Scout (sonnet) first to map each family's current schema surface. TDD skill before code; standing rules from the index issue apply.

## #416 — W5: PadSpec contract + conformance

Wave 5 of #411. Design: `docs/superpowers/specs/2026-08-03-scoringpad-v2-design.md` (Part II, "PadSpec contract"). **Needs W4** (specs describe the audited, enriched schemas). W6 waits on this wave (same module files); W8 builds on it.

The contract at the heart of ScoringPad v2: each module declares its scoring surface as data, and CI proves the declaration covers everything the module can accept — per variant.

## Why

Eight hand-written pads each expose the subset of `eventSchema` their author thought of, and nothing checks coverage. Making coverage a **conformance property** inverts that: a sport module without a complete pad declaration fails CI, and a new sport is scoreable with zero web-side work.

## Changes

1. **`PadSpec` types in `packages/engine/src/sport/module.ts`** and new field `padSpec(cfg: Cfg): PadSpec` on `SportModule` — a pure function of resolved config (base ⊕ variant preset ⊕ org overrides), data only, no React, no display strings:
   - **phases** `pre` / `live` / `post` — pre-match setup events (toss, serve order, colour, lineup confirm), live scoring, post-match (`postDecisionTypes`, result confirmation).
   - **panels** — named ordered action groups, layout hints (`primary|grid|drawer|perSide`), optional gate predicates over folded `state`/`summary` (super-over panel appears when reachable).
   - **actions** — 1:1 with an `eventSchema` union branch: event `type`; parameter fields (enums/numbers/toggles) with bounds derived from `cfg` (`ballsPerOver`, best-of…); attribution requirement `none | side | person(role?) | persons(n)`; stable `labelKey` following the existing scoring-vocab pattern (engine declares keys + fallback labels, web dictionaries translate — see `docs/superpowers/specs/2026-07-16-scoring-vocab-i18n-design.md`).
   - **fidelity tiers** — `quick` (result-only) / `standard` (structured) / `full` (everything, person-attributed), formalising `fidelityTiers` already on `SportInfo` (`fixture-console.tsx:132`).
2. **`padSpec` on all 11 modules**, per-variant correct: cricket (over rhythm, extras, dismissals with fielder, reviews, super over, DLS panel when `dls.enabled`), football (goals/cards/subs/period flow), racquet+setbased family, period family, boardgame (result + clock/forfeit + colour pre-match), carrom, generic. The W4 dossier is the checklist — every non-deferred fact reachable.
3. **Conformance kit — padSpec block** for every builtin module × **every declared variant**: (a) every `eventSchema` union branch reachable from some action (full tier hides nothing); (b) every action property-generates payloads `eventSchema` accepts across parameter bounds; (c) label keys unique + stable; (d) tiers nest `quick ⊆ standard ⊆ full`; (e) `DOMAIN.md` present (from W4). Plus: `padSpec(cfg)` is deterministic for a given cfg and never throws across all variant presets + generated org-override perturbations.

Engine-only wave: no web files, no api-v1 change, no migration.

## Acceptance criteria

- [ ] All 11 modules declare `padSpec`; conformance padSpec block green for every module × variant
- [ ] Deleting any single action from any module's spec makes conformance fail (mutation-check one example per family, backup/`cp` restore — never `git checkout` on uncommitted work)
- [ ] An action emitting a payload outside `eventSchema` is impossible by construction or caught by the property test
- [ ] Variant reshaping proven: `t20` vs `test` produce different panels/bounds from the same module; `hundred` honours its ball structure
- [ ] Tier nesting holds; `quick` alone suffices to reach a decidable result for every sport (a result-only scorer is never stuck)
- [ ] Engine purity gate green; tsc `EXIT=0`; vitest counts from JSON reporter
- [ ] No `apps/web` diff (`git diff --stat` engine-only)

## Gotchas

- `padSpec` renders from the **pinned** module version at runtime (division semver pin) — keep the function total for every cfg its `configSchema` accepts, not just the presets.
- Label keys are API the moment they ship (dictionaries + tests will anchor on them) — choose the scoring-vocab naming convention, don't invent a second one.
- Gate predicates run in the browser later: pure data + serialisable predicate forms only, or the engine purity gate and W8 both break.

## Execution

Same family split as W4 is available, but the shared types in `sport/module.ts` and the conformance block come first inline, then families in parallel only if dispatched with disjoint dirs; otherwise one sequential implementer→reviewer loop. Scout (sonnet) to locate the conformance kit + streams layout before briefing. TDD skill before code; standing rules from the index issue apply.

## #417 — W6: player-stat models

Wave 6 of #411. Design: `docs/superpowers/specs/2026-08-03-scoringpad-v2-design.md` (Part I, WS2 + the prefer-person-fields decision). **Needs W5 merged** (W5/W6 both edit every module file + conformance kit; logically this wave needs only W4's attribution fields).

Closes the engine half of #407 WS2: `playerStats` exists only for football/hockey/icehockey; cricket, tennis, setbased, carrom, boardgame (chess), generic show `requires_detailed_scoring` instead of stats.

## Why

`PlayerStatMetric` (`packages/engine/src/stats/stats.ts:7`) reads flat payload fields holding PersonIds — fine for the three period sports, useless for families that attribute to EntrantIds (setbased `rally.wonBy`, nested `point.by`, boardgame `result.winner`, carrom, generic). W4 added optional explicit PersonId fields; the owner decision: **prefer explicit person fields when a payload carries them, fall back to entrant→person resolution otherwise** — v1-era events keep producing stats, v2-pad events sharpen them.

## Changes

1. **Stats core (`stats/stats.ts`)**: dot-path support in `field`/`sumField`; `value?: (payload) => number|undefined`; `fromEntrant?: boolean`; new `PlayerStatsFoldCtx {entrants, personsOf(entrantId), cfg}`; `PlayerStatsModel` gains `folded?: {keys, fold(events, ctx) → PlayerStatRow[]}` merged with metric rows. Resolution order per event: explicit PersonId field → `personsOf(entrantId)` for `individual`/`pair` entrants → unattributed. Back-compat signature (existing three sports untouched semantics).
2. **Kernel-level models** (many sports at once, no drift): default `playerStats` built inside `setbased/kernel.ts` + `nested/kernel.ts` factories (period-kernel precedent) — `matches`, `sets_won/lost`, `points_won` (+ `games_won` nested, `aces` tennis). Team-sized entrants → `personsOf` returns `[]` → existing `requires_detailed_scoring` messaging stands.
3. **Per-sport models**: cricket — `runs`, `balls_faced`, `fours/sixes`, `wickets`, `runs_conceded`, `catches`, `dismissals`, reading the W4-enriched ball payloads (fielder credit → catches; dismissal detail → dismissal splits) with coarse `player_line` mirror keys for v1-era events; boardgame/chess — folded `games/wins/draws/losses` + white/black splits, forfeit handling; carrom — `boards_won`, `queens`, folded matches/wins; generic — folded W/D/L + points_for.
4. **Conformance — playerStats block across all 11 modules**: any module with `playerStats` must aggregate generated streams without throwing, deterministic rows, unique keys; void events un-count; mixed streams (v1-era entrant-only + v2 person-attributed) produce consistent totals.

Engine-only, read-side projection: **no module-version bumps for models, no migrations** — snapshots self-backfill via recompute-on-read (`usecases/player-stats.ts:29` deletes+refolds per division).

## Acceptance criteria

- [ ] All 11 modules declare `playerStats`; conformance playerStats block green ×11
- [ ] Explicit-person event beats `personsOf` fallback when both resolve (test with conflicting attribution)
- [ ] v1-era streams (no person fields) still produce rows for individual/pair entrants via `personsOf`
- [ ] Cricket: fielder-credited catch and dismissal-mode splits appear from enriched payloads; v1-era `player_line` mirror still counts
- [ ] Boardgame forfeit + colour splits correct; void events un-count everywhere
- [ ] Deterministic: same stream folds to identical rows twice (property test)
- [ ] Engine purity gate green; vitest counts from JSON reporter; no `apps/web` diff

## Gotchas

- Fold ctx is data + callbacks only — the engine purity gate breaks on anything else.
- `folded` rows and metric rows merge on key — key collisions between the two paths are the drift to test for, not just uniqueness within one path.
- Team-entrant sports legitimately return `[]` from `personsOf` — that is the designed no-stats state, don't "fix" it by attributing to the whole roster.

## Execution

Core (step 1) inline first — everything depends on its types; then kernels/per-sport models via the W4 family split if dispatched disjoint, else one implementer→reviewer loop. Scout (sonnet) re-pins stats.ts and kernel factories. TDD before code; standing rules from the index issue apply.

## #418 — W7: career rollup

Wave 7 of #411. Design: `docs/superpowers/specs/2026-08-03-scoringpad-v2-design.md` (Part I, WS2 web half). **Needs W6.** Safe in parallel with W8+ (disjoint trees: `/me` + persons routes vs `scorepad/`).

Closes the web half of #407 WS2: stats are per-division only — a player linked to multiple sports has no career view, and the plumbing can't resolve entrant-attributed events to persons.

## Why

`personStats` returns a per-division list only; `/me` (`apps/web/src/app/me/page.tsx:293`) shows per-division metric tiles and nothing cross-sport. `recomputePlayerStats` doesn't build the `personsOf` context W6 requires, so the new models never see entrant members.

## Changes

1. **Server plumbing**: `recomputePlayerStats` (`server/usecases/player-stats.ts`) loads lineup entrants + division config + entrant members to build `PlayerStatsFoldCtx.personsOf` (credit `individual`/`pair` entrant members only), passes resolved `cfg`.
2. **Career rollup**: new `personCareerStats(auth, personId)` grouping snapshots by `divisions.sport_key`, summed via `sumPlayerStats` + `registry.latest().playerStats` metric metadata; exposed as `?group=sport` on the existing persons-stats route. `usecases/me.ts` gains `listMyCareerStats(userId)`.
3. **`/me` Career section** (testid `me-career`): one card per sport with metric tiles, per-sport variant count + matches; empty state when a person has stats in zero sports. Public player card gets a per-sport rollup **scoped to that competition** — cross-org totals stay private to `/me` (consent posture unchanged).
4. **i18n**: new chrome keys in all 4 dictionaries; metric labels stay engine-declared per the existing pattern.
5. **Tests**: DB — career rollup for a person in 2+ sports across 2+ divisions (asymmetric fixtures: different sports, different metric sets, different divisions counts); `personsOf` credit rules (team entrants excluded); consent gate on the public card (competition-scoped only — assert the cross-org number is absent, anchoring on `="` per the RSC serialisation trap); route test for `?group=sport`.

## Acceptance criteria

- [ ] A person in 2+ sports sees one Career card per sport on `/me` with correct summed metrics
- [ ] Team-entrant divisions contribute no phantom person rows
- [ ] Public player card shows only competition-scoped rollups; cross-org totals absent (assertion anchored on `="`, not a bare `data-*` probe)
- [ ] `?group=sport` documented: `npm run openapi:gen` run + `openapi/*.json` committed (route schema changed)
- [ ] i18n ×4 + `i18n:check` green; `/me` Career screenshot desktop + 375px, no horizontal scroll
- [ ] Vitest counts from JSON reporter; suites named with paths that exist (positionals are filename filters — a typo runs a subset green)

## Gotchas

- Recompute-on-read deletes+refolds per division — career sums must read snapshots, not trigger N recomputes per page view; verify query count.
- Asymmetric test fixtures are mandatory: two identical divisions cannot catch first-row-wins or wrong-group-by bugs.
- `/me` strings feed e2e — grep changed text across e2e specs (both phases) before merge.

## Execution

Inline or single implementer→reviewer loop (plumbing + route + UI interlock). Scout (sonnet) re-pins `player-stats.ts`, `me.ts`, persons routes. TDD before code; `frontend-design:frontend-design` for the Career section; Playwright MCP screenshots; standing rules from the index issue apply.

## #419 — W8: chassis + universal renderer

Wave 8 of #411. Design: `docs/superpowers/specs/2026-08-03-scoringpad-v2-design.md` (Part II, "Chassis" + "Universal renderer"). **Needs W5.** Safe in parallel with W7. Flag stays off — no dispatcher changes in this wave.

The greenfield pad: a new `apps/web/src/components/v2/scorepad/` tree. Headless chassis (pipeline, offline queue, timeline, attribution) plus the universal renderer that executes any PadSpec. v1 pads untouched.

## Why

v1's chassis is three in-memory retries and a resync (`device-score-pad.tsx:107-135`) — tab death courtside loses the queue. And v1 has no renderer concept at all: every sport's UI is hand-written, so the W4/W5 enrichment would otherwise wait on eight rewrites. One renderer makes every sport scoreable the day its module lands.

## Changes

1. **Pipeline (headless hook layer)**: append `{expected_seq, type, payload, idempotency_key}` → `POST /api/v1/fixtures/[id]/events`; 409 SEQ_CONFLICT → `since_seq` resync; optimistic local fold using the module's fold (engine is pure — runs in the browser); reconcile optimistic state against server `match_states` on every ack.
2. **Offline queue**: pending events in IndexedDB keyed by `idempotency_key`, survives tab death/reload, replays in order renegotiating `expected_seq`; visible queue depth + explicit "offline — keep scoring" UI state. Hash chain stays server-side; client preserves only order + idempotency.
3. **Timeline**: full event list with fold-derived captions, `core.void` undo, void+re-append correction flow, per-event attribution display, `recorded_by`/`device_link_id` provenance.
4. **Attribution picker**: lineup-aware person chips (squad number, position, captain) honouring PadSpec requirements (`none|side|person(role?)|persons(n)`); side-only fallback when no roster exists — never blocks the action.
5. **Contexts**: works under both auth modes — authed console and device-link token (`/score/[token]`) — and both transports: Supabase realtime channel `fixture:{id}` where entitled, 15s polling fallback (load `supabase:supabase` skill before the realtime hook).
6. **Variant resolution**: server passes resolved `cfg` (base ⊕ variant preset ⊕ org overrides from `sport_variants`) and the division's **pinned** `module_version`; pad renders the pinned module's `padSpec(cfg)`, never latest.
7. **Universal renderer**: walks PadSpec — phase navigation (pre/live/post), panels as button grids/forms sized for courtside use, action parameter entry with cfg-derived bounds, gate predicates over folded state, fidelity switcher (tier per fixture; mid-match upgrade allowed, downgrade warns), i18n via dictionary keys with engine `labelKey` fallback. 375px-first.
8. **Tests**: queue replay order + tab-death survival (fake IndexedDB); 409 recovery; optimistic-fold vs server-fold equivalence (same events, same state, per family); double-fire idempotency; renderer component tests per phase/tier over 2+ contrasting sports (cricket, boardgame); picker requirement matrix.

No dispatcher/route changes; v1 pads and both entry points behave exactly as today. New strings ×4 dictionaries.

## Acceptance criteria

- [ ] Kill the tab mid-queue, reopen: queued events replay in order, none duplicated (idempotency proven), scorer sees queue depth throughout
- [ ] Airplane-mode scoring continues; reconnect drains the queue; 409 mid-drain resyncs and completes
- [ ] Optimistic fold equals server fold for generated streams across all families (property test)
- [ ] Renderer reaches every action of every module × variant (drive it from the W5 conformance fixtures — full tier, both contexts)
- [ ] Tier switch mid-match: upgrade keeps state; downgrade warns and hides, never deletes
- [ ] i18n ×4 green; renderer screenshots (cricket + generic sport) desktop + 375px, no horizontal scroll
- [ ] Vitest counts from JSON reporter; no changes outside `scorepad/` + dictionaries (`git diff --stat`)

## Gotchas

- The engine import into the browser bundle must stay pure — no server-only imports leak through the fold path; check bundle doesn't pull `engine-db`.
- `expected_seq` renegotiation after resync is the correctness heart: replay must re-read server seq, not trust the queue's stale value.
- Realtime is entitlement-gated with device-link bypass — the hook must degrade to polling without user-visible errors on Community plans.

## Execution

Chassis (1–6) then renderer (7); inline or one sequential implementer→reviewer loop — single new tree, no parallel agents. Scout (sonnet) first: flag/env conventions, realtime token route shape, existing fold-in-browser precedents. Load `frontend-design:frontend-design` before renderer work; `supabase:supabase` before the realtime hook; TDD throughout; standing rules from the index issue apply.

## #420 — W9: sport skins

Wave 9 of #411. Design: `docs/superpowers/specs/2026-08-03-scoringpad-v2-design.md` (Part II, "Universal renderer and skins"). **Needs W8.**

Skins for the marquee sports: cricket, the racquet family (tennis + setbased as one skin with config-driven differences), football. Layout craft only — same PadSpec, same chassis dispatch, no new events.

## Why

The universal renderer guarantees coverage, not ergonomics. A cricket scorer thinks in overs and needs the over's rhythm on screen; a tennis scorer thinks in points-within-games-within-sets; a football scorer needs the clock and two big goal buttons. These three families carry the platform's real match volume — they earn hand-crafted layouts. Everything else stays on the universal renderer deliberately.

## Changes

1. **`scorepad/skins/cricket-skin.tsx`**: over-rhythm primary surface (this over's balls, extras drawer, dismissal flow with fielder attribution, free-hit state), innings header (score/wickets/overs, DLS par when `dls.enabled`), variant-aware (t20/odi/hundred/test panels from `padSpec(cfg)` — the hundred's ball structure honoured, follow-on/declaration where the variant allows).
2. **`scorepad/skins/racquet-skin.tsx`**: point-first layout (server marked, rally winner tap, ace/fault where the spec declares them), set/game scoreboard, tiebreak state, config-driven differences (best-of, points-to, golden point) — one skin serving tennis + volleyball/badminton/tabletennis.
3. **`scorepad/skins/football-skin.tsx`**: clock + period control, goal/assist attribution flow, cards + subs drawers, period sports (icehockey/hockey) evaluated for reuse — if the period kernel's spec shapes match, one skin serves all three; otherwise football-only and the period pair stays universal (record the decision in the PR).
4. **Skin registry contract**: a skin consumes `{padSpec, chassis}` and may render only actions the spec declares. **Skin-coverage test**: every skin reaches the same action set as the universal renderer for its sports × variants (drive from W5 conformance fixtures); a skin hiding an action fails CI.
5. **i18n** ×4 for any skin-specific chrome; action labels keep coming from `labelKey` dictionaries.

No dispatcher/route changes; flag still off.

## Acceptance criteria

- [ ] Skin-coverage test green: cricket/racquet/football skins reach every spec action for every variant
- [ ] Cricket skin: full over scored with extras + a fielder-credited dismissal in ≤ the tap count of v1 (count it, put the number in the PR)
- [ ] Racquet skin serves all four racquet/net sports with correct config-driven differences (best-of switch changes the scoreboard)
- [ ] Football skin: goal with assist attribution, card, sub — each ≤ 3 taps from the live surface
- [ ] Skins render both auth contexts (console + device link) without layout drift
- [ ] Screenshots per skin: desktop + 375px, no horizontal scroll — attach to PR
- [ ] i18n ×4 green; vitest counts from JSON reporter; diff confined to `scorepad/skins/` + registry + dictionaries

## Gotchas

- A skin inventing an event type or bypassing chassis dispatch is the failure mode this architecture exists to prevent — the coverage test is the gate, review enforces the dispatch path.
- 375px is the primary scoring surface in the real world (phone courtside) — design mobile-first, desktop is the adaptation.
- Load `frontend-design:frontend-design` **before** any skin work, not after: these three screens are the product's face on match day.

## Execution

Three skins are provably disjoint files — parallel `implementer` agents are acceptable with the standard brief (paths, criteria, don't-touch: chassis/renderer/other skins, verify command, output cap); the skin-coverage test + registry land inline first so agents build against it. `reviewer` over the combined diff. Screenshot-verify via Playwright MCP at both breakpoints; standing rules from the index issue apply.

## #421 — W10: integration behind flag

Wave 10 of #411. Design: `docs/superpowers/specs/2026-08-03-scoringpad-v2-design.md` (Part II, "Rollout"). **Needs W9.**

Integration behind a flag: one registry feeds both entry points, killing the dual dispatcher. v1 remains the default; v2 must be fully working end-to-end before W11 flips anything.

## Why

Two near-duplicate dispatchers pick the pad today — `fixture-console.tsx:226-231` (+ render switch ~:316) and `device-score-pad.tsx:59-63,268-283` — with no drift guard, plus a third hardcoded key list in `scoring-vocab.ts:15-17`. #407 WS2 step 6 wanted a PAD_FOR registry over v1; this wave supersedes that with the v2 registry.

## Changes

1. **`scorepad/registry.tsx`**: resolves `sportKey → skin | universal` and owns `<ScorePad/>`; compile-time completeness against the engine's module keys (drift-guard test: every `module.key` in `builtinModules` resolves — a new engine sport without a registry decision fails CI, defaulting to universal is the decision).
2. **Flag**: scout the repo's existing feature-flag convention first and follow it (env-based expected). `scorepad_v2` off by default; when on, **both** entry points — `FixtureConsole` (authed) and `/score/[token]` (device link) — render `<ScorePad/>` with the server-loaded payload (fixture, resolved cfg + pinned module version, sides incl. members/lineup, initial state/events, console extras). When off, v1 paths byte-identical (no behaviour change flag-off is the review bar).
3. **Server payload**: extend the two loaders to pass resolved variant cfg + pinned module version (W8's resolution contract) without breaking v1 props. If any api-v1 zod schema moves, openapi drift rules apply.
4. **e2e (flag on, local only)**: console path — score a cricket fixture pre→live→post including an attributed dismissal and a void/correction; device path — claim link, score offline (context-level network kill), reconnect, drain queue, finalize; both assert the public page's summary updates (poll fallback). Desktop + 375px screenshot passes over both entry points.
5. **Cleanup prep**: inventory every import of v1 pads + dispatcher branches (the W11 deletion list), committed as a checklist in the PR body.

## Acceptance criteria

- [ ] Flag off: zero behavioural diff on both entry points (e2e smoke of v1 paths still green, byte-level review of the two dispatch sites)
- [ ] Flag on: both entry points fully scoreable via v2 for all 11 sports (drift-guard + one e2e per entry point)
- [ ] Offline e2e: kill network mid-match on the device path, keep scoring, reconnect, queue drains, server state converges (assert final `last_seq` + summary)
- [ ] Registry drift-guard test fails when a module key lacks resolution
- [ ] Local e2e run via prod build + `E2E_PROD_TARGET` on :3100 (`whsec_e2e_payments` set — payments suites fail without it); **never enable `.github/workflows/e2e.yml`**
- [ ] openapi drift handled if schemas moved; i18n ×4 for any new chrome; vitest + e2e counts pasted
- [ ] Screenshots both entry points, both breakpoints, attached

## Gotchas

- e2e `newContext` without options inherits the authed storageState — the device-link spec must build an explicit fresh context or it tests the wrong auth mode (memory: invite auto-login lesson).
- UI text in v2 that duplicates v1's e2e-anchored strings will break v1 assertions while the flag is off — grep e2e specs (both phases) for any shared text before merge.
- Next dev server dies under rtk (memory) — use the prod-build e2e recipe, and `rm -rf .next` after a killed dev server if 404s appear.

## Execution

Inline or single implementer→reviewer loop — the two dispatch sites + registry interlock; no parallel agents. Scout (sonnet): flag convention, both loaders' current prop shapes, v1 import inventory. TDD; `frontend-design` not needed (no new visual surface beyond wiring); Playwright MCP for screenshots; standing rules from the index issue apply.

## #422 — W11: cutover

Wave 11 of #411 — the cutover. Design: `docs/superpowers/specs/2026-08-03-scoringpad-v2-design.md` (Part II, "Rollout"). **Needs W10.** Closes the programme; #407 can close when this merges.

Default on, delete v1, ship the paper: no parallel-forever, no dead code left as "reference".

## Why

A flag that never flips is a second dispatcher with better marketing. W10 proved v2 end-to-end behind the flag; this wave makes it the only path and pays the closing costs every branch owes (help, smoke, i18n audit).

## Changes

1. **Flip + delete**: remove the flag entirely (not default-on — gone); delete `apps/web/src/components/v2/pads/{cricket,football,setbased,tennis,period,boardgame,generic,carrom}-pad.tsx`, the v1 dispatch branches in `fixture-console.tsx` and `device-score-pad.tsx`, and every import the W10 inventory listed. `scoring-vocab.ts:15-17`'s hardcoded key union: derive from engine module keys or add a drift test — no third list survives.
2. **e2e re-anchor**: v1-pad-anchored selectors/text across both e2e phases updated to v2 surfaces (grep the deleted components' testids/strings across `e2e/` before deleting — memory: UI text changes break e2e).
3. **Help pages**: `content/help/**` (English tree only, no i18n owed) — scoring a match with v2: choosing fidelity tier, pre-match setup, attribution, offline behaviour, corrections/void, device-link handoff. Update any existing scoring help that shows v1.
4. **Smoke**: extend `scripts/smoke.ts` pro + free paths — score a fixture via the v2 append path to a decided result (fidelity `quick` is the designed minimal path).
5. **Final audits**: `i18n:check` + gen-keys across the whole scorepad tree; a11y pass on the live surface (focus order, hit targets, contrast — courtside sunlight is the use case); `/admin` untouched (staff-only bar).
6. **Full local verification** before the PR: complete unit sweep (JSON reporter), lint via `rtk proxy`, tsc with `EXIT=$?`, prod-build e2e both phases, openapi drift if anything moved.

## Acceptance criteria

- [ ] No file imports a v1 pad; the eight components are gone; `git grep -a` (binary-mask trap) for each deleted component name returns nothing
- [ ] Exactly one sport-key list survives (engine) or a drift test pins any projection of it
- [ ] Both e2e phases green locally on the prod build, counts pasted; no assertion references a deleted surface
- [ ] Help tree covers v2 scoring end-to-end; no v1 screenshots/steps remain
- [ ] `smoke.ts` scores through v2 on both pro and free paths
- [ ] i18n ×4 audit green; final screenshots (console + device pad, desktop + 375px) attached
- [ ] PR body: full gate outputs + the W10 inventory checklist all ticked

## Gotchas

- Deletion order: re-anchor e2e first, delete second — or every intermediate commit is red.
- `git checkout <file>` on uncommitted work restores the index and deletes the implementation (playbook §4) — during the deletion sweep, verify with `cp` backups.
- Help-tree edits owe no i18n, but any new in-app string does — the boundary is `content/help/**` exactly (memory: help-tree-english-only).

## Execution

Inline or single implementer→reviewer loop; deletion sweeps don't parallelise. Scout (sonnet): grep sweep of v1 references + e2e anchors before touching anything. `superpowers:verification-before-completion` is the closing skill — every claim in the PR body carries its command output. Write programme memory (decisions + gotchas discovered) and run `scripts/agent-memory-snapshot.sh` at close; standing rules from the index issue apply.
