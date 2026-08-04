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
| 2 | T3-T5 repair-domain, repair.ts, repairAndVerify | **in progress** — `9c145f55`/`a526ee3c`/`cff11b0e`, review NEEDS FIXES (2 CRITICAL), all 9 fixed in `63f2ef1c`/`d94b18b2`/`91bbc54b`. **Orchestrator gate re-run: 1566 pass / 0 fail / 427 suites, 0 outside worktree, tsc 0, 0 goldens, 0 pre-existing tests touched. Re-review in flight.** | badminton +1 clash moves **exactly 1** fixture (12 anchors byte-identical); Stepladder 13-violation → verifier-clean, both finals Friday; determinism twice; infeasible names families; timeout returns cleanly; `z3LoadCount()===0` on the clean path |
| 3 | T6-T7 bench + budget + engine gate | **code landed** — `db1de378`, `c7c5a5dc` (see "T6 measured" below; orchestrator gate re-run 1572/0/430, tree clean, 0 goldens). `DEFAULT_REPAIR_BUDGET_MS = 20_000`, measured. **The bench found a blocker for boundary 4: the solver cannot reach 500 movable at any budget — the feasibility probe alone exceeds 119 s from ~80 movable up.** | measured 20-500 table recorded; `DEFAULT_REPAIR_BUDGET_MS` set FROM it; goldens untouched. **Engine half fully droppable after this.** |
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

- **Boundary-2 review found a reproduced hole and it is now closed.** The class of bug to
  keep watching for: any path where a constraint `validateAssignments` ENFORCES is not
  ENCODED. It appeared as `span` being the intersection of ALL families — a fixture with an
  unsatisfiable *relaxable* instruction got `span: null`, which was then read as "cannot
  interact with anything", dropping it from `candidatePairs` AND the movable×immovable loop,
  so it carried no court/person/rest constraint at all. `repairSchedule` returned
  `clean, moved: []` on a board the verifier scored as 2 blocking `court` conflicts.
  **Rule that came out of it: prune on `BLOCKING_FAMILIES` + the universe ONLY, and an empty
  domain must still be encoded against everything else.**
- Post-fix solver surface, for the integration tasks:
  `RepairVerificationError` gained `kind: "encoding_drift"` (zero moves on a proven-dirty
  board is now an ERROR, never `clean`); new relaxable family **`order_soft`** carries
  indirect (`direct:false`) deps, which `isBlockingConflict` ignores; `BLOCKING_FAMILIES`
  now lives in `repair-domain.ts` and is re-exported from `repair.ts` alongside
  `REPAIR_FAMILIES`/`RepairFamily`; sessions are encoded under the relaxable `blackout`
  family (matching the verifier's reason) while the pack window stays enforced
  unconditionally; the budget now covers `loadZ3` + encode, sampled every 1024th pair.
- **The C1 bug class struck TWICE — watch for it in every future encoder change.**
  Second instance (re-review, `assertDayCap`): `max_fixtures_per_day` was asserted per
  BUCKET, but with `sessionWindows` a bucket is a SESSION, not a day — two sessions on one
  day let a `count:1` cap admit two fixtures, and the immovable subtraction ran once per
  bucket instead of once per day. **The invariant: every encoder assertion must use the
  VERIFIER'S unit.** Cheap detection: any board where the encoder's grouping key and the
  verifier's grouping key can differ (session vs day, court vs venue, pool vs division).
- **THE DOMINANT BUG CLASS OF THIS WAVE — four instances, every one invisible to a green
  suite and caught only by a probe: _an encoder unit that is not the verifier's unit._**
  1. span-vs-family (pruned on relaxable families → a fixture got no constraints at all);
  2. bucket-vs-day (`assertDayCap` per session bucket, cap admitted 2/day);
  3. clipped-window-vs-calendar-day (bucket 0 clipped to `window.from` → starts escaped the cap);
  4. session-label-vs-calendar-day (a session crossing local midnight is labelled
     `dayKeyInTz(w.from)`, so `not_before`/`not_after`/`fixture_on_date` admit starts the
     verifier judges against the NEXT day) — **RESOLVED `f8d202ce`**: private
     `splitAtMidnights(from,to,tz,out)`, used by BOTH `dayBuckets` branches, so `ymd` is the
     org-zone date of every instant in the bucket. Steps via
     `zonedTimeToUtc(ymdAddDays(ymd,1),"00:00",tz)` so the 25-hour fall-back day survives
     (pinned by a test). Repro was: one court, London session 22:00 Mon → 02:00 Tue,
     `fixture_on_date "2026-08-10"`, Monday half filled — the only ONE-move fix lands after
     midnight and the verifier scores it Tuesday; the honest answer costs two moves.
  **Encoder-unit spot-check now CONFIRMED across the whole encoder** (second agent, independent):
  court clash keys a bijective index over `repairCourts` (config ∪ board labels, so an immovable
  is never missed); person/rest via `sharesParticipant` = entrants ∪ people, matching the
  verifier's two loops; feed edge on `extKey` + `divisionId`, character-for-character; day cap
  on `calendarDaysCovering`/`dayKeyInTz`; scope via the imported `scopeCoversFixture`. Session
  `normalise` fusion is sound (runs fuse only when they touch and coverage carries).
  **Standing check for every future encoder change:** name the grouping/counting key the
  encoder uses, name the one `calendar.ts` uses, and prove they are the same key. Everything
  else in the encoder groups by court label, participant id or feed edge — all verifier keys.
- **RESOLVED** (`97f31b62`) — instance 3 above. Fix is whole org-zone calendar days via
  `calendarDaysCovering(range, tz)`, padded one day each end (the start bound is applied in
  whole minutes), grouped over `config.window ?? universe ± START_GUARD_MS`. A windowed board
  still gets exactly one group per window day, so the common case is unchanged. A per-fixture
  `Or(day literals)` stays under `instruction` as a **completeness clause** so a truncated day
  walk relaxes-and-reports instead of silently under-enforcing.
  **Do not "simplify" to the `Or` alone — it was implemented and measured first: it makes the
  cap unsatisfiable inside the universe and the pigeonhole UNSAT proof burns the whole budget,
  60 s timeout vs 1.8 s repaired on the same board.**
- **RESOLVED (superseded)** — the entry below was instance 3 before the fix; kept for the
  reproduction only:
  the day cap's buckets are clipped to the universe, but the verifier counts whole calendar
  days. `dayBuckets` (`repair-domain.ts:175-183`) clips bucket 0 to `window.from`, so with
  **no pack window AND no session windows** (`repairUniverse` = board extent ±7 days) bucket 0
  covers only part of its `ymd`; starts in the clipped-off remainder are counted by no day
  literal and escape the cap. Reproduced at 20 fixtures / `max_fixtures_per_day: 1`:
  `repaired` with **`relaxed: []`** and the verifier returning 10 conflicts
  (`6 fixtures on 2026-08-03 exceed the 1/day cap`); `repairAndVerify` throws.
  Sound WITH a pack window (buckets and the never-relaxed `window` family clip to the same
  instants), so the gap is exactly the no-window/no-session config M6's finite-model guard
  singles out. Fix: build the cap's buckets over whole calendar days (or the ±30-day guard
  range), or assert every start falls inside some bucket when a day-shaped rule exists.
  Probe: `scratchpad/probe-cap2.mjs`. **Third instance of the encoder-unit-vs-verifier-unit
  bug class.**
- **DECOMPOSITION SPIKE — measured, and it makes the full 500 range reachable. This is the
  design boundary 4 must be built on.** (scripts: `scratchpad/graph.ts`, `scratchpad/decompose.ts`)
  - **The candidate-pair graph is COMPLETE — partitioning it is a dead end.** 124,750/124,750
    pairs at n=500, one component of 500, every size and density. `span` is blocking-only and
    `window` is the only per-fixture blocking interval, so every span is the whole pack window
    and any two cards can be moved onto one court. **Do not try to partition `candidatePairs`.**
  - **What works is FREEZE-AND-COMMIT-SEQUENTIALLY, not partition.** Build the graph over
    CURRENT PLACEMENTS (same court / shared person within `maxSeparationMinutes`, plus order
    deps); solve one component with the entire rest of the board frozen into `existing`;
    commit; move on. Graph build is 1-2 ms.
  - Component sizes n=500: 46 comps light / 40 dense, **max 36 / 39**. Bounded by the busiest
    DAY (courts × slots), never by board size — the overnight gap exceeds
    `maxSeparationMinutes`, so a component can never span two days.
  - Measured end-to-end at a 20 s per-component budget, all verifier-clean, all at provably
    minimal `k`: 120 → 4.5 s / 13.9 s · 250 → 9.8 s / 50.0 s · 500 → **38.9 s / 145.0 s**
    (light/dense). Today: does not return in 119 s. Peak RSS 643 / 903 MB at n=500.
  - **Anytime property:** each component commits independently, so exhausting the budget
    yields a PARTLY repaired board rather than nothing. Any partial result must still be
    verified before it is returned.
  - **Minimality is proved by a CERTIFICATE, not by the ring-expansion argument.** Restricting
    the movable set can only raise `k` — true, so a result is an upper bound. What proves
    minimality is a lower bound: an independent set of DISJOINT conflicts each needing ≥1 move.
    When found `k` meets that bound, minimality is proved. Ship the certificate check.
  - **Per-component gate: 50 movable.** From the T6 curve read per-component (40→8.2 s,
    50→8.8 s, 60→43.8 s, 70→68.9 s, 80→never) plus a measured 1.5-2× cost for ~465 frozen
    cards. Fires on a busy DAY, never on a big board — a far weaker constraint than the
    board-size gate #401 forbids. Above it: skip to LLM repair, telemetry-visible.
  - **Pathological case degrades gracefully:** a single-court continuous chain is one
    component by construction (measured n=60/80/120 → one solve, 20 s timeout, zero repair =
    today's behaviour + 1 ms). Real one-court venues cap at 16-20 cards/day, under the cliff.
  - **`max_fixtures_per_day` COUPLES components.** Freezing converts a card's cap contribution
    from an `AtMost` literal into a decrement of the bound — sound, but **only if every frozen
    fixture appears in `config.ruleFixtures`**, because `assertDayCap` filters `existing` by
    `fixtureById.has()`. A frozen fixture missing from `ruleFixtures` is invisible to the cap,
    under-counts, and the verifier rejects a board the solver called repaired — the SAME bug
    class again. Also, sequential commits make the cap ORDER-DEPENDENT: solving A first can
    fill a day B then cannot use. With a day cap the result stays SOUND but LOSES the
    minimality proof. Say so in telemetry rather than claiming minimal.
- **ROOT CAUSE FOUND for the WASM abort, and it is the opposite of the hopeful theory.**
  Decomposition makes it WORSE, not better: many medium solves share one monotonically-growing
  WASM heap and nothing frees the per-component `Solver` and its terms. Reproduced
  deterministically — **3/3 runs died without a reset between components**
  (`RuntimeError: memory access out of bounds` from the pthread worker, at components 7/14,
  11/16, 13/24) and **0/3 with `await resetZ3()` between solves**. `resetZ3()` between
  component solves is MANDATORY and nearly free: ~1 ms teardown, ~200-300 ms reboot absorbed
  into the next solve. This also explains both earlier sightings (mixed workloads, one heap).
- **PRE-EXISTING PRODUCT BUG, confirmed by a scout, NOT introduced by W6 and deliberately NOT
  fixed here — `min_rest_minutes` feeder-rest has never fired in production.**
  `RuleFixture.winnerTo` carries `fixtures.winner_to_fixture` (**uuid** FK,
  `V214__fixtures.sql:14`); `RuleFixture.extKey` carries `fixtures.ext_key` (**text**,
  `V214__fixtures.sql:31-33`). `calendar.ts:707` joins them with
  `d.extKey !== f.winnerTo`, and `repair.ts:491` carries the same join. **No conversion site
  exists anywhere in the codebase** — an earlier claim that `stages.ts:908` maps uuid→ext_key
  is false; that line does not exist and `stages.ts:957-1075` is bracket-wiring SQL that
  WRITES `winner_to_fixture = <target id>`. So the comparison matches zero pairs on real data.
  Affected: `schedule-ai.ts:1489`, `competition-schedule-ai.ts:1359` and `:1531`, all tracing
  to `schedule-ai.ts:976`.
  **Why the suite is blind:** every engine test sets `winnerTo` to a string equal to some
  fixture's `extKey`/`id` (`calendar-instruction.test.ts:22-25` — the `rf` helper defaults
  `extKey = id`; `repair.test.ts:349-351,492-494,530-532`;
  `repair-domain.test.ts:136,280-281,395-397`; `payload-fixtures.ts:141-144`;
  `calendar-shared-semantics.test.ts:146`). `competition-schedule-verify.test.ts:1169` uses a
  real UUID but pairs it with `ext_key: null`, so it exercises the `terminal` selector, not the
  feeder-rest join. **No test pairs a real UUID `winnerTo` with a real ext-key `extKey`.**
  Encoder and verifier agree, so `repairAndVerify` cannot catch it — the safety net is blind
  because both halves share the assumption.
  **Why it stays out of W6:** (1) fixing it changes SHIPPED verifier behaviour — boards that
  validate clean today would start reporting feeder-rest conflicts, which needs its own
  decision about existing data; (2) W6's scale evidence was measured with this join matching
  NOTHING, so making it fire adds real constraints and could change component sizes — the very
  thing that makes 500 movable reachable. Folding it in would invalidate the bench.
  **Fix sketch for the follow-up issue:** either resolve `winnerTo` to an ext key when building
  `RuleFixture` (a map of the right shape already exists at `schedule-ai.ts:724`, `extKeyById`,
  currently used only to rewrite assumption text), or change both joins to compare on fixture
  id. Either way the regression test MUST pair a real UUID with a real ext key — the current
  helpers make the bug invisible by construction.
  **FILED as issue #443** (2026-08-04) with the full evidence, the fix sketch, and the
  non-negotiable test requirement.
- **A SEVENTH way a count lies, and it fires on EVERY worktree: no `.env.local`.**
  `.env.local` is gitignored, so `git worktree add` does not carry it. `apps/web/vitest.config.ts`
  loads `../../.env.local` to supply `DATABASE_URL`, and every DB-backed suite is
  `describe.skipIf(!HAS_DB)`. Without the file the run is **green and meaningless**: measured
  here at `pass 3394 / fail 0 / pending 1822 / total 5216` against a 6857-test baseline —
  about **1640 tests deleted from the run**, with a 0-failure headline. The `pending` count is
  the tell; the `pass` count is not. Fix: provision a fresh DB and export the URL for the run.

  ```
  createdb -h 127.0.0.1 -p 54329 -U postgres seazn_w6
  DATABASE_URL="postgresql://postgres@127.0.0.1:54329/seazn_w6" DATABASE_SSL=disable \
    npm run db:apply && ... npm run sync:sports     # BOTH — sync:sports or the sport catalog is empty
  DATABASE_URL=... DATABASE_SSL=disable AUTH_SECRET=<any> NEXT_PUBLIC_SUPABASE_URL="" \
    npm test --workspace apps/web -- --reporter=json --outputFile=/tmp/w6-web-db.json
  ```
- **A SIXTH way a count lies in this repo, and it is the nastiest: MACHINE CONTENTION.**
  Measured, not inferred: a fixed JS CPU unit costs **93 ms idle vs 464 ms (5x)** while other
  agents run suites. At 5x the n=120 encode blows a 2.5 s budget **inside the O(n²) encode**,
  so `check()` is never reached and the assertion reads `checks === 0`. Same mechanism explains
  `12745 ms vs a 7000 ms bound` (idle overshoot on n=500 is only **98 ms**) and a 9-failure
  `repair.test.ts` set that vanishes on an idle machine.
  **This cost a wrong diagnosis:** three failures were attributed to `8363cb7f`'s budget
  widening purely because they appeared after it. They cannot be — the decompose test runs in
  `components` mode where the new ternary picks the IDENTICAL `Math.min(...)` branch. A probe
  calling `repairSchedule` directly, with nothing from `repair-decompose.ts` on the path,
  reproduces the failure. **Correlation with a recent commit is not causation; get the
  mechanism.**
  Consequence for CI: this repo runs suites concurrently, so solver tests that pass on an idle
  laptop WILL be flaky in CI. The fix must be structural — calibrate a CPU unit in the same run
  and scale **test bounds** by a clamped factor.
  **NEVER scale the production solver budget by that factor.** The web runner passes 45 s
  deliberately (sized against `ROUND_TIMEOUT_MS` and two full-ceiling components); a 5x host
  would turn that into 225 s inside an HTTP request — invisible at the call site. A slow host
  must produce a `timeout` + telemetry-visible fallback, which is what #401 asks for. Scaling
  the encode loop's clock-SAMPLING granularity is fine (it does not move the deadline, only the
  precision of honouring it); scaling the deadline is not.
  **The half-built calibration in the tree has a latent bug — fix it before trusting it.**
  `solver-load-factor.ts`'s `workUnit()` runs **5M iterations costing ~115 ms** on this box,
  while `REFERENCE_UNIT_MS` claims **23 ms**. So on a fully IDLE machine the factor reads a
  constant ~5x and silently loosens every scaled bound — a calibration that always says
  "the machine is slow" is worse than none, because it disables the bounds while looking
  principled. Measured correction: **1M iterations = 23.1 ms, stable**, which makes the shipped
  constant honest and the calibration cost ~70 ms as documented.
  Also seen: a **927 s / 961 s wall on a 2.5 s budget** — almost certainly host suspend, not a
  solver bug. Do not go hunting when an absurd elapsed value appears.
- **THE WASM ABORT IS FIXED — root cause was the TEST FILE, not the solver** (`8dc64b69`).
  `repair.test.ts` ran ~20 solves against ONE WASM heap (`isolate: false` shares the module
  registry file-wide) with only an `afterAll` reset; nothing frees a solve's `Solver` and terms,
  so the heap only grew and the pthread worker died mid-solve. The production path already knew
  this — `repairDecomposed` resets between components for exactly this reason — the test file
  was the one place NOT doing it. Adding `afterEach(resetZ3)` took the aborts from **8 to 0**.
  Tightening the budget sampling did not cause it; it changed where a timing-out encode stops,
  left more partial work per test, and moved the threshold.
  `repair-verify.test.ts` deliberately has NO such hook — it already resets modules per test and
  shuts its own instance down in a `finally`. Do not "fix" it.
- **THIS HOST SUSPENDS MID-RUN — do not chase timing failures on it.** Measured: a **3 s budget
  produced a 986 s wall**, matching 927 s / 961 s seen earlier by another agent. Symptoms:
  `STACK_TRACE_ERROR` timeouts, vitest runs that die WITHOUT writing their JSON report, and
  wall-clock assertions off by two orders of magnitude. Post-fix the residual failures are in
  `roundrobin`, `swiss`, `carrom`, `simulation` — suites this wave never touched — plus a
  marginal 1510 ms vs 1500 ms perf bound. **A clean engine gate is not obtainable here; CI must
  judge.** Do not "fix" these by loosening bounds.
- **Budget sampling is now every 128 pairs / 16 fixtures** (was 1024 / 64). This is a PRODUCT
  fix: the window is how far past its deadline a call may run before noticing, and one chunk of
  z3 term building stretches with the host — tens of ms idle, **19 s loaded** against a 3 s
  budget. The web runner passes 45 s and must get 45 s. A `performance.now()` read is tens of
  nanoseconds against 128 term allocations, so the tighter window is not measurable in the
  encode's cost.
- **`timedUnderLoad` exists because calibrating once per FILE measured the wrong moment** —
  module scope runs at IMPORT time, before the worker pool saturates, so the factor honestly
  read ~1 and then scaled a bound applied to a call that ran under full contention. It now
  samples both sides of the timed call and keeps the worse.
- **OPEN — `atABudgetThatReachesTheSolver` doubling is expensive under load.** On a slow host
  every attempt runs to its full budget, so one test can burn 5+10+20+40 s. A cheaper
  construction that gets the same guarantee: shrink the BOARD instead of raising the budget —
  the feasibility probe is intractable from ~80 movable up, so n≈80-90 has a small fast encode
  and a probe that still never returns, reaching `check()` in one attempt at any speed. n=120
  was overshooting into "the encode is the bottleneck". Worth doing when a stable host is available.
- **OPEN — rounding, not grouping (5th encoder/verifier mismatch, different family).**
  `repair.ts:378-379` bounds an IMMOVABLE with `roundMin` (`Math.round`) while movable domains
  use conservative `ceilMin`/`floorMin`. An obstacle with sub-minute endpoints can therefore be
  cleared by up to **30 s less** than the verifier demands. Found by inspection, NOT reproduced.
  Cheap to fix (use the conservative direction on both sides); needs a probe first to confirm
  sub-minute endpoints are reachable from real payloads at all.
- **OPEN CRITICAL — z3 can abort the PROCESS, not return `timeout`. SEEN TWICE now, so the
  bench's 0-in-50 does NOT refute it** — the bench ran one synthetic board family; both
  sightings came from mixed/real-shaped workloads. Second sighting: a combined
  `repair-domain.test.ts` + `repair.test.ts` run died with `Cannot enlarge memory arrays … (OOM)`;
  both files pass individually and in the full gate. Working theory: the abort needs several
  distinct WASM contexts or a large heap already in play, which a single-board bench never
  builds. **Do not close this on a clean bench run.** One of two identical
  20-fixture runs died with an emscripten `_emscripten_resize_heap` OOM inside
  `rewriter_tpl<maximize_bv_sharing>`. Unrecoverable WASM abort — no `try/catch` contains it,
  so in production it takes the web process down and defeats "solver failure must never fail
  the run". Non-deterministic. T6 is measuring frequency and peak heap at 250/500; mitigation
  (memory cap / solver in a worker thread / hard size ceiling) is an ARCHITECTURE decision for
  the integration task and must be chosen from those numbers. **A wall-clock budget is
  worthless if the process dies before the deadline.**
- **Resolved, NOT a bug:** the day cap being absent from the relaxed path is safe. It is
  asserted under `instruction`; `validateInstructionRules:745-751` reports a breach as
  `reason:"instruction"`, which `isBlockingConflict` does not cover, so relaxing it yields
  only non-blocking conflicts, which `repairAndVerify:538` filters. Family ↔ reason ↔ blocking
  is consistent. Do not re-open.
- **T6 budget-bench inputs, measured by the reviewer at N=500 / 124,750 pairs:**
  the unbudgeted prologue (pre-check `validateAssignments` + `buildDomains` +
  `candidatePairs` + WASM boot) is **282 ms** — `budgetMs:1` still returns `elapsedMs 282`.
  Budget overshoot from the 1024-pair sampling granularity is **~30-80 ms**
  (`budgetMs 1000` → `elapsedMs 1032`). The encode does NOT finish inside 1 s at N=500.
  Do not let the bench read the 282 ms prologue as solve time.
- **Deferred optimisation, decide AFTER T6's bench, not before:** the pruner is currently
  near-useless because one encoding serves two assumption sets, so spans must be
  blocking-only. A sound recovery is TWO encodings — full-family spans for the strict pass,
  blocking-only spans for the fallback. Only worth the complexity if the measured N=500
  number actually threatens the budget. Do not build it speculatively.
- **Feeds T6's bench:** with only `window` being a per-fixture interval list among the
  blocking families, the pruner now rarely drops a pair, so the O(n²) encode at 500 movable
  is close to unpruned. That cost is real and must be measured, not assumed.
- `swiss.test.ts` "chess colour bounds hold (n up to 64)" is a **pre-existing flake** —
  fast-check property test on the default 5 s timeout, dies under pool contention. Passes
  alone and on rerun. Untouched by this wave; do not chase it.

## T6 measured — the bench, the table, and what it says

Run with `node --experimental-strip-types packages/engine/scripts/bench-repair.ts`
(`--sizes --densities --repeats --budget`). One CHILD PROCESS per run, so a WASM abort is a
recorded row instead of a vanished bench. Board: `repair-synthetic-board.ts`, seeded, 4
courts, 40 fixtures/day on a 50-minute pitch, explicit pack window + one session window per
day, feed chains of 4, entrants repeating within and across days. Clean baseline verifies
0 conflicts at every size; `k` therefore counts exactly the injected clashes. NO `hard`
instruction rules and NO `max_fixtures_per_day` — the clipped-bucket day-cap bug is under
review and a board using it would measure an encoding that is about to change.

Machine: darwin arm64, node v26.4.0. All times ms. "1-in-N" = one clash injected per N
fixtures. Three repeats each at 45 s budget unless noted; run-to-run spread was under 1%.

| n | 1-in | pairs | prologue | encode | probe | search | total | k | checks | status |
|---|---|---|---|---|---|---|---|---|---|---|
| 20 | 20 | 190 | 275 | 145 | 417 | 114 | **952** | 1 | 3 | repaired |
| 20 | 5 | 190 | 281 | 146 | 416 | 296 | **1 140** | 4 | 6 | repaired |
| 40 | 20 | 780 | 279 | 343 | 5 903 | 1 641 | **8 166** | 2 | 4 | repaired |
| 40 | 5 | 780 | 282 | 312 | 2 101 | 3 584 | **6 279** | 8 | 10 | repaired |
| 50 | 20 | 1 225 | 173 | 270 | 2 003 | 838 | **3 283** | 2 | 4 | repaired |
| 50 | 5 | 1 225 | 181 | 278 | 2 361 | 5 974 | **8 794** | 10 | 12 | repaired |
| 60 | 20 | 1 770 | 255 | 574 | 8 169 | 3 186 | **12 184** | 3 | 5 | repaired |
| 60 | 5 | 1 770 | 242 | 519 | 14 195 | 28 825 | **43 781** | 12 | 14 | repaired |
| 70 | 20 | 2 415 | 226 | 649 | 25 120 | 2 417 | **28 412** | 3 | 5 | repaired |
| 70 | 5 | 2 415 | 233 | 640 | 22 937 | 45 096 | **68 906** | 14 | 16 | repaired |
| 80 | 20 | 3 160 | 226 | 789 | 119 180 | — | **120 196** | — | 1 | timeout (120 s budget) |
| 80 | 5 | 3 160 | 335 | 1 121 | 118 807 | — | **120 263** | — | 1 | timeout (120 s budget) |
| 120 | 20 | 7 140 | 183 | 1 200 | 43 778 | — | **45 161** | — | 1 | timeout |
| 120 | 5 | 7 140 | 193 | 1 361 | 43 626 | — | **45 180** | — | 1 | timeout |
| 250 | 20 | 31 125 | 223 | 4 718 | 40 259 | — | **45 201** | — | 1 | timeout |
| 250 | 5 | 31 125 | 261 | 5 420 | 39 595 | — | **45 276** | — | 1 | timeout |
| 500 | 20 | 124 750 | 329 | 21 210 | 24 414 | — | **45 953** | — | 1 | timeout |
| 500 | 5 | 124 750 | 363 | 24 927 | 20 434 | — | **45 724** | — | 1 | timeout |

Prologue splits at n=500: pre-check 46-87, WASM boot 189-296, domain build 52-67. Peak RSS
206 MB at n=50, 345 at 120, 588 at 250, **906 at 500**.

- **THE HEADLINE: the cliff is between 70 and 80 movable, and it is the FEASIBILITY PROBE,
  not the ascending-k search.** At n≥80 `check(REPAIR_FAMILIES)` with no `AtMost` bound does
  not return in 119 s; every run at 120/250/500 spent its whole budget on `checks: 1`. The
  probe is also the expensive half BELOW the cliff — at n=70 light it is 25 s against 2.4 s
  for the entire k=0..3 walk it exists to protect. The probe is a fail-fast optimisation
  that costs ten times the search.
- **Consequence for #401's "NO fixture-count gate, solve the full 500 movable range":** the
  encoding as it stands cannot. 500 movable is not slow, it is unreachable — 21-25 s to
  encode 124,750 pairs and then a probe that never returns. A larger budget does not help
  (20 s → 60 s → 120 s changed nothing at any size ≥80).
- Density matters far less than size. n=500 dense and n=500 light are within 10% of each
  other; both die in the probe. Below the cliff density drives `search` only (k+1 checks).
- Not the cause, checked and eliminated: the 5-minute grid `s.mod(grid)` (`gridMinutes: 1`
  → 58.8 s probe at n=120, unchanged) and the session-window `blackout` intervals (removed
  → 58.8 s, unchanged). It is the O(n²) disjunctive court/rest encoding itself.
- **Two-encoding pruning recovery (deferred at boundary 2) would NOT fix this.** It targets
  encode time; encode is 21-25 s of a run whose probe alone exceeds 119 s. Worth much more:
  skipping or bounding the probe, and containing the solver.
- **`DEFAULT_REPAIR_BUDGET_MS = 20_000`**, from the rule: 2× the worst total among boards
  repaired at every measured density inside 10 s (n=50 dense, 8 794 ms), rounded up to the
  next 5 s. Covers everything to n=60 light. 15 s would also have been defensible; 20 s
  buys the 2× host-speed headroom without buying any board the solver cannot reach anyway.
- **WASM abort: 0 in 50 runs** (30 of them completing solves at n=20..70; 20 at n≥120).
  Peak RSS never exceeded 906 MB. The reviewer's `_emscripten_resize_heap` abort at 20
  fixtures did NOT reproduce here — but 0/50 on one board family does not refute a
  non-deterministic abort, and note that every 250/500 run died on the wall clock inside
  the probe rather than deep in a search, which is where heavy rewriting allocates.
- The reviewer's "prologue is 282 ms at N=500" does not reproduce on this board: the
  pre-check is 46-87 ms and the whole prologue 329-363 ms. `budgetMs: 1` returns straight
  after `validateAssignments`, before `loadZ3`, so that 282 ms was a pre-check on a board
  carrying more rule work than this one (instruction rules / `ruleFixtures`).
- Termination is covered by `repair-scale.test.ts`: 500 movable at a 3 s budget returns in
  3.1 s (budget expires mid-ENCODE), and 120 movable at a 5 s budget returns in 5.2 s
  (budget expires inside `check()`, `checks >= 1`). Mutation-verified: disabling the
  encode's budget sampling takes the first from 3.1 s to 20.7 s.

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
