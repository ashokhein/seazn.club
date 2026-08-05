# W6 follow-ups — two self-contained briefs

Both came out of #401 (merged as `a1aef2a4`). Written to be pasted into a fresh
session with no prior context. Do them in **separate branches**; they touch the
same file (`packages/engine/src/scheduling/repair.ts`) and must not share a lane.

---

## Follow-up A — #443: feeder-rest has never fired (uuid vs text join)

**Start with:** `gh issue view 443` — it carries the full evidence, the affected
call sites, and why it was excluded from W6. Read it before touching code.

### The defect

`RuleFixture.winnerTo` carries `fixtures.winner_to_fixture`, a **uuid**.
`RuleFixture.extKey` carries `fixtures.ext_key`, **text**. The join at
`packages/engine/src/scheduling/calendar.ts:707` compares them directly:

```ts
if (d.extKey !== f.winnerTo || d.divisionId !== f.divisionId) continue;
```

No code path converts one namespace into the other, so on real payloads this
matches zero pairs and the feeder-rest half of `min_rest_minutes` silently never
fires. `repair.ts:491` carries the same join, so encoder and verifier agree —
which is exactly why `repairAndVerify` cannot catch it. The safety net is blind
because both halves share the assumption.

### Why the whole suite is green on it

Every engine test sets `winnerTo` to a string equal to some fixture's `extKey`
or `id` (`calendar-instruction.test.ts:22-25`, `repair.test.ts:349-351`,
`repair-domain.test.ts:136`, `payload-fixtures.ts:141-144`). **No test anywhere
pairs a real uuid `winnerTo` with a real ext-key `extKey`.** Write that test
first — it is the one that fails before the fix.

### Decide first, then build

The issue does not decide **where** the mapping belongs. Two candidates:

1. Resolve uuid → ext_key at the adapter boundary
   (`apps/web/src/server/usecases/schedule-ai.ts:976`, where
   `winner_to: f.winner_to_fixture` is set), so the engine keeps one namespace.
2. Carry both on `RuleFixture` and join on the uuid.

(1) keeps the engine honest and is the smaller blast radius. Confirm against the
three call sites the issue lists before committing to it.

### This changes shipped behaviour — that is the point, and the risk

Schedules that validate clean **today** will start reporting feeder-rest
conflicts. That is the bug being fixed, but it means:

- Decide deliberately what happens to existing data. Ask the owner if unsure.
- **Re-run the W6 scale bench** (`packages/engine/scripts/bench-repair.ts`,
  `bench-decompose.ts`). W6 measured 500-movable reachability with this join
  matching nothing. Making it fire adds real constraints and can change
  component sizes, which is precisely what made 500 reachable. If the bench
  regresses, say so — do not quietly adjust `COMPONENT_MOVABLE_LIMIT` (50) or
  `DEFAULT_REPAIR_BUDGET_MS` (20 000) to make numbers fit.

### Acceptance criteria

- A test pairing a real uuid `winnerTo` with a real ext-key `extKey` that
  **fails before the fix** and passes after.
- `calendar.ts` and `repair.ts` still share ONE join semantic —
  `calendar-shared-semantics.test.ts` must stay green; it exists to fail if
  solver and verifier fork.
- Scale bench re-run and its numbers reported, pass or fail.
- Engine suite green.

### Do NOT touch

`*.golden.json` (never run `UPDATE_GOLDEN=1`), `.github/workflows/e2e.yml`
(disabled deliberately), the budget/limit constants above.

---

## Follow-up B — rounding: an immovable obstacle is rounded, not widened

Smaller, self-contained, and unreproduced — **step 1 is deciding whether it is
reachable at all.** If it is not, the deliverable is a comment saying so plus a
guard, not a rewrite.

### The asymmetry

`packages/engine/src/scheduling/repair.ts:191-193` defines three helpers:

```ts
const ceilMin  = (ms) => Math.ceil(ms  / MS_PER_MIN);
const floorMin = (ms) => Math.floor(ms / MS_PER_MIN);
const roundMin = (ms) => Math.round(ms / MS_PER_MIN);
```

Movable domains are bounded **conservatively** — `ceilMin` on lower bounds,
`floorMin` on upper (`:299`, `:316`, `:407-408`, `:575`).

Immovable obstacles are bounded with `roundMin` (`:410-411`):

```ts
const eStart = roundMin(e.startAt);
const eEnd   = roundMin(e.endAt);
```

and used at `:426`:

```ts
const clear = (r) => Z3.Or(start[i].ge(eEnd + r), start[i].le(eStart - durMin[i] - r));
```

### The failure it would produce

An obstacle ending at `10:00:20` rounds **down** to `10:00`. z3 then permits a
movable fixture to start at `10:00`, overlapping the real obstacle by 20 s. The
verifier works in milliseconds and disagrees. Result: either a
`RepairVerificationError { kind: "encoding_drift" }` or — worse — a board the
solver calls clean that is not.

Rounding an obstacle must always **widen** it: `floorMin` on its start,
`ceilMin` on its end. Also check `durMin`/`origStartMin` (`:283-284`), which use
`roundMin` too; a movable's own duration should round **up** to be conservative.

### Reachability first

Determine whether any real payload carries sub-minute timestamps. Check what
writes `scheduled_at` and whether the AI/adapter path can produce non-zero
seconds. If nothing can, the correct deliverable is:

- a test pinning the current behaviour at minute granularity,
- a comment at `:410` recording that the input is minute-aligned by construction
  and naming what would break the assumption,
- optionally an assertion that fails loudly if a sub-minute value ever arrives.

If it **is** reachable, fix the direction and ship a test built on a sub-minute
obstacle that fails before the change.

### Acceptance criteria

- Either a failing-then-passing test on a sub-minute obstacle, or a documented
  reachability argument plus a guard. Not silence.
- No change to `ceilMin`/`floorMin` use on the movable side — that half is
  already correct.
- Engine suite green.

### Context worth having

This is the **fifth** instance of one bug class W6 kept hitting: *an encoder unit
that is not the verifier's unit.* The other four (span pruned on all families,
day cap per bucket not per day, clipped first/last day bucket, session crossing
local midnight) were each invisible to a green suite and each caught only by a
probe that asked the solver to defend a board it had called clean. Expect this
one to be invisible the same way.

---

## Traps that apply to BOTH (this repo lies in specific ways)

- **New branch → new worktree.** Never check out in the main repo dir.
- **A worktree has no `.env.local`** (gitignored, not carried by
  `git worktree add`). `apps/web`'s DB suites are `skipIf(!HAS_DB)`, so without
  `DATABASE_URL` they skip and the run is green and meaningless — measured
  `pass 3394 / pending 1822` vs `pass 5166 / pending 50`, with **`total`
  identical (5216) in both**. Reconciling the total does not catch it; only
  `pending` moves. Provision: `createdb` → `npm run db:apply` → **and**
  `npm run sync:sports` (both; the second seeds the sport catalog).
- **Judge green only from `--reporter=json --outputFile`** and read
  `numPassedTests`/`numFailedTests`. `rtk` prints `PASS(0) FAIL(0)` for a suite
  that failed to *collect*.
- **Never pass path positionals** to `npm test --workspace apps/web -- run <path>`
  — vitest treats them as filename filters and silently runs a subset.
- **Shell cwd resets between calls.** Prefix `cd <abs worktree> &&` in the *same*
  call; it bit twice during W6, once turning a rebuild into a silent no-op.
- **Never `git stash` in a worktree** — the stack is shared with the main
  checkout and popping a foreign stash leaves `package.json` unmerged.
- **`grep -a`** — files here report as `Binary file … matches` and hide lines.
- **Never run `UPDATE_GOLDEN=1`**; never enable `.github/workflows/e2e.yml`.
- Verify command for both:

```
cd <abs worktree> && npm test --workspace packages/engine -- \
  --reporter=json --outputFile=/tmp/gate.json; \
  node -e "const r=require('/tmp/gate.json');console.log('pass',r.numPassedTests,'fail',r.numFailedTests)"
```

- Engine timing tests are contention-sensitive: a wall-clock assertion around a
  call that takes the process-wide z3 lock measures the **lock queue**, not the
  solver. Assert budgets on `r.elapsedMs`, never on wall.
