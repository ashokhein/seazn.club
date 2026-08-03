# W4 — delta-based blocking, rule codes, feeder rest (#399)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `person_overlap` and `window` conflicts stop a schedule write — but only when
the write *introduces or worsens* them — every `Conflict` carries the rule code the
prompt taught, and a dependent fixture may not start until its feeder's occupancy plus
the effective rest.

**Architecture:** Three additions, all pure logic in `packages/engine`, consumed by the
three impure gates that persist a board. (1) `RULE_BY_REASON` beside the
`ConflictReason` union, attached at one choke point per producer so no call site can
forget it. (2) `conflictKey` + `deltaConflicts` — a multiset difference over
`${fixtureId}|${reason}|${detail}`, so a pre-existing conflict passes through as a
warning and a worsened one (bigger breach → different `detail`; more instances → higher
count) reads as new. (3) the feed-order loop gains `+ effectiveRestMinutes`.

**Tech Stack:** TypeScript, zod, vitest, Next.js (api-v1 usecases), Postgres.

## Global Constraints

- Every change ships a test that fails without it (repo rule).
- Tests are frozen from the two real payloads in `packages/engine/src/scheduling/payload-fixtures.ts`
  (`BADMINTON`, `STEP`), in BOTH directions — a rejection case and an acceptance case.
- Vitest counting: run FULL suites, never path-filtered positionals; verify a suspicious
  summary with `--reporter=json --outputFile`.
- api-v1 schema change → `npm run openapi:gen` and commit `openapi/*.json`; the drift
  gate is CI-only.
- Any new/changed user-facing string → all 4 locale dictionaries (`en`, `es`, `fr`, `nl`)
  + `gen-keys` + `i18n:check`. `content/help/**` is one English tree.
- UI verified by screenshot at desktop AND 375px, no horizontal page scroll.
- Work in the worktree `.claude/worktrees/w4-delta-blocking`, branch
  `feat/w4-delta-blocking`; ship as a PR so smoke CI runs.
- `rest` does NOT become blocking. `instruction` does NOT become blocking.

## Decisions taken in this plan (not in the issue, needed to implement it)

1. **Apply-time window bounds come from the division's configured dates only** —
   `config.startAt` → lower bound, `config.endAt` → upper bound, each independently
   optional. The pack's window resolver deliberately *widens* onto already-occupied
   slots and onto the compiled instruction; reusing it at apply time would make the
   window unfalsifiable (nothing already on the board can ever be outside it) and would
   cage a board with no `endAt` inside an invented 7-day default. A board with neither
   bound configured gets no window check.
2. **`isBlocking` becomes the absolute vocabulary** (`court`, direct `order`,
   `person_overlap`, `window`); the delta is applied by the three persistence gates, not
   by `isBlocking`. The AI plan/repair loop keeps using it absolutely — that is what
   makes a repair round try to fix a person double-booking. The escalation-ratio shift
   this causes is asserted, per the issue's gotcha.
3. **`crossPersonClash: "hard"` stops being the switch for person-overlap blocking.**
   It stays in the type and still steers the solver; the apply gates now refuse a newly
   introduced overlap for every org. A "hard" org therefore sees no loosening, and a
   "warn" org gains the delta rule.
4. **`unschedulable` rows carry `rule: "CAP"`** — an unplaced fixture is the capacity
   case by definition. `no_slot` maps to `CAP` too.

---

## File structure

| File | Change |
|---|---|
| `packages/engine/src/scheduling/calendar.ts` | `RuleCode`, `RULE_BY_REASON`, `withRule`, `conflictKey`, `deltaConflicts`; feeder rest in the order loop; `rule` on every produced `Conflict` |
| `packages/engine/src/scheduling/index.ts` | re-export the new names |
| `packages/engine/src/scheduling/calendar-rules.test.ts` (new) | rule-code exhaustiveness + `conflictKey`/`deltaConflicts` semantics |
| `packages/engine/src/scheduling/calendar-feeder-rest.test.ts` (new) | feeder rest, both directions, from `BADMINTON` |
| `apps/web/src/server/usecases/schedule.ts` | `applyWindow()`, baseline pass, `mapConflicts(…, baseline)`, delta gate in `applySchedule` + `moveFixture` |
| `apps/web/src/server/usecases/competition-schedule-apply.ts` | baseline pass + delta gate + per-division apply window |
| `apps/web/src/server/usecases/schedule-ai.ts` | `isBlocking` gains `person_overlap`/`window`; `rule` surfaced on plan conflicts; `CAP` on unschedulable |
| `apps/web/src/server/usecases/competition-schedule-ai.ts` | `verifyConfigFor` apply-window arg; `CAP` on unschedulable |
| `apps/web/src/server/api-v1/schemas.ts` | `rule` on `AiPlanConflict` + `ScheduleConflict`; `rule` on unschedulable rows |
| `openapi/v1.json`, `openapi/v1.public.json` | regenerated |
| `apps/web/content/help/scheduling/board.md` | what now gets refused vs badged |
| `apps/web/src/dictionaries/{en,es,fr,nl}/ui.json` | only if a new string appears |
| `scripts/smoke.ts` | pro path: a drag that introduces a person clash is refused; the pre-existing one is not |

---

### Task 1: rule codes on `Conflict`

**Files:**
- Modify: `packages/engine/src/scheduling/calendar.ts:105-126` (union + interface), plus
  one `withRule` choke point at each `Conflict[]` return.
- Test: `packages/engine/src/scheduling/calendar-rules.test.ts` (new)

**Interfaces:**
- Produces: `type RuleCode = "H2"|"H3"|"H4"|"H5"|"H6"|"H8"|"CAP"`,
  `const RULE_BY_REASON: Record<ConflictReason, RuleCode>`,
  `Conflict.rule?: RuleCode`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { RULE_BY_REASON, validateAssignments } from "./calendar";
import type { ConflictReason } from "./calendar";

const ALL_REASONS: ConflictReason[] = [
  "no_slot", "court", "rest", "blackout", "person_overlap",
  "start_window", "window", "instruction", "order",
];

describe("rule codes (#399)", () => {
  it("maps every ConflictReason exactly once, and nothing else", () => {
    expect(Object.keys(RULE_BY_REASON).sort()).toEqual([...ALL_REASONS].sort());
    expect(RULE_BY_REASON.court).toBe("H2");
    expect(RULE_BY_REASON.blackout).toBe("H3");
    expect(RULE_BY_REASON.window).toBe("H3");
    expect(RULE_BY_REASON.rest).toBe("H4");
    expect(RULE_BY_REASON.person_overlap).toBe("H4");
    expect(RULE_BY_REASON.start_window).toBe("H5");
    expect(RULE_BY_REASON.order).toBe("H6");
    expect(RULE_BY_REASON.instruction).toBe("H8");
    expect(RULE_BY_REASON.no_slot).toBe("CAP");
  });

  it("stamps the code on a conflict the verifier actually produces", () => {
    // two fixtures, one court, same instant → court clash
    const at = Date.UTC(2026, 7, 10, 9, 0);
    const conflicts = validateAssignments(
      [
        { fixtureId: "a", court: "C1", startAt: at, endAt: at + 30 * 60_000, entrants: ["e1"], people: [] },
        { fixtureId: "b", court: "C1", startAt: at, endAt: at + 30 * 60_000, entrants: ["e2"], people: [] },
      ],
      { startAt: at, matchMinutes: 30, gapMinutes: 0, courts: ["C1"], perEntrantMinRest: 0, blackouts: [], sessionWindows: [] },
    );
    expect(conflicts.every((c) => c.rule === RULE_BY_REASON[c.reason])).toBe(true);
    expect(conflicts.some((c) => c.reason === "court" && c.rule === "H2")).toBe(true);
  });
});
```

- [ ] **Step 2: Run it, expect failure** — `npm test --workspace packages/engine`
      → `RULE_BY_REASON is not exported`.

- [ ] **Step 3: Implement** in `calendar.ts`, beside the union:

```ts
/** The rule vocabulary the scheduling prompts teach (H1–H8). A repair round is
 *  handed the same token it was taught, so repair is mechanical rather than
 *  interpretive (#399). `no_slot` is not a rule violation at all — no single
 *  rule is broken when demand exceeds capacity — so it carries the capacity
 *  marker `CAP`. */
export type RuleCode = "H2" | "H3" | "H4" | "H5" | "H6" | "H8" | "CAP";

export const RULE_BY_REASON: Record<ConflictReason, RuleCode> = {
  court: "H2",
  blackout: "H3",
  window: "H3",
  rest: "H4",
  person_overlap: "H4",
  start_window: "H5",
  order: "H6",
  instruction: "H8",
  no_slot: "CAP",
};

/** Stamped at ONE choke point per producer rather than at each push site: a new
 *  `conflicts.push` would otherwise ship a code-less conflict and the repair
 *  round would silently fall back to prose. */
export const withRule = (c: Conflict): Conflict => ({ ...c, rule: RULE_BY_REASON[c.reason] });
```

  and `rule?: RuleCode` on the `Conflict` interface. Then map every `Conflict[]`
  return through `withRule` — `validateAssignments`, `validateInstructionRules`,
  `slotFixtures`'s conflict array, and any other exported producer.

- [ ] **Step 4: Run the engine suite** — `npm test --workspace packages/engine` → PASS.

- [ ] **Step 5: Commit** `feat(engine): rule codes on every Conflict (#399)`

---

### Task 2: `conflictKey` + `deltaConflicts`

**Files:**
- Modify: `packages/engine/src/scheduling/calendar.ts` (append near the Conflict types)
- Test: `packages/engine/src/scheduling/calendar-rules.test.ts`

**Interfaces:**
- Consumes: `Conflict` from Task 1.
- Produces: `conflictKey(c: Conflict): string`,
  `deltaConflicts(before: readonly Conflict[], after: readonly Conflict[]): Conflict[]`.

- [ ] **Step 1: Write the failing test**

```ts
const c = (fixtureId: string, reason: ConflictReason, detail?: string): Conflict =>
  ({ fixtureId, reason, ...(detail !== undefined ? { detail } : {}) });

describe("deltaConflicts (#399)", () => {
  it("passes a pre-existing conflict through — it is not new", () => {
    const pre = c("f1", "person_overlap", "person p1 overlap");
    expect(deltaConflicts([pre], [pre])).toEqual([]);
  });

  it("reports a conflict the change introduced", () => {
    const fresh = c("f2", "person_overlap", "person p9 overlap");
    expect(deltaConflicts([c("f1", "person_overlap", "person p1 overlap")], [fresh])).toEqual([fresh]);
  });

  it("reports a WORSENED conflict — same key, higher count", () => {
    const dup = c("f1", "person_overlap", "person p1 overlap");
    expect(deltaConflicts([dup], [dup, dup])).toEqual([dup]);
  });

  it("treats a larger breach as new, because the detail differs", () => {
    expect(
      deltaConflicts([c("f1", "rest", "entrant e1 below rest")], [c("f1", "rest", "entrant e1/e2 below rest")]),
    ).toHaveLength(1);
  });

  it("keys on fixture, reason and detail", () => {
    expect(conflictKey(c("f1", "court", "court C1 double-booked"))).toBe("f1|court|court C1 double-booked");
    expect(conflictKey(c("f1", "court"))).toBe("f1|court|");
  });
});
```

- [ ] **Step 2: Run it, expect failure** (`deltaConflicts is not exported`).

- [ ] **Step 3: Implement**

```ts
/** Stable conflict identity, the key `verifyJoint`'s dedupe and the joint apply
 *  gate already use. `detail` is part of it on purpose: a bigger breach writes a
 *  different detail string, so "worsened" needs no separate comparison. */
export const conflictKey = (c: Conflict): string => `${c.fixtureId}|${c.reason}|${c.detail ?? ""}`;

/**
 * The conflicts a change INTRODUCED OR WORSENED — a multiset difference, not a
 * set one. Two instances of one key after and one before means the change added
 * a second, so one instance is returned.
 *
 * This is what keeps a dirty board editable (#399): boards published before this
 * wave may legitimately carry person overlaps, because they were warnings all
 * along. Under an absolute rule the organiser's next edit would 409 and they
 * would be stuck — unable to fix anything precisely because the board is dirty.
 */
export function deltaConflicts(
  before: readonly Conflict[],
  after: readonly Conflict[],
): Conflict[] {
  const budget = new Map<string, number>();
  for (const c of before) budget.set(conflictKey(c), (budget.get(conflictKey(c)) ?? 0) + 1);
  const out: Conflict[] = [];
  for (const c of after) {
    const key = conflictKey(c);
    const left = budget.get(key) ?? 0;
    if (left > 0) budget.set(key, left - 1);
    else out.push(c);
  }
  return out;
}
```

- [ ] **Step 4: Run the engine suite** → PASS.
- [ ] **Step 5: Commit** `feat(engine): conflict identity + delta (#399)`

---

### Task 3: feeder rest

**Files:**
- Modify: `packages/engine/src/scheduling/calendar.ts:828-840` (the dependency loop)
- Test: `packages/engine/src/scheduling/calendar-feeder-rest.test.ts` (new)

**Interfaces:**
- Consumes: `effectiveRestMinutes(config, group)` (`calendar.ts:82`).
- Produces: no new export; the `order` conflict's `detail` gains the rest form
  `starts N min after feeder <id> ends, needs M`.

- [ ] **Step 1: Write the failing test** (both directions, `BADMINTON`)

```ts
// Rejection: a dependent starting the instant its feeder ends, with rest > 0.
it("a dependent may not start at its feeder's final whistle", () => {
  const conflicts = validateAssignments(
    [feeder, dependentAtFeederEnd],                 // built from BADMINTON's SF→F edge
    { ...cfg, perEntrantMinRest: 45 },
    [],
    [{ fixtureId: dependentAtFeederEnd.fixtureId, dependsOn: feeder.fixtureId, direct: true }],
  );
  const order = conflicts.filter((c) => c.reason === "order");
  expect(order).toHaveLength(1);
  expect(order[0]!.direct).toBe(true);
  expect(order[0]!.rule).toBe("H6");
  expect(order[0]!.detail).toMatch(/needs 45/);
});

// Acceptance: the same pair with the rest honoured verifies clean.
it("verifies clean once the feeder rest is honoured", () => {
  const conflicts = validateAssignments(
    [feeder, dependentPlus45],
    { ...cfg, perEntrantMinRest: 45 },
    [],
    [{ fixtureId: dependentPlus45.fixtureId, dependsOn: feeder.fixtureId, direct: true }],
  );
  expect(conflicts.filter((c) => c.reason === "order")).toEqual([]);
});

// The pre-W4 shape stays reported the way it was: a dependent placed BEFORE its
// feeder ends is still one `order` conflict, not two.
it("a genuine ordering violation is still exactly one conflict", () => { /* … */ });
```

- [ ] **Step 2: Run it, expect failure** — the rest-breach case reports no `order`
      conflict today.

- [ ] **Step 3: Implement**

```ts
  for (const dep of dependencies) {
    const target = byId.get(dep.fixtureId);
    const source = byId.get(dep.dependsOn);
    if (!target || !source) continue;
    // The advancing player is a participant of the fixture they feed (#396), so
    // the dependent may not start at the feeder's final whistle — it may start
    // once the feeder's occupancy plus the rest that entrant is owed has passed
    // (#399 gap 7). `effectiveRestMinutes` is the same answer the placer and the
    // person checks give, so the three cannot disagree.
    const restMs = effectiveRestMinutes(config, target) * MS_PER_MIN;
    if (target.startAt < source.endAt + restMs) {
      const late = target.startAt < source.endAt;
      conflicts.push({
        fixtureId: dep.fixtureId,
        reason: "order",
        detail: late
          ? `starts before feeder ${dep.dependsOn} ends`
          : `starts ${Math.round((target.startAt - source.endAt) / MS_PER_MIN)} min after feeder ${dep.dependsOn} ends, needs ${effectiveRestMinutes(config, target)}`,
        direct: dep.direct === true,
      });
    }
  }
```

  Two distinct `detail` strings on purpose: they are different failures, and the
  delta key must not let a rest breach hide behind a pre-existing ordering one.

- [ ] **Step 4: Run the engine suite.** Expect existing suites that place a dependent
      exactly at its feeder's end with a non-zero rest to newly report — inspect each,
      and update only where the new report is correct.

- [ ] **Step 5: Commit** `feat(engine): a dependent rests after its feeder (#399)`

---

### Task 4: `isBlocking` gains `person_overlap` and `window`

**Files:**
- Modify: `apps/web/src/server/usecases/schedule-ai.ts:1344`
- Test: `apps/web/src/server/usecases/__tests__/competition-schedule-verify.test.ts`

- [ ] **Step 1: Write the failing test** — a person overlap and a window violation are
      blocking; `rest`, `blackout`, `instruction`, indirect `order` are not; and
      `partitionConflicts` stays the EXACT complement (existing R13 pin).
      Assert the escalation consequence explicitly: a plan whose only defects are person
      overlaps now has them in `blocking`, not in the `warnings` numerator.

- [ ] **Step 2: Run it, expect failure.**

- [ ] **Step 3: Implement**

```ts
export function isBlocking(c: Conflict): boolean {
  return (
    c.reason === "court" ||
    c.reason === "person_overlap" ||
    c.reason === "window" ||
    (c.reason === "order" && c.direct === true)
  );
}
```

- [ ] **Step 4: Run the AI suites** — `schedule-ai-*`, `competition-schedule-*`.
      The SDK mock queue is 1:1 with architect calls; a changed repair-round count
      shifts every later expectation in those suites. Read each failure before editing.

- [ ] **Step 5: Commit** `feat(scheduling): a person double-booking blocks (#399)`

---

### Task 5: delta gate on the single-division apply and the board move

**Files:**
- Modify: `apps/web/src/server/usecases/schedule.ts` — `mapConflicts` (`:371`),
  `applySchedule` (`:560-569`), `moveFixture` (`:769-778`), `toSlotConfig` (`:328`)
- Test: `apps/web/src/server/usecases/__tests__/schedule-delta-blocking.test.ts` (new,
  DB-gated like its neighbours)

**Interfaces:**
- Consumes: `deltaConflicts`, `conflictKey` (Task 2).
- Produces: `applyWindow(settings): {from:number;to:number} | undefined` (exported for
  the joint gate and for tests).

- [ ] **Step 1: Write the failing acceptance tests**

```ts
// 1. REJECTION — an edit that introduces a person overlap 409s.
// 2. ACCEPTANCE — a board that ALREADY holds a person overlap stays editable:
//    an unrelated fixture moves and the apply succeeds, with the pre-existing
//    overlap still reported as a non-blocking badge.
// 3. WORSENING — an edit that adds a SECOND overlapping fixture to the same
//    person blocks, even though the person was already double-booked.
// 4. WINDOW — a drag outside the configured competition dates 409s; the same
//    board re-applied unchanged does not.
// 5. The 409 body carries the rule code (`H4` / `H3`).
```

- [ ] **Step 2: Run them, expect failure** (today every one of these applies cleanly).

- [ ] **Step 3: Implement**

```ts
/** The competition's own dates as an engine window (#399). Deliberately NOT the
 *  pack's resolved window: that one widens onto whatever is already scheduled and
 *  onto the compiled instruction, so nothing already on the board could ever be
 *  outside it, and a division with no `endAt` would be caged inside an invented
 *  seven-day default. Each bound is independently optional. */
export function applyWindow(settings: ScheduleSettingsOut): { from: number; to: number } | undefined {
  const { startAt, endAt } = settings.config;
  if (!startAt && !endAt) return undefined;
  const tz = settings.orgTz;
  return {
    from: startAt ? zonedTimeToUtc(dayKeyInTz(ms(startAt), tz), "00:00", tz) : -Infinity,
    to: endAt ? zonedTimeToUtc(ymdAddDays(dayKeyInTz(ms(endAt), tz), 1), "00:00", tz) : Infinity,
  };
}
```

  `toSlotConfig` passes `window: applyWindow(settings)` through to `SlotConfig`.

  `mapConflicts` takes the baseline and marks `blocking` only for delta-new rows:

```ts
function mapConflicts(
  conflicts: readonly Conflict[],
  crossPersonClash?: "warn" | "hard",
  /** The SAME verifier run over the board as it stands today. A conflict already
   *  present is a badge, never a refusal — otherwise the first edit to a dirty
   *  board 409s and the organiser cannot fix the very thing that is wrong. */
  baseline: readonly Conflict[] = [],
): ScheduleConflict[] {
  const introduced = new Set(deltaConflicts(baseline, conflicts).map(conflictKey));
  return conflicts.map((c) => ({
    fixture_id: c.fixtureId,
    code: REASON_CODE[c.reason],
    ...(c.rule !== undefined ? { rule: c.rule } : {}),
    blocking: isBlockingReason(c, crossPersonClash) && introduced.has(conflictKey(c)),
    ...(c.detail !== undefined ? { detail: c.detail } : {}),
  }));
}
```

  In `applySchedule`, the baseline is the SAME fixtures at their CURRENT slots,
  validated against the same `untouched + siblings`:

```ts
    const current: Assignment[] = input.assignments
      .map((a) => byId.get(a.fixture_id) as FixtureLite)
      .filter((f) => f.scheduled_at !== null && f.court_label !== null)
      .map((f) => toAssignment(f, settings.config.matchMinutes, people));
    const baseline = validateAssignments(current, slotConfig, [...untouched, ...siblings], feedDependencies(all));
```

  `moveFixture` does the same with the single fixture at its stored slot (an
  unscheduled fixture yields an empty baseline, so every blocking conflict it
  introduces is new — correct).

- [ ] **Step 4: Run the web suites** with a provisioned `DB_SCHEMA`; confirm
      `numPassedTests`/`numTotalTests` from `--reporter=json`, not the summary line.

- [ ] **Step 5: Commit** `feat(scheduling): delta-based blocking on the board (#399)`

---

### Task 6: delta gate on the joint apply

**Files:**
- Modify: `apps/web/src/server/usecases/competition-schedule-apply.ts:472-539`
- Test: `apps/web/src/server/usecases/__tests__/competition-schedule-apply.test.ts`

- [ ] **Step 1: Write the failing test** — a joint apply that introduces a
      cross-division person overlap 409s; a joint apply over a competition that already
      holds one succeeds and returns it as a warning.
- [ ] **Step 2: Run it, expect failure.**
- [ ] **Step 3: Implement** — build `baselineByDivision` from the listed fixtures'
      stored slots, run the identical per-division pass over it, and gate on
      `deltaConflicts(baseline, found)` keys instead of `blockingKeys` alone. Keep
      `conflictKey` — import the engine's now, delete the local copy at `:476`.
      Pass each division's `applyWindow(d.settings)` into `verifyConfigFor`.
- [ ] **Step 4: Run** `competition-schedule-apply` + `competition-schedule-verify`.
- [ ] **Step 5: Commit** `feat(scheduling): delta-based blocking on the joint apply (#399)`

---

### Task 7: `rule` and `CAP` on the wire

**Files:**
- Modify: `apps/web/src/server/api-v1/schemas.ts:762-787` (`ScheduleConflict`),
  `:1655-1660` (`AiPlanConflict`), the unschedulable rows at `:1687`/`:1856`
- Modify: `apps/web/src/server/usecases/schedule-ai.ts`,
  `competition-schedule-ai.ts` — stamp `rule: "CAP"` on unschedulable rows
- Regenerate: `npm run openapi:gen`, commit `openapi/v1.json` + `openapi/v1.public.json`

- [ ] **Step 1: Write the failing test** — the plan response carries `rule` on every
      conflict and `CAP` on every unschedulable row; the 409 apply body carries `rule`.
- [ ] **Step 2: Run it, expect failure.**
- [ ] **Step 3: Implement** — `rule: z.enum(["H2","H3","H4","H5","H6","H8","CAP"]).optional()`.
- [ ] **Step 4: Run** the api-v1 suites + `npm run openapi:gen` and confirm a clean
      `git diff --stat openapi/`.
- [ ] **Step 5: Commit** `feat(api): rule codes and CAP on the wire (#399)`

---

### Task 8: closing pass

- [ ] **Step 1: Help** — `apps/web/content/help/scheduling/board.md`: what is refused
      (a new court clash, a new person double-booking, a slot outside the competition
      dates, a match that starts before its feeder has finished resting) versus what is
      badged (everything already on the board, rest, blackouts, instruction rules).
      English tree only, no i18n owed.
- [ ] **Step 2: i18n** — only if a new user-facing string appeared. `board.conflict.*`
      codes are unchanged, so the existing keys still resolve. If a string is added:
      all 4 dictionaries + `npm run gen-keys` + `npm run i18n:check`.
- [ ] **Step 3: smoke** — `scripts/smoke.ts` pro path: assert the drag that introduces
      a person clash comes back 409 `SCHEDULE_CONFLICT`, and that an unrelated move on
      the same dirty board still applies.
- [ ] **Step 4: Screenshots** — board with badges + the refusal toast at desktop and
      375px, no horizontal page scroll.
- [ ] **Step 5: Verify** — full engine suite, full web suite (`--reporter=json`),
      `tsc`, lint via `rtk proxy` reading `✖ N problems`, `npm run openapi:gen` clean.
- [ ] **Step 6: PR** — `feat: W4 delta-based blocking, rule codes, feeder rest (#399)`,
      closes #399, smoke CI runs on the PR.
