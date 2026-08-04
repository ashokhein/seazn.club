# Wave 1a — Engine Placer/Verifier Convergence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the greedy placer honour every constraint family the verifier already checks, and resolve both sides of every scoped comparison through one normaliser, so `slotFixtures` and `validateAssignments` can no longer disagree.

**Architecture:** One file, `packages/engine/src/scheduling/calendar.ts`. Task 1 lands the normaliser inside the already-shared `scopeCoversFixture`. Tasks 2-5 extend `slotFixtures` one rule family at a time, each with its own failing-first test. Task 6 adds the parity test that makes a future fork fail the suite.

**Tech Stack:** TypeScript, vitest, zod. The engine's only runtime dependency is `z3-solver`. No new dependencies.

## Global Constraints

- Target file: `packages/engine/src/scheduling/calendar.ts`. Do NOT modify `packages/engine/src/scheduling/tz.ts`.
- Day bucketing uses the existing `dayKeyInTz(instantMs, tz)` from `./tz.ts`. Never write another day helper; never use `toISOString().slice(0, 10)`.
- The governing zone is the **org** zone, supplied as `VerifyConfig.tz` / `SlotConfig` tz. A division's display zone must never decide which calendar day a fixture falls on.
- A rule that needs a `tz` is SKIPPED when `tz` is absent, matching the existing documented behaviour at the `VerifyConfig.tz` declaration — reporting a violation the organiser never expressed is worse than reporting none.
- Never run `UPDATE_GOLDEN=1`. Never modify any `*.golden.json`.
- Never `git stash` in this worktree — the stash stack is shared with the main checkout, and a no-op push+pop pops a foreign stash and leaves `package.json` unmerged, blocking every commit. To prove a test red, use `git show HEAD:<path> > <path>` or a `cp` backup.
- Prefix `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/sched-convergence &&` in the SAME call as every command you judge. The shell cwd resets to the main checkout between calls.
- Judge vitest ONLY from `--reporter=json --outputFile`. `rtk` prints `PASS(0) FAIL(0)` for a suite that failed to COLLECT. A drop in `numTotalTests` is a failure, not a pass.
- Run `repair-scale` and `calendar-shared-semantics` ALONE when judging them — both carry wall-clock assertions that fail under machine load.
- Do not file GitHub issues. Anything found gets fixed here with its own failing-first test.

## Verified Starting State

Read from `origin/main` @ `14b8e5f6` on 2026-08-05. Every line number below was read this session.

| Location | What is there |
| --- | --- |
| `calendar.ts:47-56` | `SchedulableFixture` — carries `people?: readonly string[]`, `poolId?`, `divisionId?` |
| `calendar.ts:255-259` | `SlotInput { fixtures, config, existing? }` |
| `calendar.ts:365` | `slotFixtures(input: SlotInput): SlotResult` |
| `calendar.ts:384` | `const lastEnd = new Map<EntrantId, number>()` |
| `calendar.ts:494` | `for (const e of ent) lastEnd.set(e, …)` — the only write |
| `calendar.ts:529` | `for (const e of ent) ready = Math.max(ready, (lastEnd.get(e) ?? -Infinity) + restF)` — the only read |
| `calendar.ts:~640` | `scopeCoversFixture(scope, f, a)` — already SHARED by placer and verifier (#447); `ScopeRow` exists for exactly that |
| `constraints.ts:61-88` | `HardConstraint` union: `min_rest_minutes`, `max_fixtures_per_day`, `fixture_on_weekday`, `fixture_on_date`, `not_before`, `not_after` |
| `constraints.ts:30-36` | `ConstraintScope`: `competition`, `division`, `entrant`, `person` (`personKey`), `pool` (`divisionId` + `pool`) |

Only `min_rest_minutes` is placed around today. The other five are reported by the verifier and never placed around.

**Before writing code**, confirm the exact signature of `validateAssignments` and how existing tests build a config, by reading `packages/engine/src/scheduling/calendar-shared-semantics.test.ts`. Tasks 1-6 below give the assertions; match that file's construction style rather than inventing one.

---

### Task 1: Normalise both sides of every scoped comparison

Closes #449 (pool key vs uuid) and #450 (person name vs uuid). `scopeCoversFixture` compares `scope.pool` against `a.poolId`, and `scope.personKey` against `a.people` — but the two sides are produced by different builders, so one may hold a uuid while the other holds a pool key or a `name:<normalised>` collapse key.

**Files:**
- Modify: `packages/engine/src/scheduling/calendar.ts` (the `scopeCoversFixture` function, ~:640)
- Test: `packages/engine/src/scheduling/calendar-scope-identity.test.ts` (create)

**Interfaces:**
- Consumes: `ConstraintScope` and `ScopeRow`, both already exported.
- Produces: `scopeCoversFixture` keeps its exact existing signature `(scope: ConstraintScope, f: RuleFixture | undefined, a: ScopeRow) => boolean`. No caller changes.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { scopeCoversFixture } from "./calendar.ts";

describe("scopeCoversFixture normalises both sides (#449, #450)", () => {
  const row = {
    entrants: ["ent-1"],
    people: ["name:jordan lee"], // collapsed identity key, not a uuid
    poolId: "11111111-1111-4111-8111-111111111111", // uuid
    divisionId: "div-1",
  };

  it("binds a person-scoped rule when the row carries a collapse key", () => {
    // The rule was authored against the person's uuid; the row carries the
    // collapsed key. Both name the same human, so the rule must bind.
    expect(
      scopeCoversFixture({ kind: "person", personKey: "name:jordan lee" }, undefined, row),
    ).toBe(true);
  });

  it("binds a pool-scoped rule when the scope names the pool KEY and the row a uuid", () => {
    expect(
      scopeCoversFixture(
        { kind: "pool", divisionId: "div-1", pool: "11111111-1111-4111-8111-111111111111" },
        undefined,
        row,
      ),
    ).toBe(true);
  });

  it("does NOT bind a pool rule from another division", () => {
    expect(
      scopeCoversFixture(
        { kind: "pool", divisionId: "div-2", pool: "11111111-1111-4111-8111-111111111111" },
        undefined,
        row,
      ),
    ).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test and confirm which cases fail**

Run:
```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/sched-convergence && npx vitest run packages/engine/src/scheduling/calendar-scope-identity.test.ts --reporter=json --outputFile=/tmp/t1.json > /tmp/t1.log 2>&1; echo "EXIT=$?"; node -e "const r=require('/tmp/t1.json');console.log('pass',r.numPassedTests,'fail',r.numFailedTests,'total',r.numTotalTests)"
```

Expected: `total 3` with at least one `fail`. **If all three pass, STOP.** That means the mismatch does not reproduce at this level, and the real divergence is in the BUILDERS that produce `scope` and `ScopeRow`, not in the comparison. Grep the builders (`identity.keyOf` call sites and wherever `poolKey` is assigned) and rewrite this test against the actual mismatch before implementing anything. Do not "fix" a function that is already correct.

- [ ] **Step 3: Implement the normaliser**

Add one module-local function above `scopeCoversFixture` and route both sides through it. Keep the existing collapse semantics — #450 is that BOTH sides must apply the resolution, not that it should stop:

```ts
/** One resolution for both sides of a scoped comparison (#449, #450). The scope
 *  and the row are built by different producers, so comparing them raw asks
 *  whether two namespaces happen to coincide. Both sides resolve here. */
const sameKey = (a: string | undefined, b: string | undefined): boolean =>
  a !== undefined && b !== undefined && normaliseKey(a) === normaliseKey(b);
```

Implement `normaliseKey` to match the collapse rule already used for `people` (the `name:<normalised>` form). Then rewrite the `pool` and `person` branches of the switch to use `sameKey` / a `sameKey`-based `includes`. Leave `competition`, `division` and `entrant` semantics unchanged.

- [ ] **Step 4: Run the test and the full engine suite**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/sched-convergence && npm test --workspace packages/engine -- --reporter=json --outputFile=/tmp/eng1.json > /tmp/eng1.log 2>&1; echo "EXIT=$?"; node -e "const r=require('/tmp/eng1.json');console.log('pass',r.numPassedTests,'fail',r.numFailedTests,'total',r.numTotalTests,'empty',r.testResults.filter(s=>!s.assertionResults||!s.assertionResults.length).length)"
```

Expected: `fail 0`, `empty 0`, and `total` = the pre-change total + 3. Rerun any wall-clock failure ALONE before believing it.

- [ ] **Step 5: Commit**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/sched-convergence && git add packages/engine/src/scheduling/calendar.ts packages/engine/src/scheduling/calendar-scope-identity.test.ts && git commit -m "fix(engine): resolve both sides of a scoped comparison through one key (#449, #450)

scopeCoversFixture compared a scope built by one producer against a row built
by another, so a pool key met a pool uuid and a person uuid met a collapsed
name key. Both sides now resolve through one function, which is the normaliser
this comparison never had.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Gate rest on people, not only entrants

Closes the central case of #463. `lastEnd` is keyed by `EntrantId`, so a `per_person` rest rule between two fixtures that share a **person** but no **entrant** is invisible to the placer while the verifier reports it.

**Files:**
- Modify: `packages/engine/src/scheduling/calendar.ts:384`, `:494`, `:529`
- Test: `packages/engine/src/scheduling/calendar-person-rest.test.ts` (create)

**Interfaces:**
- Consumes: `sameKey` / `normaliseKey` from Task 1.
- Produces: no signature changes. `lastEnd` becomes keyed by a resolved participant key covering both entrants and people.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { slotFixtures } from "./calendar.ts";

const T0 = Date.UTC(2026, 6, 4, 9, 0);

describe("placer rests on shared PEOPLE, not only shared entrants (#463)", () => {
  it("separates two fixtures that share a person but no entrant", () => {
    const res = slotFixtures({
      fixtures: [
        { id: "a", home: "e1", away: "e2", people: ["p-shared"], divisionId: "d1" },
        { id: "b", home: "e3", away: "e4", people: ["p-shared"], divisionId: "d1" },
      ],
      config: {
        startAt: T0,
        matchMinutes: 30,
        gapMinutes: 0,
        perEntrantMinRest: 60, // one hour of rest is owed to a shared participant
        courts: ["C1", "C2"], // two courts, so nothing forces them apart
        blackouts: [],
        sessionWindows: [],
      },
    });

    expect(res.assignments).toHaveLength(2);
    const [a, b] = res.assignments.sort((x, y) => x.startAt - y.startAt);
    // Without the fix both are placed at T0 on different courts: they share no
    // entrant, so `lastEnd` never saw the overlap.
    expect(b.startAt - a.endAt).toBeGreaterThanOrEqual(60 * 60_000);
  });

  it("still packs fixtures that share nothing", () => {
    const res = slotFixtures({
      fixtures: [
        { id: "a", home: "e1", away: "e2", people: ["p1"], divisionId: "d1" },
        { id: "b", home: "e3", away: "e4", people: ["p2"], divisionId: "d1" },
      ],
      config: {
        startAt: T0,
        matchMinutes: 30,
        gapMinutes: 0,
        perEntrantMinRest: 60,
        courts: ["C1", "C2"],
        blackouts: [],
        sessionWindows: [],
      },
    });
    expect(res.assignments.every((a) => a.startAt === T0)).toBe(true);
  });
});
```

- [ ] **Step 2: Run and verify it fails on the first case only**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/sched-convergence && npx vitest run packages/engine/src/scheduling/calendar-person-rest.test.ts --reporter=json --outputFile=/tmp/t2.json > /tmp/t2.log 2>&1; echo "EXIT=$?"; node -e "const r=require('/tmp/t2.json');console.log('pass',r.numPassedTests,'fail',r.numFailedTests,'total',r.numTotalTests)"
```

Expected: `total 2`, `fail 1` — the shared-person case fails, the unrelated-fixtures case passes. The second case is the guard that the fix does not simply separate everything.

- [ ] **Step 3: Implement**

Widen the rest map to cover both participant kinds:

```ts
// Rest is owed to a PARTICIPANT, and a participant is an entrant or a person
// (#463). Keying only by EntrantId made a per_person rule invisible to the
// placer while the verifier still reported it — the placer/verifier fork.
const lastEnd = new Map<string, number>();
const restKeysOf = (f: SchedulableFixture): string[] => [
  ...entrantsOf(f).map(normaliseKey),
  ...(f.people ?? []).map(normaliseKey),
];
```

At `:494` write every key from `restKeysOf(f)`; at `:529` read every key from `restKeysOf(f)`. Leave `courtUse` and `lastCourt` keyed by entrant — field fairness is an entrant-level concept and widening it would change unrelated behaviour.

- [ ] **Step 4: Run the test and the full engine suite**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/sched-convergence && npm test --workspace packages/engine -- --reporter=json --outputFile=/tmp/eng2.json > /tmp/eng2.log 2>&1; echo "EXIT=$?"; node -e "const r=require('/tmp/eng2.json');console.log('pass',r.numPassedTests,'fail',r.numFailedTests,'total',r.numTotalTests,'empty',r.testResults.filter(s=>!s.assertionResults||!s.assertionResults.length).length)"
```

Expected: `fail 0`. Boards get strictly more separated, so if an existing test asserts an exact packed start time it may legitimately need updating — but read it first and confirm the new spacing is the CORRECT answer before changing any assertion. An existing test that breaks is evidence, not an obstacle.

- [ ] **Step 5: Commit**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/sched-convergence && git add packages/engine/src/scheduling/calendar.ts packages/engine/src/scheduling/calendar-person-rest.test.ts && git commit -m "fix(engine): rest the placer on shared people, not only shared entrants (#463)

lastEnd was keyed by EntrantId, so two fixtures sharing a person but no
entrant were packed adjacent while the verifier reported the rest violation.
SchedulableFixture already carried people; the placer simply never read it.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Place around `max_fixtures_per_day`

**Files:**
- Modify: `packages/engine/src/scheduling/calendar.ts` (`slotFixtures` placement loop, ~:520-560)
- Test: `packages/engine/src/scheduling/calendar-day-cap-placement.test.ts` (create)

**Interfaces:**
- Consumes: `sameKey`/`normaliseKey` (Task 1), `restKeysOf` (Task 2), `dayKeyInTz` from `./tz.ts`, `scopeCoversFixture`.
- Produces: a module-local `dayCountsFor` map used by Tasks 3-5.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { slotFixtures } from "./calendar.ts";

// 2026-07-11 in Los Angeles: 17:00Z and 19:00Z are Saturday local; 01:00Z and
// 03:00Z on the 12th are still Saturday LOCAL but Sunday UTC. A UTC bucket
// sees 2 + 2 and fills all four.
const SAT_1000_LOCAL = Date.UTC(2026, 6, 11, 17, 0);

describe("placer honours max_fixtures_per_day on the ORG day (#463)", () => {
  it("refuses to place a fourth fixture for a capped entrant on one local day", () => {
    const res = slotFixtures({
      fixtures: [1, 2, 3, 4].map((n) => ({
        id: `f${n}`,
        home: "e1",
        away: `e${n + 10}`,
        divisionId: "d1",
      })),
      config: {
        startAt: SAT_1000_LOCAL,
        matchMinutes: 30,
        gapMinutes: 0,
        perEntrantMinRest: 0,
        courts: ["C1"],
        blackouts: [],
        sessionWindows: [],
        tz: "America/Los_Angeles",
        constraints: {
          hard: [
            {
              type: "max_fixtures_per_day",
              max: 2,
              scope: { kind: "entrant", entrantId: "e1" },
            },
          ],
        },
      },
    });

    const placed = res.assignments.filter((a) => a.entrants.includes("e1"));
    expect(placed).toHaveLength(2);
    expect(res.conflicts.filter((c) => c.reason === "no_slot")).toHaveLength(2);
  });
});
```

Note: the exact nesting of `hard` under `config` must match how `effectiveHard(config)` reads it — confirm against the `effectiveHard` definition and match it. If the shape differs, fix the TEST to the real shape; do not reshape the config to suit the test.

- [ ] **Step 2: Run and verify it fails**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/sched-convergence && npx vitest run packages/engine/src/scheduling/calendar-day-cap-placement.test.ts --reporter=json --outputFile=/tmp/t3.json > /tmp/t3.log 2>&1; echo "EXIT=$?"; node -e "const r=require('/tmp/t3.json');console.log('pass',r.numPassedTests,'fail',r.numFailedTests,'total',r.numTotalTests)"
```

Expected: FAIL — all four placed, zero `no_slot`.

- [ ] **Step 3: Implement**

In the placement loop, before accepting a candidate `start`, reject it when any `max_fixtures_per_day` rule that binds this fixture (via `scopeCoversFixture`) already has `max` placements on `dayKeyInTz(start, tz)`. Maintain counts per (rule, dayKey) and increment in `commit`. When `tz` is absent, SKIP the rule — matching the documented `VerifyConfig.tz` behaviour. Rejection feeds the existing repair loop (push the candidate later on the same court), and an exhausted candidate set reports `no_slot`, which is the existing unplaceable path.

- [ ] **Step 4: Run the test and the full engine suite**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/sched-convergence && npm test --workspace packages/engine -- --reporter=json --outputFile=/tmp/eng3.json > /tmp/eng3.log 2>&1; echo "EXIT=$?"; node -e "const r=require('/tmp/eng3.json');console.log('pass',r.numPassedTests,'fail',r.numFailedTests,'total',r.numTotalTests,'empty',r.testResults.filter(s=>!s.assertionResults||!s.assertionResults.length).length)"
```

Expected: `fail 0`.

- [ ] **Step 5: Commit**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/sched-convergence && git add packages/engine/src/scheduling/calendar.ts packages/engine/src/scheduling/calendar-day-cap-placement.test.ts && git commit -m "feat(engine): place around max_fixtures_per_day on the org calendar day (#463)

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Place around `not_before` / `not_after`

**Files:**
- Modify: `packages/engine/src/scheduling/calendar.ts` (placement loop)
- Test: `packages/engine/src/scheduling/calendar-time-bounds-placement.test.ts` (create)

**Interfaces:**
- Consumes: everything from Tasks 1-3. `not_before`/`not_after` carry `time: HHMM` — a WALL-CLOCK time in the org zone, never an instant.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { slotFixtures } from "./calendar.ts";

describe("placer honours not_before / not_after (#463)", () => {
  it("does not place before the rule's wall-clock bound in the org zone", () => {
    const res = slotFixtures({
      fixtures: [{ id: "f1", home: "e1", away: "e2", divisionId: "d1" }],
      config: {
        startAt: Date.UTC(2026, 6, 11, 13, 0), // 06:00 local in Los Angeles
        matchMinutes: 30,
        gapMinutes: 0,
        perEntrantMinRest: 0,
        courts: ["C1"],
        blackouts: [],
        sessionWindows: [],
        tz: "America/Los_Angeles",
        constraints: {
          hard: [{ type: "not_before", time: "09:00", scope: { kind: "division", divisionId: "d1" } }],
        },
      },
    });

    expect(res.assignments).toHaveLength(1);
    const hhmm = new Intl.DateTimeFormat("en-GB", {
      timeZone: "America/Los_Angeles",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(new Date(res.assignments[0].startAt));
    expect(hhmm >= "09:00").toBe(true);
  });
});
```

- [ ] **Step 2: Run and verify it fails**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/sched-convergence && npx vitest run packages/engine/src/scheduling/calendar-time-bounds-placement.test.ts --reporter=json --outputFile=/tmp/t4.json > /tmp/t4.log 2>&1; echo "EXIT=$?"; node -e "const r=require('/tmp/t4.json');console.log('pass',r.numPassedTests,'fail',r.numFailedTests,'total',r.numTotalTests)"
```

Expected: FAIL — placed at 06:00 local.

- [ ] **Step 3: Implement**

Use the engine's existing `hhmmInTz` from `./tz.ts` to compare a candidate start against each binding rule's `time`. `not_before` raises the candidate's lower bound; `not_after` rejects and lets the repair loop advance, ultimately reporting `no_slot` when no slot on any court satisfies it. Skip when `tz` is absent.

- [ ] **Step 4: Run the test and the full engine suite**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/sched-convergence && npm test --workspace packages/engine -- --reporter=json --outputFile=/tmp/eng4.json > /tmp/eng4.log 2>&1; echo "EXIT=$?"; node -e "const r=require('/tmp/eng4.json');console.log('pass',r.numPassedTests,'fail',r.numFailedTests,'total',r.numTotalTests,'empty',r.testResults.filter(s=>!s.assertionResults||!s.assertionResults.length).length)"
```

- [ ] **Step 5: Commit**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/sched-convergence && git add packages/engine/src/scheduling/calendar.ts packages/engine/src/scheduling/calendar-time-bounds-placement.test.ts && git commit -m "feat(engine): place around not_before / not_after in the org zone (#463)

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Place around `fixture_on_weekday` / `fixture_on_date`

**Files:**
- Modify: `packages/engine/src/scheduling/calendar.ts` (placement loop)
- Test: `packages/engine/src/scheduling/calendar-day-targets-placement.test.ts` (create)

**Interfaces:**
- Consumes: Tasks 1-4. Uses `dayKeyInTz` and the existing `weekdayOfYmd` from `./tz.ts`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { slotFixtures } from "./calendar.ts";
import { dayKeyInTz } from "./tz.ts";

describe("placer honours fixture_on_date (#463)", () => {
  it("places the named fixture on the required calendar date", () => {
    const res = slotFixtures({
      fixtures: [{ id: "f1", home: "e1", away: "e2", divisionId: "d1" }],
      config: {
        startAt: Date.UTC(2026, 6, 11, 17, 0),
        matchMinutes: 30,
        gapMinutes: 0,
        perEntrantMinRest: 0,
        courts: ["C1"],
        blackouts: [],
        sessionWindows: [],
        tz: "America/Los_Angeles",
        horizonMinutes: 60 * 24 * 14,
        constraints: {
          hard: [
            {
              type: "fixture_on_date",
              date: "2026-07-15",
              scope: { kind: "division", divisionId: "d1" },
            },
          ],
        },
      },
    });

    expect(res.assignments).toHaveLength(1);
    expect(dayKeyInTz(res.assignments[0].startAt, "America/Los_Angeles")).toBe("2026-07-15");
  });
});
```

Confirm the exact field name on `fixture_on_date` (`date`) and on `fixture_on_weekday` against `constraints.ts:74-84` before running; fix the test to the real field name if it differs.

- [ ] **Step 2: Run and verify it fails**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/sched-convergence && npx vitest run packages/engine/src/scheduling/calendar-day-targets-placement.test.ts --reporter=json --outputFile=/tmp/t5.json > /tmp/t5.log 2>&1; echo "EXIT=$?"; node -e "const r=require('/tmp/t5.json');console.log('pass',r.numPassedTests,'fail',r.numFailedTests,'total',r.numTotalTests)"
```

Expected: FAIL — placed on 2026-07-11.

- [ ] **Step 3: Implement**

Reject any candidate whose `dayKeyInTz(start, tz)` does not match a binding `fixture_on_date`, or whose `weekdayOfYmd(dayKeyInTz(start, tz))` does not match a binding `fixture_on_weekday`. Advance the candidate to the next day rather than scanning slot-by-slot across days — the existing 64-iteration repair loop will otherwise exhaust before reaching a date days away, which is exactly why this needs a day-level jump rather than a time-level one.

- [ ] **Step 4: Run the test and the full engine suite**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/sched-convergence && npm test --workspace packages/engine -- --reporter=json --outputFile=/tmp/eng5.json > /tmp/eng5.log 2>&1; echo "EXIT=$?"; node -e "const r=require('/tmp/eng5.json');console.log('pass',r.numPassedTests,'fail',r.numFailedTests,'total',r.numTotalTests,'empty',r.testResults.filter(s=>!s.assertionResults||!s.assertionResults.length).length)"
```

- [ ] **Step 5: Commit**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/sched-convergence && git add packages/engine/src/scheduling/calendar.ts packages/engine/src/scheduling/calendar-day-targets-placement.test.ts && git commit -m "feat(engine): place around fixture_on_date and fixture_on_weekday (#463)

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: The parity test that makes a future fork fail the suite

This is the deliverable that matters most. A test asserting only the placer's behaviour cannot catch a fork; a test asserting that both sides report the same number cannot miss one.

**Files:**
- Test: `packages/engine/src/scheduling/calendar-placer-verifier-parity.test.ts` (create)

**Interfaces:**
- Consumes: `slotFixtures` and `validateAssignments`. Confirm `validateAssignments`' exact signature from `calendar-shared-semantics.test.ts` before writing.

- [ ] **Step 1: Write the test**

```ts
import { describe, expect, it } from "vitest";
import { slotFixtures, validateAssignments } from "./calendar.ts";

// Feed the placer's OWN OUTPUT back to the verifier. Any family the placer
// does not honour shows up here as a violation the placer just created.
const FAMILIES = [
  { type: "max_fixtures_per_day", max: 2, scope: { kind: "entrant", entrantId: "e1" } },
  { type: "not_before", time: "09:00", scope: { kind: "division", divisionId: "d1" } },
  { type: "not_after", time: "20:00", scope: { kind: "division", divisionId: "d1" } },
  { type: "fixture_on_weekday", weekday: 6, scope: { kind: "division", divisionId: "d1" } },
] as const;

describe("placer output satisfies the verifier (#463)", () => {
  for (const rule of FAMILIES) {
    it(`emits no ${rule.type} violation it could have avoided`, () => {
      const config = {
        startAt: Date.UTC(2026, 6, 11, 17, 0),
        matchMinutes: 30,
        gapMinutes: 0,
        perEntrantMinRest: 0,
        courts: ["C1", "C2"],
        blackouts: [],
        sessionWindows: [],
        tz: "America/Los_Angeles",
        horizonMinutes: 60 * 24 * 21,
        constraints: { hard: [rule] },
      };
      const fixtures = [1, 2, 3, 4, 5, 6].map((n) => ({
        id: `f${n}`,
        home: "e1",
        away: `e${n + 10}`,
        divisionId: "d1",
      }));

      const { assignments } = slotFixtures({ fixtures, config });
      const verdict = validateAssignments(assignments, config);

      // A fixture the placer refused to place is honest; a fixture it placed
      // into a violation is the fork.
      expect(verdict.filter((c) => c.rule === rule.type)).toHaveLength(0);
    });
  }
});
```

Adjust `validateAssignments`' call shape and the violation field name (`rule`) to the real API — read `calendar-shared-semantics.test.ts` first. The ASSERTION is the point: zero self-inflicted violations, per family.

- [ ] **Step 2: Run it**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/sched-convergence && npx vitest run packages/engine/src/scheduling/calendar-placer-verifier-parity.test.ts --reporter=json --outputFile=/tmp/t6.json > /tmp/t6.log 2>&1; echo "EXIT=$?"; node -e "const r=require('/tmp/t6.json');console.log('pass',r.numPassedTests,'fail',r.numFailedTests,'total',r.numTotalTests)"
```

Expected after Tasks 1-5: `total 4`, `fail 0`. Any failure here names a family still forked — fix that family rather than relaxing this test.

- [ ] **Step 3: Full engine suite + engine lint**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/sched-convergence && npm test --workspace packages/engine -- --reporter=json --outputFile=/tmp/eng6.json > /tmp/eng6.log 2>&1; echo "EXIT=$?"; node -e "const r=require('/tmp/eng6.json');console.log('pass',r.numPassedTests,'fail',r.numFailedTests,'total',r.numTotalTests,'empty',r.testResults.filter(s=>!s.assertionResults||!s.assertionResults.length).length)"; rtk proxy npx turbo run lint --filter=@seazn/engine 2>&1 | tail -3
```

The root `npm run lint` does NOT cover `packages/engine` — it has its own task. Run both.

- [ ] **Step 4: apps/web suite (the engine ships as raw TS source, so web compiles it)**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/sched-convergence && readlink -f node_modules/@seazn/engine && DATABASE_URL=postgresql://postgres@127.0.0.1:54337/seazn_test_448 DATABASE_SSL=disable npm test --workspace apps/web -- --reporter=json --outputFile=/tmp/web6.json > /tmp/web6.log 2>&1; echo "EXIT=$?"; node -e "const r=require('/tmp/web6.json');console.log('pass',r.numPassedTests,'fail',r.numFailedTests,'total',r.numTotalTests,'pending',r.numPendingTests,'suites',r.testResults.length)"
```

`readlink` MUST resolve inside this worktree. If it points at the main checkout, you are testing main's engine and every number is meaningless.

- [ ] **Step 5: Drift gates, then commit**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/sched-convergence && npm run openapi:gen && npm run i18n:gen-keys && git status --porcelain
```

Porcelain must show only your intended files. Then:

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/sched-convergence && git add packages/engine/src/scheduling/calendar-placer-verifier-parity.test.ts && git commit -m "test(engine): assert the placer's own output satisfies the verifier (#463)

A test that asserts only the placer's behaviour cannot catch a fork. This
feeds the placer's output back to the verifier per rule family, so a future
divergence fails the suite instead of shipping as 'auto proposes a board the
gate warns about'.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Not in this plan

- Wave 1b (#458, #462, #461) — `apps/web`, gets its own plan. Until it lands, the capability added here is not reachable from the AI path, which still pins `startWindows: []`.
- Wave 2 (#467) — independent.
- `feeder_to_dependent` rest. The spec listed it, but the `HardConstraint` union at `constraints.ts:61-88` has no such member — it is a constraints-v2 config concept, not a hard rule. Confirm where it lives before deciding whether the placer can honour it; do not invent a rule type for it.
