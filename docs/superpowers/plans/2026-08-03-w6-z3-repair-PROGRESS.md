# W6 (#401) — live progress ledger

Compaction insurance. Update this at every task boundary. If context is lost,
this file plus the plan beside it is enough to resume without re-deriving anything.

**Worktree:** `/Users/ashokhein/github/seazn.club/.claude/worktrees/w6-z3-repair`
**Branch:** `feat/w6-z3-repair` (off `main` @ `44144cd4`)
**Plan:** `docs/superpowers/plans/2026-08-03-w6-z3-repair.md`
**Issue:** #401 · **Gate: PASSED** — #397 closed 2026-08-03T10:05Z, #398 closed 12:11Z.

## Status — five boundaries, each a safe checkpoint

A boundary is reached when its work is **committed** and its gate is **green**. At that
moment everything below it is droppable: the committed file contents, the exploration,
the resolved errors. What must survive is only what this file records.

| # | Boundary | State | Exit gate |
|---|---|---|---|
| 1 | T1-T2 z3 loader + calendar.ts exports | **CLOSED** — `3b1b2ad4`, `7ac1cf6d`, `a0605bd7` | gate re-run by the orchestrator: 1523 pass / 0 fail / 410 suites, 0 outside the worktree, no pre-existing test or golden touched, tsc 0. Review found 5, all fixed; re-review in flight |
| 2 | T3-T5 repair-domain, repair.ts, repairAndVerify | **in progress** | badminton +1 clash moves **exactly 1** fixture (12 anchors byte-identical); Stepladder 13-violation → verifier-clean, both finals Friday; determinism twice; infeasible names families; timeout returns cleanly; `z3LoadCount()===0` on the clean path |
| 3 | T6-T7 bench + budget + engine gate | pending | measured 50/120/250/500 table in the commit body; `DEFAULT_REPAIR_BUDGET_MS` set FROM it; goldens untouched. **Engine half fully droppable after this.** |
| 4 | T8-T10 both runners + openapi regen | pending | `schedule-ai-route`, `competition-schedule-ai-route`, `competition-schedule-ai-http`, `ai-credit-wallet-spend` all green; `openapi/` clean after regen |
| 5 | T11-T12 UI/i18n/e2e/smoke/help | pending | 4 dicts + `i18n:check`; screenshots desktop **and 375px**; e2e local prod build; smoke extended; help extended; review; PR |

**Context discipline in force:** agent transcripts are never read (full JSONL — one read
overflows), vitest results are projected through `node -e` rather than dumped, and every
broad read is delegated to a scout. A compaction landing at any boundary above loses
nothing that this file does not already carry.

## Facts already established — do NOT re-derive

- `npm install` has been run in the worktree; `node_modules` exists.
- `z3-solver@5.0.0` spiked and works on node 26: `init()` ~160 ms; `solver.set("timeout", ms)`
  → `check()` returns `"unknown"` with `reasonUnknown() === "timeout"`; `check(...assumptions)`
  + `[...solver.unsatCore()]` names exactly the conflicting assumption literals;
  `Z3.AtMost(boolArray, k)` takes an **array**, not varargs; same seed → identical model twice;
  `em.PThread.terminateAllThreads()` is required or node hangs on worker threads.
  Assumption literal names must avoid `:` (z3 renders `|fam:court|` quoted) — use `fam_court`.
- Verifier contract (`packages/engine/src/scheduling/calendar.ts`, 1012 lines):
  `validateAssignments` :791, `validateInstructionRules` :657, private `effectiveHard` :649,
  `restFor` closure :812-826, `windowFor` closure :831-844, `scopeCoversFixture` :585,
  `resolveSelector` :607, `effectiveRestMinutes` :82, `isBlockingConflict` :185,
  `deltaConflicts` :204, `conflictKey` :168, `RULE_BY_REASON` :130.
- **`pairRestMinutes` is asymmetric, and the rule differs by pair kind** (review finding,
  boundary 1 — an earlier version of this note said "always max" and was WRONG):
  - movable vs movable → `max(f(c,i,j), f(c,j,i))` (both orderings are evaluated).
  - movable vs **immovable/`existing`** → exactly `f(c, movable, immovable)`, **no max**,
    because only the movable side is ever the outer `a` in `validateAssignments`.
  Max against an immovable → spurious `infeasible`. Wrong single direction → the verifier
  rejects the "repaired" board. Asymmetry exists because `effectiveRestMinutes` reads the
  FIRST argument's pool/division.
- **`pairRestMinutes` must not re-derive `effectiveHard`/`ruleFixtures` per call** — it sits
  in the O(n²) rest loop and cost 47 ms → 5242 ms (111×) on a 500-fixture board before the
  hoist. The exported signature stays `(config, a, other)`; the hoisted internal form is
  what `validateAssignments` and the solver's inner loops use.
- `WeekdayCode` is UPPERCASE (`"FRI"`), `constraints.ts:76`.
- No frozen 13-slot clean badminton schedule exists yet — T4 builds one and exports it
  from `payload-fixtures.ts` as a NEW export (never modify existing ones there).
- Web integration: `schedule-ai.ts` verify :1789, split :1790-1791, repair send :1798-1804,
  `finalizeFrom` :1679-1704, `AiPlanResult` :1340-1358, `verifyConfig` :1481,
  `toObstacleAssignments` :1454, `packFeedDependencies` :1546, `ROUND_TIMEOUT_MS` :1203,
  `MAX_REPAIR_ROUNDS` :1204. `competition-schedule-ai.ts` has its OWN repair loop
  (verify :1400, `repairRounds` :1618/:1626/:1731/:1735) — two integration sites, not one.
- `COMPETITION_MOVABLE_CAP = 500` at `competition-schedule-ai.ts:129`.
- Adding a field to the AI-plan response **trips the CI-only OpenAPI drift gate** →
  `npm run openapi:gen` + commit `openapi/v1.json` and `openapi/v1.public.json`.
- **`board.ai.repair.*` is already taken** (scoped-repair CTA, `en/ui.json:18-24`).
  New keys go under `board.ai.repaired.*`. Plurals are `.one`/`.other` via `usePlural()`.
  i18n script is `i18n:gen-keys` (NOT `gen-keys`), `package.json:33/35`.
- Help tree is `apps/web/content/help/`; extend `scheduling/ai-scheduling.md`;
  slug registry `apps/web/src/lib/help.ts`.
- e2e: `apps/web/e2e/ai-architect.spec.ts` + `ai-fixture-server.ts` (`FIXTURE_REFUSE` :56 is
  selected by instruction-text substring; `buildSchedulePlan` :120-141). Mobile describe :1057.
- smoke assertion style is `check("<label>", <boolean>)`.
- `plan.assumptions` is a DEAD field (#400) — never render it.
- **A FIFTH way a vitest count lies, found this wave.** `packages/engine`'s own `test`
  script is already `vitest run`, so `npm test --workspace packages/engine -- run …`
  expands to `vitest run run` — that second `run` is a **filename filter matching
  nothing**, and the suite reports `0/0/0` with exit 1. Drop the `run`. Belongs beside
  the four shapes in [[vitest-count-masking]].

- **`packages/engine` BANS ambient time in `src/**`, tests included** —
  `scripts/engine-boundary.ts`, enforced by `test/boundary-gate.test.ts`. No `Date.now()`,
  no argless `new Date()`. Use `performance.now()` for an elapsed span. The repair budget
  loop has to take its clock from there or from an injected source.
- **Engine source has NO lint config** (root `lint` covers `apps/web` only), so
  `tsc --noEmit` is the only static gate on `packages/engine`.
- The internal hoisted form is `pairRestMinutesWith(hard, fixtureById, config, a, other)`
  and is NOT exported; the O(n²) solver encoder must use an exported **factory** that
  derives once, never the per-call wrapper, or the 111× cost returns inside the encoder.

- **`vitest.config.ts:8` sets `isolate: false`, so `vi.resetModules()` clears the registry
  for the WHOLE worker.** A binding imported before the reset and one imported after are
  two different module instances — two `z3-load` singletons, two `count`s, two WASM boots,
  and a `z3LoadCount()` assertion that can pass vacuously against the wrong instance.
  Re-import every touched module on the same side of the reset; `resetZ3()` in teardown.

## Open, non-blocking — fix after boundary 2 lands

Carried from the boundary-1 re-review (verdict: Approved). All three are on the test-only
path in `z3-load.ts`; none blocks the solver.

1. `z3-load.ts:67-73` — `resetZ3`'s `finally` clears `loaded`/`count` unconditionally while
   the failure path is identity-guarded, so a concurrent `resetZ3` can orphan a successor
   instance (never shut down) and the next `loadZ3` boots a second WASM. Fix: capture
   `const current = loaded` before the `try`, guard the `finally` with `if (loaded === current)`.
2. `z3-load.ts:55` — `count--` on failure makes a failed boot invisible to `z3LoadCount()`,
   which exists precisely to prove the WASM was never touched. Either split
   `attempts` from successful loads, or say "successful loads" in the header comment.
3. `z3-load.test.ts:31-33,66-67` — the `vi.resetModules()` note above; add a comment or
   opt the file into isolation once the solver imports the loader.

## Verify commands (cd must be in the SAME bash call — cwd resets)

```
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/w6-z3-repair && \
  npm test --workspace packages/engine -- --reporter=json --outputFile=/tmp/w6.json; \
  node -e "const r=require('/tmp/w6.json');console.log('pass',r.numPassedTests,'fail',r.numFailedTests)"
```
Judge green ONLY from that JSON. Never pass path positionals (silently treated as filters).
Never run `UPDATE_GOLDEN=1`. Never `git stash` in this worktree (shared stack).
