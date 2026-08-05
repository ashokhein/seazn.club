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
