# z3 auto-schedule — programme state

Read this first after a compaction. It is the durable record; the conversation is not.

Spec: `docs/superpowers/specs/2026-08-05-z3-auto-schedule-design.md`
Plan: `docs/superpowers/plans/2026-08-05-z3-auto-schedule.md`
SDD ledger: `.superpowers/sdd/2026-08-05-z3-auto-schedule/progress.md`
Worktree: `/Users/ashokhein/github/wt-z3-build`   Branch: `feat/z3-auto-schedule`
Branch base: `0b8af458` on `main`

## What this builds, in one paragraph

Auto-schedule is greedy (`slotFixtures`) and has four owner-named defects: it
reports `no_slot` for placeable cards, it builds legal-but-poor boards, reflow
re-places every unlocked card, and it cannot optimise around typed rules. z3 is
already in the repo (#401) as minimal-movement *repair*. This programme extends
it into *generation*: a slot-grid boolean model, greedy-seeded, with four
descending-bound lexicographic tiers (placed > makespan > worst idle gap > court
imbalance). REFLOW moves onto the existing `repairSchedule`. LNS windows over
that same solver are the fallback.

## The measured fact that shapes the design

`repair.ts:66-94` — the arithmetic encoding repairs ≤~70 movable fixtures and at
80+ the feasibility probe alone does not return in 119 s. Decomposition does not
rescue a BUILD, because every fixture is movable and every fixture competes for
the same courts, so the conflict graph is one component. Reaching the
~200-fixture target needs a different **encoding**, not a different search.

## Owner decisions (do not relitigate)

D1 ~200 fixtures · D2 three modes BUILD/REFLOW/POLISH · D3 lexicographic
compact > fairness > balance · D4 settings/hours/courts/constraints are HARD ·
D5 anytime, synchronous, ~30 s · D6 no escape hatch back to greedy (safe only
because the incumbent starts as the greedy board) · D7 approach A + C ·
D8 no new UI for BUILD/REFLOW, new Polish button, result strip · D9 budget on
z3 `rlimit`, not wall clock.

## Environment facts learned here

- Installer is **pnpm** (`pnpm install --frozen-lockfile`); scripts still run as
  `npm run <x> --workspace <ws>`.
- **Shell cwd resets to the main checkout between calls.** Prefix
  `cd /Users/ashokhein/github/wt-z3-build &&` in the SAME call, always.
- Baseline: engine 2328/2330, **1 pre-existing failure** —
  `repair-scale.test.ts:102`, a machine-speed assertion (<7000 ms, got 7978 ms).
  Unrelated to this work. Every later count reads against 1, not 0.

## Task log

- [x] Task 0 — worktree, install, traps checked, baseline recorded
- [x] Task 1 — build-objectives.ts + 11 unit tests
- [x] Task 2 — build-grid.ts + 14 unit tests
- [x] Task 3 — build-encode.ts + parity suite

## Mid-flight state (2026-08-05) — the SDD ledger is the fuller record

**Read `.superpowers/sdd/2026-08-05-z3-auto-schedule/progress.md` FIRST.** It has a
"RESUME HERE AFTER COMPACTION" block at the top with live lane state, running
worktrees, and the task order.

Complete: T1 metrics · T2 lattice · T3 encoder · T3b typed rules · T4 solver loop ·
**T5 tiers** · T8 API · **T11 result strip** · #230 item 4. Merged into this branch
@ **`349f01d5`**, verified there: engine 2418/2419/0, both typechecks 0, and
`openapi:gen` + `i18n:gen-keys` + `i18n:check` all clean with an empty porcelain.

In flight at last flush: **T6** (LNS, `wt-z3-solver` @ `b9832a81`, R11 fix round
running) and **T9** (dispatch + telemetry, `wt-z3-web` @ `349f01d5`, no commits,
owes an answer to a scope question). Check `git log` in both before dispatching.

Rulings R1–R12, all in the ledger with reasoning. Beyond the first eight: R9 fixes
the strip's tier denominator and pin count at the ROOT via two new wire fields
(`tiers_total`, `contradictory_pins`) rather than patching the component; R10 keeps
the wall-clock backstop because D5 needs a synchronous ~30 s response, conditional
on Task 13 proving it never fires; R11 makes `rlimit` a RUN total, since per-solve
leaves the wall clock as the only run-level bound and inverts D9; R12 leaves the
over-cap LNS entry unwired because `buildGrid` never reads the fixture list, making
that pass inert by construction.

Two things worth knowing before trusting anything:

1. **Every Critical and Important finding so far has been in code or tests the
   CONTROLLER authored into the plan, not in implementer work.** Seven brief
   premises have now been measured false by implementers — including
   "LNS runs over `repairSchedule`", which cannot work at all. Treat the plan's
   test files as drafts and mutation-prove everything.
2. **`DEFAULT_BUILD_RLIMIT` is an uncalibrated placeholder** and Tasks 6/7/9/10 are
   all built against it. Task 13's bench owes five measurements now. The sharpest
   one: there is still no unmocked case where LNS improves a real board.

## Task 7 (engine lane) — R17, and three brief premises measured false

Engine suite **2449/2448/0**, 1 pending, `success: true`. Baseline was 2442/2440/**1**
— the pre-existing red is FIXED, see the third point below.

1. **The brief's own Task 7 was already done.** `already_optimal` shipped with Task 5
   and keys on `tiersCompleted === TIER_COUNT && !improved`. Both of the brief's
   "failing" cases passed against an untouched `build.ts`. Its Step 3 replacement
   predicate (`mode === "polish" && moved === 0`) was applied as a mutant and **reds
   8 tests**: it calls a starved run optimal (`rlimit: 1` gives `tiersCompleted: 0`,
   `moved: 0`) and takes `already_optimal` away from every BUILD run. NOT implemented.
   `build-polish.test.ts` now pins both directions so it cannot be loosened back.
   **`BuildInput.mode` is still read nowhere in the engine** and is decorative.
2. **M10 is a WEB-lane survivor, not an engine one.** Deleting `input.frozen` reds two
   existing `build.test.ts` cases — measured, so `frozen` is NOT dead surface and was
   not deleted. It is live in exactly ONE shape: a fixture with no `locked` anchor,
   held to the slot greedy itself gave it. Every `locked` fixture masks it, because
   `publishedSlotOf` prefers `locked` and `encodeBuild` pins that on its own account.
   That is why `schedule.ts:852`'s mutant survived: its cases run `only_unlocked: true`,
   where `frozenIds ⊆ pinnedIds` **by construction** (same predicate, minus the flag).
   **The killing case is `only_unlocked: false`** — there `pinnedIds` is EMPTY and
   `frozen` is not. → web lane. And on that path POLISH freezes cards to greedy's own
   RE-PLACEMENT rather than to the published slot, which `publishedSlotOf`'s comment
   already flags as wrong; worth a product ruling, not just a test.
3. **R17 also fixed a latent determinism defect.** The teardown gives every solve a
   fresh context, so a board no longer depends on what the process solved earlier.
   Evidence is `build.test.ts`'s makespan case, probed directly: COLD it answers 10:30,
   warm behind that file's earlier solves it answered 10:00 — same input, two boards.
   Two boards tie on all four tiers there (09:00/09:30/10:00 vs 09:30/10:00/10:30), so
   the assertion on the absolute instant was pinning z3's search state; relaxed to the
   shape the test's own comment argues. **RETRACTION:** an earlier round cited
   `build-lns-wiring.test.ts` as the evidence. That was an overstatement — measured
   red/red/green over three full runs, it is a band-sensitive FULL-RUN FLAKE both before
   and after R17 and proves nothing either way.

## Task 7 fix round 1 — four Importants + one Minor, all addressed

Engine **2453 total**, best full run **2451 passed / 1 failed** (`repair-scale:102`, the
long-documented machine-speed flake — 4/4 green alone, twice). Three full runs; every
distinct failure across them verified green in isolation. tsc 0, lint 0.

- **R17 completed at `repair.ts:237`.** It was the one z3 entry point the ruling missed,
  inherited by `repairAndVerify`, so a BUILD after a repair started warm. Of the new
  test's two halves only `z3LoadCount() === 0` discriminates (reds `expected 1 to be
  +0`); the board-equality half was mutation-tested with that witness neutered and
  stayed green, so it is labelled a canary rather than a proof. `repairDecomposed`'s own
  reset degrades to a no-op and was left in place. All repair suites 113/113.
- **The teardown no longer eats the solve's error** (`z3-load.ts`). A throw inside the
  `finally` replaced the real exception, so an encoder-drift throw surfaced as a WASM
  shutdown failure. Caught and logged; safe because `tearDownZ3` clears the singleton in
  a `finally` of its own.
- **`moved` now measures against `BuildInput.current`** (new, optional) rather than the
  greedy seed, so the strip's "moved N" is true in the one shape where they differ: a
  frozen card with no `locked` anchor, which greedy re-places. The early-return greedy
  paths route through the same helper instead of hard-coding 0.
- **The encoder's locked-anchor assertion is now a PROOF.** Premise partly false: the
  mutant is already killed by four engine tests — but all four are board-level, which
  cannot separate "the encoding forbids every other slot" from "z3 picked the right one
  anyway". Asserting `Not(place[i][s])` is `unsat` settles it.
4. **`boundSolverWindow`'s second greedy pass: MEASURED, leave it.** 20.5 ms at 200
   fixtures (8.9 at 90, 1.7 at 15) against an 8 s wall — 0.26%. The literal ask (expose
   the engine's seed on `BuildResult`) cannot remove it: the caller needs the horizon
   BEFORE it may call `buildSchedule` at all, since an open-ended window makes
   `dayKeyInTz(Infinity)` throw inside `buildGrid`. The only shape that works is an
   inbound `BuildInput.seed`, which would be dead engine surface until the web adopts
   it and would put the "never worse than greedy" floor and the delta gate's baseline
   at the mercy of the caller's config. Not worth 0.26%. No engine change.

## Task 7 fix round 2 — RULING R20 + three latent `current` bugs

**R20: POLISH freezes against the PUBLISHED board.** `publishedSlotOf` now reads
`locked` → `current` → greedy seed. The old fall-through anchored a frozen card to a
slot greedy INVENTED during that run, so POLISH silently moved published cards — the
opposite of the mode's purpose. Only reachable for a frozen id with no `locked` anchor.

Three bugs in `current`, all fixed engine-side and all mutation-proved:

1. `current: []` counted every placed card as moved. One `currentBoard` binding now
   treats empty as "no baseline", read by BOTH `publishedSlotOf` and `movedFrom` so a
   freeze and its `moved` count can never disagree about whether a caller board exists.
2. A LOST card read as `moved: 0` — `movedFrom` only walked the board, so a run that
   dropped a match reported the most alarming outcome as the most reassuring one.
   Baseline rows absent from the answer are now counted.
3. The determinism case pinned `status === "repaired"` under a budget. Now
   `status !== "clean"`, with the `z3LoadCount()` witness moved AHEAD of it so the
   mutant fails on the thing the case is about rather than on machine speed.

## OWED BY THE WEB LANE — `BuildInput.current` has NO caller (→ Task 12)

`git grep buildSchedule` under `apps/web` is **0 hits**, so nothing supplies `current`
and the user-visible wrong number is unchanged end to end. The engine side is done; the
wiring is not, and **R20 does not take effect until it lands.**

Pass the board for the cards the run may touch — the web already computes exactly this
as `placedNow` + `pinnedNow` in `schedule.ts`. Two traps, both handled in the engine and
both easy to reintroduce at the seam:

1. **Do not synthesise a baseline on a first-ever build.** The engine reads `[]` as "no
   baseline" and falls back to the seed, which is right. A caller that instead passes a
   placeholder row gets every placed card counted as moved — "12 matches moved" for a
   board nobody had ever scheduled.
2. **Do not filter out cards the run may fail to place.** A baseline row absent from the
   answer is counted as MOVED on purpose: that is a lost match, and it is the one
   outcome that must never render as "nothing moved". Filtering to "cards we expect
   back" silently re-hides it.

Three things `current` is NOT: it is not `existing` (the immovable board — conflating
them puts the organiser's own cards in their own way); it does not constrain the solve;
and it does not replace `locked` for a card that must not move at all.
