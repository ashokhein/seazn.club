# Scheduling placer/verifier convergence — design

Date: 2026-08-05
Issues: #463, #449, #450, #458, #462, #461, #467
Branch: `feat/sched-convergence` (this doc), then one branch per wave.

## Why these six are one programme

Every remaining item in the scheduling correctness lane is an instance of one
defect shape:

> **A value exists on one side of a seam and is absent, or in a different
> namespace, on the other — and both sides typecheck.**

The tell is always **two producers, one comparison, no normaliser.** `tsc`
cannot see any of them, so they are found only by reading the *builders*, never
the types. Eight instances are now on record: #443 (uuid vs ext_key), #446
(Assignment group ids), #447 (`SlotConfig` assignable to `VerifyConfig` with
`tz`/`hard`/`ruleFixtures` undefined), #449 (pool key vs uuid), #450 (person
name vs uuid), #451 (cfg scales vs table scales), #448 (UTC day vs local day),
and the near-miss caught while fixing #448 (`settings.tz` vs `settings.orgTz`).

The scheduling instance has a name: the **placer/verifier fork**. The placer
(`slotFixtures`) and the verifier (`validateAssignments`) answer the same
question from two different code paths, so they can disagree. The user-visible
symptom is specific and recognisable:

> auto proposes a board that the gate immediately warns about, and re-running
> auto cannot fix it.

This programme closes the fork rather than patching each divergence.

## Current state, verified against `origin/main` @ `14b8e5f6`

| Site | What is there now |
| --- | --- |
| `packages/engine/src/scheduling/calendar.ts:365` | `slotFixtures` — the placer |
| `calendar.ts:384` | `const lastEnd = new Map<EntrantId, number>()` — rest tracked per **entrant** |
| `calendar.ts:494`, `:529` | the only writes/reads of `lastEnd` |
| `calendar.ts:645-656` | `scope.kind` switch: `pool` compares `scope.pool`, `person` compares `scope.personKey` |
| `calendar.ts:737` | a comment that already documents the `lastEnd` defect |
| `apps/web/src/server/usecases/schedule-ai.ts:1606` | `startWindows: []`, pinned |
| `apps/web/src/server/usecases/schedule.ts:313` | `siblingAssignments` returns `Assignment[]` |
| `apps/web/src/server/usecases/schedule.ts:909` | `moveFixture` returns `Promise<void>` |
| `packages/engine/src/sports/cricket/cricket.ts` | the only mentions of `revisedTarget` anywhere |

`slotFixtures` folds rest, `startWindows` and `crossPersonClash` and nothing
else. So `max_fixtures_per_day`, `not_before`/`not_after`,
`fixture_on_weekday`/`fixture_on_date` and `feeder_to_dependent` rest are
**reported by the verifier but never placed around**.

## Wave 1a — engine capability

One file: `packages/engine/src/scheduling/calendar.ts`. Closes **#449**,
**#450**, **#463**.

### Commit 1 — the identity seam

Three of the defects are the same missing normaliser:

```
lastEnd: Map<EntrantId, …>      compared against  a per_person rule   (#463)
guardedPeople: identity.keyOf   compared against  a person uuid       (#450)
scope.pool: "A"                 compared against  a pool uuid         (#449)
```

Introduce a single key-resolution function, local to the scheduling module.
Every scope comparison in the `scope.kind` switch and every rest bucket resolves
its key through it, so both sides of each comparison are produced by the same
code. `lastEnd` stops being keyed by `EntrantId`.

To be explicit, since this is the sort of thing that gets misread into a much
larger change: this does **not** alter what `identity.keyOf` means, and does not
change any persisted key or wire shape. It changes only which function each
comparison calls to obtain its key. The existing collapse semantics
(a person uuid resolving to `name:<normalised>`) stay exactly as they are —
#450 is that both sides must apply that resolution, not that it should stop.

This lands as **its own commit**, before any placement change, so a bisect can
separate "the normaliser broke something" from "the new placement logic broke
something". That separation is the whole reason for two commits.

### Commit 2 — placement convergence

Extend `slotFixtures` to place around every family the verifier already checks:
`max_fixtures_per_day`, `not_before`/`not_after`, `fixture_on_weekday`/
`fixture_on_date`, `feeder_to_dependent` rest.

Day bucketing uses `dayKeyInTz(instantMs, tz)` from
`packages/engine/src/scheduling/tz.ts`. Do not write another day helper — that
helper is the #448 fix and is DST-correct with zero dependencies. The governing
zone is the **org** zone; a division override must never decide which calendar
day a fixture falls on.

### The acceptance test that matters

Not "the placer honours rule X". The test is:

> for the same board and the same config, the placer and the verifier report
> **the same number** of violations of each family.

A test that asserts only the placer's behaviour cannot catch a fork; a test that
asserts both sides agree cannot miss one. Where practical, extract the shared
predicate so there is one function rather than two that must be kept in step.

## Wave 1b — the web side supplies what the placer now needs

Without this, Wave 1a is dead capability on the surface users actually touch:
the engine places around windows that never arrive. Closes **#458**, **#462**,
**#461**.

- **#458** — `schedule-ai.ts:1606` stops pinning `startWindows: []`. #464 added
  an assertion pinning the current empty behaviour; that assertion must **flip**
  in this change.

  **The two siblings are not interchangeable — decide which is right before
  copying.** `schedule.ts:403-406` maps every window straight through
  (`target: w.target`). `competition-schedule-ai.ts:1308` instead *drops* any
  window whose `target.kind` is not `entrant`, `pool` or `division`, with a
  comment explaining why: the pack is a wire shape, so `target.kind` is a bare
  `string`, and casting an unrecognised kind through would let the engine
  silently never match it while hiding that a settings row has drifted from the
  enum. `schedule-ai.ts` consumes a pack, so the filtering sibling is the
  correct model for it. Copying the other one would reintroduce the exact
  silent-never-matches failure that comment was written to prevent.

  Note this divergence is itself an instance of the programme's bug class: two
  producers of the same engine input, no shared normaliser. Prefer extracting
  one shared builder over adding a third copy.
- **#462** — `siblingAssignments` (`schedule.ts:313`) carries `RuleFixture`, so
  a competition-scoped day cap stops undercounting cross-division fixtures. The
  joint path already does this correctly; copy it. This is a **prerequisite for
  correctness**, not a nicety: a day cap that places confidently on undercounted
  data is worse than today's behaviour, where it does not place at all.
- **#461** — `moveFixture` (`schedule.ts:909`) returns the conflicts it already
  computes instead of `Promise<void>`. Same file as #462, and it is the feedback
  half of the same story.

## Wave 2 — #467

Nothing renders `revisedTarget`. Independent of the waves above; no shared
files. Worth doing because an invisible output is an unverified output — #451
survived precisely because nothing displayed this value.

## Testing

Every change ships all four, per the standing rule, and a task is not done until
all four exist and pass:

1. **unit** — engine and `apps/web`, judged only from
   `--reporter=json --outputFile`. A drop in `numTotalTests` means DB tests
   silently skipped and is a failure, not a pass.
2. **regression** — a test that fails without the change. Prove it red by
   reverting with `git show <ref>:<path> > <path>` or a `cp` backup. Never
   `git stash` in a worktree; the stack is shared with the main checkout.
3. **smoke** — `scripts/smoke.ts` against a real standalone server, with the env
   from the smoke job in `.github/workflows/ci.yml`. Smoke reads
   `SCHEDULING_AI_BASE_URL` from its **own** env; without it the v4 AI section
   skips silently and the run still reports success.
4. **e2e** — Playwright against a prod build. Never enable
   `.github/workflows/e2e.yml`.

Before every commit, both CI-only drift gates: `openapi:gen` **and**
`i18n:gen-keys`, then `git status --porcelain` must be empty.

## Risks

- **Wave 1a is a refactor and new logic in one file.** Mitigated by the
  two-commit split and by gating the wave on no other worktree holding
  `calendar.ts` changes. Several sessions run in parallel in this repo; at the
  time of writing no other worktree has uncommitted `calendar.ts` edits.
- **The golden corpus cannot catch what no config exercises.** A green
  conformance run is not coverage. Never run `UPDATE_GOLDEN=1`.
- **Timing gates lie under load.** `repair-scale` and
  `calendar-shared-semantics` carry wall-clock assertions and fail on a busy
  machine. Judge them only from an isolated run.
- **A spec regenerating cleanly does not mean the served JSON is unchanged.**
  `openapi:gen` regenerates from the zod schema, which nothing applies at
  runtime. This gap was demonstrated during #448: a wire-breaking rename passed
  tsc, vitest, lint and `openapi:gen` in both directions. Where a change touches
  a boundary payload, assert the payload.

## Out of scope

- Any schema migration. None of the six needs one.
- The remaining untriaged issues: #465, #455, #453, #439, #389, #388.
- Re-litigating settled invariants: instruction-rule conflicts are warn-only by
  design; `blocking` is absolute while the delta lives only in the write gate.
