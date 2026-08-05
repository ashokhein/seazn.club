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
