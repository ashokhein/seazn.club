# L3 — #414 (W3): formats — placement snapshots and qualification from every stage kind

Paste this whole file as the session opener. Read `_RULES.md`, then `_INDEX.md`,
then this. Engine + server + a little UI.

Branch `feat/l3-w3-formats` in a fresh worktree. One PR. Issue #414.
Design: `../2026-08-03-scoringpad-v2-design.md` (Part I, WS3). Closes #407 WS3.

No dependencies — disjoint from both the S-chain and L1/L2 (different engine
dirs), but it does touch `stages.ts`, so it must be **single-writer** on that
file. Check `_INDEX.md` before running it alongside anything else.

## Why

Owner decision: qualification must work **out of every stage kind** — brackets by
placements (including losers, for plates), americano by personal points, ladder
by ladder order — into any next stage.

Today the engine's `StageKind` (`packages/engine/src/core/types.ts`, re-pin) is
missing `americano`, `ladder` and `page_playoff`, papered over by a **lying cast**
in `engine-db/competition.ts`. `stages.ts` throws "qualification from a bracket
stage is not supported yet", so KO→plate and qualifying-KO→main **do not exist**.
Ladder has zero engine unit tests; americano is only tested indirectly;
page_playoff is layout-only.

## Scope

1. **Enum drift**: add the three kinds to `StageKind`; widen `BracketStage.kind`
   to include `page_playoff`. `TableStage` stays league|group|swiss (the
   americano→league adapter mapping stands). **Delete the cast** in
   `engine-db/competition.ts`.
2. **Qualification extensions** (`competition/qualification.ts`, all pure):
   `StageTables` gains optional `bracket?: BracketFixture[]`; a new spec
   `RoundLosers {from?, losersOfRound: {round, count?}}` in `QualificationSpec` +
   `qualificationSize` + `resolveQualification` — losers of bracket round R
   ordered by bracket position then seed, with `STAGE_NOT_READY` /
   `QUALIFICATION_INVALID` errors, composing inside `combine` (dedupe already
   exists). New `placementTable(finalRanks) → PoolTable` so `topN` works over
   bracket placements unchanged.
3. **Completion writes placement snapshots for every kind**
   (`engine-db/competition.ts`): the bracket branch rebuilds `BracketFixture[]`
   from the `outcome` jsonb (winner/loser; lane and thirdPlace recovered from
   `ext_key`), calls `bracketRanks` (`stage.ts` — it already handles losers,
   third-place, DE-reset and page-playoff) → full `finalRanks` +
   `writeSnapshot(placementTable(...).rows)`. New ladder branch: complete when
   zero fixtures are open, `finalRanks = config.ladder_order`. The americano
   display snapshot is unchanged.
4. **`seedNextStage`** (`server/usecases/stages.ts`): delete the throw; route by
   source kind — table/bracket/ladder read the newly written snapshot;
   `losersOfRound` additionally loads source fixtures into `tables.bracket`;
   americano ranks by personal points — **extract a shared `americanoLeaderboard`**
   from `usecases/americano.ts` rather than duplicating it, and map person →
   individual entrant. Carry-over guard (`points.ts`): only from true table kinds.
5. **Schemas / UI**: `RoundLosersS` added to the `QualificationSpecSchema` union;
   `qualifierCount` handles it. New templates in
   `components/v2/format-templates.ts`: `ko_plate` (main KO → plate via
   `losersOfRound:{round:1}`) and `qualifying_main` (KO → KO topN); extend
   `detectTemplate`. Template names and descriptions in all 4 dictionaries.

No migration.

## Acceptance criteria

- [ ] `StageKind` complete; **no cast** in `engine-db/competition.ts`;
      `npx tsc --noEmit; echo "EXIT=$?"` → `EXIT=0`
- [ ] KO→plate: losers of round 1 seed the plate in bracket-position order
- [ ] Qualifying KO→main via `topN` over placements; americano→KO by personal
      points; ladder→KO by ladder order
- [ ] A ladder stage with an open challenge refuses completion (`STAGE_NOT_READY`)
- [ ] **Every** stage kind writes a placement snapshot at completion — one test
      per kind
- [ ] Both new templates create, and `detectTemplate` round-trips them
- [ ] One `americanoLeaderboard` implementation — grep proves the duplicate is gone
- [ ] `openapi:gen` + commit (the QualificationSpec union changed);
      `i18n:gen-keys`; then `git status --porcelain` **empty**
- [ ] Engine purity gate green (`scripts/engine-boundary.ts`); goldens
      byte-identical or a deliberate isolated re-baseline per S1
- [ ] Templates picker screenshot at desktop **and 375px**
- [ ] Vitest counts from the JSON reporter

### Test types

- **Unit (engine)** — new `scheduling/americano.test.ts`; `qualification.test.ts`
  additions (losersOfRound, topN over placements, combine dedupe);
  `stage.test.ts` (page_playoff / stepladder / DE-reset `bracketRanks`).
  Ladder currently has **zero** engine unit tests — that gap closes here.
- **DB integration (server)** — KO→plate; qualifying-KO→main; americano→KO;
  ladder→KO; ladder refuses completion with an open challenge; auto-advance
  through a bracket source; league→KO regression. Revisit any
  `skipIf(!HAS_DB)` format test where a pure path now exists.
- **E2E (Playwright)** — create a `ko_plate` competition from the template
  picker, complete round 1, see the plate seeded; desktop + 375px.
- **Smoke** — extend `smoke.ts` to build one multi-stage format end to end.
- **Regression** — league→KO unchanged; the deleted cast cannot return (a type
  test); americano leaderboard parity between the two former call sites.

## Gotchas

- **Bracket rounds number sparsely** (1,2,3 winners / 7-10 losers / 14 grand
  final). Round numbers are display labels; the ordering authority is the bracket
  wiring, **never arithmetic on `round`**.
- `ext_key` is the only place lane and thirdPlace survive — **parse it, do not
  re-derive**.
- Absolute-count DB tests flake under file-parallel sweeps — rerun alone before
  treating a red as a regression. Sweep suites that scan all orgs also go red on
  a long-lived test DB (34k accumulated orgs once reded 7/14); the final gate
  wants a fresh DB.
- A football-division suite that does not seed the catalog passes locally forever
  and 422s on CI — use the seed helper.
- `stages.ts` is a single-writer file for this session. If another session is
  running, sequence rather than parallelise.

## Execution

Engine steps 1–4, then server/UI 5. Shared `stages.ts` forbids parallel agents →
**one sequential implementer → reviewer loop**.

**Scout (sonnet) brief:** re-pin `StageKind`, `BracketStage`, the cast in
`engine-db/competition.ts`, `qualification.ts`'s spec union and `combine`,
`bracketRanks` in `stage.ts`, `seedNextStage` and its throw, the americano
leaderboard in `usecases/americano.ts`, the carry-over guard in `points.ts`, and
`format-templates.ts` + `detectTemplate`. file:line table only, under 30 lines,
no file contents.

**Implementer (opus, high):** brief carries the scout table, the sparse-round
warning, and the "extract, don't duplicate, `americanoLeaderboard`" rule.

**Reviewer (sonnet):** does any new code do arithmetic on `round`? Is lane/
thirdPlace parsed from `ext_key` or re-derived? Is there still a second americano
leaderboard? Does every stage kind actually write a snapshot, or only the ones
with a test? Gap list only.

## On close

`_INDEX.md`: L3 → DONE, the `RoundLosers` spec shape as shipped, the two new
template keys. Update help pages for the new formats. Memory +
`scripts/agent-memory-snapshot.sh`.
