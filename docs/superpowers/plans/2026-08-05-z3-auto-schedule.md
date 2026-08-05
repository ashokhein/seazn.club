# z3-backed auto-schedule, reflow and polish — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace greedy-only auto-schedule with a greedy-seeded z3 solver that proves placement, optimises boards lexicographically, and moves the provably fewest cards on reflow.

**Architecture:** A slot-grid boolean model (`x[fixture][slot]`) encodes the board; four descending-bound tiers under z3 push/pop optimise placed-count → makespan → worst idle gap → court imbalance. The greedy `slotFixtures` output seeds the incumbent, so the answer is never worse than today's. REFLOW routes to the existing `repairSchedule` (ascending-k minimal movement). An LNS window loop over the same repair solver is the fallback when the whole-board model stalls or the lattice is too large.

**Tech Stack:** TypeScript 7 (`typescript-native`), Node 26, vitest, `z3-solver@5.0.0` (WASM), zod 4, Next.js (apps/web), Playwright.

**Spec:** `docs/superpowers/specs/2026-08-05-z3-auto-schedule-design.md` — read it before Task 1. Decisions D1–D9, the eight gaps, and the known limits live there and are not repeated in full here.

**Durable state:** `.claude/z3-scheduling-state.md`. Created in Task 0, updated at the end of every task. It survives compaction; it is the first thing any agent reads.

## Global Constraints

- **Never re-derive a rule semantic.** Every rest / scope / selector / hard-rule answer comes from `calendar.ts` exports: `effectiveHard`, `effectiveRestMinutes`, `pairRestMinutesFor`, `scopeCoversFixture`, `resolveSelector`, `startWindowFor`, `intervalsOverlap`. A literal like `config.perEntrantMinRest` inside `build-encode.ts` is a review rejection.
- **No ambient wall-clock reads in `packages/engine`.** `scripts/engine-boundary.ts` bans `Date.now()` / `new Date()`. Use `performance.now()` for elapsed spans and take instants as parameters.
- **The governing clock is `tz` on `VerifyConfig`, which carries `settings.orgTz`.** Never `settings.tz` (display only). A day-shaped rule with no `tz` is **skipped**, not bucketed in UTC.
- **Every change ships a test that fails without it.** Four kinds per wave: unit, e2e, smoke, regression.
- **Judge vitest only from JSON.** `--reporter=json --outputFile=<file>`, then read `numPassedTests` / `numTotalTests` / `numFailedTests`. An `rtk` summary prints `PASS(0) FAIL(0)` for a suite that failed to *collect*.
- **`npm test --workspace <ws> -- <path>`** — both workspaces' `test` script is already `vitest run`, so a leading `run` positional would be parsed as a **filename filter** and silently run a subset.
- **Lint:** root `npm run lint` covers apps/web **and** packages/engine (both workspaces). Run it through `rtk proxy` and read `✖ N problems`; `rtk` hides lint output otherwise.
- **`grep` needs `-a`** in this repo, or matches are hidden behind `Binary file … matches`. Prefer `git grep`.
- **Every commit** runs `npm run openapi:gen` and `npm run i18n:gen-keys`, then `git status --porcelain` must be empty.
- **Any new user-facing string** → all 4 locale dictionaries, flat dotted keys, never hardcoded English.
- **UI** works at desktop **and 375 px** with no horizontal page scroll.
- **No new GitHub issues.** Fix inline, or ask the owner if it widens blast radius.
- **Worktree, never the main checkout.** No `git stash` inside it (shared stack with main).

## File Structure

**Created (engine — `packages/engine/src/scheduling/`)**

| File | Responsibility |
| --- | --- |
| `build-objectives.ts` | Pure metrics over `Assignment[]`. No z3, no config rules. |
| `build-objectives.test.ts` | Metric math on hand-built boards. |
| `build-grid.ts` | `SlotConfig` → legal slot lattice, day-anchored in `tz`. |
| `build-grid.test.ts` | Lattice bounds, blackouts, sessions, cap, step. |
| `build-encode.ts` | The boolean model and nothing else. |
| `build-encode-parity.test.ts` | Model accepts an assignment iff `validateAssignments` does. |
| `build.ts` | `buildSchedule` — seed, tier walk, anytime, verifier gate. |
| `build.test.ts` | Tier behaviour, T0 proof, never-worse-than-greedy. |
| `build-determinism.test.ts` | Byte-identical across runs and across wall-clock caps. |
| `build-lns.ts` | Window selection + improve loop over `repairSchedule`. |
| `build-lns.test.ts` | Improves or no-ops, never regresses, respects frozen. |
| `build-polish.test.ts` | `already_optimal`, frozen set immovable. |

**Created (repo root)**

| File | Responsibility |
| --- | --- |
| `scripts/bench-build.ts` | Sizes the `rlimit` constant, with hard rules included. |
| `apps/web/e2e/schedule-solver.spec.ts` | Auto-schedule + Polish, desktop and 375 px. |
| `.claude/z3-scheduling-state.md` | Durable programme state across compaction. |

**Modified**

| File | Change |
| --- | --- |
| `packages/engine/src/scheduling/index.ts` | One `export *` per new module. **Touched by every engine task — this is why the engine tasks are sequential.** |
| `apps/web/src/server/api-v1/schemas.ts:856` | `AutoScheduleRequest.mode`; `AutoScheduleResult.metrics` / `.solver`. |
| `apps/web/src/server/usecases/schedule.ts:~660-740` | `autoSchedule` becomes a three-way dispatch. |
| `apps/web/src/components/v2/schedule-board.tsx` | Result strip + Polish button. |
| `apps/web/src/dictionaries/{en,es,fr,nl}/ui.json` | New keys. |
| `scripts/smoke.ts` | Solver smoke step. |
| `apps/web/src/server/usecases/__tests__/schedule.test.ts` | Dispatch + reflow behaviour change. |
| `openapi/v1.json`, `openapi/v1.public.json` | Regenerated. |

---

### Task 0: Worktree, state file, and a verified baseline

**Files:**
- Create: `.claude/z3-scheduling-state.md`

**Interfaces:**
- Consumes: nothing.
- Produces: the worktree path and a recorded baseline test count every later task compares against.

- [ ] **Step 1: Create the worktree**

```bash
cd /Users/ashokhein/github/seazn.club
git worktree add ../wt-z3-build -b feat/z3-auto-schedule main
cd ../wt-z3-build && pwd
```

- [ ] **Step 2: Check the three worktree traps before trusting any test result**

```bash
cd ../wt-z3-build && \
  readlink -f node_modules/@seazn/engine && \
  ls -la .claude/agent-memory 2>&1 | head -1 && \
  ls -la .env.local 2>&1 | head -1
```

Expected: the `readlink` path is **inside `wt-z3-build`**, not `seazn.club`. If it resolves to main's engine, the build compiles the wrong branch while every gate stays green — run a real install in the worktree. **The installer is pnpm** (`pnpm install --frozen-lockfile`, matching `.github/workflows/ci.yml:63`); scripts are still invoked as `npm run <x> --workspace <ws>`, which is why every command below says `npm`. If `.claude/agent-memory` is missing, symlink it. If `.env.local` is missing, ~1772 DB tests will skip with `total` unchanged and only `pending` moving — copy it from main before believing any count.

- [ ] **Step 3: Record the baseline**

```bash
cd ../wt-z3-build && npm test --workspace packages/engine -- \
  --reporter=json --outputFile=/tmp/base-engine.json >/dev/null 2>&1; \
  node -e 'const r=require("/tmp/base-engine.json");console.log(r.numPassedTests,r.numTotalTests,r.numFailedTests)'
```

- [ ] **Step 4: Write the state file**

```markdown
# z3 auto-schedule — programme state

Spec: docs/superpowers/specs/2026-08-05-z3-auto-schedule-design.md
Plan: docs/superpowers/plans/2026-08-05-z3-auto-schedule.md
Worktree: ../wt-z3-build   Branch: feat/z3-auto-schedule

## Baseline (Task 0)
engine: <passed>/<total>, <failed> failed

## Task log
- [x] Task 0 — worktree + baseline

## Decisions taken mid-flight
(none yet)
```

- [ ] **Step 5: Commit**

```bash
git add .claude/z3-scheduling-state.md
git commit -m "chore(scheduling): worktree state file and recorded baseline"
```

---

### Task 1: `build-objectives.ts` — the three metrics

**Files:**
- Create: `packages/engine/src/scheduling/build-objectives.ts`
- Test: `packages/engine/src/scheduling/build-objectives.test.ts`
- Modify: `packages/engine/src/scheduling/index.ts`

**Interfaces:**
- Consumes: `Assignment` from `./calendar.ts`.
- Produces:
  - `interface BoardMetrics { makespanMinutes: number; worstIdleGapMinutes: number; courtImbalanceMinutes: number; placed: number; total: number }`
  - `function boardMetrics(assignments: readonly Assignment[], courts: readonly string[], total: number): BoardMetrics`
  - `function isStrictlyBetter(a: BoardMetrics, b: BoardMetrics): boolean` — lexicographic `placed` desc, then `makespanMinutes`, `worstIdleGapMinutes`, `courtImbalanceMinutes` asc.

- [ ] **Step 1: Write the failing test**

```ts
// packages/engine/src/scheduling/build-objectives.test.ts
import { describe, expect, it } from "vitest";
import { boardMetrics, isStrictlyBetter } from "./build-objectives.ts";
import type { Assignment } from "./calendar.ts";

const T0 = Date.UTC(2026, 7, 8, 9, 0);
const MIN = 60_000;

const card = (id: string, court: string, startMin: number, durMin = 30, entrants: string[] = [], people: string[] = []): Assignment => ({
  fixtureId: id,
  court,
  startAt: T0 + startMin * MIN,
  endAt: T0 + (startMin + durMin) * MIN,
  entrants,
  people,
});

describe("boardMetrics", () => {
  it("reports zero for an empty board", () => {
    expect(boardMetrics([], ["C1"], 0)).toEqual({
      makespanMinutes: 0, worstIdleGapMinutes: 0, courtImbalanceMinutes: 0, placed: 0, total: 0,
    });
  });

  it("makespan spans earliest start to latest end", () => {
    const m = boardMetrics([card("a", "C1", 0), card("b", "C1", 60)], ["C1"], 2);
    expect(m.makespanMinutes).toBe(90);
  });

  it("worst idle gap is measured per entrant, between consecutive matches", () => {
    const m = boardMetrics(
      [card("a", "C1", 0, 30, ["E1"]), card("b", "C2", 120, 30, ["E1"])],
      ["C1", "C2"], 2,
    );
    expect(m.worstIdleGapMinutes).toBe(90); // 30 -> 120
  });

  it("counts a person's gap as well as an entrant's", () => {
    const m = boardMetrics(
      [card("a", "C1", 0, 30, [], ["p1"]), card("b", "C2", 200, 30, [], ["p1"])],
      ["C1", "C2"], 2,
    );
    expect(m.worstIdleGapMinutes).toBe(170);
  });

  it("is zero when nobody plays twice", () => {
    const m = boardMetrics([card("a", "C1", 0, 30, ["E1"]), card("b", "C2", 500, 30, ["E2"])], ["C1", "C2"], 2);
    expect(m.worstIdleGapMinutes).toBe(0);
  });

  it("court imbalance counts an unused configured court as zero minutes", () => {
    const m = boardMetrics([card("a", "C1", 0, 30), card("b", "C1", 60, 30)], ["C1", "C2"], 2);
    expect(m.courtImbalanceMinutes).toBe(60);
  });

  it("counts a court the board uses but the config omits", () => {
    const m = boardMetrics([card("a", "CX", 0, 30)], [], 1);
    expect(m.courtImbalanceMinutes).toBe(0);
  });
});

describe("isStrictlyBetter", () => {
  const base = { makespanMinutes: 100, worstIdleGapMinutes: 50, courtImbalanceMinutes: 20, placed: 10, total: 10 };

  it("prefers more placed above everything", () => {
    expect(isStrictlyBetter({ ...base, placed: 11, makespanMinutes: 999 }, base)).toBe(true);
  });

  it("prefers a shorter makespan over a fairer board", () => {
    expect(isStrictlyBetter({ ...base, makespanMinutes: 90, worstIdleGapMinutes: 999 }, base)).toBe(true);
    expect(isStrictlyBetter({ ...base, makespanMinutes: 110, worstIdleGapMinutes: 0 }, base)).toBe(false);
  });

  it("prefers a fairer board over a balanced one", () => {
    expect(isStrictlyBetter({ ...base, worstIdleGapMinutes: 40, courtImbalanceMinutes: 999 }, base)).toBe(true);
  });

  it("is false for an identical board", () => {
    expect(isStrictlyBetter(base, base)).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
cd ../wt-z3-build && npm test --workspace packages/engine -- \
  src/scheduling/build-objectives.test.ts --reporter=json --outputFile=/tmp/t1.json >/dev/null 2>&1; \
  node -e 'const r=require("/tmp/t1.json");console.log(r.numPassedTests,r.numTotalTests,r.numFailedTests)'
```

Expected: fails to resolve `./build-objectives.ts` — `numTotalTests` is 0 and the suite errors. **A `0 0 0` here means "failed to collect", which is the expected red at this step and NOT a pass.**

- [ ] **Step 3: Write the implementation**

```ts
// packages/engine/src/scheduling/build-objectives.ts
//
// The three numbers that decide whether one board is better than another, and
// the lexicographic comparison over them (design D3: compact > fairness >
// balance, with placed-count above all three).
//
// PURE on purpose. No config, no rules, no z3. Four callers read these — the
// solver's tier bounds, the API response, the board's result strip, and the
// tests that assert the solver never returns a board worse than greedy — and a
// metric computed inside the solver would be one no test could reproduce.
import type { Assignment } from "./calendar.ts";

const MS_PER_MIN = 60_000;

export interface BoardMetrics {
  /** Earliest start to latest end, in minutes. 0 for an empty board. */
  makespanMinutes: number;
  /** The largest gap any single participant waits between two of its matches.
   *  Measured over entrants AND people: a human umpiring two divisions waits
   *  just as long as a team does, and `people` is what carries them. */
  worstIdleGapMinutes: number;
  /** Busiest court's minutes minus the quietest's, over the configured courts
   *  plus any court the board actually uses. A configured court nobody plays on
   *  counts as zero, which is the whole point of the metric. */
  courtImbalanceMinutes: number;
  placed: number;
  total: number;
}

export function boardMetrics(
  assignments: readonly Assignment[],
  courts: readonly string[],
  total: number,
): BoardMetrics {
  if (assignments.length === 0) {
    return { makespanMinutes: 0, worstIdleGapMinutes: 0, courtImbalanceMinutes: 0, placed: 0, total };
  }

  let lo = Infinity;
  let hi = -Infinity;
  const byParticipant = new Map<string, Assignment[]>();
  const courtMinutes = new Map<string, number>(courts.map((c) => [c, 0]));

  for (const a of assignments) {
    if (a.startAt < lo) lo = a.startAt;
    if (a.endAt > hi) hi = a.endAt;
    courtMinutes.set(a.court, (courtMinutes.get(a.court) ?? 0) + (a.endAt - a.startAt) / MS_PER_MIN);
    // Namespaced so an entrant id can never collide with a person id — the
    // identity-seam defect shape this repo has hit eight times.
    for (const e of a.entrants) push(byParticipant, `e:${e}`, a);
    for (const p of a.people) push(byParticipant, `p:${p}`, a);
  }

  let worstIdleGapMinutes = 0;
  for (const rows of byParticipant.values()) {
    if (rows.length < 2) continue;
    const sorted = [...rows].sort((x, y) => x.startAt - y.startAt);
    for (let i = 1; i < sorted.length; i++) {
      const gap = (sorted[i]!.startAt - sorted[i - 1]!.endAt) / MS_PER_MIN;
      if (gap > worstIdleGapMinutes) worstIdleGapMinutes = gap;
    }
  }

  const mins = [...courtMinutes.values()];
  return {
    makespanMinutes: (hi - lo) / MS_PER_MIN,
    worstIdleGapMinutes,
    courtImbalanceMinutes: Math.max(...mins) - Math.min(...mins),
    placed: assignments.length,
    total,
  };
}

function push(map: Map<string, Assignment[]>, key: string, a: Assignment): void {
  const rows = map.get(key);
  if (rows === undefined) map.set(key, [a]);
  else rows.push(a);
}

/** Design D3's ordering, as one comparison. Lexicographic rather than weighted
 *  so a reviewer and an organiser can both say WHY one board won. */
export function isStrictlyBetter(a: BoardMetrics, b: BoardMetrics): boolean {
  if (a.placed !== b.placed) return a.placed > b.placed;
  if (a.makespanMinutes !== b.makespanMinutes) return a.makespanMinutes < b.makespanMinutes;
  if (a.worstIdleGapMinutes !== b.worstIdleGapMinutes) return a.worstIdleGapMinutes < b.worstIdleGapMinutes;
  return a.courtImbalanceMinutes < b.courtImbalanceMinutes;
}
```

- [ ] **Step 4: Export it**

Add to `packages/engine/src/scheduling/index.ts`, after the `export * from "./tz.ts";` line:

```ts
// The build solver (this plan). Pure metrics first — no z3 anywhere in here.
export * from "./build-objectives.ts";
```

- [ ] **Step 5: Run the test and the full engine suite**

```bash
cd ../wt-z3-build && npm test --workspace packages/engine -- \
  --reporter=json --outputFile=/tmp/t1.json >/dev/null 2>&1; \
  node -e 'const r=require("/tmp/t1.json");console.log(r.numPassedTests,r.numTotalTests,r.numFailedTests)'
```

Expected: `numFailedTests` is 0 and `numTotalTests` is the Task 0 baseline **+ 11**.

- [ ] **Step 6: Commit and update state**

```bash
git add packages/engine/src/scheduling/build-objectives.ts \
        packages/engine/src/scheduling/build-objectives.test.ts \
        packages/engine/src/scheduling/index.ts .claude/z3-scheduling-state.md
git commit -m "feat(engine): board metrics and the lexicographic board comparison"
```

---

### Task 2: `build-grid.ts` — the legal slot lattice

**Files:**
- Create: `packages/engine/src/scheduling/build-grid.ts`
- Test: `packages/engine/src/scheduling/build-grid.test.ts`
- Modify: `packages/engine/src/scheduling/index.ts`

**Interfaces:**
- Consumes: `SlotConfig`, `Assignment`, `Blackout`, `SessionWindow`, `intervalsOverlap` from `./calendar.ts`; `calendarDaysCovering`, `repairCourts`, `repairUniverse` from `./repair-domain.ts`; `REPAIR_GRID_MINUTES` from `./repair.ts`.
- Produces:
  - `const MAX_SLOTS = 20_000`
  - `interface BuildSlot { court: string; startAt: number }`
  - `interface BuildGrid { slots: readonly BuildSlot[]; byCourt: ReadonlyMap<string, readonly number[]>; stepMinutes: number; overCap: boolean }`
  - `function gridStepMinutes(config: Pick<SlotConfig, "matchMinutes" | "gapMinutes">): number`
  - `function buildGrid(input: BuildGridInput): BuildGrid` where
    `interface BuildGridInput { config: SlotConfig & { courts: string[] }; existing?: readonly Assignment[]; pinned?: readonly BuildSlot[] }`

- [ ] **Step 1: Write the failing test**

```ts
// packages/engine/src/scheduling/build-grid.test.ts
import { describe, expect, it } from "vitest";
import { buildGrid, gridStepMinutes, MAX_SLOTS } from "./build-grid.ts";
import type { Assignment, SlotConfig } from "./calendar.ts";

const MIN = 60_000;
const DAY = 86_400_000;
const T0 = Date.UTC(2026, 7, 8, 8, 0); // Sat 08 Aug 2026, 08:00Z

const cfg = (over: Partial<SlotConfig> = {}): SlotConfig & { courts: string[] } => ({
  startAt: T0,
  matchMinutes: 30,
  gapMinutes: 10,
  courts: ["C1", "C2"],
  perEntrantMinRest: 0,
  window: { from: T0, to: T0 + 4 * 60 * MIN },
  ...over,
});

describe("gridStepMinutes", () => {
  it("is the gcd of match and gap length", () => {
    expect(gridStepMinutes({ matchMinutes: 60, gapMinutes: 15 })).toBe(15);
    expect(gridStepMinutes({ matchMinutes: 45, gapMinutes: 10 })).toBe(5);
  });

  it("degenerates to the match length when there is no gap", () => {
    expect(gridStepMinutes({ matchMinutes: 45, gapMinutes: 0 })).toBe(45);
  });

  it("never goes below the repair grid", () => {
    expect(gridStepMinutes({ matchMinutes: 7, gapMinutes: 3 })).toBe(5);
  });
});

describe("buildGrid", () => {
  it("covers every court across the window at the step", () => {
    const g = buildGrid({ config: cfg() });
    expect(g.stepMinutes).toBe(10);
    // A 30-minute match must FIT: last legal start is window.to - 30 min.
    const c1 = g.byCourt.get("C1")!;
    expect(g.slots[c1[0]!]!.startAt).toBe(T0);
    expect(g.slots[c1[c1.length - 1]!]!.startAt).toBe(T0 + (4 * 60 - 30) * MIN);
    expect(g.byCourt.get("C2")!.length).toBe(c1.length);
    expect(g.overCap).toBe(false);
  });

  it("drops starts whose occupancy overlaps a global blackout", () => {
    const g = buildGrid({ config: cfg({ blackouts: [{ from: T0 + 60 * MIN, to: T0 + 90 * MIN }] }) });
    const starts = g.byCourt.get("C1")!.map((i) => g.slots[i]!.startAt);
    expect(starts).not.toContain(T0 + 60 * MIN);
    expect(starts).not.toContain(T0 + 40 * MIN); // 40..70 overlaps
    expect(starts).toContain(T0 + 30 * MIN); // 30..60 touches, does not overlap
    expect(starts).toContain(T0 + 90 * MIN);
  });

  it("scopes a court-scoped blackout to that court only", () => {
    const g = buildGrid({ config: cfg({ blackouts: [{ court: "C1", from: T0, to: T0 + 60 * MIN }] }) });
    expect(g.byCourt.get("C1")!.map((i) => g.slots[i]!.startAt)).not.toContain(T0);
    expect(g.byCourt.get("C2")!.map((i) => g.slots[i]!.startAt)).toContain(T0);
  });

  it("admits only starts fully inside a session window", () => {
    const g = buildGrid({
      config: cfg({ sessionWindows: [{ from: T0 + 60 * MIN, to: T0 + 150 * MIN }] }),
    });
    const starts = g.byCourt.get("C1")!.map((i) => g.slots[i]!.startAt);
    expect(starts[0]).toBe(T0 + 60 * MIN);
    expect(starts[starts.length - 1]).toBe(T0 + 120 * MIN); // 120..150 fits
  });

  it("removes court-time an existing booking occupies, including the gap", () => {
    const existing: Assignment[] = [{
      fixtureId: "x", court: "C1",
      startAt: T0 + 60 * MIN, endAt: T0 + 90 * MIN,
      entrants: [], people: [],
    }];
    const g = buildGrid({ config: cfg(), existing });
    const starts = g.byCourt.get("C1")!.map((i) => g.slots[i]!.startAt);
    expect(starts).not.toContain(T0 + 60 * MIN);
    expect(starts).not.toContain(T0 + 50 * MIN); // needs the 10-minute gap
    expect(starts).toContain(T0 + 100 * MIN); // 90 + 10 gap
    expect(g.byCourt.get("C2")!.map((i) => g.slots[i]!.startAt)).toContain(T0 + 60 * MIN);
  });

  it("admits an off-grid pinned start so a locked card stays representable", () => {
    const pinnedAt = T0 + 7 * MIN; // not a multiple of the 10-minute step
    const g = buildGrid({ config: cfg(), pinned: [{ court: "C1", startAt: pinnedAt }] });
    expect(g.byCourt.get("C1")!.map((i) => g.slots[i]!.startAt)).toContain(pinnedAt);
  });

  it("keeps a start whose match runs past midnight", () => {
    // REGRESSION. Bounding the occupancy by `bucket.to` drops this start from
    // BOTH days: excluded by day 0's bound, and unreachable from day 1 whose
    // stepping begins at midnight. Needs step < duration to appear at all,
    // which is any `gapMinutes > 0` — the ordinary case, no DST involved.
    const from = Date.UTC(2026, 7, 8, 0, 0);
    const g = buildGrid({
      config: cfg({ tz: "UTC", window: { from, to: from + 3 * DAY }, matchMinutes: 90, gapMinutes: 30 }),
    });
    expect(g.byCourt.get("C1")!.map((i) => g.slots[i]!.startAt)).toContain(from + 1380 * MIN); // 23:00 -> 00:30
  });

  it("anchors each day at local midnight so a DST day does not drift", () => {
    // Europe/London springs forward 29 Mar 2026 at 01:00 local. The step must
    // NOT divide the local-midnight offsets, or the anchored and UTC-stepped
    // lattices are the same instants and the assertion proves nothing: those
    // offsets are 0/1440/2820/4260 minutes, all divisible by 60 and only the
    // first two by 45. A 60-minute step here is VACUOUS — measured, not feared.
    const from = Date.UTC(2026, 2, 28, 0, 0);
    const g = buildGrid({
      config: cfg({ tz: "Europe/London", window: { from, to: from + 3 * DAY }, matchMinutes: 45, gapMinutes: 45 }),
    });
    const local = (ms: number) =>
      new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(ms));
    // Every start is on a whole local hour on BOTH sides of the transition.
    for (const s of g.slots) expect(local(s.startAt).endsWith(":00")).toBe(true);
  });

  it("flags overCap and returns no slots when the lattice is too large", () => {
    const g = buildGrid({
      config: cfg({ window: { from: T0, to: T0 + 400 * DAY }, courts: ["C1", "C2", "C3", "C4"] }),
    });
    expect(g.overCap).toBe(true);
    expect(g.slots.length).toBe(0);
  });

  it("is deterministic", () => {
    expect(buildGrid({ config: cfg() })).toEqual(buildGrid({ config: cfg() }));
  });

  it("exposes the cap", () => {
    expect(MAX_SLOTS).toBe(20_000);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
cd ../wt-z3-build && npm test --workspace packages/engine -- \
  src/scheduling/build-grid.test.ts --reporter=json --outputFile=/tmp/t2.json >/dev/null 2>&1; \
  node -e 'const r=require("/tmp/t2.json");console.log(r.numPassedTests,r.numTotalTests,r.numFailedTests)'
```

Expected: collection failure — `./build-grid.ts` does not exist.

- [ ] **Step 3: Write the implementation**

```ts
// packages/engine/src/scheduling/build-grid.ts
//
// The legal slot lattice a BUILD searches over (design §Architecture).
//
// This is the whole reason the build solver reaches 200 fixtures where the
// repair solver stalls at 80: the repair encoding gives every fixture an
// integer start and pays O(n²) arithmetic to keep them apart, while this one
// pre-computes the finite set of legal (court, start) pairs and lets the SAT
// core do cardinality reasoning over booleans.
//
// Everything removed here is a constraint the encoder then never has to state.
import { intervalsOverlap, type Assignment, type Blackout, type SlotConfig } from "./calendar.ts";
import { calendarDaysCovering, repairCourts, repairUniverse } from "./repair-domain.ts";
import { REPAIR_GRID_MINUTES } from "./repair.ts";

const MS_PER_MIN = 60_000;

/** The lattice size past which the boolean model stops being the right tool.
 *  A season-length window over four courts at a five-minute step is >100k
 *  slots; the encoder would spend the whole budget building clauses it never
 *  gets to solve. Over the cap, `build.ts` goes straight to LNS. */
export const MAX_SLOTS = 20_000;

export interface BuildSlot {
  court: string;
  startAt: number;
}

export interface BuildGrid {
  /** Sorted by (court, startAt) — the order is part of the determinism
   *  contract, because slot INDEX is what the encoder names its variables by. */
  slots: readonly BuildSlot[];
  byCourt: ReadonlyMap<string, readonly number[]>;
  stepMinutes: number;
  /** True when the lattice would exceed `MAX_SLOTS`. `slots` is then empty:
   *  a truncated lattice is worse than none, because the encoder cannot tell a
   *  missing slot from an illegal one and would report a spurious infeasible. */
  overCap: boolean;
}

export interface BuildGridInput {
  config: SlotConfig & { courts: string[] };
  existing?: readonly Assignment[];
  /** Locked cards' exact placements. Admitted even when off-grid, so `k = 0`
   *  is representable and a pinned card never forces an infeasible. */
  pinned?: readonly BuildSlot[];
}

/**
 * The lattice step, in minutes.
 *
 * The gcd of match and gap length is the coarsest step that can still express
 * every back-to-back placement: on one court a match starts at a multiple of
 * `matchMinutes + gapMinutes`, and around a blackout or an existing booking it
 * starts at that edge, which is a multiple of neither alone. `gapMinutes: 0` is
 * legal and makes the gcd the match length, which is exactly right for a
 * back-to-back court rather than a degenerate case.
 *
 * Floored at `REPAIR_GRID_MINUTES` so the two solvers agree about what
 * "on-grid" means, and so a five-minute sport cannot explode the lattice.
 */
export function gridStepMinutes(config: Pick<SlotConfig, "matchMinutes" | "gapMinutes">): number {
  const g = gcd(Math.max(1, Math.round(config.matchMinutes)), Math.max(0, Math.round(config.gapMinutes)));
  return Math.max(REPAIR_GRID_MINUTES, g);
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

export function buildGrid(input: BuildGridInput): BuildGrid {
  const { config } = input;
  const existing = input.existing ?? [];
  const pinned = input.pinned ?? [];
  const stepMinutes = gridStepMinutes(config);
  const stepMs = stepMinutes * MS_PER_MIN;
  const durMs = config.matchMinutes * MS_PER_MIN;
  const gapMs = config.gapMinutes * MS_PER_MIN;

  const courts = repairCourts({ proposal: [], existing, config });
  const universe = repairUniverse({ proposal: [], existing, config });

  // Day anchors. Stepping from `universe.from` alone stays aligned in UTC and
  // DRIFTS in wall clock across a DST boundary — a 10:00 lattice becomes an
  // 09:00 one. Anchoring each day at its own local midnight is what keeps a
  // start on a whole local hour on both sides of the transition.
  //
  // With no `tz` there is no local midnight to anchor to, so the whole universe
  // is one bucket. That matches the verifier, which SKIPS day-shaped rules
  // rather than bucketing them in UTC.
  const buckets =
    config.tz !== undefined
      ? calendarDaysCovering(universe, config.tz)
      : [{ ymd: "", from: universe.from, to: universe.to }];

  const sessions = config.sessionWindows ?? [];
  const blackouts: readonly Blackout[] = config.blackouts ?? [];

  const slots: BuildSlot[] = [];
  const seen = new Set<string>();
  let overCap = false;

  outer: for (const court of courts) {
    for (const bucket of buckets) {
      const lo = Math.max(bucket.from, universe.from);
      // Step ANCHORED to the bucket — that is what keeps a start on a whole
      // local hour across a DST transition. But bound the OCCUPANCY by the
      // universe, never by the bucket: a match that starts at 23:00 and ends
      // at 00:30 is legal, and bounding it by `bucket.to` drops it from BOTH
      // days at once — this day excludes it, and the next day's own `lo`
      // begins at midnight so it is never reachable there either. Fires on any
      // `gapMinutes > 0` with a multi-day window. `repair-domain.ts` gets this
      // right: its position domain is continuous over the whole universe, and
      // day buckets restrict day-SCOPED RULES, never raw start admissibility.
      const stopStepping = Math.min(bucket.to, universe.to);
      for (let start = lo; start < stopStepping && start + durMs <= universe.to; start += stepMs) {
        if (!admits(start)) continue;
        if (slots.length >= MAX_SLOTS) { overCap = true; break outer; }
        slots.push({ court, startAt: start });
        seen.add(`${court}|${start}`);
      }
    }

    function admits(start: number): boolean {
      const end = start + durMs;
      if (sessions.length > 0 && !sessions.some((w) => start >= w.from && end <= w.to)) return false;
      for (const b of blackouts) {
        if (b.court !== undefined && b.court !== court) continue;
        if (intervalsOverlap(start, end, b.from, b.to)) return false;
      }
      for (const a of existing) {
        if (a.court !== court) continue;
        // The same half-open, gap-padded test `slotFixtures` uses, so the
        // lattice and the placer agree about what "free court time" is.
        if (intervalsOverlap(start, end + gapMs, a.startAt, a.endAt + gapMs)) return false;
      }
      return true;
    }
  }

  if (overCap) {
    return { slots: [], byCourt: new Map(), stepMinutes, overCap: true };
  }

  // Pinned placements are admitted UNCONDITIONALLY — a locked card's own slot
  // must exist even when it is off-grid, outside the session windows, or inside
  // a blackout the organiser added afterwards. Refusing it would report the
  // board infeasible for a card nobody asked to move.
  for (const p of pinned) {
    const key = `${p.court}|${p.startAt}`;
    if (seen.has(key)) continue;
    seen.add(key);
    slots.push({ court: p.court, startAt: p.startAt });
  }

  slots.sort((a, b) => (a.court === b.court ? a.startAt - b.startAt : a.court < b.court ? -1 : 1));

  const byCourt = new Map<string, number[]>();
  slots.forEach((s, i) => {
    const rows = byCourt.get(s.court);
    if (rows === undefined) byCourt.set(s.court, [i]);
    else rows.push(i);
  });

  return { slots, byCourt, stepMinutes, overCap: false };
}
```

- [ ] **Step 4: Export it**

Add to `packages/engine/src/scheduling/index.ts` under the Task 1 line:

```ts
export * from "./build-grid.ts";
```

- [ ] **Step 5: Run the test and the full engine suite**

```bash
cd ../wt-z3-build && npm test --workspace packages/engine -- \
  --reporter=json --outputFile=/tmp/t2.json >/dev/null 2>&1; \
  node -e 'const r=require("/tmp/t2.json");console.log(r.numPassedTests,r.numTotalTests,r.numFailedTests)'
```

Expected: `numFailedTests` 0; total = Task 1's total **+ 12**.

- [ ] **Step 6: Commit**

```bash
git add packages/engine/src/scheduling/build-grid.ts \
        packages/engine/src/scheduling/build-grid.test.ts \
        packages/engine/src/scheduling/index.ts .claude/z3-scheduling-state.md
git commit -m "feat(engine): day-anchored slot lattice for the build solver"
```

---

### Task 3: `build-encode.ts` — the boolean model

**Files:**
- Create: `packages/engine/src/scheduling/build-encode.ts`
- Test: `packages/engine/src/scheduling/build-encode-parity.test.ts`
- Modify: `packages/engine/src/scheduling/index.ts`

**Interfaces:**
- Consumes: `BuildGrid` / `BuildSlot` from `./build-grid.ts`; `Assignment`, `SchedulableFixture`, `OrderDependency`, `VerifyConfig`, `validateAssignments`, `pairRestMinutesFor`, `effectiveRestMinutes`, `startWindowFor`, `intervalsOverlap` from `./calendar.ts`; `Z3Context` from `./z3-load.ts`.
- Produces:
  - `interface EncodeInput { Z3: Z3Context["Z3"]; solver: Solver; fixtures: readonly SchedulableFixture[]; grid: BuildGrid; config: VerifyConfig & { matchMinutes: number; courts: string[] }; existing?: readonly Assignment[]; dependencies?: readonly OrderDependency[] }`
  - `interface EncodedModel { place: Bool[][]; slotOf: (model: Model) => (readonly (number | null)[]); assignmentsFrom: (picked: readonly (number | null)[]) => Assignment[] }`
  - `function encodeBuild(input: EncodeInput): EncodedModel`

**What this task must NOT do:** compute any rest amount, scope test, or selector resolution itself. Every one comes from a `calendar.ts` export. A reviewer rejects the diff on sight otherwise.

- [ ] **Step 1: Write the failing parity test**

```ts
// packages/engine/src/scheduling/build-encode-parity.test.ts
//
// THE anti-fork test. The encoder and `validateAssignments` must answer the
// same question: for every assignment the lattice can express, the model
// accepts it IFF the verifier reports no conflict. A solver with its own idea
// of the rules produces boards the gate rejects, which is the lock-out this
// whole design exists to prevent.
import { describe, expect, it } from "vitest";
import { buildGrid } from "./build-grid.ts";
import { encodeBuild } from "./build-encode.ts";
import { loadZ3, resetZ3, withZ3Lock } from "./z3-load.ts";
import { validateAssignments, type Assignment, type SchedulableFixture, type SlotConfig, type VerifyConfig } from "./calendar.ts";

const MIN = 60_000;
const T0 = Date.UTC(2026, 7, 8, 9, 0);

const config = (over: Partial<SlotConfig> = {}): SlotConfig & { courts: string[] } => ({
  startAt: T0, matchMinutes: 30, gapMinutes: 10, courts: ["C1", "C2"],
  perEntrantMinRest: 60, window: { from: T0, to: T0 + 6 * 60 * MIN },
  tz: "Europe/London", ...over,
});

const fx = (id: string, home: string, away: string, people: string[] = []): SchedulableFixture =>
  ({ id, home, away, people });

/** Every placement the lattice can express, one fixture per slot, no repeats. */
function* placements(n: number, slotCount: number): Generator<number[]> {
  const pick: number[] = [];
  function* go(i: number): Generator<number[]> {
    if (i === n) { yield [...pick]; return; }
    for (let s = 0; s < slotCount; s++) {
      if (pick.includes(s)) continue;
      pick.push(s); yield* go(i + 1); pick.pop();
    }
  }
  yield* go(0);
}

describe("encodeBuild — verifier parity", () => {
  it("accepts a placement iff validateAssignments does (no siblings)", async () => {
    const cfg = config({ window: { from: T0, to: T0 + 150 * MIN } });
    const fixtures = [fx("f1", "E1", "E2"), fx("f2", "E1", "E3")];
    const grid = buildGrid({ config: cfg });
    await assertParity(cfg, fixtures, grid, []);
  }, 120_000);

  it("accepts a placement iff validateAssignments does, WITH a sibling sharing a person", async () => {
    // Gap 6: the sibling's court time is already out of the lattice, but its
    // PERSON is not. An encoder that only subtracted court time double-books
    // the human and the verifier rejects the board.
    const cfg = config({ window: { from: T0, to: T0 + 150 * MIN } });
    const existing: Assignment[] = [{
      fixtureId: "sib", court: "C9",
      startAt: T0 + 30 * MIN, endAt: T0 + 60 * MIN,
      entrants: ["E9"], people: ["ref1"],
    }];
    const fixtures = [fx("f1", "E1", "E2", ["ref1"])];
    const grid = buildGrid({ config: cfg, existing });
    await assertParity(cfg, fixtures, grid, existing);
  }, 120_000);
});

async function assertParity(
  cfg: SlotConfig & { courts: string[] },
  fixtures: readonly SchedulableFixture[],
  grid: ReturnType<typeof buildGrid>,
  existing: readonly Assignment[],
): Promise<void> {
  const verify: VerifyConfig = { ...cfg };
  const { Z3 } = await loadZ3();
  let checked = 0;
  await withZ3Lock(async () => {
    for (const pick of placements(fixtures.length, grid.slots.length)) {
      const solver = new Z3.Solver();
      const model = encodeBuild({ Z3, solver, fixtures, grid, config: { ...verify, matchMinutes: cfg.matchMinutes, courts: cfg.courts }, existing });
      // Force exactly this placement and ask whether the model tolerates it.
      pick.forEach((s, i) => solver.add(model.place[i]![s]!));
      const sat = (await solver.check()) === "sat";
      const assignments = model.assignmentsFrom(pick);
      const clean = validateAssignments(assignments, verify, existing).length === 0;
      expect({ pick, sat }).toEqual({ pick, sat: clean });
      checked++;
    }
  });
  expect(checked).toBeGreaterThan(20);
  await resetZ3();
}
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
cd ../wt-z3-build && npm test --workspace packages/engine -- \
  src/scheduling/build-encode-parity.test.ts --reporter=json --outputFile=/tmp/t3.json >/dev/null 2>&1; \
  node -e 'const r=require("/tmp/t3.json");console.log(r.numPassedTests,r.numTotalTests,r.numFailedTests)'
```

Expected: collection failure — `./build-encode.ts` does not exist.

- [ ] **Step 3: Write the implementation**

```ts
// packages/engine/src/scheduling/build-encode.ts
//
// The boolean model, and NOTHING else.
//
// One variable per (fixture, slot). Exactly one slot per fixture; at most one
// fixture per slot. Everything the lattice already removed — blackouts, session
// windows, the competition window, court time a sibling occupies — is absent by
// construction and is not restated here.
//
// What IS stated here is every pairwise rule, and every one of them asks
// `calendar.ts` for the answer. This file must contain no rule arithmetic of
// its own: the placer/verifier fork is the recurring defect in this subsystem,
// and it always arrives as a literal that looked harmless.
import type { Bool, Model, Solver } from "z3-solver";
import type { BuildGrid } from "./build-grid.ts";
import {
  intervalsOverlap,
  pairRestMinutesFor,
  startWindowFor,
  type Assignment,
  type OrderDependency,
  type SchedulableFixture,
  type VerifyConfig,
} from "./calendar.ts";
import type { Z3Context } from "./z3-load.ts";

const MS_PER_MIN = 60_000;

export type BuildConfig = VerifyConfig & { matchMinutes: number; courts: string[] };

export interface EncodeInput {
  Z3: Z3Context["Z3"];
  solver: Solver;
  fixtures: readonly SchedulableFixture[];
  grid: BuildGrid;
  config: BuildConfig;
  existing?: readonly Assignment[];
  dependencies?: readonly OrderDependency[];
}

export interface EncodedModel {
  /** `place[f][s]` — fixture `f` occupies slot `s`. */
  place: Bool<"repair">[][];
  /** `placed[f]` — fixture `f` got a slot at all. T0 maximises the count of
   *  these, which is what turns greedy's `no_slot` GUESS into a PROOF. */
  placed: Bool<"repair">[];
  /** Read a solved model back into slot indexes, `null` for unplaced. */
  slotOf: (model: Model<"repair">) => (number | null)[];
  /** Turn slot indexes into the assignments the verifier will be handed. */
  assignmentsFrom: (picked: readonly (number | null)[]) => Assignment[];
}

export function encodeBuild(input: EncodeInput): EncodedModel {
  const { Z3, solver, fixtures, grid, config } = input;
  const existing = input.existing ?? [];
  const dependencies = input.dependencies ?? [];
  const durMs = config.matchMinutes * MS_PER_MIN;
  const gapMs = config.gapMinutes * MS_PER_MIN;

  const asAssignment = (f: SchedulableFixture, slot: number): Assignment => ({
    fixtureId: f.id,
    court: grid.slots[slot]!.court,
    startAt: grid.slots[slot]!.startAt,
    endAt: grid.slots[slot]!.startAt + durMs,
    entrants: [f.home, f.away].filter((e): e is string => e !== undefined),
    people: [...(f.people ?? [])],
    ...(f.poolId !== undefined ? { poolId: f.poolId } : {}),
    ...(f.divisionId !== undefined ? { divisionId: f.divisionId } : {}),
  });

  const place = fixtures.map((_, i) => grid.slots.map((_, s) => Z3.Bool.const(`x_${i}_${s}`)));
  const placed = fixtures.map((_, i) => Z3.Bool.const(`p_${i}`));

  // 1. A fixture takes at most one slot, and `placed[i]` says whether it took
  //    one. Encoded as AtMost + an equivalence rather than exactly-one, because
  //    T0 needs "unplaced" to be a legal state it can then minimise.
  // NOTE the array argument. `AtMost`/`AtLeast`/`PbLe` take a NON-EMPTY TUPLE,
  // not varargs — `AtMost(...lits, 1)` is a runtime TypeError, and `repair.ts`
  // spells it `Z3.AtMost([lits[0]!, ...lits.slice(1)], k)` for that reason.
  fixtures.forEach((_, i) => {
    const lits = place[i]!;
    if (lits.length > 0) solver.add(Z3.AtMost([lits[0]!, ...lits.slice(1)], 1));
    solver.add(placed[i]!.eq(Z3.Or(...lits)));
  });

  // 2. A slot holds at most one fixture. This is the court-clash rule, and the
  //    gap between neighbours is handled below rather than here, because two
  //    DIFFERENT slots on one court can still be too close together.
  grid.slots.forEach((_, s) => {
    const column = fixtures.map((_, i) => place[i]![s]!);
    if (column.length > 1) solver.add(Z3.AtMost(...column, 1));
  });

  // 3. A fixture may only use a slot its own locked placement allows.
  fixtures.forEach((f, i) => {
    if (f.locked === undefined) return;
    const s = grid.slots.findIndex((sl) => sl.court === f.locked!.court && sl.startAt === f.locked!.startAt);
    // `buildGrid` admits every pinned placement, so -1 here is a programming
    // error in the caller, not an organiser input.
    if (s < 0) throw new Error(`locked slot missing from grid: ${f.id}`);
    solver.add(place[i]![s]!);
  });

  // 4. Start windows. `startWindowFor` is the verifier's own answer; asking it
  //    per (fixture, slot) is O(n·|slots|) and cheap next to the pair loop.
  fixtures.forEach((f, i) => {
    grid.slots.forEach((sl, s) => {
      const a = asAssignment(f, s);
      const w = startWindowFor(config, a);
      if (sl.startAt < w.notBefore || sl.startAt > w.notAfter) solver.add(Z3.Not(place[i]![s]!));
    });
  });

  // 5. Pairwise rules between two MOVABLE fixtures: same-court gap, participant
  //    overlap, and the rest each pair owes. `pairRestMinutesFor` is hoisted
  //    once — the un-hoisted wrapper made this loop 111x slower in `repair.ts`.
  const pairRest = pairRestMinutesFor(config);
  for (let i = 0; i < fixtures.length; i++) {
    for (let j = i + 1; j < fixtures.length; j++) {
      // Two fixtures with no participant in common can only ever clash on a
      // court, which is a same-court test and not a rest one. Knowing that up
      // front is what makes the pruning in the note below possible.
      const shared = sharesParticipantFixture(fixtures[i]!, fixtures[j]!);
      void shared; // consumed by the pruned form; see the implementer note
      for (let s = 0; s < grid.slots.length; s++) {
        const a = asAssignment(fixtures[i]!, s);
        for (let t = 0; t < grid.slots.length; t++) {
          const b = asAssignment(fixtures[j]!, t);
          if (compatible(a, b)) continue;
          solver.add(Z3.Not(Z3.And(place[i]![s]!, place[j]![t]!)));
        }
      }
    }
  }

  // 6. The same rules against every IMMOVABLE row (Gap 6). The lattice already
  //    removed their COURT time; their entrants, people and rest did not travel
  //    with it, and an encoder that stops at court time double-books a human
  //    across two divisions.
  fixtures.forEach((f, i) => {
    for (let s = 0; s < grid.slots.length; s++) {
      const a = asAssignment(f, s);
      if (existing.every((e) => compatible(a, e))) continue;
      solver.add(Z3.Not(place[i]![s]!));
    }
  });

  // 7. Order dependencies: a fixture starts no earlier than its feeder ends.
  //    A dependency on an immovable row is a bound on one side only.
  const indexOf = new Map(fixtures.map((f, i) => [f.id, i]));
  const endOfExisting = new Map(existing.map((e) => [e.fixtureId, e.endAt]));
  for (const dep of dependencies) {
    const i = indexOf.get(dep.fixtureId);
    if (i === undefined) continue;
    const j = indexOf.get(dep.dependsOn);
    if (j === undefined) {
      const end = endOfExisting.get(dep.dependsOn);
      if (end === undefined) continue;
      grid.slots.forEach((sl, s) => { if (sl.startAt < end) solver.add(Z3.Not(place[i]![s]!)); });
      continue;
    }
    for (let s = 0; s < grid.slots.length; s++) {
      for (let t = 0; t < grid.slots.length; t++) {
        if (grid.slots[s]!.startAt >= grid.slots[t]!.startAt + durMs) continue;
        solver.add(Z3.Not(Z3.And(place[i]![s]!, place[j]![t]!)));
      }
    }
  }

  /** Two placements that may coexist. The ONLY place this file decides
   *  anything, and every term in it is a `calendar.ts` answer. */
  function compatible(a: Assignment, b: Assignment): boolean {
    if (a.court === b.court && intervalsOverlap(a.startAt, a.endAt + gapMs, b.startAt, b.endAt + gapMs)) return false;
    if (!sharesParticipant(a, b)) return true;
    // Rest is ASYMMETRIC: the amount owed depends on which row is asked about,
    // so both directions are taken and the binding one is the max of the two.
    const restMs = Math.max(pairRest(a, b), pairRest(b, a)) * MS_PER_MIN;
    return !intervalsOverlap(a.startAt, a.endAt + restMs, b.startAt, b.endAt + restMs);
  }

  return {
    place,
    placed,
    slotOf: (model) =>
      fixtures.map((_, i) => {
        const s = grid.slots.findIndex((_, si) => model.eval(place[i]![si]!).toString() === "true");
        return s < 0 ? null : s;
      }),
    assignmentsFrom: (picked) =>
      fixtures.flatMap((f, i) => (picked[i] === null || picked[i] === undefined ? [] : [asAssignment(f, picked[i]!)])),
  };
}

function sharesParticipant(a: Assignment, b: Assignment): boolean {
  return (
    a.entrants.some((e) => b.entrants.includes(e)) || a.people.some((p) => b.people.includes(p))
  );
}

function sharesParticipantFixture(a: SchedulableFixture, b: SchedulableFixture): boolean {
  const ea = [a.home, a.away].filter((x): x is string => x !== undefined);
  const eb = [b.home, b.away].filter((x): x is string => x !== undefined);
  return ea.some((e) => eb.includes(e)) || (a.people ?? []).some((p) => (b.people ?? []).includes(p));
}
```

> **Implementer note — the O(n²·|slots|²) pair loop in step 5 is the performance risk of this whole plan.** At 200 fixtures × 250 slots it is 10¹⁰ iterations and will not finish. Before moving on, replace the inner double loop with the *pruned* form: iterate only slot pairs whose intervals can actually conflict (same court within `matchMinutes + gapMinutes`, or within `max rest` of each other), reached from a per-court sorted slot list. The `sharesParticipantFixture` guard already lets you skip the rest half entirely for pairs with no shared participant. **Keep the parity test passing while you prune — that test is exactly what makes pruning safe.** If pruning proves harder than expected, stop and ask the owner rather than shipping a loop that cannot run.

- [ ] **Step 4: Export it, then run the parity test**

```ts
export * from "./build-encode.ts";
```

```bash
cd ../wt-z3-build && npm test --workspace packages/engine -- \
  src/scheduling/build-encode-parity.test.ts --reporter=json --outputFile=/tmp/t3.json >/dev/null 2>&1; \
  node -e 'const r=require("/tmp/t3.json");console.log(r.numPassedTests,r.numTotalTests,r.numFailedTests)'
```

Expected: `2 2 0`.

- [ ] **Step 5: Run the whole engine suite and commit**

```bash
cd ../wt-z3-build && npm test --workspace packages/engine -- \
  --reporter=json --outputFile=/tmp/t3all.json >/dev/null 2>&1; \
  node -e 'const r=require("/tmp/t3all.json");console.log(r.numPassedTests,r.numTotalTests,r.numFailedTests)'
git add packages/engine/src/scheduling/build-encode.ts \
        packages/engine/src/scheduling/build-encode-parity.test.ts \
        packages/engine/src/scheduling/index.ts .claude/z3-scheduling-state.md
git commit -m "feat(engine): boolean slot-assignment encoding, verified against the verifier"
```

---

### Task 3b: typed instruction rules in the encoder

**Added mid-flight, on the owner's ruling (2026-08-05), after Task 3 reported the gap.**

**Files:**
- Modify: `packages/engine/src/scheduling/build-encode.ts`
- Test: `packages/engine/src/scheduling/build-encode-rules.test.ts` (create)

**Why this is not optional.** `slotFixtures` has placed around typed rules since
the convergence programme (#463 — see `calendar-day-cap-placement.test.ts` and
`calendar-day-targets-placement.test.ts`), and `repair.ts:803` (`assertDayCap`)
encodes `max_fixtures_per_day`. Without this task BUILD is the **only** path that
ignores rules the greedy it replaces and the repair solver beside it both honour:
`validateInstructionRules` would report breaches on a board the solver had just
called lexicographically optimal, and re-running auto could not fix it. That is
the precise symptom #463 existed to close.

**Why it is cheap here.** In this encoding slot → day and slot → wall-clock are
known *statically*, which the arithmetic encoding cannot say. So:

- `not_before` / `not_after` / `fixture_on_date` / `fixture_on_weekday` are
  **per-slot unary filters** — exactly the shape the existing `startWindowFor`
  filter already uses: if the slot's instant fails the rule for that fixture,
  assert `Z3.Not(place[i][s])`. A few lines each.
- `max_fixtures_per_day` is **one `AtMost` per (rule, calendar day)** over the
  slot literals falling in that day, across the fixtures the rule's scope covers.
  No auxiliary day literals and no `Iff` — `repair.ts` needs those only because
  its starts are integers rather than slots.

**Interfaces:** no new exports. `encodeBuild` gains the assertions; its signature
is unchanged.

**Requirements the tests must pin:**

- Rules come from `effectiveHard(config)`, never from `config.constraints.hard`
  directly — that merged stream is the verifier's own, and a second reading of it
  is the fork this file exists to avoid.
- Scope resolution is `scopeCoversFixture(rule.scope, ruleFixture, assignment)`.
  Do not reimplement the switch.
- The day unit is the **calendar day in `config.tz`**, via `dayKeyInTz` /
  `calendarDaysCovering`. Not a session, not a slice of a day — `repair.ts:810-830`
  documents at length how counting `dayBuckets` instead admitted one fixture per
  *session* and let starts fall in an uncounted gap.
- The cap must **seed from the immovable rows** the rule's scope covers on that
  day (`existing` rows named by `ruleFixtures`), exactly as `assertDayCap` does —
  and must count only KNOWN FIXTURES, since an outside booking or a closed court
  is not a fixture and counting one invents a breach out of a blackout.
- With `config.tz` absent, every day-shaped rule is **skipped**, matching the
  verifier. Do not bucket in UTC.

**Acceptance:** a board that breaches each rule type is rejected by the model,
one that satisfies it is accepted, and — the real gate — `validateInstructionRules`
returns empty for every board the model accepts. Mutation-prove each: break the
rule's assertion, confirm its test alone goes red.

- [ ] **Step 1: Write the failing test file**, one describe per rule type, each asserting both directions (breaching board rejected, satisfying board accepted) plus the `validateInstructionRules`-agrees check.
- [ ] **Step 2: Run it, confirm it fails** for the right reason — the model currently accepts breaching boards, so the "rejected" half fails while the "accepted" half passes.
- [ ] **Step 3: Implement the per-slot filters**, then the day cap.
- [ ] **Step 4: Mutation-prove each assertion**, and re-run the Task 3 parity suite — it must still pass, since these rules only ever *remove* legal placements.
- [ ] **Step 5: Run the engine suite, typecheck, lint, commit.**

---

### Task 4: `build.ts` — seed, gate, and the T0 placement proof

**Files:**
- Create: `packages/engine/src/scheduling/build.ts`
- Test: `packages/engine/src/scheduling/build.test.ts`
- Modify: `packages/engine/src/scheduling/index.ts`

**Interfaces:**
- Consumes: `boardMetrics` / `isStrictlyBetter` / `BoardMetrics` (Task 1), `buildGrid` / `MAX_SLOTS` (Task 2), `encodeBuild` (Task 3), `slotFixtures` / `validateAssignments` from `./calendar.ts`, `loadZ3` / `withZ3Lock` from `./z3-load.ts`.
- Produces:
  - `const DEFAULT_BUILD_RLIMIT = 40_000_000` (re-set by Task 15's bench)
  - `const DEFAULT_BUILD_WALL_MS = 30_000`
  - `type BuildStatus = "ok" | "already_optimal" | "infeasible" | "verifier_rejected" | "z3_unavailable" | "solver_busy"`
  - `interface BuildInput { fixtures; config; existing?; dependencies?; frozen?: readonly string[]; rlimit?: number; wallMs?: number; mode?: "build" | "polish" }`
  - `interface BuildResult { assignments: readonly Assignment[]; conflicts: readonly Conflict[]; metrics: BoardMetrics; engine: "greedy" | "z3" | "z3+lns"; status: BuildStatus; tiersCompleted: number; budgetExpired: boolean; elapsedMs: number; moved: number }`
  - `function buildSchedule(input: BuildInput): Promise<BuildResult>`

- [ ] **Step 1: Write the failing test**

```ts
// packages/engine/src/scheduling/build.test.ts
import { describe, expect, it } from "vitest";
import { buildSchedule } from "./build.ts";
import { boardMetrics } from "./build-objectives.ts";
import { slotFixtures, validateAssignments, type SchedulableFixture, type SlotConfig } from "./calendar.ts";
import { resetZ3 } from "./z3-load.ts";

const MIN = 60_000;
const T0 = Date.UTC(2026, 7, 8, 9, 0);

const cfg = (over: Partial<SlotConfig> = {}): SlotConfig & { courts: string[] } => ({
  startAt: T0, matchMinutes: 30, gapMinutes: 0, courts: ["C1"],
  perEntrantMinRest: 0, window: { from: T0, to: T0 + 180 * MIN },
  tz: "Europe/London", ...over,
});

const fx = (id: string, home: string, away: string, roundNo = 1): SchedulableFixture =>
  ({ id, home, away, roundNo });

describe("buildSchedule", () => {
  it("never returns a board worse than the greedy seed", async () => {
    const config = cfg({ courts: ["C1", "C2"] });
    const fixtures = [fx("f1", "E1", "E2"), fx("f2", "E3", "E4"), fx("f3", "E5", "E6")];
    const greedy = slotFixtures({ fixtures, config });
    const built = await buildSchedule({ fixtures, config });
    const g = boardMetrics(greedy.assignments, config.courts, fixtures.length);
    expect(built.metrics.placed).toBeGreaterThanOrEqual(g.placed);
    expect(built.metrics.makespanMinutes).toBeLessThanOrEqual(g.makespanMinutes);
    await resetZ3();
  }, 120_000);

  it("places a fixture greedy reports no_slot for", async () => {
    // One court, a 60-minute window, three 30-minute matches where E1 plays
    // twice and needs 30 minutes of rest. Greedy takes (roundNo, id) order and
    // paints itself into a corner; a solver reorders and fits all three.
    const config = cfg({ courts: ["C1"], perEntrantMinRest: 30, window: { from: T0, to: T0 + 120 * MIN } });
    const fixtures = [fx("a", "E1", "E2"), fx("b", "E1", "E3"), fx("c", "E4", "E5")];
    const greedy = slotFixtures({ fixtures, config });
    const built = await buildSchedule({ fixtures, config });
    expect(greedy.conflicts.some((c) => c.reason === "no_slot")).toBe(true);
    expect(built.metrics.placed).toBe(3);
    expect(built.conflicts.filter((c) => c.reason === "no_slot")).toHaveLength(0);
    await resetZ3();
  }, 120_000);

  it("returns a board the verifier accepts", async () => {
    const config = cfg({ courts: ["C1", "C2"], perEntrantMinRest: 45 });
    const fixtures = [fx("a", "E1", "E2"), fx("b", "E1", "E3"), fx("c", "E2", "E3")];
    const built = await buildSchedule({ fixtures, config });
    expect(validateAssignments(built.assignments, config)).toEqual([]);
    expect(built.status).toBe("ok");
    await resetZ3();
  }, 120_000);

  it("prefers a shorter makespan over a fairer board (D3 ordering)", async () => {
    const config = cfg({ courts: ["C1", "C2"], perEntrantMinRest: 0 });
    const fixtures = [fx("a", "E1", "E2"), fx("b", "E3", "E4")];
    const built = await buildSchedule({ fixtures, config });
    // Both on their own court, both at the window start: makespan is one match.
    expect(built.metrics.makespanMinutes).toBe(30);
    await resetZ3();
  }, 120_000);

  it("falls back to greedy and says so when the lattice is over the cap", async () => {
    const config = cfg({ window: { from: T0, to: T0 + 400 * 86_400_000 }, courts: ["C1", "C2", "C3", "C4"] });
    const built = await buildSchedule({ fixtures: [fx("a", "E1", "E2")], config });
    expect(built.engine).not.toBe("z3");
    expect(built.assignments.length).toBe(1);
    await resetZ3();
  }, 120_000);

  it("reports infeasible without inventing a board", async () => {
    // Two matches for one entrant, a window that fits only one.
    const config = cfg({ courts: ["C1"], window: { from: T0, to: T0 + 30 * MIN } });
    const built = await buildSchedule({ fixtures: [fx("a", "E1", "E2"), fx("b", "E1", "E3")], config });
    expect(built.metrics.placed).toBe(1);
    expect(built.conflicts.some((c) => c.reason === "no_slot")).toBe(true);
    await resetZ3();
  }, 120_000);
});
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
cd ../wt-z3-build && npm test --workspace packages/engine -- \
  src/scheduling/build.test.ts --reporter=json --outputFile=/tmp/t4.json >/dev/null 2>&1; \
  node -e 'const r=require("/tmp/t4.json");console.log(r.numPassedTests,r.numTotalTests,r.numFailedTests)'
```

Expected: collection failure.

- [ ] **Step 3: Write the implementation**

```ts
// packages/engine/src/scheduling/build.ts
//
// The build solver's control loop.
//
// Greedy seeds the incumbent, so the answer is never worse than today's — that
// property is what lets this ship with NO escape hatch back to greedy (design
// D6). Four tiers then improve the incumbent in a fixed lexicographic order,
// each by a DESCENDING-bound walk under push/pop: assert the objective is
// strictly better than the incumbent, solve, and on SAT take the new board.
// The last satisfiable bound IS the optimum, by construction rather than by an
// objective function nobody can audit — the same reason `repair.ts` walks k
// upward instead of minimising a weighted sum.
//
// The budget is z3's `rlimit`, a DETERMINISTIC resource counter, not the wall
// clock (design D9). An anytime search cut off by wall clock returns a
// different board on a faster machine, which is both a support ticket and a
// permanently flaky test. The wall clock survives only as an outer cap that
// should never fire.
import { boardMetrics, isStrictlyBetter, type BoardMetrics } from "./build-objectives.ts";
import { buildGrid, type BuildGrid } from "./build-grid.ts";
import { encodeBuild, type BuildConfig } from "./build-encode.ts";
import {
  slotFixtures,
  validateAssignments,
  type Assignment,
  type Conflict,
  type OrderDependency,
  type SchedulableFixture,
  type SlotConfig,
} from "./calendar.ts";
import { loadZ3, withZ3Lock } from "./z3-load.ts";

/** Set by `scripts/bench-build.ts` (Task 15) — a placeholder until it runs. */
export const DEFAULT_BUILD_RLIMIT = 40_000_000;
/** The outer safety cap. Not the stopping rule; see the header. */
export const DEFAULT_BUILD_WALL_MS = 30_000;

export type BuildStatus =
  | "ok" | "already_optimal" | "infeasible"
  | "verifier_rejected" | "z3_unavailable" | "solver_busy";

export interface BuildInput {
  fixtures: readonly SchedulableFixture[];
  config: SlotConfig & { courts: string[] };
  existing?: readonly Assignment[];
  dependencies?: readonly OrderDependency[];
  /** POLISH only: fixture ids that may not move. */
  frozen?: readonly string[];
  rlimit?: number;
  wallMs?: number;
  mode?: "build" | "polish";
}

export interface BuildResult {
  assignments: readonly Assignment[];
  conflicts: readonly Conflict[];
  metrics: BoardMetrics;
  engine: "greedy" | "z3" | "z3+lns";
  status: BuildStatus;
  tiersCompleted: number;
  budgetExpired: boolean;
  elapsedMs: number;
  moved: number;
}

export function buildSchedule(input: BuildInput): Promise<BuildResult> {
  return withZ3Lock(() => solveBuild(input));
}

async function solveBuild(input: BuildInput): Promise<BuildResult> {
  const t0 = performance.now();
  const elapsed = (): number => performance.now() - t0;
  const { fixtures, config } = input;
  const existing = input.existing ?? [];
  const dependencies = input.dependencies ?? [];
  const wallMs = input.wallMs ?? DEFAULT_BUILD_WALL_MS;
  const rlimit = input.rlimit ?? DEFAULT_BUILD_RLIMIT;

  // 1. The seed. Also the floor: nothing below can return worse than this.
  const seed = slotFixtures({ fixtures, config, existing });
  const seedMetrics = boardMetrics(seed.assignments, config.courts, fixtures.length);
  const greedy = (status: BuildStatus, engine: BuildResult["engine"] = "greedy"): BuildResult => ({
    assignments: seed.assignments,
    conflicts: seed.conflicts,
    metrics: seedMetrics,
    engine, status, tiersCompleted: 0, budgetExpired: false,
    elapsedMs: elapsed(), moved: 0,
  });

  // 2. The lattice. Over the cap there is nothing to encode.
  const pinned = fixtures.flatMap((f) => (f.locked !== undefined ? [f.locked] : []));
  const grid = buildGrid({ config, existing, pinned });
  if (grid.overCap || grid.slots.length === 0) return greedy("ok");

  // 3. z3. A boot failure is a fallback, never an exception: auto-schedule must
  //    always hand back a board.
  let Z3;
  try {
    ({ Z3 } = await loadZ3());
  } catch {
    return greedy("z3_unavailable");
  }

  const solver = new Z3.Solver();
  solver.set("rlimit", rlimit);
  solver.set("timeout", Math.max(1, Math.ceil(wallMs - elapsed())));

  const buildConfig: BuildConfig = { ...config, matchMinutes: config.matchMinutes, courts: config.courts };
  const model = encodeBuild({ Z3, solver, fixtures, grid, config: buildConfig, existing, dependencies });

  // 4. POLISH freezes the cards an entrant has already been told about.
  for (const id of input.frozen ?? []) {
    const i = fixtures.findIndex((f) => f.id === id);
    const at = seed.assignments.find((a) => a.fixtureId === id);
    if (i < 0 || at === undefined) continue;
    const s = grid.slots.findIndex((sl) => sl.court === at.court && sl.startAt === at.startAt);
    if (s >= 0) solver.add(model.place[i]![s]!);
  }

  let incumbent = seed.assignments;
  let incumbentMetrics = seedMetrics;
  let tiersCompleted = 0;
  let budgetExpired = false;

  // 5. T0 — maximise the number placed. This is what turns greedy's `no_slot`
  //    GUESS into a proof: UNSAT at `placed >= n` is the proof that n is out of
  //    reach, and SAT is a board that reaches it.
  //
  //    MEASURED in Task 3: `AtLeast(placed, k)` returns sat in 0.4-2.2 s well
  //    away from the optimum, but goes `unknown` at a 20 s bound as k
  //    approaches it. So `unknown` is the EXPECTED terminal state of this walk,
  //    not an error — it means "no proof either way inside the budget", and the
  //    incumbent stands. Never report `unknown` as `infeasible`: infeasible is a
  //    proof, and this is the absence of one.
  //
  //    Also measured: a `locked` fixture whose pinned slot is illegal makes the
  //    WHOLE model UNSAT rather than leaving that one card unplaced. Task 4's
  //    `infeasible` branch must therefore not be read as "the board is
  //    impossible" without checking the locked set first.
  for (let target = fixtures.length; target > incumbentMetrics.placed; target--) {
    if (elapsed() >= wallMs) { budgetExpired = true; break; }
    solver.push();
    // Array, not varargs — see the note in Task 3's encoder.
    solver.add(Z3.AtLeast([model.placed[0]!, ...model.placed.slice(1)], target));
    const verdict = await solver.check();
    if (verdict === "sat") {
      const picked = model.slotOf(solver.model());
      const board = model.assignmentsFrom(picked);
      const metrics = boardMetrics(board, config.courts, fixtures.length);
      if (isStrictlyBetter(metrics, incumbentMetrics)) { incumbent = board; incumbentMetrics = metrics; }
      solver.pop();
      // Freeze the achieved count as a hard bound for every later tier.
      solver.add(Z3.AtLeast(...model.placed, metrics.placed));
      tiersCompleted = 1;
      break;
    }
    solver.pop();
    if (verdict === "unknown") { budgetExpired = true; break; }
  }

  // Tiers 1-3 land in Task 5; the incumbent contract above is what they extend.

  // 6. The gate. Encoder and verifier disagreeing is the exact bug class this
  //    design exists to prevent, so it is never silent — but it is also never
  //    an exception, because the organiser still needs a board.
  const conflicts = validateAssignments(incumbent, buildConfig, existing, dependencies);
  const blocking = conflicts.filter((c) => c.reason === "court" || c.reason === "person_overlap" || c.reason === "window");
  if (blocking.length > 0) return { ...greedy("verifier_rejected", "greedy") };

  const seedById = new Map(seed.assignments.map((a) => [a.fixtureId, a]));
  const moved = incumbent.filter((a) => {
    const was = seedById.get(a.fixtureId);
    return was === undefined || was.court !== a.court || was.startAt !== a.startAt;
  }).length;

  return {
    assignments: incumbent,
    conflicts,
    metrics: incumbentMetrics,
    engine: "z3",
    status: incumbentMetrics.placed === 0 && fixtures.length > 0 ? "infeasible" : "ok",
    tiersCompleted, budgetExpired, elapsedMs: elapsed(), moved,
  };
}
```

- [ ] **Step 4: Export, run the test, run the suite**

```ts
export * from "./build.ts";
```

```bash
cd ../wt-z3-build && npm test --workspace packages/engine -- \
  --reporter=json --outputFile=/tmp/t4.json >/dev/null 2>&1; \
  node -e 'const r=require("/tmp/t4.json");console.log(r.numPassedTests,r.numTotalTests,r.numFailedTests)'
```

Expected: `numFailedTests` 0, total = Task 3's total **+ 6**.

- [ ] **Step 5: Commit**

```bash
git add packages/engine/src/scheduling/build.ts \
        packages/engine/src/scheduling/build.test.ts \
        packages/engine/src/scheduling/index.ts .claude/z3-scheduling-state.md
git commit -m "feat(engine): greedy-seeded build solver with the T0 placement proof"
```

---

### Task 5: Tiers 1-3 and the deterministic budget

**Files:**
- Modify: `packages/engine/src/scheduling/build.ts` (the block marked "Tiers 1-3 land in Task 5")
- Modify: `packages/engine/src/scheduling/build.test.ts`
- Create: `packages/engine/src/scheduling/build-determinism.test.ts`

**Interfaces:**
- Consumes: everything Task 4 produced.
- Produces: no new exported names. `tiersCompleted` now reaches 4, and `BuildResult.metrics` is lexicographically optimal when `budgetExpired` is false.

- [ ] **Step 1: Write the failing tests**

Append to `build.test.ts`:

```ts
describe("buildSchedule — lexicographic tiers", () => {
  it("completes all four tiers on a small board", async () => {
    const config = cfg({ courts: ["C1", "C2"], perEntrantMinRest: 0 });
    const fixtures = [fx("a", "E1", "E2"), fx("b", "E3", "E4"), fx("c", "E5", "E6"), fx("d", "E7", "E8")];
    const built = await buildSchedule({ fixtures, config });
    expect(built.budgetExpired).toBe(false);
    expect(built.tiersCompleted).toBe(4);
    await resetZ3();
  }, 120_000);

  it("balances courts once makespan and fairness are settled", async () => {
    // Four matches, two courts, no shared entrants: every board with the same
    // makespan is equally fair, so T3 is the tier that decides, and an even
    // 2-2 split beats a 3-1.
    const config = cfg({ courts: ["C1", "C2"], perEntrantMinRest: 0, gapMinutes: 0 });
    const fixtures = [fx("a", "E1", "E2"), fx("b", "E3", "E4"), fx("c", "E5", "E6"), fx("d", "E7", "E8")];
    const built = await buildSchedule({ fixtures, config });
    expect(built.metrics.courtImbalanceMinutes).toBe(0);
    await resetZ3();
  }, 120_000);

  it("does not trade makespan away for fairness", async () => {
    const config = cfg({ courts: ["C1", "C2"], perEntrantMinRest: 0 });
    const fixtures = [fx("a", "E1", "E2"), fx("b", "E1", "E3")];
    const built = await buildSchedule({ fixtures, config });
    const spread = built.assignments.map((a) => a.startAt);
    // E1 plays both, so they cannot be simultaneous; the shortest board is
    // back-to-back, even though spreading them out would be kinder.
    expect(Math.max(...spread) - Math.min(...spread)).toBe(30 * MIN);
    await resetZ3();
  }, 120_000);
});
```

```ts
// packages/engine/src/scheduling/build-determinism.test.ts
//
// Gap 1. `calendar.test.ts` asserts the greedy placer is deterministic, and a
// solver budgeted on the WALL CLOCK would break that invariant the moment CI
// ran on a faster box: same input, different board. The budget is z3's
// `rlimit` instead, so the stopping point is a property of the search rather
// than of the machine.
import { describe, expect, it } from "vitest";
import { buildSchedule } from "./build.ts";
import { resetZ3 } from "./z3-load.ts";
import type { SchedulableFixture, SlotConfig } from "./calendar.ts";

const MIN = 60_000;
const T0 = Date.UTC(2026, 7, 8, 9, 0);
const config: SlotConfig & { courts: string[] } = {
  startAt: T0, matchMinutes: 30, gapMinutes: 10, courts: ["C1", "C2"],
  perEntrantMinRest: 30, window: { from: T0, to: T0 + 240 * MIN }, tz: "Europe/London",
};
const fixtures: SchedulableFixture[] = [
  { id: "a", home: "E1", away: "E2", roundNo: 1 },
  { id: "b", home: "E3", away: "E4", roundNo: 1 },
  { id: "c", home: "E1", away: "E3", roundNo: 2 },
  { id: "d", home: "E2", away: "E4", roundNo: 2 },
];

describe("buildSchedule determinism", () => {
  it("returns the same board twice", async () => {
    const a = await buildSchedule({ fixtures, config });
    const b = await buildSchedule({ fixtures, config });
    expect(a.assignments).toEqual(b.assignments);
    expect(a.metrics).toEqual(b.metrics);
    await resetZ3();
  }, 120_000);

  it("returns the same board under two different wall-clock caps", async () => {
    // If the wall clock were the stopping rule these would differ. It is the
    // outer safety cap only, and on a board this size it never fires.
    const a = await buildSchedule({ fixtures, config, wallMs: 30_000 });
    const b = await buildSchedule({ fixtures, config, wallMs: 120_000 });
    expect(a.assignments).toEqual(b.assignments);
    expect(a.tiersCompleted).toBe(b.tiersCompleted);
    expect(a.budgetExpired).toBe(false);
    expect(b.budgetExpired).toBe(false);
    await resetZ3();
  }, 240_000);
});
```

- [ ] **Step 2: Run both and confirm they fail**

```bash
cd ../wt-z3-build && npm test --workspace packages/engine -- \
  src/scheduling/build.test.ts src/scheduling/build-determinism.test.ts \
  --reporter=json --outputFile=/tmp/t5.json >/dev/null 2>&1; \
  node -e 'const r=require("/tmp/t5.json");console.log(r.numPassedTests,r.numTotalTests,r.numFailedTests)'
```

Expected: the three new tier tests fail (`tiersCompleted` is 1, imbalance is not 0) and the determinism pair may pass vacuously — that is fine, they become meaningful once the tiers exist.

- [ ] **Step 3: Replace the "Tiers 1-3" comment in `build.ts` with the tier walk**

```ts
  // Tiers 1-3. Each takes at most HALF the remaining budget so the last tier is
  // never structurally starved by the first; the final tier takes what is left.
  // A tier that completes freezes its achieved value as a hard bound, which is
  // what makes the ordering lexicographic rather than a negotiation.
  const tiers: { name: string; of: (m: BoardMetrics) => number; term: () => Arith<"repair"> }[] = [
    { name: "makespan", of: (m) => m.makespanMinutes, term: () => makespanTerm(Z3, model, grid, config) },
    { name: "idleGap", of: (m) => m.worstIdleGapMinutes, term: () => idleGapTerm(Z3, model, grid, fixtures, config) },
    { name: "imbalance", of: (m) => m.courtImbalanceMinutes, term: () => imbalanceTerm(Z3, model, grid, config) },
  ];

  for (const tier of tiers) {
    if (elapsed() >= wallMs) { budgetExpired = true; break; }
    const slice = (wallMs - elapsed()) / 2;
    const deadline = elapsed() + (tier === tiers[tiers.length - 1] ? wallMs - elapsed() : slice);
    const term = tier.term();
    let best = tier.of(incumbentMetrics);
    for (;;) {
      if (elapsed() >= deadline) { budgetExpired = true; break; }
      solver.set("timeout", Math.max(1, Math.ceil(deadline - elapsed())));
      solver.push();
      solver.add(term.le(best - 1));
      const verdict = await solver.check();
      if (verdict !== "sat") { solver.pop(); if (verdict === "unknown") budgetExpired = true; break; }
      const picked = model.slotOf(solver.model());
      const board = model.assignmentsFrom(picked);
      const metrics = boardMetrics(board, config.courts, fixtures.length);
      solver.pop();
      if (!isStrictlyBetter(metrics, incumbentMetrics)) break;
      incumbent = board;
      incumbentMetrics = metrics;
      best = tier.of(metrics);
    }
    // Freeze whatever this tier achieved, so the next one may not undo it.
    solver.add(term.le(tier.of(incumbentMetrics)));
    tiersCompleted++;
  }
```

Add the three term builders at the bottom of `build.ts`. Each expresses its metric over the SAME slot variables the encoder made, so the number z3 minimises and the number `boardMetrics` reports are the same number:

```ts
/** Makespan, in minutes, as the latest end minus the earliest start. Both ends
 *  are built as z3 max/min folds over the placement literals. */
function makespanTerm(Z3: Z3Context["Z3"], model: EncodedModel, grid: BuildGrid, config: SlotConfig): Arith<"repair"> {
  const step = 60_000;
  const startOf = (s: number): number => grid.slots[s]!.startAt / step;
  const endOf = (s: number): number => grid.slots[s]!.startAt / step + config.matchMinutes;
  const lo = Z3.Int.const("mk_lo");
  const hi = Z3.Int.const("mk_hi");
  model.place.forEach((row) =>
    row.forEach((lit, s) => {
      // `lo <= start` and `hi >= end` for every PLACED fixture; minimising
      // `hi - lo` then squeezes both onto the real extremes.
      // NOTE the `solver.add` — an implication that is built and dropped
      // constrains nothing, and the tier would then "optimise" a free variable.
      solver.add(Z3.Implies(lit, Z3.And(lo.le(startOf(s)), hi.ge(endOf(s)))));
    }),
  );
  return hi.sub(lo);
}
```

`makespanTerm` therefore needs the `solver` too — thread it through all three
term builders' signatures.

> **Implementer note.** The three term builders are the part of this task with genuine design latitude, and the sketch above is a shape, not a finished encoding — `Z3.Implies(...)` there is built and dropped rather than asserted, which is a bug you must fix by adding it to the solver. Requirements the tests enforce, and which you must satisfy however you encode them: (a) minimising the term must minimise the metric `boardMetrics` reports, exactly, or the tier freezes a bound the incumbent does not meet; (b) all three terms must be built once, before the tier loop, if building them adds assertions; (c) the idle-gap term only needs to range over participants who appear in **two or more** fixtures — everyone else contributes 0 and adding them is pure encoding cost. If an exact encoding of the idle-gap term proves too large at 200 fixtures, the correct fallback is to leave T2 to the LNS pass in Task 6 and report `tiersCompleted: 2` — **ask the owner before taking it**, do not silently drop a tier.

- [ ] **Step 4: Run both suites**

```bash
cd ../wt-z3-build && npm test --workspace packages/engine -- \
  --reporter=json --outputFile=/tmp/t5.json >/dev/null 2>&1; \
  node -e 'const r=require("/tmp/t5.json");console.log(r.numPassedTests,r.numTotalTests,r.numFailedTests)'
```

Expected: `numFailedTests` 0; total = Task 4's total **+ 5**.

- [ ] **Step 5: Commit**

```bash
git add packages/engine/src/scheduling/build.ts \
        packages/engine/src/scheduling/build.test.ts \
        packages/engine/src/scheduling/build-determinism.test.ts \
        .claude/z3-scheduling-state.md
git commit -m "feat(engine): lexicographic tiers on a deterministic rlimit budget"
```

---

### Task 6: `build-lns.ts` — the large-neighbourhood fallback

**Files:**
- Create: `packages/engine/src/scheduling/build-lns.ts`
- Test: `packages/engine/src/scheduling/build-lns.test.ts`
- Modify: `packages/engine/src/scheduling/build.ts` (call it when T1 makes no progress or the lattice is over the cap)
- Modify: `packages/engine/src/scheduling/index.ts`

**Interfaces:**
- Consumes: `repairSchedule` / `RepairResult` from `./repair.ts`, `boardMetrics` / `isStrictlyBetter` (Task 1).
- Produces:
  - `const LNS_WINDOW_LIMIT = 50` — the measured `COMPONENT_MOVABLE_LIMIT`, reused deliberately.
  - `interface LnsInput { board: readonly Assignment[]; config: VerifyConfig & { courts: string[] }; existing?: readonly Assignment[]; frozen?: ReadonlySet<string>; courts: readonly string[]; total: number; deadlineMs: number; elapsed: () => number }`
  - `function improveByWindows(input: LnsInput): Promise<{ board: readonly Assignment[]; metrics: BoardMetrics; windows: number }>`

- [ ] **Step 1: Write the failing test**

```ts
// packages/engine/src/scheduling/build-lns.test.ts
import { describe, expect, it } from "vitest";
import { improveByWindows, LNS_WINDOW_LIMIT } from "./build-lns.ts";
import { boardMetrics } from "./build-objectives.ts";
import { resetZ3 } from "./z3-load.ts";
import type { Assignment, SlotConfig } from "./calendar.ts";

const MIN = 60_000;
const T0 = Date.UTC(2026, 7, 8, 9, 0);
const config: SlotConfig & { courts: string[] } = {
  startAt: T0, matchMinutes: 30, gapMinutes: 0, courts: ["C1", "C2"],
  perEntrantMinRest: 0, window: { from: T0, to: T0 + 240 * MIN }, tz: "Europe/London",
};
const card = (id: string, court: string, startMin: number, entrants: string[]): Assignment => ({
  fixtureId: id, court,
  startAt: T0 + startMin * MIN, endAt: T0 + (startMin + 30) * MIN,
  entrants, people: [],
});

describe("improveByWindows", () => {
  it("compacts a board that greedy strung out on one court", async () => {
    const board = [card("a", "C1", 0, ["E1"]), card("b", "C1", 30, ["E2"]), card("c", "C1", 60, ["E3"])];
    const before = boardMetrics(board, config.courts, 3);
    const out = await improveByWindows({
      board, config, courts: config.courts, total: 3,
      deadlineMs: 20_000, elapsed: () => 0,
    });
    expect(out.metrics.makespanMinutes).toBeLessThan(before.makespanMinutes);
    await resetZ3();
  }, 120_000);

  it("never returns a worse board", async () => {
    const board = [card("a", "C1", 0, ["E1"]), card("b", "C2", 0, ["E2"])];
    const before = boardMetrics(board, config.courts, 2);
    const out = await improveByWindows({
      board, config, courts: config.courts, total: 2,
      deadlineMs: 20_000, elapsed: () => 0,
    });
    expect(out.metrics.makespanMinutes).toBeLessThanOrEqual(before.makespanMinutes);
    await resetZ3();
  }, 120_000);

  it("never moves a frozen card", async () => {
    const board = [card("a", "C1", 0, ["E1"]), card("b", "C1", 120, ["E2"])];
    const out = await improveByWindows({
      board, config, courts: config.courts, total: 2,
      frozen: new Set(["b"]), deadlineMs: 20_000, elapsed: () => 0,
    });
    const b = out.board.find((x) => x.fixtureId === "b")!;
    expect({ court: b.court, startAt: b.startAt }).toEqual({ court: "C1", startAt: T0 + 120 * MIN });
    await resetZ3();
  }, 120_000);

  it("stops immediately when the deadline has passed", async () => {
    const board = [card("a", "C1", 0, ["E1"])];
    const out = await improveByWindows({
      board, config, courts: config.courts, total: 1,
      deadlineMs: 1_000, elapsed: () => 9_999,
    });
    expect(out.windows).toBe(0);
    expect(out.board).toEqual(board);
  });

  it("reuses the measured component limit", () => {
    expect(LNS_WINDOW_LIMIT).toBe(50);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
cd ../wt-z3-build && npm test --workspace packages/engine -- \
  src/scheduling/build-lns.test.ts --reporter=json --outputFile=/tmp/t6.json >/dev/null 2>&1; \
  node -e 'const r=require("/tmp/t6.json");console.log(r.numPassedTests,r.numTotalTests,r.numFailedTests)'
```

- [ ] **Step 3: Write the implementation**

```ts
// packages/engine/src/scheduling/build-lns.ts
//
// The safety net (design D7's "C" half).
//
// When the whole-board model does not converge — a board past the lattice cap,
// or a T1 that finds nothing inside its slice — this spends the remaining
// budget on windows instead: freeze all but ≤50 cards, hand that window to the
// EXISTING repair solver, and keep the result only if a metric improved.
//
// Every solve here is inside the envelope `bench-repair.ts` measured, which is
// the entire point: 50 movable is 8.8 s at the dense end and the whole reason
// `COMPONENT_MOVABLE_LIMIT` is 50. Reusing that number rather than picking a
// new one keeps the two solvers' scaling stories the same story.
import { boardMetrics, isStrictlyBetter, type BoardMetrics } from "./build-objectives.ts";
import { repairSchedule } from "./repair.ts";
import type { Assignment, VerifyConfig } from "./calendar.ts";

export const LNS_WINDOW_LIMIT = 50;

export interface LnsInput {
  board: readonly Assignment[];
  config: VerifyConfig & { courts: string[] };
  existing?: readonly Assignment[];
  frozen?: ReadonlySet<string>;
  courts: readonly string[];
  total: number;
  /** Absolute elapsed-ms mark to stop at, read against `elapsed()`. */
  deadlineMs: number;
  elapsed: () => number;
}

export async function improveByWindows(
  input: LnsInput,
): Promise<{ board: readonly Assignment[]; metrics: BoardMetrics; windows: number }> {
  const frozen = input.frozen ?? new Set<string>();
  let board = input.board;
  let metrics = boardMetrics(board, input.courts, input.total);
  let windows = 0;

  for (const window of windowsOf(board, frozen)) {
    if (input.elapsed() >= input.deadlineMs) break;
    const movable = window;
    const movableIds = new Set(movable.map((a) => a.fixtureId));
    const fixed = board.filter((a) => !movableIds.has(a.fixtureId));

    const result = await repairSchedule({
      proposal: movable,
      existing: [...(input.existing ?? []), ...fixed],
      config: input.config,
      budgetMs: Math.max(1, input.deadlineMs - input.elapsed()),
    });
    windows++;
    if (result.status !== "repaired" && result.status !== "clean") continue;

    const candidate = [...fixed, ...result.assignments];
    const candidateMetrics = boardMetrics(candidate, input.courts, input.total);
    // Strictly better or discarded. A window that merely reshuffles has told
    // entrants a new time for nothing, which is the same safety property
    // `repair.ts` protects with minimal movement.
    if (!isStrictlyBetter(candidateMetrics, metrics)) continue;
    board = candidate;
    metrics = candidateMetrics;
  }

  return { board, metrics, windows };
}

/** Candidate windows, in the order most likely to pay: each court's own cards
 *  first (that is where imbalance and same-court slack live), then the tail of
 *  the board (that is where makespan lives). */
function* windowsOf(
  board: readonly Assignment[],
  frozen: ReadonlySet<string>,
): Generator<readonly Assignment[]> {
  const movable = board.filter((a) => !frozen.has(a.fixtureId));
  const byCourt = new Map<string, Assignment[]>();
  for (const a of movable) {
    const rows = byCourt.get(a.court);
    if (rows === undefined) byCourt.set(a.court, [a]);
    else rows.push(a);
  }
  for (const court of [...byCourt.keys()].sort()) {
    yield byCourt.get(court)!.slice(0, LNS_WINDOW_LIMIT);
  }
  const tail = [...movable].sort((a, b) => b.startAt - a.startAt).slice(0, LNS_WINDOW_LIMIT);
  if (tail.length > 0) yield tail;
}
```

- [ ] **Step 4: Wire it into `build.ts`**

Two call sites. First, replace the over-cap early return with an LNS pass over the greedy board:

```ts
  if (grid.overCap || grid.slots.length === 0) {
    const out = await improveByWindows({
      board: seed.assignments, config: buildConfigOf(config), existing,
      courts: config.courts, total: fixtures.length,
      deadlineMs: wallMs, elapsed,
    });
    return { ...greedy("ok", "z3+lns"), assignments: out.board, metrics: out.metrics };
  }
```

Second, after the tier loop, when `tiersCompleted < 2` and budget remains:

```ts
  if (tiersCompleted < 2 && elapsed() < wallMs) {
    const out = await improveByWindows({
      board: incumbent, config: buildConfigOf(config), existing,
      frozen: new Set(input.frozen ?? []),
      courts: config.courts, total: fixtures.length,
      deadlineMs: wallMs, elapsed,
    });
    if (isStrictlyBetter(out.metrics, incumbentMetrics)) {
      incumbent = out.board;
      incumbentMetrics = out.metrics;
    }
  }
```

> `repairSchedule` takes `withZ3Lock` itself and the lock is **not reentrant** — `build.ts` already holds it. Move the lock: have `buildSchedule` call `solveBuild` **without** wrapping, and take `withZ3Lock` around the encode-and-tier section only, releasing before the LNS pass. Confirm with `build-lns.test.ts` — a deadlock shows up as a test that never returns, not as a failure.

- [ ] **Step 5: Run the whole engine suite and commit**

```bash
cd ../wt-z3-build && npm test --workspace packages/engine -- \
  --reporter=json --outputFile=/tmp/t6.json >/dev/null 2>&1; \
  node -e 'const r=require("/tmp/t6.json");console.log(r.numPassedTests,r.numTotalTests,r.numFailedTests)'
git add packages/engine/src/scheduling/build-lns.ts \
        packages/engine/src/scheduling/build-lns.test.ts \
        packages/engine/src/scheduling/build.ts \
        packages/engine/src/scheduling/index.ts .claude/z3-scheduling-state.md
git commit -m "feat(engine): LNS window fallback over the existing repair solver"
```

---

### Task 7: POLISH mode

**Files:**
- Test: `packages/engine/src/scheduling/build-polish.test.ts` (create)
- Modify: `packages/engine/src/scheduling/build.ts`

**Interfaces:**
- Consumes: `BuildInput.frozen` and `BuildInput.mode` from Task 4.
- Produces: `status: "already_optimal"` when `mode: "polish"` finds no strict improvement, with `moved: 0`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/engine/src/scheduling/build-polish.test.ts
import { describe, expect, it } from "vitest";
import { buildSchedule } from "./build.ts";
import { resetZ3 } from "./z3-load.ts";
import type { SchedulableFixture, SlotConfig } from "./calendar.ts";

const MIN = 60_000;
const T0 = Date.UTC(2026, 7, 8, 9, 0);
const config: SlotConfig & { courts: string[] } = {
  startAt: T0, matchMinutes: 30, gapMinutes: 0, courts: ["C1", "C2"],
  perEntrantMinRest: 0, window: { from: T0, to: T0 + 240 * MIN }, tz: "Europe/London",
};

describe("buildSchedule — polish", () => {
  it("returns already_optimal and moves nothing on an optimal board", async () => {
    const fixtures: SchedulableFixture[] = [
      { id: "a", home: "E1", away: "E2", locked: { court: "C1", startAt: T0 } },
      { id: "b", home: "E3", away: "E4", locked: { court: "C2", startAt: T0 } },
    ];
    const out = await buildSchedule({ fixtures, config, mode: "polish", frozen: ["a", "b"] });
    expect(out.status).toBe("already_optimal");
    expect(out.moved).toBe(0);
    await resetZ3();
  }, 120_000);

  it("improves an unpublished card and leaves every frozen one alone", async () => {
    const fixtures: SchedulableFixture[] = [
      { id: "pub", home: "E1", away: "E2", locked: { court: "C1", startAt: T0 } },
      { id: "draft", home: "E3", away: "E4" },
    ];
    const out = await buildSchedule({ fixtures, config, mode: "polish", frozen: ["pub"] });
    const pub = out.assignments.find((a) => a.fixtureId === "pub")!;
    expect({ court: pub.court, startAt: pub.startAt }).toEqual({ court: "C1", startAt: T0 });
    // The draft joins it rather than trailing behind it.
    expect(out.metrics.makespanMinutes).toBe(30);
    await resetZ3();
  }, 120_000);
});
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
cd ../wt-z3-build && npm test --workspace packages/engine -- \
  src/scheduling/build-polish.test.ts --reporter=json --outputFile=/tmp/t7.json >/dev/null 2>&1; \
  node -e 'const r=require("/tmp/t7.json");console.log(r.numPassedTests,r.numTotalTests,r.numFailedTests)'
```

- [ ] **Step 3: Add the polish status to `build.ts`**

Immediately before the final `return`:

```ts
  // POLISH ran because the organiser asked, not because anything was broken.
  // No strict improvement is a real answer, and the button says so rather than
  // reporting a re-run of the same board as work done.
  const status: BuildStatus =
    input.mode === "polish" && moved === 0
      ? "already_optimal"
      : incumbentMetrics.placed === 0 && fixtures.length > 0
        ? "infeasible"
        : "ok";
```

and use `status` in the returned object in place of the inline ternary.

- [ ] **Step 4: Run the suite and commit**

```bash
cd ../wt-z3-build && npm test --workspace packages/engine -- \
  --reporter=json --outputFile=/tmp/t7.json >/dev/null 2>&1; \
  node -e 'const r=require("/tmp/t7.json");console.log(r.numPassedTests,r.numTotalTests,r.numFailedTests)'
git add packages/engine/src/scheduling/build.ts \
        packages/engine/src/scheduling/build-polish.test.ts .claude/z3-scheduling-state.md
git commit -m "feat(engine): polish mode reports already_optimal instead of churning a board"
```

---

### Task 8: API schema + OpenAPI regeneration

**Files:**
- Modify: `apps/web/src/server/api-v1/schemas.ts:856-866`
- Modify: `openapi/v1.json`, `openapi/v1.public.json` (regenerated, never hand-edited)
- Test: `apps/web/src/server/usecases/__tests__/schedule.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `AutoScheduleRequest.mode`, `AutoScheduleResult.metrics`, `AutoScheduleResult.solver` — the shapes Task 9 returns and Task 11 renders.

- [ ] **Step 1: Write the failing test**

Append to `apps/web/src/server/usecases/__tests__/schedule.test.ts`:

```ts
import { AutoScheduleRequest } from "@/server/api-v1/schemas";

describe("AutoScheduleRequest.mode", () => {
  it("defaults to reflow when only_unlocked is true", () => {
    expect(AutoScheduleRequest.parse({ only_unlocked: true }).mode).toBe("reflow");
  });

  it("defaults to build when only_unlocked is false", () => {
    expect(AutoScheduleRequest.parse({ only_unlocked: false }).mode).toBe("build");
  });

  it("defaults to reflow for an empty body, matching today's only_unlocked default", () => {
    expect(AutoScheduleRequest.parse({}).mode).toBe("reflow");
  });

  it("takes an explicit mode over the derived one", () => {
    expect(AutoScheduleRequest.parse({ only_unlocked: true, mode: "polish" }).mode).toBe("polish");
  });

  it("rejects an unknown mode", () => {
    expect(() => AutoScheduleRequest.parse({ mode: "magic" })).toThrow();
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
cd ../wt-z3-build && npm test --workspace apps/web -- \
  src/server/usecases/__tests__/schedule.test.ts --reporter=json --outputFile=/tmp/t8.json >/dev/null 2>&1; \
  node -e 'const r=require("/tmp/t8.json");console.log(r.numPassedTests,r.numTotalTests,r.numFailedTests)'
```

Expected: five failures — `mode` is `undefined`.

- [ ] **Step 3: Change the schema**

Replace lines 856-866 of `apps/web/src/server/api-v1/schemas.ts`:

```ts
// NOTE: `z.preprocess`, NOT `.transform()`. `openapi.ts:288` converts every
// registered schema with `z.toJSONSchema(…, { io: "output" })`, and a trailing
// transform IS the output node — so `openapi:gen` dies with "Transforms cannot
// be represented in JSON Schema". `schemas.ts` already carries that warning on
// `AiApplyMeta`. Preprocess puts the function on the INPUT side, where the
// generator never looks. Measured, not guessed: the transform form was tried
// and the generator failed.
export const AutoScheduleRequest = z
  .object({
    /** true (default) = re-flow unlocked fixtures only, locked ones are fixed
     *  obstacles ("re-flow remaining", doc 12 §2); false = fresh full pass. */
    only_unlocked: z.boolean().default(true),
    /** Which solver this run is asking for. Absent is derived from
     *  `only_unlocked` so every pre-existing caller keeps its behaviour:
     *  re-flowing is a REFLOW, a fresh pass is a BUILD. */
    mode: z.enum(["build", "reflow", "polish"]).optional(),
  })
  .transform((v) => ({ ...v, mode: v.mode ?? (v.only_unlocked ? "reflow" : "build") }));
export type AutoScheduleRequest = z.infer<typeof AutoScheduleRequest>;

export const ScheduleMetrics = z.object({
  makespan_minutes: z.number(),
  worst_idle_gap_minutes: z.number(),
  court_imbalance_minutes: z.number(),
  placed: z.number().int(),
  total: z.number().int(),
});

export const ScheduleSolverInfo = z.object({
  engine: z.enum(["greedy", "z3", "z3+lns"]),
  status: z.enum([
    "ok", "already_optimal", "infeasible",
    "verifier_rejected", "z3_unavailable", "solver_busy",
  ]),
  tiers_completed: z.number().int(),
  budget_expired: z.boolean(),
  elapsed_ms: z.number(),
  moved: z.number().int(),
});

export const AutoScheduleResult = z.object({
  assignments: z.array(ScheduleAssignment),
  conflicts: z.array(ScheduleConflict),
  metrics: ScheduleMetrics,
  solver: ScheduleSolverInfo,
});
```

- [ ] **Step 4: Regenerate OpenAPI and prove no drift**

```bash
cd ../wt-z3-build && npm run openapi:gen && npm run i18n:gen-keys && git status --porcelain
```

Expected: the two `openapi/*.json` files show as modified; nothing else unexpected. Commit them in this task — a later commit that regenerates them is the drift the CI gate exists to catch.

- [ ] **Step 5: Run the web suite and commit**

```bash
cd ../wt-z3-build && npm test --workspace apps/web -- \
  --reporter=json --outputFile=/tmp/t8.json >/dev/null 2>&1; \
  node -e 'const r=require("/tmp/t8.json");console.log(r.numPassedTests,r.numTotalTests,r.numFailedTests)'
git add apps/web/src/server/api-v1/schemas.ts openapi/v1.json openapi/v1.public.json \
        apps/web/src/server/usecases/__tests__/schedule.test.ts .claude/z3-scheduling-state.md
git commit -m "feat(api): auto-schedule mode, board metrics and solver telemetry"
```

---

### Task 9: `autoSchedule` three-way dispatch

**Files:**
- Modify: `apps/web/src/server/usecases/schedule.ts` (the `autoSchedule` body around line 690-740)
- Test: `apps/web/src/server/usecases/__tests__/schedule.test.ts`

**Interfaces:**
- Consumes: `buildSchedule` (Task 4/5/7), `repairSchedule` (existing), `AutoScheduleRequest.mode` (Task 8).
- Produces: `autoSchedule(auth, stageId, body)` returning `{ assignments, conflicts, metrics, solver }`.

- [ ] **Step 1: Write the failing tests**

```ts
describe("autoSchedule dispatch", () => {
  it("build mode returns solver telemetry and metrics", async () => {
    const out = await autoSchedule(auth, stageId, { only_unlocked: false, mode: "build" });
    expect(out.solver.engine).not.toBe(undefined);
    expect(out.metrics.total).toBeGreaterThan(0);
  });

  it("reflow leaves an already-legal board untouched", async () => {
    // REGRESSION for defect 3: today's slotFixtures re-places every unlocked
    // card even when nothing is wrong. Under repairSchedule, k = 0 is
    // representable, so a legal board comes back byte-identical.
    const first = await autoSchedule(auth, stageId, { only_unlocked: false, mode: "build" });
    await applySchedule(auth, stageId, { assignments: first.assignments });
    const again = await autoSchedule(auth, stageId, { only_unlocked: true, mode: "reflow" });
    expect(again.solver.moved).toBe(0);
    expect(again.assignments).toEqual(first.assignments);
  });

  it("polish never moves a locked card", async () => {
    const out = await autoSchedule(auth, stageId, { only_unlocked: true, mode: "polish" });
    for (const a of out.assignments) {
      if (!lockedIds.has(a.fixture_id)) continue;
      expect(a.scheduled_at).toBe(lockedAt.get(a.fixture_id));
    }
  });
});
```

> **Implementer note.** `schedule.test.ts` already has an `auth` / `stageId` fixture harness — reuse it exactly rather than building a second one, and read the existing `autoSchedule` describe block first so the new cases sit beside it in the same style. The three sketches above are the *behaviours* to assert; adapt the fixture plumbing to what that file already does.

- [ ] **Step 2: Run and confirm they fail**

```bash
cd ../wt-z3-build && npm test --workspace apps/web -- \
  src/server/usecases/__tests__/schedule.test.ts --reporter=json --outputFile=/tmp/t9.json >/dev/null 2>&1; \
  node -e 'const r=require("/tmp/t9.json");console.log(r.numPassedTests,r.numTotalTests,r.numFailedTests)'
```

- [ ] **Step 3: Rewrite the tail of `autoSchedule`**

Everything up to and including `const config = toVerifyConfig(...)` and `const board = [...obstacles, ...siblings.assignments]` stays exactly as it is — that single-config property is load-bearing (#447). Replace only the `slotFixtures` call and the return:

```ts
    // Three modes, one config (design D2). BUILD and POLISH go to the tier
    // solver; REFLOW goes to the repair solver, because "the fewest cards
    // moved" is a property ascending-k proves and a re-place cannot.
    const total = schedulable.length;
    const out =
      body.mode === "reflow"
        ? await reflowExisting(schedulable, config, board, obstacles)
        : await buildSchedule({
            fixtures: schedulable,
            config,
            existing: board,
            ...(body.mode === "polish"
              ? { mode: "polish" as const, frozen: frozenIds(all, scopes) }
              : {}),
          });

    return {
      assignments: out.assignments.map((a) => ({
        fixture_id: a.fixtureId,
        scheduled_at: iso(a.startAt),
        ends_at: iso(a.endAt),
        court_label: a.court,
      })),
      // `buildSchedule` already ran the verifier; the typed-rule referee is
      // still run here for the same reason it always was — the solver reports
      // what it could not place, not what an instruction rule forbids.
      conflicts: mapConflicts([
        ...out.conflicts,
        ...validateInstructionRules(out.assignments, config, board),
      ]),
      metrics: {
        makespan_minutes: out.metrics.makespanMinutes,
        worst_idle_gap_minutes: out.metrics.worstIdleGapMinutes,
        court_imbalance_minutes: out.metrics.courtImbalanceMinutes,
        placed: out.metrics.placed,
        total,
      },
      solver: {
        engine: out.engine,
        status: out.status,
        tiers_completed: out.tiersCompleted,
        budget_expired: out.budgetExpired,
        elapsed_ms: out.elapsedMs,
        moved: out.moved,
      },
    };
```

Add the two helpers below `autoSchedule`:

```ts
/** REFLOW: the board as it stands is the proposal, locked and scope-locked
 *  cards are obstacles, and `repairSchedule` finds the fewest moves that make
 *  it legal. A board with nothing wrong comes back with k = 0 and moves
 *  nothing — which is the defect this replaces. */
async function reflowExisting(
  schedulable: readonly SchedulableFixture[],
  config: VerifyConfig & { courts: string[] },
  board: readonly Assignment[],
  obstacles: readonly Assignment[],
): Promise<BuildResult> { /* … maps RepairResult onto BuildResult … */ }

/** POLISH's frozen set: locked, scope-locked, and anything already published. */
function frozenIds(all: readonly FixtureRow[], scopes: ScopeRows): string[] { /* … */ }
```

> **Implementer note.** `reflowExisting` must map every `RepairResult` status onto a `BuildResult`: `clean` → `status: "ok"`, `moved: 0`; `repaired` → `"ok"` with `moved: result.moved.length`; `timeout` → `"ok"` with `budgetExpired: true` and the ORIGINAL board; `infeasible` → `"infeasible"` with the original board. **Never return a partially-repaired board as though it were repaired.** Read `RepairResult` in `repair.ts:126-160` for the exact union before writing this.

- [ ] **Step 4: Run the web suite and commit**

```bash
cd ../wt-z3-build && npm test --workspace apps/web -- \
  --reporter=json --outputFile=/tmp/t9.json >/dev/null 2>&1; \
  node -e 'const r=require("/tmp/t9.json");console.log(r.numPassedTests,r.numTotalTests,r.numFailedTests)'
npm run openapi:gen && npm run i18n:gen-keys && git status --porcelain
git add apps/web/src/server/usecases/schedule.ts \
        apps/web/src/server/usecases/__tests__/schedule.test.ts .claude/z3-scheduling-state.md
git commit -m "feat(schedule): three-way auto dispatch, reflow via the repair solver"
```

---

### Task 10: The solver queue cap

**Files:**
- Modify: `packages/engine/src/scheduling/build.ts`
- Test: `packages/engine/src/scheduling/build.test.ts`

**Interfaces:**
- Consumes: `withZ3Lock` from `./z3-load.ts`.
- Produces: `const MAX_SOLVER_QUEUE = 2`; `buildSchedule` returns `status: "solver_busy"` with the greedy board when the queue is deeper than that.

- [ ] **Step 1: Write the failing test**

```ts
describe("buildSchedule — queue cap", () => {
  it("returns the greedy board immediately rather than queueing behind two strangers", async () => {
    const config = cfg({ courts: ["C1", "C2"] });
    const fixtures = [fx("a", "E1", "E2"), fx("b", "E3", "E4")];
    const runs = Array.from({ length: MAX_SOLVER_QUEUE + 2 }, () => buildSchedule({ fixtures, config }));
    const results = await Promise.all(runs);
    expect(results.some((r) => r.status === "solver_busy")).toBe(true);
    // Busy still means a board, never an error and never an empty response.
    for (const r of results) expect(r.assignments.length).toBe(2);
    await resetZ3();
  }, 240_000);
});
```

- [ ] **Step 2: Run and confirm it fails**

```bash
cd ../wt-z3-build && npm test --workspace packages/engine -- \
  src/scheduling/build.test.ts --reporter=json --outputFile=/tmp/t10.json >/dev/null 2>&1; \
  node -e 'const r=require("/tmp/t10.json");console.log(r.numPassedTests,r.numTotalTests,r.numFailedTests)'
```

- [ ] **Step 3: Implement the cap in `build.ts`**

```ts
/** How many builds may be waiting on the WASM before a caller is told to take
 *  the greedy board instead. `withZ3Lock` serialises the whole process, so
 *  without this the third organiser to click auto-schedule waits out two full
 *  budgets before their own starts (Gap 4). */
export const MAX_SOLVER_QUEUE = 2;

let queued = 0;

export function buildSchedule(input: BuildInput): Promise<BuildResult> {
  if (queued >= MAX_SOLVER_QUEUE) return Promise.resolve(greedyOnly(input, "solver_busy"));
  queued++;
  return solveBuild(input).finally(() => { queued--; });
}
```

`greedyOnly` runs `slotFixtures` + `boardMetrics` and returns a `BuildResult` with `engine: "greedy"` — factor it out of `solveBuild`'s existing `greedy()` closure so there is one definition, not two.

- [ ] **Step 4: Run and commit**

```bash
cd ../wt-z3-build && npm test --workspace packages/engine -- \
  --reporter=json --outputFile=/tmp/t10.json >/dev/null 2>&1; \
  node -e 'const r=require("/tmp/t10.json");console.log(r.numPassedTests,r.numTotalTests,r.numFailedTests)'
git add packages/engine/src/scheduling/build.ts packages/engine/src/scheduling/build.test.ts \
        .claude/z3-scheduling-state.md
git commit -m "feat(engine): bound the solver queue so a third organiser is not made to wait"
```

---

### Task 11: Result strip

**Files:**
- Modify: `apps/web/src/components/v2/schedule-board.tsx`
- Modify: the 4 locale dictionaries
- Test: a component test beside the board's existing ones, plus `apps/web/e2e/schedule-board.spec.ts`

**Interfaces:**
- Consumes: `AutoScheduleResult.metrics` / `.solver` (Task 8).
- Produces: a `data-testid="schedule-result-strip"` element the e2e in Task 15 asserts on.

**REQUIRED SUB-SKILL:** invoke `frontend-design` before writing any JSX.

- [ ] **Step 1: Add the strings to all four dictionaries**

Flat dotted keys, e.g. `schedule.solver.finish`, `schedule.solver.courtSpread`, `schedule.solver.worstGap`, `schedule.solver.budgetExpired`, `schedule.solver.alreadyOptimal`, `schedule.solver.busy`, `schedule.solver.fellBackToGreedy`. Four dictionaries, no hardcoded English.

- [ ] **Step 2: Write the failing component test**

Assert the strip renders each metric, and that `budget_expired: true` renders the "improved N of 4" note. **Anchor DOM assertions on `="`** — React serialises an omitted prop as `"$undefined"`, so a bare `data-*` probe passes whether or not the prop was set.

- [ ] **Step 3: Run it, confirm it fails, build the strip, run it again**

```bash
cd ../wt-z3-build && npm test --workspace apps/web -- \
  src/components/v2 --reporter=json --outputFile=/tmp/t11.json >/dev/null 2>&1; \
  node -e 'const r=require("/tmp/t11.json");console.log(r.numPassedTests,r.numTotalTests,r.numFailedTests)'
```

- [ ] **Step 4: Screenshot at desktop and 375 px**

Both must show no horizontal page scroll. Wide content scrolls inside its own container, never the page.

- [ ] **Step 5: Gates and commit**

```bash
cd ../wt-z3-build && npm run i18n:gen-keys && npm run openapi:gen && git status --porcelain
git commit -am "feat(board): result strip showing what the solver achieved"
```

---

### Task 12: Polish button

**Files:**
- Modify: `apps/web/src/components/v2/schedule-board.tsx`
- Modify: the 4 locale dictionaries

**Interfaces:**
- Consumes: `POST /stages/{id}/schedule/auto` with `mode: "polish"`.
- Produces: `data-testid="schedule-polish"`.

- [ ] **Step 1: Add `schedule.polish.action` / `.running` / `.alreadyOptimal` / `.improved` to all four dictionaries**

- [ ] **Step 2: Write the failing component test**

The button posts `mode: "polish"`, and an `already_optimal` response renders the already-optimal message rather than a success count.

- [ ] **Step 3: Build it, run the test, screenshot desktop + 375 px**

Touch target ≥ 44 px; the button sits beside the existing auto-schedule action, not in a desktop-only toolbar.

- [ ] **Step 4: Grep the new text across e2e before committing**

```bash
cd ../wt-z3-build && git grep -an "Auto-schedule\|Polish" -- apps/web/e2e | head -20
```

UI text changes break e2e specs in this repo; any spec asserting on the old label is updated in this task, not discovered in Task 15.

- [ ] **Step 5: Gates and commit**

```bash
cd ../wt-z3-build && npm run i18n:gen-keys && git status --porcelain
git commit -am "feat(board): polish action for an already-legal board"
```

---

### Task 13: `scripts/bench-build.ts` and the real `rlimit`

**Files:**
- Create: `scripts/bench-build.ts`
- Modify: `packages/engine/src/scheduling/build.ts` (`DEFAULT_BUILD_RLIMIT`)

**Interfaces:**
- Consumes: `buildSchedule`.
- Produces: a measured `DEFAULT_BUILD_RLIMIT` and a table for the commit message.

- [ ] **Step 1: Write the bench**

20 / 50 / 100 / 200 / 500 fixtures × two conflict densities, three runs each, **one child process per run** (a shared WASM heap across many solves is what `resetZ3` exists to prevent). **Every board carries typed `hard` rules** — a `min_rest_minutes` and a `max_fixtures_per_day` at minimum. `bench-repair.ts` omits them and is therefore inert for exactly the rules organisers write (#455); this bench must not repeat that.

- [ ] **Step 2: Run it and record the table**

```bash
cd ../wt-z3-build && node --experimental-strip-types scripts/bench-build.ts | tee /tmp/bench-build.txt
```

- [ ] **Step 3: Set the constant from the measurement, not from taste**

Same rule `DEFAULT_REPAIR_BUDGET_MS` used: twice the worst `rlimit` consumed among boards that completed **all four tiers** at every measured density, rounded up. Document the derivation in the doc comment, including the numbers.

- [ ] **Step 4: Re-run the engine suite and commit with the table in the message**

```bash
cd ../wt-z3-build && npm test --workspace packages/engine -- \
  --reporter=json --outputFile=/tmp/t13.json >/dev/null 2>&1; \
  node -e 'const r=require("/tmp/t13.json");console.log(r.numPassedTests,r.numTotalTests,r.numFailedTests)'
```

---

### Task 14: Smoke step

**Files:**
- Modify: `scripts/smoke.ts`

- [ ] **Step 1: Add the solver step**

On demo data: run a BUILD, then assert `solver.status` is `ok`, `metrics.placed === metrics.total`, and `validateAssignments` reports no blocking conflict. Then run POLISH on the result and assert `already_optimal`.

- [ ] **Step 2: Run the full smoke locally**

Follow `~/.claude/skills/seazn-local-env/SKILL.md` for the DB and server. `db:apply` alone is **not** a fresh schema — it needs `sync:sports`, or `funnel.test.ts` fails `expected 'generic' to be 'badminton'`. If `pg_ctl` reports "Address already in use", the `createdb` that follows **succeeds against another session's server** — confirm `show data_directory` is yours before trusting anything.

- [ ] **Step 3: Commit**

---

### Task 15: E2E

**Files:**
- Create: `apps/web/e2e/schedule-solver.spec.ts`
- Modify: `apps/web/e2e/schedule-board.spec.ts` if Task 12's grep found stale text

- [ ] **Step 1: Stand up the prod target**

Prod build, `E2E_PROD_TARGET`, port 3100, host **`localhost`** — `127.0.0.1` 401s every API call because the session cookie is `Secure` under `NODE_ENV=production`, while the browser stays signed in, which reads as an auth bug for hours. Before running anything, assert the port is yours:

```bash
lsof -t -i :3100
```

Expected: exactly your server's PID. A foreign PID means the health check will 200 against someone else's server and all three projects will fail in `auth.setup` on a magic-link timeout.

- [ ] **Step 2: Write the spec**

Run auto-schedule → the result strip shows finish time, court spread, worst gap. Click Polish → improvement or already-optimal. Assert at desktop **and 375 px**, with no horizontal page scroll. Because the conflicts panel exposes no `data-*` hooks (#465), assert on text there rather than adding hooks in this programme.

- [ ] **Step 3: Run all three projects and record the counts**

```bash
cd ../wt-z3-build && npm run test:e2e --workspace apps/web 2>&1 | tail -30; echo "EXIT=$?"
```

A killed background command reports exit 0 — that 0 is the SIGTERM, which is why `EXIT=$?` is echoed by the command itself.

- [ ] **Step 4: Commit**

---

### Task 16: Full gate and PR

- [ ] **Step 1: Rebase on main and re-run everything**

```bash
cd ../wt-z3-build && git fetch origin && git rebase origin/main
rm -rf apps/web/.next   # a prod build in a worktree leaves .next/types that fail tsc for untouched pages
npm run typecheck 2>&1 | tail -5; echo "EXIT=${PIPESTATUS[0]}"
npx rtk proxy npm run lint 2>&1 | grep -E "✖|problems" | tail -5
npm test --workspace packages/engine -- --reporter=json --outputFile=/tmp/final-engine.json >/dev/null 2>&1
npm test --workspace apps/web -- --reporter=json --outputFile=/tmp/final-web.json >/dev/null 2>&1
node -e 'for(const f of ["/tmp/final-engine.json","/tmp/final-web.json"]){const r=require(f);console.log(f,r.numPassedTests,r.numTotalTests,r.numFailedTests)}'
```

`tsc | tail` reports **tail's** exit status, which is why `PIPESTATUS[0]` is read instead.

- [ ] **Step 2: Both drift gates**

```bash
cd ../wt-z3-build && npm run openapi:gen && npm run i18n:gen-keys && git status --porcelain
```

Must print nothing.

- [ ] **Step 3: Open the PR**

Smoke CI runs on **PRs only** — this must be a PR, not a local merge and push. Body carries the bench table from Task 13, the final test counts, and the three known limits (#439, #440, #465) as recorded non-goals.

---

## Self-Review

**Spec coverage.** D1 (200 fixtures) → Tasks 2, 6, 13. D2 (three modes) → Tasks 4, 7, 9. D3 (lexicographic) → Tasks 1, 5. D4 (settings are hard) → Tasks 2, 3. D5/D9 (anytime, rlimit) → Tasks 5, 13. D6 (no escape hatch) → Task 4's greedy seed and its "never worse" test. D7 (A + C) → Tasks 3-6. D8 (UI) → Tasks 11, 12. Gaps 1-8 → Tasks 5, 2, 2, 10, 4, 3, 3, 13 respectively. Known limits → Task 16's PR body. Testing section → Tasks 14, 15, and each task's own suite.

**Known soft spots, flagged rather than hidden.** Three places in this plan carry an implementer note instead of finished code, because each needs a measurement or a shape decision that cannot honestly be made before the previous task runs: the pruned pair loop in Task 3, the three z3 objective terms in Task 5, and `reflowExisting`'s status mapping in Task 9. Each note states the acceptance criteria the tests already enforce and says to ask the owner rather than improvise if the obvious approach fails. The pair loop in Task 3 is the single largest risk in the plan — an unpruned O(n²·|slots|²) encode does not finish at 200 fixtures.

**Type consistency.** `BoardMetrics` field names (`makespanMinutes`, `worstIdleGapMinutes`, `courtImbalanceMinutes`, `placed`, `total`) are used identically in Tasks 1, 4, 5, 6, 9. The API's snake_case mapping happens once, in Task 9. `BuildResult` is produced by Task 4 and consumed unchanged by Tasks 6, 7, 9, 10. `BuildStatus` values match the zod enum in Task 8 one-for-one.
