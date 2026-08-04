# W4a follow-ups — handoff

Written 2026-08-04. Branch `fix/w4a-followups`, stacked on `feat/w4a-core-time`
(PR #444). Worktree `.claude/worktrees/w4a-followups`.

Five tasks remain. Each section below is self-contained: read only the section
you are working on, plus **Before you start** and **How to gate**.

---

## Before you start

### 1. Check engine resolution — this silently invalidated three agents

A worktree whose `node_modules` is a symlink to the main checkout resolves
`@seazn/engine` to **main's** engine, not the branch's. Every `apps/web`
typecheck, vitest run and `next build` then compiles the wrong code while
`packages/engine`'s own gate stays green.

```
readlink -f node_modules/@seazn/engine     # MUST print a path inside the worktree
```

If it points outside, fix it once — do not work around it per-run:

```
unlink node_modules            # link only; never rm -r
mkdir node_modules
MAIN=/Users/ashokhein/github/seazn.club/node_modules
for e in $(ls -A "$MAIN"); do [ "$e" = "@seazn" ] || ln -s "$MAIN/$e" "node_modules/$e"; done
mkdir -p node_modules/@seazn
ln -s ../../packages/engine node_modules/@seazn/engine
ln -s ../../apps/web        node_modules/@seazn/web
```

Symptom to recognise: `apps/web` errors about engine symbols the branch
demonstrably contains, while the engine suite is green on those same symbols.
On this branch it showed up as `NON_MONOTONIC_TIME` "missing" from
`EngineErrorCode` — present at `core/errors.ts:31`, absent on main.

### 2. Never run `UPDATE_GOLDEN=1`

A red golden means the change was not additive. Fix the change. `EXTEND_GOLDEN=1`
is the sanctioned append-only pass, and after running it verify the prefixes
yourself rather than trusting the run's own assertion — parse each corpus
against a pre-run copy and confirm `streams.slice(0, before.length)` is
unchanged and every non-stream top-level key is byte-identical.

### 3. Engine constraints that apply to every task here

- All 11 sport modules stay at version `1.0.0`. `registry.get(key, version)` is
  an exact lookup with no fallback.
- Any new payload/cfg/state field is `.optional()` with **no default** — cfg is
  serialised into frozen golden state strings.
- `packages/engine` declares zero runtime dependencies. Keep `node:fs` out of
  anything re-exported from `testkit/index.ts`.
- A new event type is five coordinated edits: union branch, apply case,
  summary, `fidelityTiers`, `arbitraryEvent` (plus `playerStats` if it carries
  person credit). `eventSchema` validates the **payload** only; the type string
  lives on the envelope.
- Every change ships a test that fails without it. Prove red-first with pasted
  counts, not a claim.

---

## How to gate

One call, absolute path, **no positional** (a positional is a filename filter
that silently runs a subset), with `git status --porcelain` in the same call:

```
cd <abs worktree>/packages/engine && \
  npx vitest run --reporter=json --outputFile=/tmp/eng.json > /dev/null 2>&1; echo "EXIT=$?"; \
cd <abs worktree> && git status --porcelain && git diff --stat -- '*.golden.json'
```

Read `numPassedTests` / `numFailedTests` / `numTotalTests` from the JSON. Confirm
every `.testResults[].name` contains `w4a-followups` — a sibling worktree exists
at `w4a-core-time` and a run can silently execute there.

**Baseline as of this handoff** (taken on a clean tree):

| gate | result |
|---|---|
| engine vitest | 2069 passed / 0 failed / 2070 total / 549 suites |
| engine tsc | exit 0 |
| apps/web tsc | exit 0, zero output (`.next` cleared first) |
| goldens | zero drift; 9 appends across two sanctioned passes |

Known pre-existing flakes, **not** yours: `cricket.test.ts` "generated streams
respect bowling legality" (~1 in 5) and `scheduling/swiss.test.ts` "chess colour
bounds hold". Both unseeded `fc.assert`.

`apps/web` vitest without `.env.local` skips ~1772 DB tests **while leaving
`total` unchanged** — only `pending` moves. Report `pending`, or wire env in.

Capture exit codes with a redirect, never a pipe: `tsc --noEmit > out.txt 2>&1;
echo "EXIT=$?"`. `tsc | tail; echo $?` reports **tail's** status and will print
`EXIT=0` directly under "4 errors in 4 files".

---

## Task 1 — snapshot cfg per fixture (issue #19) — **owner-approved, do this first**

**Why it exists.** Cfg is read live from `division.config` and the whole event
stream replays from `init` on **every read**
(`apps/web/src/server/engine-db/append-event.ts:205-207`). So editing a
division's config retroactively rescores matches that are already finished, and
a cfg-derived `throw` inside a fold makes an already-recorded fixture throw on
every read — state endpoint, score page, standings. There is no event to void,
so the ledger cannot rescue it. That class has now been found **six times** in
W4a alone.

**The decision, already made by the owner:** snapshot cfg per fixture. A match is
scored under the rules in force when it was played.

**Design questions to answer before writing code** — these are the ones that
change the shape of the work:

1. **Where does the snapshot live?** A new column on the fixture row is the
   obvious answer; confirm against how fixtures are read today.
2. **Snapshot the RESOLVED cfg**, i.e. the output of
   `stageScopedCfg(division.config, stage?.config)` — not the raw division
   config. Otherwise stage scoping is re-applied at read time against a config
   that has since moved.
3. **When is it taken?** First event appended is the natural trigger. Decide
   what a fixture with zero events reads (live cfg, presumably) and make that
   explicit rather than incidental.
4. **Per-fixture or per-stage?** Per-fixture is simpler and matches "the rules
   in force when it was played". Per-stage is less duplication. Pick one and say
   why.
5. **The admin escape hatch.** A snapshot with no escape hatch converts one
   class of unrecoverable state into another: if an admin genuinely set the
   wrong config, they need a way to re-snapshot. Audited, and probably requiring
   the fixture to be reopened. **Do not ship the snapshot without this.**
6. **Find every read path.** `foldMatch` is called from more than
   `append-event`. Enumerate them; any path still reading live cfg reintroduces
   the bug for that surface only, which is worse than not fixing it.

**Expect the cfg-replay conformance suite to go red.** It is built to red when
this class gets fixed, so the carve-out can be deleted. That red is the intended
signal, not a regression. Delete the carve-out — do not edit
`SPORTS_WITH_DECIDED_EARLIER`, which is asserted exactly and says so in its own
comment.

**Related, found while closing generator coverage and deliberately left:**
`cricket.ts` `applyRevise` has two more ungated cfg-derived refusals
(`quota === null`, `inningsPerSide !== 1`). No generated stream reaches them
under a mutant today, so cfg-replay is green on both. The snapshot makes them
moot; if you fix them instead, use `strict &&` as
`packages/engine/src/sports/period/kernel.ts:549-560` does.

**Scope note:** greenfield, no prod data, no backfill needed. A new table or
column is fine.

**Tests owed:** unit (fold reads the snapshot, not live cfg), regression (edit a
division config after a fixture is scored → the fixture's score is unchanged and
still readable), e2e, smoke.

---

## Task 2 — state and config fields have no additive tripwire (issue #20)

**The gap.** The golden tripwire now proves that every optional **payload** field
a sport declares is one some recorded stream actually writes. Nothing does this
for **state** and **cfg** fields, which are not in any `eventSchema`.

Currently unprotected: `asOf`, `startedAt` / `expiresAt`, `overran`, `overCount`,
`periodSeconds`, `releaseOnGoal`, `subWindows`, `clock.delay`.

**Why it matters.** Frozen golden corpora store serialised state strings, so a
narrowing state or cfg schema breaks replay — but only if some corpus exercises
the field. Today none is guaranteed to.

**Where to start.** `packages/engine/src/testkit/golden.ts` and the
`schema-fields.ts` / `golden-fields.test.ts` pair added in W4a T10 are the
existing machinery for the payload half; extend the same idea rather than
building a second mechanism. `UNREACHABLE_FIELDS` is the precedent for recording
a field that genuinely cannot be reached, in named classes with an exact-set
test pinning it — it is currently down to its 9 `KERNEL-UNION` entries.

**Do this after Task 1** if Task 1 changes how cfg reaches a fold.

---

## Task 3 — boardgame declares `games` twice (issue #25)

`labelPlayerStats` emits two rows with the same `key`, and the player pages use
that `key` as a React key. Silent today; makes row identity ambiguous on any
reorder or animation.

Confirm which of the two declarations is intended **before** deleting — if they
genuinely differ in metric they need distinct keys, not a deletion.

**Test owed:** assert emitted keys are distinct as a **list**, not a set, for
every builtin module — not just boardgame. The existing i18n test asserts the key
*set*, which is exactly why it passes in both states.

---

## Task 4 — `packages/engine` has no lint coverage (issue #22) — **do this last**

The root `lint` script is `apps/web` only; `packages/engine` has no eslint
config at all, so no engine file has ever been linted.

**Run it last.** It can touch any file in the package and will collide with
every other task here.

Beware the wrapper: `rtk` hides `npm run lint` output entirely, and "ESLint
output (JSON parse failed)" is the wrapper losing the result, not a clean run.
Use `rtk proxy` and read the `✖ N problems` line. Current `apps/web` baseline is
`✖ 79 problems (0 errors, 79 warnings)` — do not treat that as a regression.

Expect a large first-run diff. Land the config and the mechanical fixes
separately from anything judgemental, so the review is readable.

---

## Task 5 — finish the wave-boundary gate (issue #26)

Partly done. Remaining:

- `apps/web` vitest under corrected engine resolution. **Every apps/web number
  produced on this branch before the resolution fix measured main's engine and
  should be treated as unverified, not as a baseline** — including the
  3413 passed / 0 failed an agent reported.
- openapi drift: `npm run openapi:gen` and commit `openapi/*.json` if anything
  moves. The drift gate is **CI-only**, so a fully green local run proves
  nothing. This has bitten four times (#88, #124, #127, #397 — the last for a
  single added enum value). The job dies in ~2 min with no test output.
- smoke, against a prod build.

Already done: debris cleared (`zz-probe.test.ts`, and an agent's untracked
`apps/web/tsconfig.branch-engine.json` workaround), `apps/web` tsc green, engine
gate green, goldens verified.

Then open the second PR. It was deliberately kept off PR #444 — an engine lint
sweep and a Next export refactor do not belong in a time-model PR already at
50 commits.

---

## What is already committed on this branch

| SHA | |
|---|---|
| `adf7839b` | i18n: player-stat labels per sport, 4 locales |
| `f31a5189` | Next page/route modules keep to the export set Next allows |
| `a980652d` | generator writes 13 optional payload fields the sports declared |
| `b715a338` | golden extension for those 13 (5 corpora) |
| `f4281b5f` | i18n: fixture console activity feed |
| `6e95a5e8` | three fold defects: two cfg-derived refusals gated on `strict`, coarsen no longer doubles a partial |
| `5186ebd4` | generator writes the last 7 fields; blocked list emptied |
| `6bc41fcd` | golden extension for those 7 (4 corpora) |

**The coarsen defect, for context** — it is the one that is not a missing guard.
`coarsen`'s non-rally fall-through called `flushPartial()` and then passed the
incoming event through. When that event was itself a partial summary, the coarse
stream got two partials for one set; `flushPartial` **resets the counters to
zero**, so the next flush read as a decrease and the fold's own "may not
decrease the score" guard threw. Fix: an entrant-keyed partial is absorbed into
the running slot counters (`by` names a slot, so no lineup context is needed);
a positional `{home, away}` partial is genuinely unresolvable, so it is dropped
when a rally count exists and passed through when none does.
