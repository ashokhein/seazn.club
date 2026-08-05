# z3-backed auto-schedule, reflow and polish — design

Date: 2026-08-05
Branch: `feat/z3-auto-schedule` (worktree — never the main checkout)
Durable state: `.claude/z3-scheduling-state.md` (written before W1, updated at every wave boundary)

## Why

Auto-schedule is a greedy pass (`slotFixtures`). The owner named four defects in it,
and all four are real properties of greedy placement, not bugs:

1. **It gives up too easily.** A fixture is reported `no_slot` when it is placeable
   had an *earlier* fixture moved. Greedy never backtracks, so the organiser is told
   a card cannot be scheduled when it can.
2. **The boards are poor.** Greedy produces a *legal* board, never a *good* one.
   Courts run lopsided, entrants sit idle for hours, the day runs later than it needs to.
3. **Reflow moves too much.** `only_unlocked` re-places every unlocked card from
   scratch. Change one setting and everyone who was already told a time gets a new one.
4. **Rules the placer has no term for.** Closed for typed hard rules by the
   convergence programme (#449/#450/#463); what remains is that greedy cannot
   *optimise* around them, only avoid violating them.

z3 already ships in this repo (#401) but only as a **minimal-movement repair** of an
AI-proposed board. This design extends the solver from repair into generation.

## The measured wall that shapes everything

`packages/engine/src/scheduling/repair.ts:66-94` records the `bench-repair.ts` table:

| movable fixtures | outcome |
| --- | --- |
| 20 | 0.95 s |
| 50 | 8.8 s (dense) |
| 60 | 12.2 s (light) |
| 80+ | **the feasibility probe alone does not return in 119 s** |
| 120 / 250 / 500 | raising the budget 20 s → 60 s changed nothing |

That is the *arithmetic* encoding (`Arith` start times, O(n²) pair assertions).
The target board size is **~200 fixtures**, which is 2.5× past the wall.

**Decomposition does not rescue it.** `repair-decompose.ts` splits a board into
independent components and that works for *repair* because nearly everything is a
frozen obstacle, so components stay under `COMPONENT_MOVABLE_LIMIT = 50`. In a
**build every fixture is movable and every fixture competes for the same courts**,
so the conflict graph is one giant component. Decomposition yields nothing.

The conclusion that drove the design: reaching 200 requires a **different encoding**,
not a different search.

## Decisions (owner-approved, 2026-08-05)

| # | Decision |
| --- | --- |
| D1 | Target board size: **~200 fixtures** per auto-schedule run (weekend tournament) |
| D2 | **Three modes**: BUILD, REFLOW, POLISH — all three in this programme |
| D3 | Objectives, **lexicographic**: compact (makespan) > entrant fairness (worst idle gap) > court balance. "Rest beyond minimum" explicitly dropped |
| D4 | Settings, session hours, court config and typed constraints are **hard** — never traded against an objective |
| D5 | **Anytime, synchronous**, ~30 s ceiling. No background job, no polling UI |
| D6 | **No escape hatch to greedy.** Justified only because the solver is greedy-seeded and therefore can never return a worse board |
| D7 | Approach **A + C**: new slot-grid boolean encoder for BUILD/POLISH, LNS window loop over the existing repair solver as the safety net. REFLOW stays on `repairSchedule` |
| D8 | UI: no new surface for BUILD/REFLOW; **new Polish button**; **result strip** showing what the solver achieved |
| D9 | Budget is primarily z3 **`rlimit`** (deterministic), with wall clock only as an outer safety cap |

### Rejected, with reasons

- **B — chronological decomposition** (solve day 1, freeze, solve day 2 against it).
  Least new code, but a weekend day is still ~100 movable — past the 80-fixture stall —
  and freezing day 1 optimally can render day 2 infeasible with no way back.
- **Whole-board arithmetic encoding with z3 `Optimize`.** Cleanest semantics, but this
  is precisely the regime already measured as not returning.
- **Weighted objective** (`w1*makespan + w2*imbalance + …`). Rejected on the same
  grounds `repair.ts` rejects it: an organiser cannot reason about why a board came out
  a given way, and neither can a reviewer. Lexicographic tiers are auditable —
  the last satisfiable bound *is* the optimum by construction.
- **A 'fast' toggle back to raw greedy.** Unnecessary once the incumbent starts as the
  greedy board; the solver's floor already *is* greedy.

## Architecture

### Engine — five new files in `packages/engine/src/scheduling/`

| File | Job | Depends on |
| --- | --- | --- |
| `build-grid.ts` | `SlotConfig` → legal slot lattice. Per court, every grid start inside `window` and `sessionWindows`, minus `blackouts`, minus court bookings in `existing`. Off-grid pinned starts admitted as extra slots so a locked card is always representable | `calendar.ts` types |
| `build-objectives.ts` | Pure metrics over `readonly Assignment[]`: `makespan`, `worstIdleGapMinutes`, `courtImbalance` | nothing |
| `build-encode.ts` | The boolean model: `x[f][s]` vars, exactly-one-per-fixture, at-most-one-per-slot, rest / order / typed-rule clauses, and the **fixed-neighbour clauses against `existing`** | `calendar.ts`, `build-grid.ts` |
| `build.ts` | `buildSchedule(input): Promise<BuildResult>` — greedy seed, tier walk, anytime incumbent, verifier gate | all above, `z3-load.ts` |
| `build-lns.ts` | The safety net: window selection + improve loop over the existing `repairSchedule` | `repair.ts`, `build-objectives.ts` |

Reused unchanged: `z3-load.ts` (`loadZ3`, `withZ3Lock`), `calendar.ts`
(`slotFixtures` for the seed, `validateAssignments` for the gate), `repair.ts`
(REFLOW and LNS windows). `scheduling/index.ts` gains one export line per file.

**Why `build-objectives.ts` is its own pure module:** the same three numbers are
consumed by four callers — the solver's tier bounds, the API response, the result
strip, and the "never worse than greedy" tests. Computed inline in the solver, the
strip would show numbers no test could reproduce.

**The boundary that matters most.** `build-encode.ts` must read *every* rule semantic
through `calendar.ts` exports — `effectiveHard`, `pairRestMinutesFor`,
`effectiveRestMinutes`, `scopeCoversFixture`, `resolveSelector`, `intervalsOverlap`.
It declares no rule of its own. A line like `const rest = config.perEntrantMinRest`
in that file re-opens the placer/verifier fork, which has been the recurring
scheduling defect in this repo (see `.claude` history and the convergence programme).

### Web — no new route

`AutoScheduleRequest` gains `mode?: "build" | "reflow" | "polish"`. Back-compat
default: absent + `only_unlocked: true` → `reflow`; absent otherwise → `build`.
`autoSchedule` in `apps/web/src/server/usecases/schedule.ts` becomes a three-way
dispatch. It builds the one shared config exactly as today (`toVerifyConfig`) — that
single-config property is load-bearing (#447) and is not disturbed.

Response gains:

```ts
metrics: { makespan: number; worstIdleGapMinutes: number; courtImbalance: number;
           placed: number; total: number }
solver:  { engine: "greedy" | "z3" | "z3+lns";
           status: "ok" | "already_optimal" | "infeasible" | "verifier_rejected"
                 | "z3_unavailable" | "solver_busy";
           tiersCompleted: number; budgetExpired: boolean; elapsedMs: number;
           moved: number }
```

Both regenerated into `openapi/v1.json` and `openapi/v1.public.json`.

## Data flow

### BUILD

```
fixtures + settings
  → toVerifyConfig(settings, …)     ONE config for both halves      [unchanged]
  → slotFixtures(…)                 greedy SEED → incumbent + metrics M0
  → buildGrid(config, existing)     legal slot lattice
  → loadZ3 / withZ3Lock             WASM boot (once per process)
  → encode(fixtures, grid, config)  x[f][s] + clauses
  → T0 … T3                         tier walk
  → validateAssignments(incumbent)  gate
  → assignments + metrics + solver
```

### The tier walk

Four tiers, each a **descending-bound** loop under z3 push/pop — the mirror image of
`repair.ts`'s ascending-k, and auditable for the same reason.

| Tier | Objective | On UNSAT |
| --- | --- | --- |
| T0 | maximise fixtures placed | count is optimal → freeze as hard bound |
| T1 | minimise `makespan` | freeze → T2 |
| T2 | minimise `worstIdleGapMinutes` | freeze → T3 |
| T3 | minimise `courtImbalance` | done — board is lexicographically optimal |

Each iteration asserts `objective ≤ incumbent − 1`, solves, and on SAT replaces the
incumbent. **T0 is the fix for defect 1**: greedy *guesses* a card is unplaceable,
T0 *proves* it either way.

### Budget and the anytime contract

One deadline for the whole call. Tiers run in order until it expires; each tier takes
at most half the *remaining* resource so T3 is never structurally starved, and the
final tier takes all that is left. Expiry never throws — it returns the incumbent and
records `tiersCompleted` / `budgetExpired`. Because the incumbent **starts as the
greedy board**, the result can never be worse than today's. That property is what
makes D6 (no escape hatch) safe.

Budget unit is z3 **`rlimit`**, not wall clock (D9) — see Gap 1.

### LNS trigger

If T1 finds no improvement within its slice, `build.ts` abandons the whole-board model
and spends the remaining budget in `build-lns.ts`: pick a ≤50-fixture window (a
court-day, then the tail), freeze the rest, hand it to the existing `repairSchedule`,
keep the window only if a metric improved. Repeat until the deadline. Different
windows, one incumbent. Also entered directly when the lattice exceeds `MAX_SLOTS`.

### REFLOW — a real behaviour change

Today reflow calls `slotFixtures` with locked cards pinned, which re-places every
unlocked card from scratch. That *is* defect 3, structurally.

New: the current board becomes `proposal`, locked and scope-locked cards become
`existing` obstacles, and `repairSchedule` runs its ascending-k. `k = 0` is always
representable, so a board that is already legal comes back **untouched**; when a
setting changed, the answer is the provably fewest cards moved.

### POLISH

Frozen set = locked + scope-locked + published. Movable = the rest. Runs the BUILD
tier walk over the movable set with the frozen set as obstacles, and one extra
assertion: each tier's bound is seeded from the **current board's** metric, so only a
strict improvement can be returned. No improvement anywhere → `already_optimal`, zero
cards moved, and the button says so.

## Error handling — every rung returns a board, none throws

| Condition | Result | `solver.status` |
| --- | --- | --- |
| Budget expired mid-tier | incumbent (≥ greedy) | `ok`, `budgetExpired: true` |
| T0 proves some fixtures unplaceable | best board + `no_slot` conflicts, now proven | `ok`, `placed < total` |
| UNSAT at T0 with zero placed | greedy seed | `infeasible` |
| Encoder and verifier disagree | greedy seed + error log | `verifier_rejected` |
| z3 WASM fails to load | greedy seed | `z3_unavailable` |
| Over the z3 queue-depth cap | greedy seed, immediately | `solver_busy` |

`repair.ts` throws `RepairVerificationError` on verifier rejection. `buildSchedule`
must **not** throw — auto-schedule must always hand back a board — but it must never
be silent either: the fallback is recorded in the response *and* logged as an error,
because encoder/verifier disagreement is the exact bug class this design exists to
prevent.

## Eight gaps closed in the design

1. **Determinism.** `calendar.test.ts:402` asserts `slotFixtures` is deterministic. An
   anytime solver cut off by *wall clock* returns a different board on a faster
   machine — same input, different output, and a permanently flaky test. Budget on
   z3's **`rlimit`** (a deterministic resource counter) with a fixed `random_seed`;
   wall clock is an outer safety cap that should never fire. BUILD is then reproducible
   and the invariant survives.
2. **Grid explosion.** A season-length `window` × 4 courts at a 5-minute grid is >100k
   slots and the boolean encoding dies. Grid step = `gcd(matchMinutes, gapMinutes)`
   clamped to ≥ `REPAIR_GRID_MINUTES` (5), plus a hard `MAX_SLOTS` (20 000). Over the
   cap → skip the whole-board model, go straight to LNS. `gapMinutes: 0` is legal and
   makes the gcd degenerate to `matchMinutes`, which is the correct step for a
   back-to-back court, not a bug.
3. **DST.** Building the lattice by adding `86_400_000` across a DST boundary is the
   #397/#448 defect. Grid days come from `dayKeyInTz` / `calendarDaysCovering`, and the
   governing clock is **`settings.orgTz`**, not `settings.tz` — one letter apart, both
   `string`, and the in-scope one is the wrong answer that typechecks.
4. **z3 is serialised by `withZ3Lock`.** Three organisers clicking at once queue for
   90 s. A queue-depth cap returns the greedy board immediately with `solver_busy`
   rather than making someone wait behind two strangers.
5. **`no_slot` semantics change under T0.** Cards greedy called unplaceable will now be
   placed; existing assertions expecting a `no_slot` conflict will flip. Those are real
   test updates, not breakage.
6. **Siblings are more than court occupancy.** `schedule.ts` passes
   `[...obstacles, ...siblings.assignments]` as `existing`, and those rows carry
   `entrants`, `people`, `poolId` and `divisionId`. Removing their court-time from the
   lattice is **not enough** — the encoder must also emit fixed-neighbour rest and
   person-clash clauses against them, or the solver double-books a person across two
   divisions and the verifier rejects the board. This is the single easiest way to
   trip `verifier_rejected`, and `build-encode-parity.test.ts` must include an
   `existing` set with shared people for exactly that reason.
7. **TBD-entrant fixtures** (bracket feeds, `home`/`away` undefined) carry no rest or
   overlap constraints but *do* carry `OrderDependency`. The encoder keeps the order
   clauses while skipping the participant clauses, or brackets schedule out of order.
8. **The repair bench is inert for `hard` rules (#455)** — it omits them, so it cannot
   measure min_rest / day-cap changes. `scripts/bench-build.ts` includes typed hard
   rules from the start, or the budget constant is set against a board that never
   exercises the constraints organisers actually write.

## Known limits — recorded, not fixed here

- **#439** — two divisions naming the same physical court differently. The lattice keys
  on court *labels*, so it would treat one physical court as two and double-book it.
  Pre-existing in `slotFixtures`; the solver inherits it and does not worsen it.
- **#440** — courts have no identity or typed attributes, so the grid cannot reason
  about surface, indoor/outdoor, or capacity.
- **#465** — the conflicts panel exposes no `data-*` hooks, so the e2e asserts on text.

Per the owner's standing rule, none of these opens a new issue.

## Testing

Required for every wave: **unit, e2e, smoke, and a regression test for the specific
behaviour changed.** A wave is not done until all four exist and pass.

### Verification protocol (non-negotiable — each has produced a false green here)

- vitest judged **only** from `--reporter=json --outputFile`, reading `numPassedTests`
  / `numTotalTests`. An `rtk` summary prints `PASS(0) FAIL(0)` for a suite that failed
  to *collect*.
- lint via `rtk proxy`, reading `✖ N problems`. `packages/engine` has its **own** lint
  task; a clean root lint says nothing about it.
- A run launched from a worktree prefixes `cd <abs worktree> &&` in the same call, and
  the resolved paths in `.testResults[].name` are checked before a count is believed.
- Assertions on a Next HTML body anchor on `="` — React serialises an omitted prop as
  `"$undefined"`, so a bare `data-*` probe passes in both states.

### New engine unit suites

| File | Proves |
| --- | --- |
| `build-grid.test.ts` | Lattice honours blackouts, session windows, `window` bounds; off-grid pinned start representable; `MAX_SLOTS` cap trips to LNS; grid step = `gcd(matchMinutes, gapMinutes)` ≥ 5 |
| `build-objectives.test.ts` | The three metrics on hand-built boards, including ties and single-fixture boards |
| `build-encode-parity.test.ts` | **The anti-fork test.** Over generated boards, the model accepts an assignment **iff** `validateAssignments` accepts it. Mirrors `calendar-placer-verifier-parity.test.ts`. Must include an `existing` set that shares `people` with the movable set (Gap 6) |
| `build.test.ts` | T0 places what greedy called `no_slot`; lexicographic order holds (a board better on balance but worse on makespan is rejected); incumbent never worse than the greedy seed; tier freezing is a hard bound |
| `build-determinism.test.ts` | Same input → byte-identical board across runs, and identical under two different wall-clock caps (proves `rlimit`, not the clock, is the stopping rule) |
| `build-lns.test.ts` | Window loop improves or no-ops, never regresses a metric, respects the frozen set |
| `build-polish.test.ts` | `already_optimal` returns zero moves; frozen cards never move; only strict improvements returned |

### Regression tests — each must fail without the change

- Greedy returns `no_slot` on a board z3 fully places (defect 1).
- Gap setting +5 min on a legal 40-card board → reflow moves the provably fewest
  cards, not all 40 (defect 3).
- `window` spanning a DST boundary → day count and grid starts correct.
- Config where `settings.tz ≠ settings.orgTz` → grid buckets by `orgTz`.
- Bracket feed with TBD entrants → `OrderDependency` holds, participant clauses skipped.
- Concurrent auto-schedule over the queue cap → `solver_busy` + greedy board.
- A sibling division's assignment sharing a `people` id with a movable fixture → the
  solver never overlaps them, and the verifier agrees (Gap 6).

### Existing tests to update

`apps/web/src/server/usecases/__tests__/schedule.test.ts` (three-way dispatch; reflow
behaviour genuinely changes), `competition-schedule-pack.test.ts` and
`competition-schedule-guarded-existing.test.ts` (response gains `metrics` / `solver`),
the OpenAPI snapshot, and `apps/web/e2e/schedule-board.spec.ts`.

`slotFixtures` itself is untouched, so `calendar*.test.ts` should stay green. **If any
of them go red, that is a signal the seed path changed** — investigate, do not patch
the assertion.

### E2E — `apps/web/e2e/schedule-solver.spec.ts` (new)

Prod build + `E2E_PROD_TARGET` on **`localhost`:3100** — `127.0.0.1` 401s every API
call because the session cookie is `Secure` under `NODE_ENV=production` — and assert
`lsof -t` on 3100 is our own PID before trusting anything, because a squatted port
health-checks 200 against a *foreign* server. Covers: run auto-schedule → result strip
shows finish time / court spread / worst gap; click Polish → improvement or
`already_optimal`; both at desktop **and 375 px with no horizontal page scroll**.

### Smoke — `scripts/smoke.ts`

A solver step on demo data: build a board, assert `solver.status` is clean,
`metrics.placed === metrics.total`, and the verifier returns no blocking conflicts.
Smoke CI runs on **PRs only** — merging locally and pushing to `main` skips it.

### Bench — `scripts/bench-build.ts` (new)

20 / 50 / 100 / 200 / 500 fixtures × two conflict densities, **with typed `hard` rules
included**. Sets `SCHEDULING_BUILD_RLIMIT` the way `bench-repair.ts` set
`DEFAULT_REPAIR_BUDGET_MS`; the table goes in the commit message.

### i18n

Every new user-facing string — Polish button, result-strip labels, `already_optimal`,
`solver_busy` — goes in **all 4 locale dictionaries**, flat dotted keys, never
hardcoded English. Before merging, grep the new UI text across `e2e/`: UI text changes
break e2e specs here.

## Execution

Branch lives in a **worktree**. Three worktree traps are checked before the first test
run, because each produces a false green:

- `readlink -f node_modules/@seazn/engine` must resolve inside the worktree, not to
  main's engine.
- A worktree has no `.env.local`, so ~1772 DB tests skip with `total` unchanged and
  only `pending` moving.
- `.claude/agent-memory` must be symlinked or every subagent there runs blind.
- **No `git stash` in the worktree** — the stack is shared with main; a no-op push+pop
  pops a foreign stash and leaves `package.json` unmerged.

### Waves — sequential, because `scheduling/index.ts` is touched by every engine wave

That shared file is the reason parallelism is forbidden here, not the task count.

| W | Scope | Gate |
| --- | --- | --- |
| W1 | `build-grid.ts` + `build-objectives.ts` + 2 unit suites (pure, no z3) | engine unit green |
| W2 | `build-encode.ts` + `build-encode-parity.test.ts` | parity suite green |
| W3 | `build.ts` — tier walk, `rlimit`, anytime, verifier gate + `build.test.ts` + `build-determinism.test.ts` | engine unit green |
| W4 | `build-lns.ts` + suite; `build-polish.test.ts` | engine unit green |
| W5 | Web: `schemas.ts`, `schedule.ts` three-way dispatch, route, `openapi:gen`, updated usecase tests | web unit green, `git status --porcelain` empty |
| W6 | UI: Polish button, result strip, 4 locales, `i18n:gen-keys` — `frontend-design` skill, desktop + 375 px screenshots | screenshots + porcelain empty |
| W7 | `scripts/bench-build.ts` with hard rules, sets `SCHEDULING_BUILD_RLIMIT` | bench table in commit message |
| W8 | E2E spec + smoke step + full gate rerun | e2e 3 projects green, smoke green |

### Agent topology

scout (sonnet, read-only) only when a wave needs discovery → implementer (opus, high
effort) → reviewer (sonnet) → gap list → implementer → … until the review is clean
**and** raw test counts are pasted back. The gate is re-run at every wave boundary;
"done, tests pass" without numbers is not accepted.

**Every dispatch carries seven things** so no agent re-reads the codebase: exact file
paths, acceptance criteria, what NOT to touch, the verify command *with*
`--reporter=json --outputFile`, the output cap ("final message under 15 lines —
counts, paths, deviations, blockers; no file contents or diffs"), a pointer to
`.claude/z3-scheduling-state.md`, and the relevant traps above.

Briefs **ban nested subagents**: an audit subagent whose helper never returns
fabricates the helper's findings, and the *clean* half of such a report is the
fabricated half.

### Pre-commit, every commit

Two CI-only drift gates, both tripped by this change:

```
npm run openapi:gen
npm run i18n:gen-keys
git status --porcelain   # must be empty
```

### Issue policy

**No new GitHub issues.** Anything found mid-wave that does not widen the blast radius
is fixed inline; anything that would widen it is brought to the owner as a question.
