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
- [x] Task 9 — `autoSchedule` three-way dispatch, metrics + solver on the wire
      (`feat/z3-web`). Full report:
      `.superpowers/sdd/2026-08-05-z3-auto-schedule/task-9-report.md`.

      THREE defects found at the WEB SEAM, all fixed there, none of them visible
      to the engine lane's own tests:

        1. `applyWindow` returns `to: Infinity` for a competition with no end
           date — the ordinary organiser config — and `buildGrid` ->
           `calendarDaysCovering` -> `dayKeyInTz(Infinity)` THROWS. Every BUILD
           run 500'd. Fixed by `boundSolverWindow` (web side), which closes the
           open end at the MEASURED greedy span + 1 day. Deliberately NOT a wide
           bound: a `MAX_SLOTS` overflow makes `buildGrid` return nothing and the
           solver goes silently inert on exactly the configs it exists for.
        2. The engine's 30 s wall is spent IN FULL on a 15-fixture board. Web now
           passes `AUTO_SOLVER_WALL_MS = 8_000` (measured: 2s and 5s differ, 5s
           and 10s do not). Revisit when Task 13's rlimit bench lands.
        3. The z3 WASM heap only grows; six solves in one process abort node with
           `Cannot enlarge memory arrays ... (OOM)`. `buildSchedule` has no
           teardown, so web now calls `resetZ3()` in a `finally`. This would have
           killed a long-running production server, not just the test runner.

      Left open for later tasks: `TIER_COUNT` is module-private in build.ts, so
      the wire's `tiers_total` is a web constant proved against the engine via
      the `already_optimal` contract — exporting it is a one-line engine change
      worth making. POLISH's `frozen` is redundant under `only_unlocked: true`
      (locks already pin) and anchors to GREEDY's placement under
      `only_unlocked: false` (`publishedSlotOf`), so it has no isolating test
      until Task 7 lands.

## Mid-flight state (2026-08-05) — the SDD ledger is the fuller record

**Read `.superpowers/sdd/2026-08-05-z3-auto-schedule/progress.md` FIRST.** It has a
"RESUME HERE AFTER COMPACTION" block at the top with live lane state, running
worktrees, and the task order.

Complete: T1 metrics · T2 lattice · T3 encoder · T3b typed rules · T4 solver loop ·
T8 API · #230 item 4. Merged into this branch @ `4fa9dbab`.

Owner rulings taken mid-flight, all in the ledger with reasoning: delta verifier
gate (R1), legal-only seed (R2), configured courts only (R3), `infeasible` names
the pins not the board (R4), POLISH freezes on LOCKS ONLY since there is no
per-fixture published flag (R5), publish gate blocks with an explicit override
(R6), `verifier_rejected` shows a neutral note (R7), `solver_busy` says so and
offers retry (R8).

The single most useful thing learned: **every Critical and Important finding so far
has been in code or tests the controller authored into the plan, not in implementer
work.** Treat the plan's test files as drafts and mutation-prove everything.
