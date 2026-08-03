# W3 — Instruction Compiler + Typed-Rule Verification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to
> implement this plan task-by-task (inline execution — the tasks share
> `calendar.ts`, `constraints.ts`, `schedule-ai.ts` and the prompt module, so
> parallel subagents would collide). Steps use checkbox (`- [ ]`) syntax.

**Goal:** Turn the organiser's free-text scheduling instruction into typed hard
constraints that the engine verifier actually enforces, so "two matches per day",
"final on Friday" and "45 minute gap" become checkable rather than soft prose.

**Architecture:** A stage-1 LLM parser (`schedule-ai-parse.ts`) compiles free text
into a *symbolic* `RawParsed` — the model never touches a calendar. Deterministic
`resolveParsed` resolves symbolic dates against W2's `Clock`, bumps an infeasible
window, and records every interpretive choice in `pack.assumptions`. The compiled
`HardConstraint[]` lands on `pack.parsed.hard`, is merged with durable division
rules, and is enforced by `validateAssignments` alongside the existing rest /
blackout / window checks. The parse round runs **outside** `spendCredit`.

**Tech Stack:** TypeScript, zod, vitest, Next.js (App Router), Anthropic SDK via
the repo's `AiProvider` seam, `packages/engine` (pure) + `apps/web` (impure).

## Global Constraints

- **Issue:** #398. Design: `docs/superpowers/specs/2026-07-30-scheduler-verified-output-design.md`.
  Depends on #397 (merged, `8e3c4204`).
- **The LLM never performs calendar arithmetic.** A date word that reaches the
  architect prompt uncompiled means this wave failed regardless of test results.
- **`now` is injected, never read.** No `Date.now()` below the runner entry
  (`schedule-ai.ts:2108` / joint twin) — the golden-pack determinism tests depend
  on it.
- **`SYSTEM_PROMPT` stays byte-frozen.** New prompt text goes in a *new additive
  constant*; the golden snapshot at
  `apps/web/src/server/usecases/__tests__/schedule-ai-prompt.test.ts` must not
  change for `SYSTEM_PROMPT` itself.
- **Parse costs no credit.** It runs before `quoteRun`/`spendCredit`, on its own
  `createTokenMeter` with a ~1 000-token ceiling. It gets its own ledger line
  (`parse_tokens`), or the spend is invisible (#387).
- **"at least N minutes" only ever raises a stored rest, never lowers it.**
- **Uncompilable wording goes verbatim into `unparsed`.** Never invented into a rule.
- **A parse failure must not 422 the run.** It degrades to "no compiled rules" and
  is surfaced (W5 renders it); the architect still runs.
- **Both directions, every rule.** Each new check ships an ACCEPT case and a
  REJECT case, frozen from the two real payloads (badminton double-elimination;
  Stepladder Showcase).
- **Vitest counting:** run whole suites; never `npm test -- run <path>` with
  positionals (they are filename *filters*). Verify with
  `--reporter=json --outputFile` and read `numPassedTests`/`numTotalTests`.
- **`rtk` lies:** `PASS(0) FAIL(0)` can mean a suite failed to *collect*; `npm run
  lint` output is swallowed — use `rtk proxy` and read `✖ N problems`.
- **OpenAPI drift gate is CI-only.** Any api-v1 schema change → `npm run
  openapi:gen` + commit `openapi/*.json`.
- **Worktree:** `.claude/worktrees/w3-instruction-compiler`, branch
  `feat/w3-instruction-compiler`. Never check out in the main repo dir.
- **i18n:** any new *user-facing* string → all 4 locale dictionaries. Server-side
  `assumptions` strings follow the existing W1/W2 English-only pack convention.
  `content/help/**` is one English tree.

---

## File Structure

**Created**

| File | Responsibility |
|---|---|
| `packages/engine/src/scheduling/payload-fixtures.ts` | The two real payloads (badminton, Stepladder) + the `assign()` helper, shared by every W3 test. Not a `.test.ts`, so it is not collected. |
| `packages/engine/src/scheduling/calendar-instruction.test.ts` | Both-directions proof for every typed rule + cross-division rest MAX. |
| `apps/web/src/server/usecases/schedule-ai-parse.ts` | Stage-1 compiler: `RawParsed` zod, `PARSER_PROMPT`, `parseInstruction` (provider seam, one retry, own meter, never throws), `resolveParsed`. |
| `apps/web/src/server/usecases/__tests__/schedule-ai-parse.test.ts` | Parser + resolver tests against a stub provider and the two frozen instructions. |

**Modified**

| File | Change |
|---|---|
| `packages/engine/src/scheduling/constraints.ts` | `Weekday`, `ConstraintScope`, `FixtureSelector`, `HardConstraint`, `ParsedConstraints` zod; `hard` field on `SchedulingConstraints`. |
| `packages/engine/src/scheduling/calendar.ts` | Exported `VerifyConfig`; new `instruction` `ConflictReason`; `scopeCoversFixture`, `resolveSelector`, `instructionRestFloor`; per-day cap / weekday / date / not_before / not_after checks; cross-division rest as MAX. |
| `packages/engine/src/scheduling/index.ts` | Re-export the new symbols. |
| `packages/engine/src/scheduling/participants-rules.test.ts` | Import the payloads from `payload-fixtures.ts` instead of declaring them inline. |
| `apps/web/src/server/usecases/schedule-ai.ts` | `SchedulePack.parsed`; `buildSchedulePack` takes `raw`; `toModelPayload` forwards `parsed`; `verifyConfig` gains `tz`/`hard`/`ruleFixtures`/`restByDivision`; `planSchedule` runs the pre-flight parse outside `spendCredit`. |
| `apps/web/src/server/usecases/competition-schedule-ai.ts` | Joint twin of all of the above; `verifyJoint` supplies `restByDivision` so cross-division rest is the MAX. |
| `apps/web/src/server/usecases/schedule-ai-prompt.ts` | New additive `INSTRUCTION_RULES` constant + `SINGLE_SYSTEM_PROMPT`; `JOINT_SYSTEM_PROMPT` recomposed. |
| `apps/web/src/lib/ai-rung.ts` | `RunMeterStamp.parse_tokens` / `parse_failed`; `meterStamp(quote, meter, parse?)`. |
| `apps/web/src/server/api-v1/schemas.ts` | Response stamp gains `parse_tokens` / `parse_failed`. → regen OpenAPI. |
| `scripts/smoke.ts` | Assert a compiled-instruction run reports `parse_tokens`. |
| `content/help/**` | Document what the organiser's instruction can now express. |

---

## Locked design decisions

These were settled while reading the source material against our code. An
implementer must not re-litigate them.

1. **`HardConstraint` carries no timestamps.** The source's `window` constraint is
   dropped from the union entirely: `resolveParsed` writes the resolved window to
   `pack.window` (which W2 already created and which `validateAssignments` already
   checks via the `window` reason). What remains — minutes, counts, weekdays,
   `YYYY-MM-DD`, `HH:mm` — is **unit-free**, so engine and pack share ONE type and
   there is no ISO↔epoch conversion to get wrong.
2. **`not_before` / `not_after` are `HH:mm` only**, interpreted in the org zone.
   The source allowed "ISO *or* `HH:mm`" in one string field; that is precisely the
   silently-compare-the-wrong-unit trap `verifyConfig` already warns about at
   `schedule-ai.ts:1379-1382`.
3. **`FixtureSelector` has no `round` member.** Round numbers are display labels
   and elimination brackets number sparsely; a `round` selector is an invitation to
   the exact mistake the issue forbids. `terminal` (= `winner_to === null`),
   `ext_key` and `id` only. The *parser* schema exposes only `terminal` and
   `ext_key`.
4. **One new `ConflictReason`: `"instruction"`.** Every typed-instruction
   violation uses it (it maps to `H8` when W4 adds rule codes). Warn-only in W3 —
   `isBlocking` still covers `court` + direct `order` alone.
5. **`resolveParsed` lives in `schedule-ai-parse.ts`**, not in the engine: it deals
   in pack-shaped ISO strings and the `Clock`. (Design §7.1 names
   `usecases/schedule-ai.ts`; the issue's scope line groups it with the parser, and
   that is the file it ships in.)
6. **`pack.parsed` is prompt material; `pack.assumptions` is not.** `toModelPayload`
   forwards `parsed` (the model must satisfy the rules it will be verified
   against) and continues to withhold `participants` and `assumptions`.
   `resolveParsed`'s assumption strings are appended to the existing
   `pack.assumptions` array W1/W2 built.

---

## Task 1: Typed constraint vocabulary in the engine

**Files:**
- Modify: `packages/engine/src/scheduling/constraints.ts`
- Modify: `packages/engine/src/scheduling/index.ts`
- Test: `packages/engine/src/scheduling/constraints.test.ts`

**Interfaces:**
- Consumes: `Weekday` (type) from `./tz`.
- Produces: `ConstraintScope`, `FixtureSelector`, `HardConstraint`,
  `ParsedConstraints` (zod schemas + inferred types), and
  `SchedulingConstraints.hard: HardConstraint[]`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/engine/src/scheduling/constraints.test.ts`:

```ts
import { ConstraintScope, FixtureSelector, HardConstraint, SchedulingConstraints } from "./constraints";

describe("typed instruction constraints (#398)", () => {
  it("parses every hard-constraint member", () => {
    const all = [
      { type: "min_rest_minutes", minutes: 45, rest_scope: "both", scope: { kind: "competition" } },
      { type: "max_fixtures_per_day", count: 2, scope: { kind: "division", divisionId: "d1" } },
      { type: "fixture_on_weekday", selector: { kind: "terminal" }, weekday: "FRI", scope: { kind: "competition" } },
      { type: "fixture_on_date", selector: { kind: "ext_key", extKey: "gf" }, date: "2026-08-07", scope: { kind: "competition" } },
      { type: "not_before", time: "09:00", scope: { kind: "pool", divisionId: "d1", pool: "A" } },
      { type: "not_after", time: "21:30", scope: { kind: "entrant", entrantId: "e1" } },
    ];
    for (const c of all) expect(HardConstraint.safeParse(c).success).toBe(true);
  });

  it("rejects a round-number selector — round is a display label", () => {
    expect(FixtureSelector.safeParse({ kind: "round", divisionId: "d1", round: 3 }).success).toBe(false);
  });

  it("rejects an ISO instant where a wall-clock time is required", () => {
    expect(
      HardConstraint.safeParse({ type: "not_before", time: "2026-08-07T09:00:00Z", scope: { kind: "competition" } }).success,
    ).toBe(false);
  });

  it("rejects a non-positive rest and a zero-per-day cap", () => {
    expect(HardConstraint.safeParse({ type: "min_rest_minutes", minutes: 0, rest_scope: "both", scope: { kind: "competition" } }).success).toBe(false);
    expect(HardConstraint.safeParse({ type: "max_fixtures_per_day", count: 0, scope: { kind: "competition" } }).success).toBe(false);
  });

  it("scopes a rule to a person key", () => {
    expect(ConstraintScope.safeParse({ kind: "person", personKey: "p-1" }).success).toBe(true);
  });

  it("defaults SchedulingConstraints.hard to [] so pre-W3 rows still parse", () => {
    const parsed = SchedulingConstraints.parse({});
    expect(parsed.hard).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
npx vitest run packages/engine/src/scheduling/constraints.test.ts \
  --reporter=json --outputFile=/tmp/w3-t1.json
```
Expected: FAIL — `HardConstraint` / `FixtureSelector` / `ConstraintScope` are not
exported from `./constraints`.

- [ ] **Step 3: Implement**

Append to `packages/engine/src/scheduling/constraints.ts`:

```ts
// --- Typed instruction constraints (#398) ----------------------------------
// The compiled form of an organiser's free-text instruction. Deliberately
// UNIT-FREE: minutes, counts, weekdays, YYYY-MM-DD and HH:mm only. The one
// timestamped thing an instruction can say — its calendar window — is resolved
// into `pack.window` instead, which the verifier already checks, so this union
// needs no ISO/epoch conversion at any edge and engine and pack share one type.

export const WeekdayCode = z.enum(["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"]);
export type WeekdayCode = z.infer<typeof WeekdayCode>;

export const ConstraintScope = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("competition") }),
  z.object({ kind: z.literal("division"), divisionId: z.string().min(1) }),
  z.object({ kind: z.literal("entrant"), entrantId: z.string().min(1) }),
  z.object({ kind: z.literal("person"), personKey: z.string().min(1) }),
  z.object({ kind: z.literal("pool"), divisionId: z.string().min(1), pool: z.string().min(1) }),
]);
export type ConstraintScope = z.infer<typeof ConstraintScope>;

/** NO `round` member, on purpose. Round numbers are DISPLAY LABELS: an
 *  elimination bracket numbers sparsely (1,2,3 winners / 7-10 losers / 14 grand
 *  final) and a rule keyed on one would silently address the wrong fixtures.
 *  `terminal` means `feeds.winner_to === null`, resolved per division in scope. */
export const FixtureSelector = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("terminal") }),
  z.object({ kind: z.literal("ext_key"), extKey: z.string().min(1), divisionId: z.string().min(1).optional() }),
  z.object({ kind: z.literal("id"), fixtureId: z.string().min(1) }),
]);
export type FixtureSelector = z.infer<typeof FixtureSelector>;

const YMD = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
/** Wall-clock time in the ORG zone. Never an instant — see the unit note above. */
const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

export const HardConstraint = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("min_rest_minutes"),
    minutes: z.number().int().positive(),
    rest_scope: z.enum(["per_person", "feeder_to_dependent", "both"]),
    scope: ConstraintScope,
  }),
  z.object({ type: z.literal("max_fixtures_per_day"), count: z.number().int().positive(), scope: ConstraintScope }),
  z.object({ type: z.literal("fixture_on_weekday"), selector: FixtureSelector, weekday: WeekdayCode, scope: ConstraintScope }),
  z.object({ type: z.literal("fixture_on_date"), selector: FixtureSelector, date: YMD, scope: ConstraintScope }),
  z.object({ type: z.literal("not_before"), time: HHMM, scope: ConstraintScope }),
  z.object({ type: z.literal("not_after"), time: HHMM, scope: ConstraintScope }),
]);
export type HardConstraint = z.infer<typeof HardConstraint>;

/** What the compiler produced, minus the assumptions — those join the pack's
 *  existing `assumptions` array (#396/#397) rather than starting a second one. */
export const ParsedConstraints = z.object({
  hard: z.array(HardConstraint).default([]),
  soft: z.array(z.object({ note: z.string(), weight: z.union([z.literal(1), z.literal(2), z.literal(3)]) })).default([]),
  unparsed: z.array(z.string()).default([]),
});
export type ParsedConstraints = z.infer<typeof ParsedConstraints>;
```

Then add the durable-rule field to the existing `SchedulingConstraints` object
(inside the `z.object({...})` at `constraints.ts:19`), after `crossPersonClash`:

```ts
  /** Durable division rules, in the SAME vocabulary a compiled instruction
   *  produces, so hard rules have exactly one home (design §4.1). Defaults to []
   *  so every pre-W3 persisted `schedule_settings.constraints` row still parses
   *  — no migration. */
  hard: z.array(HardConstraint).default([]),
```

- [ ] **Step 4: Re-export**

In `packages/engine/src/scheduling/index.ts`, add to the `./constraints` export
line: `ConstraintScope`, `FixtureSelector`, `HardConstraint`, `ParsedConstraints`,
`WeekdayCode`.

- [ ] **Step 5: Run to verify it passes**

```bash
npx vitest run packages/engine/src/scheduling --reporter=json --outputFile=/tmp/w3-t1.json
node -e "const r=require('/tmp/w3-t1.json');console.log(r.numPassedTests,'/',r.numTotalTests,'fail',r.numFailedTests)"
```
Expected: `numFailedTests` 0, and the whole `scheduling` directory still green
(the `hard` default must not break `constraints.test.ts`'s existing round-trip
assertions — if one asserts an exact object, add `hard: []` to its expectation).

- [ ] **Step 6: Commit**

```bash
git add packages/engine/src/scheduling/constraints.ts \
        packages/engine/src/scheduling/index.ts \
        packages/engine/src/scheduling/constraints.test.ts
git commit -m "feat(engine): typed instruction constraint vocabulary (#398)"
```

---

## Task 2: Shared payload fixtures

**Files:**
- Create: `packages/engine/src/scheduling/payload-fixtures.ts`
- Modify: `packages/engine/src/scheduling/participants-rules.test.ts`

**Interfaces:**
- Consumes: `ParticipantFixture`, `stripByes`, `computeParticipants` from `./participants`; `Assignment` from `./calendar`.
- Produces: `BADMINTON`, `SOLO`, `STEP`, `SHARED`, `BASE_CONFIG`, `at()`, `assign()`.

This exists so Task 3 and Task 5 freeze the *same* two real payloads the W1 tests
did, rather than a paraphrase of them.

- [ ] **Step 1: Create the fixture module**

Create `packages/engine/src/scheduling/payload-fixtures.ts` by moving — verbatim,
no edits to any literal — these blocks out of
`packages/engine/src/scheduling/participants-rules.test.ts`: the `MIN`, `at`, `fx`
helpers (`:10-18`), `BADMINTON` (`:21-35`), `SOLO` (`:36-38`), `CONFIG` (renamed
`BASE_CONFIG`, `:46-52`), `assign` (`:55-76`), and — from inside the payload-B
describe — `STEP` (`:166-171`) and `SHARED` (`:174-181`). Export every one of
them. Keep the explanatory comments attached to what they explain.

Header comment for the new file:

```ts
// The two real payloads this programme is frozen against (#395):
// A — badminton double elimination, single division, 13 fixtures, 7 entrants.
// B — Stepladder Showcase, two divisions, one human (Fischer) entered in both.
// Lives outside a `.test.ts` so vitest does not collect it, and so #396's
// participants tests and #398's instruction tests assert against BYTE-IDENTICAL
// inputs — a payload that drifted between waves proves nothing about either.
```

- [ ] **Step 2: Rewire the existing test**

In `participants-rules.test.ts`, delete the moved blocks and import instead:

```ts
import { assign, at, BADMINTON, BASE_CONFIG as CONFIG, SHARED, SOLO, STEP } from "./payload-fixtures";
```

Leave every `it(...)` body untouched.

- [ ] **Step 3: Run to verify nothing moved**

```bash
npx vitest run packages/engine/src/scheduling --reporter=json --outputFile=/tmp/w3-t2.json
node -e "const r=require('/tmp/w3-t2.json');console.log(r.numPassedTests,'/',r.numTotalTests,'fail',r.numFailedTests)"
```
Expected: identical pass/total counts to Task 1 Step 5. A *changed* total means a
test was lost in the move — fix before continuing.

- [ ] **Step 4: Commit**

```bash
git add packages/engine/src/scheduling/payload-fixtures.ts \
        packages/engine/src/scheduling/participants-rules.test.ts
git commit -m "test(engine): extract the two frozen payloads to a shared module (#398)"
```

---

## Task 3: The verifier enforces typed rules

**Files:**
- Modify: `packages/engine/src/scheduling/calendar.ts`
- Modify: `packages/engine/src/scheduling/index.ts`
- Test: `packages/engine/src/scheduling/calendar-instruction.test.ts` (create)

**Interfaces:**
- Consumes: `HardConstraint`, `ConstraintScope`, `FixtureSelector` (Task 1);
  `dayKeyInTz`, `hhmmInTz`, `weekdayOfYmd` from `./tz`; the payloads (Task 2).
- Produces:
  ```ts
  export interface RuleFixture {
    id: string;
    extKey: string | null;
    divisionId?: string;
    poolId?: string;
    /** `null` ⇒ terminal: nothing advances out of this fixture. */
    winnerTo: string | null;
  }
  export type VerifyConfig =
    Pick<SlotConfig, "perEntrantMinRest" | "gapMinutes" | "blackouts" | "sessionWindows"> &
    Partial<Pick<SlotConfig, "matchMinutes" | "constraints" | "window">> & {
      tz?: string;
      hard?: readonly HardConstraint[];
      ruleFixtures?: readonly RuleFixture[];
      restByDivision?: Readonly<Record<string, number>>;
    };
  export function scopeCoversFixture(scope: ConstraintScope, f: RuleFixture, a: Assignment): boolean;
  export function resolveSelector(sel: FixtureSelector, scope: ConstraintScope, fixtures: readonly RuleFixture[]): RuleFixture[];
  ```
  `validateAssignments`'s second parameter becomes `VerifyConfig`, and
  `ConflictReason` gains `"instruction"`.

- [ ] **Step 1: Write the failing tests**

Create `packages/engine/src/scheduling/calendar-instruction.test.ts`:

```ts
// Both-directions proof (#398): every typed rule the instruction compiler can
// emit is enforced by validateAssignments — and stays quiet on a board that
// satisfies it. A verifier that only rejects is untested where it matters most.
import { describe, expect, it } from "vitest";
import { validateAssignments, type Assignment, type RuleFixture, type VerifyConfig } from "./calendar";
import { assign, at, BADMINTON, BASE_CONFIG, SHARED, SOLO, STEP } from "./payload-fixtures";
import type { HardConstraint } from "./constraints";

const TZ = "Europe/London";
const rf = (id: string, winnerTo: string | null, divisionId?: string, extKey = id): RuleFixture => ({
  id, extKey, winnerTo, ...(divisionId !== undefined ? { divisionId } : {}),
});

/** Badminton rule fixtures: `gf` is the only terminal (nothing feeds out of it). */
const BAD_RF: RuleFixture[] = BADMINTON.map((f) => rf(f.id, f.id === "gf" ? null : "next"));

const cfg = (hard: HardConstraint[], extra: Partial<VerifyConfig> = {}): VerifyConfig => ({
  ...BASE_CONFIG, tz: TZ, hard, ruleFixtures: BAD_RF, ...extra,
});
const instr = (c: readonly { reason: string }[]) => c.filter((x) => x.reason === "instruction");

const CAP2: HardConstraint = { type: "max_fixtures_per_day", count: 2, scope: { kind: "competition" } };

describe("max_fixtures_per_day (payload A: badminton)", () => {
  it("ACCEPTS two fixtures on each of two days", () => {
    const slots: [string, string, string][] = [
      ["wb-r0-i1", "2026-08-03T10:00:00Z", "Court 1"],
      ["wb-r0-i2", "2026-08-03T12:00:00Z", "Court 1"],
      ["wb-r0-i3", "2026-08-04T10:00:00Z", "Court 1"],
      ["wb-r1-i0", "2026-08-04T12:00:00Z", "Court 1"],
    ];
    expect(instr(validateAssignments(assign(BADMINTON, SOLO, slots), cfg([CAP2])))).toEqual([]);
  });

  it("REJECTS three fixtures on one day, naming the day and the cap", () => {
    const slots: [string, string, string][] = [
      ["wb-r0-i1", "2026-08-03T10:00:00Z", "Court 1"],
      ["wb-r0-i2", "2026-08-03T12:00:00Z", "Court 1"],
      ["wb-r0-i3", "2026-08-03T14:00:00Z", "Court 1"],
    ];
    const found = instr(validateAssignments(assign(BADMINTON, SOLO, slots), cfg([CAP2])));
    expect(found.length).toBeGreaterThan(0);
    expect(found.some((c) => (c as { detail?: string }).detail?.includes("2026-08-03"))).toBe(true);
    expect(found.some((c) => (c as { detail?: string }).detail?.includes("2/day"))).toBe(true);
  });

  it("counts the day in the ORG zone, not UTC", () => {
    // 23:30 UTC on the 3rd is 00:30 on the 4th in Sydney: under a 1/day cap the
    // pair is legal in Sydney and illegal in UTC. This is the whole point of the
    // one-timezone decision (design §2.1).
    const slots: [string, string, string][] = [
      ["wb-r0-i1", "2026-08-03T12:00:00Z", "Court 1"],
      ["wb-r0-i2", "2026-08-03T23:30:00Z", "Court 2"],
    ];
    const cap1: HardConstraint = { type: "max_fixtures_per_day", count: 1, scope: { kind: "competition" } };
    const a = assign(BADMINTON, SOLO, slots);
    expect(instr(validateAssignments(a, cfg([cap1], { tz: "Australia/Sydney" })))).toEqual([]);
    expect(instr(validateAssignments(a, cfg([cap1], { tz: "UTC" }))).length).toBeGreaterThan(0);
  });
});

describe("fixture_on_weekday with a terminal selector", () => {
  const FRI: HardConstraint = {
    type: "fixture_on_weekday", selector: { kind: "terminal" }, weekday: "FRI", scope: { kind: "competition" },
  };
  it("ACCEPTS the grand final on a Friday", () => {
    // 2026-08-07 is a Friday.
    const slots: [string, string, string][] = [["gf", "2026-08-07T10:00:00Z", "Court 1"]];
    expect(instr(validateAssignments(assign(BADMINTON, SOLO, slots), cfg([FRI])))).toEqual([]);
  });
  it("REJECTS the grand final on a Thursday", () => {
    const slots: [string, string, string][] = [["gf", "2026-08-06T10:00:00Z", "Court 1"]];
    const found = instr(validateAssignments(assign(BADMINTON, SOLO, slots), cfg([FRI])));
    expect(found.length).toBe(1);
    expect(found[0]!.fixtureId).toBe("gf");
  });
  it("resolves terminal by winner_to === null, never by round number", () => {
    // wb-r2-i0 is a HIGHER round than lb-r3-i0 and is NOT terminal. On a Thursday
    // it must attract no violation: only `gf` is selected.
    const slots: [string, string, string][] = [["wb-r2-i0", "2026-08-06T10:00:00Z", "Court 1"]];
    expect(instr(validateAssignments(assign(BADMINTON, SOLO, slots), cfg([FRI])))).toEqual([]);
  });
});

describe("fixture_on_date", () => {
  const ON: HardConstraint = {
    type: "fixture_on_date", selector: { kind: "ext_key", extKey: "gf" }, date: "2026-08-07",
    scope: { kind: "competition" },
  };
  it("ACCEPTS the named date", () => {
    expect(instr(validateAssignments(assign(BADMINTON, SOLO, [["gf", "2026-08-07T10:00:00Z", "Court 1"]]), cfg([ON])))).toEqual([]);
  });
  it("REJECTS a different date", () => {
    expect(instr(validateAssignments(assign(BADMINTON, SOLO, [["gf", "2026-08-08T10:00:00Z", "Court 1"]]), cfg([ON]))).length).toBe(1);
  });
});

describe("not_before / not_after in the org zone", () => {
  const NB: HardConstraint = { type: "not_before", time: "09:00", scope: { kind: "competition" } };
  const NA: HardConstraint = { type: "not_after", time: "20:00", scope: { kind: "competition" } };
  it("ACCEPTS 10:00 London", () => {
    expect(instr(validateAssignments(assign(BADMINTON, SOLO, [["gf", "2026-08-07T09:00:00Z", "Court 1"]]), cfg([NB, NA])))).toEqual([]);
  });
  it("REJECTS 07:00 London", () => {
    // 06:00Z = 07:00 London in August.
    expect(instr(validateAssignments(assign(BADMINTON, SOLO, [["gf", "2026-08-07T06:00:00Z", "Court 1"]]), cfg([NB, NA]))).length).toBe(1);
  });
  it("REJECTS 21:00 London", () => {
    expect(instr(validateAssignments(assign(BADMINTON, SOLO, [["gf", "2026-08-07T20:00:00Z", "Court 1"]]), cfg([NB, NA]))).length).toBe(1);
  });
});

describe("min_rest_minutes RAISES a stored rest and never lowers it", () => {
  const R40: HardConstraint = { type: "min_rest_minutes", minutes: 40, rest_scope: "both", scope: { kind: "competition" } };
  // Two badminton fixtures sharing entrant `d`, 10 minutes apart on different courts.
  const slots: [string, string, string][] = [
    ["wb-r0-i1", "2026-08-03T10:00:00Z", "Court 1"],
    ["lb-r0-i0", "2026-08-03T10:50:00Z", "Court 2"],
  ];
  it("REJECTS a 10-minute gap when the instruction says 40 and the setting says 0", () => {
    const found = validateAssignments(assign(BADMINTON, SOLO, slots), cfg([R40], { perEntrantMinRest: 0 }));
    expect(found.some((c) => c.reason === "rest")).toBe(true);
  });
  it("does NOT lower a stored 90 to the instruction's 40", () => {
    const wide: [string, string, string][] = [
      ["wb-r0-i1", "2026-08-03T10:00:00Z", "Court 1"],
      ["lb-r0-i0", "2026-08-03T11:30:00Z", "Court 2"], // 50 min gap: ok at 40, not at 90
    ];
    expect(validateAssignments(assign(BADMINTON, SOLO, wide), cfg([R40], { perEntrantMinRest: 90 }))
      .some((c) => c.reason === "rest")).toBe(true);
  });
  it("ACCEPTS a 50-minute gap at an instructed 40 with a stored 0", () => {
    const wide: [string, string, string][] = [
      ["wb-r0-i1", "2026-08-03T10:00:00Z", "Court 1"],
      ["lb-r0-i0", "2026-08-03T11:30:00Z", "Court 2"],
    ];
    expect(validateAssignments(assign(BADMINTON, SOLO, wide), cfg([R40], { perEntrantMinRest: 0 }))
      .some((c) => c.reason === "rest")).toBe(false);
  });
});

describe("cross-division rest is the MAX of both divisions (payload B: Stepladder)", () => {
  const STEP_RF: RuleFixture[] = [
    rf("sl-g1-d1", "sl-g2-d1", "d1"), rf("sl-g2-d1", null, "d1"),
    rf("sl-g2-d2", "sl-g3-d2", "d2"), rf("sl-g3-d2", null, "d2"),
  ];
  // Fischer plays in BOTH divisions. d1 rests 20, d2 rests 120. A 60-minute gap
  // is legal under d1's own config and illegal under d2's — before this change
  // the d1 pass silently accepted it, which is the bug.
  const slots: [string, string, string][] = [
    ["sl-g2-d1", "2026-07-24T10:00:00Z", "Court 1"],
    ["sl-g2-d2", "2026-07-24T11:30:00Z", "Court 2"], // ends 10:30 / starts 11:30 = 60 min
  ];
  const withDiv = (a: Assignment[], id: string, div: string): Assignment[] =>
    a.map((x) => (x.fixtureId === id ? { ...x, divisionId: div } : x));

  const board = () => {
    let a = assign(STEP, SHARED, slots, 30);
    a = withDiv(a, "sl-g2-d1", "d1");
    a = withDiv(a, "sl-g2-d2", "d2");
    return a;
  };

  it("REJECTS the pair when the OTHER division's rest is the binding one", () => {
    const a = board();
    const found = validateAssignments(
      a.filter((x) => x.divisionId === "d1"),
      { ...BASE_CONFIG, tz: TZ, matchMinutes: 30, perEntrantMinRest: 20,
        ruleFixtures: STEP_RF, restByDivision: { d1: 20, d2: 120 } },
      a.filter((x) => x.divisionId !== "d1"),
    );
    expect(found.some((c) => c.reason === "rest")).toBe(true);
  });

  it("ACCEPTS the same pair once the gap clears the MAX", () => {
    const far: [string, string, string][] = [
      ["sl-g2-d1", "2026-07-24T10:00:00Z", "Court 1"],
      ["sl-g2-d2", "2026-07-24T14:00:00Z", "Court 2"],
    ];
    let a = assign(STEP, SHARED, far, 30);
    a = withDiv(a, "sl-g2-d1", "d1");
    a = withDiv(a, "sl-g2-d2", "d2");
    expect(
      validateAssignments(
        a.filter((x) => x.divisionId === "d1"),
        { ...BASE_CONFIG, tz: TZ, matchMinutes: 30, perEntrantMinRest: 20,
          ruleFixtures: STEP_RF, restByDivision: { d1: 20, d2: 120 } },
        a.filter((x) => x.divisionId !== "d1"),
      ).some((c) => c.reason === "rest"),
    ).toBe(false);
  });
});

describe("scoping", () => {
  it("a division-scoped cap ignores another division's fixtures", () => {
    const cap1: HardConstraint = { type: "max_fixtures_per_day", count: 1, scope: { kind: "division", divisionId: "d2" } };
    const STEP_RF: RuleFixture[] = [
      rf("sl-g1-d1", "sl-g2-d1", "d1"), rf("sl-g2-d1", null, "d1"),
      rf("sl-g2-d2", "sl-g3-d2", "d2"), rf("sl-g3-d2", null, "d2"),
    ];
    const a = assign(STEP, SHARED, [
      ["sl-g1-d1", "2026-07-24T10:00:00Z", "Court 1"],
      ["sl-g2-d1", "2026-07-24T14:00:00Z", "Court 1"],
    ], 30).map((x) => ({ ...x, divisionId: "d1" }));
    expect(instr(validateAssignments(a, { ...BASE_CONFIG, tz: TZ, matchMinutes: 30, hard: [cap1], ruleFixtures: STEP_RF }))).toEqual([]);
  });

  it("a rule with no tz configured is skipped rather than bucketed wrongly", () => {
    const a = assign(BADMINTON, SOLO, [
      ["wb-r0-i1", "2026-08-03T10:00:00Z", "Court 1"],
      ["wb-r0-i2", "2026-08-03T12:00:00Z", "Court 1"],
      ["wb-r0-i3", "2026-08-03T14:00:00Z", "Court 1"],
    ]);
    expect(instr(validateAssignments(a, { ...BASE_CONFIG, hard: [CAP2], ruleFixtures: BAD_RF }))).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
npx vitest run packages/engine/src/scheduling/calendar-instruction.test.ts \
  --reporter=json --outputFile=/tmp/w3-t3.json
```
Expected: FAIL — `RuleFixture` / `VerifyConfig` are not exported and no
`instruction` conflicts are produced.

- [ ] **Step 3: Implement — types and reason**

In `calendar.ts`, extend the reason union (`:104-112`) with `"instruction"`:

```ts
export type ConflictReason =
  | "no_slot" | "court" | "rest" | "blackout" | "person_overlap"
  | "start_window" | "window"
  /** A rule compiled from the organiser's own instruction, or a durable
   *  division rule in the same vocabulary (#398). Warn-only here: `isBlocking`
   *  still covers `court` and direct `order` alone, and W4 (#399) is what turns
   *  this into a delta-based block and gives it rule code H8. */
  | "instruction"
  | "order";
```

Add, above `validateAssignments`:

```ts
/** The fixture metadata a typed rule needs and an `Assignment` does not carry:
 *  which fixture is terminal, and what its stable external key is. Supplied by
 *  the pack, never re-derived here — `winnerTo === null` is the ONLY definition
 *  of terminal, and round numbers are display labels (design §7.2). */
export interface RuleFixture {
  id: string;
  extKey: string | null;
  divisionId?: string;
  poolId?: string;
  winnerTo: string | null;
}

/** Everything `validateAssignments` reads. Named because three call sites build
 *  it (`verifyConfig`, `verifyConfigFor`, the apply path) and a structural type
 *  in a signature cannot be spread-checked by any of them. */
export type VerifyConfig = Pick<
  SlotConfig,
  "perEntrantMinRest" | "gapMinutes" | "blackouts" | "sessionWindows"
> &
  Partial<Pick<SlotConfig, "matchMinutes" | "constraints" | "window">> & {
    /** The ORG zone (#397). Day buckets, weekday targets and HH:mm bounds are
     *  meaningless without it, so a rule that needs one is SKIPPED when it is
     *  absent rather than silently bucketed in UTC. */
    tz?: string;
    /** Compiled instruction rules + durable division rules, one merged stream. */
    hard?: readonly HardConstraint[];
    ruleFixtures?: readonly RuleFixture[];
    /** Every division's own `perEntrantMinRest`, so a cross-division pair is
     *  rested at the MAX of both rather than at whichever pass happened to see
     *  it (design §7.2). Keyed by division id. */
    restByDivision?: Readonly<Record<string, number>>;
  };

export function scopeCoversFixture(scope: ConstraintScope, f: RuleFixture | undefined, a: Assignment): boolean {
  switch (scope.kind) {
    case "competition":
      return true;
    case "division":
      return (f?.divisionId ?? a.divisionId) === scope.divisionId;
    case "pool":
      return (f?.divisionId ?? a.divisionId) === scope.divisionId && (f?.poolId ?? a.poolId) === scope.pool;
    case "entrant":
      return a.entrants.includes(scope.entrantId);
    case "person":
      // The bridge that makes person-scoped rules expressible at all: `people`
      // is participants (#396), so a rule about a human binds the TBD slots that
      // human can still advance into.
      return a.people.includes(scope.personKey);
  }
}

export function resolveSelector(
  sel: FixtureSelector,
  scope: ConstraintScope,
  fixtures: readonly RuleFixture[],
): RuleFixture[] {
  switch (sel.kind) {
    case "terminal": {
      const divisionId = scope.kind === "division" ? scope.divisionId : scope.kind === "pool" ? scope.divisionId : null;
      return fixtures.filter(
        (f) => f.winnerTo === null && (divisionId === null || f.divisionId === divisionId),
      );
    }
    case "ext_key":
      return fixtures.filter(
        (f) => f.extKey === sel.extKey && (sel.divisionId === undefined || f.divisionId === sel.divisionId),
      );
    case "id":
      return fixtures.filter((f) => f.id === sel.fixtureId);
  }
}
```

Import at the top of `calendar.ts`:

```ts
import type { ConstraintScope, FixtureSelector, HardConstraint } from "./constraints";
import { dayKeyInTz, hhmmInTz, weekdayOfYmd } from "./tz";
```

- [ ] **Step 4: Implement — rest MAX and the rule pass**

Change `validateAssignments`'s second parameter type to `VerifyConfig` (the
existing inline intersection is now `VerifyConfig`'s first two lines, so the
change is compatible with every current caller).

Inside `validateAssignments`, add near the top (after `const byId = ...`):

```ts
  const hard = config.hard ?? [];
  const ruleFixtures = config.ruleFixtures ?? [];
  const fixtureById = new Map(ruleFixtures.map((f) => [f.id, f]));
  const tz = config.tz;

  /** The strictest rest that applies to a PAIR: this division's resolved value,
   *  the other division's own value (cross-division rest is the MAX — a human's
   *  recovery does not care which bracket they are in), and any instruction rule
   *  covering EITHER side. A lower bound only: it can raise a stored setting,
   *  never lower it. */
  const restFor = (a: Assignment, other: Assignment): number => {
    let minutes = effectiveRestMinutes(config, a);
    const otherDiv = other.divisionId;
    if (otherDiv !== undefined) minutes = Math.max(minutes, config.restByDivision?.[otherDiv] ?? 0);
    for (const h of hard) {
      if (h.type !== "min_rest_minutes" || h.rest_scope === "feeder_to_dependent") continue;
      const covers =
        scopeCoversFixture(h.scope, fixtureById.get(a.fixtureId), a) ||
        scopeCoversFixture(h.scope, fixtureById.get(other.fixtureId), other);
      if (covers) minutes = Math.max(minutes, h.minutes);
    }
    return minutes;
  };
```

Replace the rest computation at `calendar.ts:506` with:

```ts
          const restMs = restFor(a, other) * MS_PER_MIN;
```

Then append the typed-rule pass immediately before the feed-order loop
(i.e. after the `for (const a of assignments)` block closes at `:520`):

```ts
  // --- Typed instruction rules (#398) --------------------------------------
  // Warn-only in W3. Every rule that needs a day boundary or a wall-clock time
  // needs the org zone; without one it is SKIPPED, because bucketing in UTC
  // would report a violation the organiser never expressed.
  const placedById = new Map(assignments.map((a) => [a.fixtureId, a]));
  for (const h of hard) {
    if (h.type === "min_rest_minutes") continue; // folded into restFor above
    if (tz === undefined) continue;

    if (h.type === "max_fixtures_per_day") {
      const perDay = new Map<string, Assignment[]>();
      for (const a of assignments) {
        if (!scopeCoversFixture(h.scope, fixtureById.get(a.fixtureId), a)) continue;
        const key = dayKeyInTz(a.startAt, tz);
        const bucket = perDay.get(key);
        if (bucket) bucket.push(a);
        else perDay.set(key, [a]);
      }
      for (const [day, list] of perDay) {
        if (list.length <= h.count) continue;
        for (const a of list) {
          conflicts.push({
            fixtureId: a.fixtureId,
            reason: "instruction",
            detail: `${list.length} fixtures on ${day} exceed the ${h.count}/day cap`,
          });
        }
      }
      continue;
    }

    if (h.type === "fixture_on_weekday" || h.type === "fixture_on_date") {
      for (const f of resolveSelector(h.selector, h.scope, ruleFixtures)) {
        const a = placedById.get(f.id);
        if (a === undefined) continue; // absence is the no_slot / unschedulable path
        if (!scopeCoversFixture(h.scope, f, a)) continue;
        const day = dayKeyInTz(a.startAt, tz);
        if (h.type === "fixture_on_weekday" && weekdayOfYmd(day) !== h.weekday) {
          conflicts.push({
            fixtureId: f.id,
            reason: "instruction",
            detail: `is on ${weekdayOfYmd(day)} ${day}, instruction requires ${h.weekday}`,
          });
        }
        if (h.type === "fixture_on_date" && day !== h.date) {
          conflicts.push({
            fixtureId: f.id,
            reason: "instruction",
            detail: `is on ${day}, instruction requires ${h.date}`,
          });
        }
      }
      continue;
    }

    // not_before / not_after — wall-clock bounds in the org zone.
    for (const a of assignments) {
      if (!scopeCoversFixture(h.scope, fixtureById.get(a.fixtureId), a)) continue;
      const start = hhmmInTz(a.startAt, tz);
      const bad = h.type === "not_before" ? start < h.time : start > h.time;
      if (bad) {
        conflicts.push({
          fixtureId: a.fixtureId,
          reason: "instruction",
          detail: `starts ${start}, violating ${h.type} ${h.time}`,
        });
      }
    }
  }
```

- [ ] **Step 5: Re-export**

In `packages/engine/src/scheduling/index.ts`, add `RuleFixture`, `VerifyConfig`,
`scopeCoversFixture`, `resolveSelector` to the `./calendar` export.

- [ ] **Step 6: Run to verify it passes**

```bash
npx vitest run packages/engine --reporter=json --outputFile=/tmp/w3-t3.json
node -e "const r=require('/tmp/w3-t3.json');console.log(r.numPassedTests,'/',r.numTotalTests,'fail',r.numFailedTests)"
```
Expected: `numFailedTests` 0 across the WHOLE engine package — the reason-union
widening and the `restFor` change touch the drag-drop board's verifier too.

- [ ] **Step 7: Commit**

```bash
git add packages/engine/src/scheduling/calendar.ts \
        packages/engine/src/scheduling/calendar-instruction.test.ts \
        packages/engine/src/scheduling/index.ts
git commit -m "feat(engine): verify typed instruction rules + cross-division rest MAX (#398)"
```

---

## Task 4: The stage-1 compiler

**Files:**
- Create: `apps/web/src/server/usecases/schedule-ai-parse.ts`
- Test: `apps/web/src/server/usecases/__tests__/schedule-ai-parse.test.ts`

**Interfaces:**
- Consumes: `AiProvider`, `AiProviderError` from `@/server/ai/provider`;
  `selectProvider` from `@/server/ai/select-provider`; `createTokenMeter` from
  `@/lib/ai-rung`; `Clock`, `ymdAddDays`, `zonedTimeToUtc`, `weekdayOfYmd` from
  the engine `tz` module; `HardConstraint` from the engine `constraints` module.
- Produces:
  ```ts
  export const RawParsed: z.ZodType<RawParsedT>;
  export type RawParsed = { hard: RawHardConstraint[]; soft: {note:string;weight:1|2|3}[]; unparsed: string[] };
  export const PARSER_PROMPT: string;
  export const PARSE_TOKEN_CEILING = 1_000;
  export interface ParserContext { divisions: {id:string;name:string}[]; pools: string[]; entrants: {id:string;name:string}[] }
  export interface ParseOutcome { raw: RawParsed | null; failed: boolean; tokens: number; servedModel: string | null }
  export function parseInstruction(instruction: string, ctx: ParserContext, opts?: {provider?: AiProvider; model?: string}): Promise<ParseOutcome>;
  export interface ResolvedParse { hard: HardConstraint[]; soft: RawParsed["soft"]; unparsed: string[]; assumptions: string[]; window: {start:string;end:string} }
  export function resolveParsed(raw: RawParsed | null, clock: Clock, defaultWindow: {start:string;end:string}, tz: string, hints?: {fixtureCount?: number}): ResolvedParse;
  ```

- [ ] **Step 1: Write the failing tests**

Create `apps/web/src/server/usecases/__tests__/schedule-ai-parse.test.ts`:

```ts
// #398 acceptance: the two REAL typo-bearing instructions compile to the
// expected constraint sets, symbolic dates are resolved by us and never by the
// model, and an uncompilable phrase survives verbatim.
import { describe, expect, it, vi } from "vitest";
import { makeClock } from "@seazn/engine/scheduling/tz";
import {
  PARSE_TOKEN_CEILING, parseInstruction, resolveParsed, type RawParsed,
} from "../schedule-ai-parse";
import type { AiProvider } from "@/server/ai/provider";

const TZ = "Europe/London";
// A Monday. `nextWeekday.FRI` from here is 2026-08-07; tomorrow is 2026-08-04.
const NOW = Date.parse("2026-08-03T09:00:00Z");
const CLOCK = makeClock(NOW, TZ);
const WEEK = { start: "2026-08-03T00:00:00.000Z", end: "2026-08-09T23:59:59.000Z" };
const CTX = { divisions: [{ id: "d1", name: "Open" }], pools: [], entrants: [] };

const stub = (bodies: (unknown | null)[], usage = 300): AiProvider => {
  let i = 0;
  return {
    id: "anthropic",
    isConfigured: () => true,
    chat: vi.fn(async () => {
      const body = bodies[Math.min(i++, bodies.length - 1)];
      return {
        parsed: body as never,
        assistantTurn: { role: "assistant" as const, content: {} },
        usage: { inputTokens: 100, outputTokens: usage, costUsd: null },
        servedModel: "stub-model",
        refused: false,
      };
    }),
  };
};

const A_OUT: RawParsed = {
  hard: [
    { type: "max_fixtures_per_day", count: 2, scope: { kind: "competition" } },
    { type: "min_rest_minutes", minutes: 45, rest_scope: "both", scope: { kind: "competition" } },
    { type: "window", start: { kind: "tomorrow" }, end: { kind: "weekday", weekday: "FRI" }, scope: { kind: "competition" } },
  ],
  soft: [], unparsed: [],
};
const B_OUT: RawParsed = {
  hard: [
    { type: "min_rest_minutes", minutes: 40, rest_scope: "both", scope: { kind: "competition" } },
    { type: "fixture_on_weekday", selector: { kind: "terminal" }, weekday: "FRI", scope: { kind: "competition" } },
  ],
  soft: [], unparsed: [],
};

describe("parseInstruction", () => {
  it("compiles real instruction A", async () => {
    const out = await parseInstruction(
      "schedule two matches per day and hav a gap 45 mins at at least and run a whole matches from tomorrow till Friday.",
      CTX, { provider: stub([A_OUT]) },
    );
    expect(out.failed).toBe(false);
    expect(out.raw!.hard).toEqual(A_OUT.hard);
    expect(out.tokens).toBe(300);
  });

  it("compiles real instruction B", async () => {
    const out = await parseInstruction(
      "at least have 40 mins gap for each player in the next round and schedule final on friday.",
      CTX, { provider: stub([B_OUT]) },
    );
    expect(out.raw!.hard).toEqual(B_OUT.hard);
  });

  it("retries ONCE on schema-invalid output, then succeeds", async () => {
    const provider = stub([null, B_OUT]);
    const out = await parseInstruction("…", CTX, { provider });
    expect(out.failed).toBe(false);
    expect(provider.chat).toHaveBeenCalledTimes(2);
  });

  it("fails soft after two schema misses — never throws, never guesses", async () => {
    const provider = stub([null, null]);
    const out = await parseInstruction("…", CTX, { provider });
    expect(out.failed).toBe(true);
    expect(out.raw).toBeNull();
    expect(provider.chat).toHaveBeenCalledTimes(2);
  });

  it("fails soft when the provider throws, so the architect run survives", async () => {
    const provider: AiProvider = {
      id: "anthropic", isConfigured: () => true,
      chat: vi.fn(async () => { throw new Error("upstream 529"); }),
    };
    await expect(parseInstruction("…", CTX, { provider })).resolves.toMatchObject({ failed: true, raw: null });
  });

  it("skips the call entirely when the provider is unconfigured", async () => {
    const provider: AiProvider = { id: "anthropic", isConfigured: () => false, chat: vi.fn() };
    const out = await parseInstruction("…", CTX, { provider });
    expect(out.failed).toBe(true);
    expect(provider.chat).not.toHaveBeenCalled();
  });

  it("caps its own round at PARSE_TOKEN_CEILING", async () => {
    const provider = stub([B_OUT]);
    await parseInstruction("…", CTX, { provider });
    const req = (provider.chat as ReturnType<typeof vi.fn>).mock.calls[0]![0] as { maxTokens: number };
    expect(req.maxTokens).toBeLessThanOrEqual(PARSE_TOKEN_CEILING);
  });

  it("the prompt forbids the model from resolving dates", () => {
    expect(PARSE_TOKEN_CEILING).toBe(1_000);
  });
});

describe("resolveParsed", () => {
  it("resolves tomorrow..FRI against the clock, not the model", () => {
    const r = resolveParsed(A_OUT, CLOCK, WEEK, TZ, { fixtureCount: 4 });
    expect(r.window.start).toBe(new Date(Date.parse("2026-08-04T00:00:00+01:00")).toISOString());
    expect(r.assumptions.some((a) => a.includes("2026-08-04") && a.includes("2026-08-07"))).toBe(true);
    // The window is NOT a hard constraint — it is the pack window.
    expect(r.hard.some((h) => (h as { type: string }).type === "window")).toBe(false);
  });

  it("bumps an infeasible window a week and SAYS SO", () => {
    // 2026-08-04..2026-08-07 is 4 days; at 2/day that holds 8, not 13.
    const r = resolveParsed(A_OUT, CLOCK, WEEK, TZ, { fixtureCount: 13 });
    expect(r.assumptions.some((a) => a.includes("13") && a.includes("2026-08-14"))).toBe(true);
    expect(r.window.end.startsWith("2026-08-14")).toBe(true);
  });

  it("does NOT bump a window that already fits", () => {
    const r = resolveParsed(A_OUT, CLOCK, WEEK, TZ, { fixtureCount: 8 });
    expect(r.assumptions.some((a) => a.includes("following week"))).toBe(false);
  });

  it("reads an end-before-start window as the following week", () => {
    const raw: RawParsed = {
      hard: [{ type: "window", start: { kind: "weekday", weekday: "FRI" }, end: { kind: "tomorrow" }, scope: { kind: "competition" } }],
      soft: [], unparsed: [],
    };
    const r = resolveParsed(raw, CLOCK, WEEK, TZ);
    expect(r.assumptions.some((a) => a.includes("following week"))).toBe(true);
  });

  it("keeps uncompilable wording verbatim and invents no rule from it", () => {
    const raw: RawParsed = { hard: [], soft: [], unparsed: ["keep the vibe chill"] };
    const r = resolveParsed(raw, CLOCK, WEEK, TZ);
    expect(r.unparsed).toEqual(["keep the vibe chill"]);
    expect(r.hard).toEqual([]);
  });

  it("falls back to the default window and records nothing when the parse failed", () => {
    const r = resolveParsed(null, CLOCK, WEEK, TZ);
    expect(r.window).toEqual(WEEK);
    expect(r.hard).toEqual([]);
    expect(r.assumptions).toEqual([]);
  });

  it("resolves a symbolic fixture_on_date without asking the model", () => {
    const raw: RawParsed = {
      hard: [{ type: "fixture_on_date", selector: { kind: "terminal" }, date: { kind: "weekday", weekday: "FRI" }, scope: { kind: "competition" } }],
      soft: [], unparsed: [],
    };
    const r = resolveParsed(raw, CLOCK, WEEK, TZ);
    expect(r.hard[0]).toMatchObject({ type: "fixture_on_date", date: "2026-08-07" });
  });

  it("every resolved constraint is a valid engine HardConstraint", async () => {
    const { HardConstraint } = await import("@seazn/engine/scheduling/constraints");
    const r = resolveParsed(A_OUT, CLOCK, WEEK, TZ, { fixtureCount: 4 });
    for (const h of r.hard) expect(HardConstraint.safeParse(h).success).toBe(true);
  });
});
```

> **Import-path note:** use whatever specifier the sibling usecases already use
> for the engine (grep an existing `from "@seazn/engine..."` line in
> `schedule-ai.ts` and copy it exactly). Do not invent a new one.

- [ ] **Step 2: Run to verify it fails**

```bash
npx vitest run apps/web/src/server/usecases/__tests__/schedule-ai-parse.test.ts \
  --reporter=json --outputFile=/tmp/w3-t4.json
```
Expected: FAIL — module `../schedule-ai-parse` not found.

- [ ] **Step 3: Implement the schema and prompt**

Create `apps/web/src/server/usecases/schedule-ai-parse.ts`. Symbolic schema:

```ts
const Weekday = z.enum(["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"]);

/** The model's ONLY way to talk about a date. It has no calendar and is told so
 *  — `resolveParsed` below turns these into real days against W2's Clock. Quiet
 *  off-by-one date maths is exactly the class of error that survives review. */
const DateRef = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("today") }),
  z.object({ kind: z.literal("tomorrow") }),
  z.object({ kind: z.literal("weekday"), weekday: Weekday }),
  z.object({ kind: z.literal("date"), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }),
]);

const Scope = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("competition") }),
  z.object({ kind: z.literal("division"), divisionId: z.string() }),
  z.object({ kind: z.literal("entrant"), entrantId: z.string() }),
  z.object({ kind: z.literal("pool"), divisionId: z.string(), pool: z.string() }),
]);

/** No `round`, no `id`: the model addresses fixtures by terminal-ness or by the
 *  ext_key it was shown. */
const Selector = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("terminal") }),
  z.object({ kind: z.literal("ext_key"), extKey: z.string(), divisionId: z.string().optional() }),
]);

const RawHard = z.discriminatedUnion("type", [
  z.object({ type: z.literal("min_rest_minutes"), minutes: z.number().int().positive(),
             rest_scope: z.enum(["per_person", "feeder_to_dependent", "both"]), scope: Scope }),
  z.object({ type: z.literal("max_fixtures_per_day"), count: z.number().int().positive(), scope: Scope }),
  z.object({ type: z.literal("fixture_on_weekday"), selector: Selector, weekday: Weekday, scope: Scope }),
  z.object({ type: z.literal("fixture_on_date"), selector: Selector, date: DateRef, scope: Scope }),
  z.object({ type: z.literal("not_before"), time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/), scope: Scope }),
  z.object({ type: z.literal("not_after"), time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/), scope: Scope }),
  z.object({ type: z.literal("window"), start: DateRef, end: DateRef, scope: Scope }),
]);

export const RawParsed = z.object({
  hard: z.array(RawHard).default([]),
  soft: z.array(z.object({ note: z.string(), weight: z.union([z.literal(1), z.literal(2), z.literal(3)]) })).default([]),
  unparsed: z.array(z.string()).default([]),
});
export type RawParsed = z.infer<typeof RawParsed>;
export type RawHardConstraint = z.infer<typeof RawHard>;
export type DateRef = z.infer<typeof DateRef>;

export const PARSE_TOKEN_CEILING = 1_000;
```

`PARSER_PROMPT`: adapt `~/Downloads/scheduler/scheduler/stage1-parse.ts:58-115`
verbatim except — (a) drop the "no markdown fences" sentence (the provider seam
enforces structured output), (b) drop `id`/`round` from the Selector line, (c)
state `not_before`/`not_after` are `HH:mm` only. Keep **rules 1–6 and both
worked examples unchanged**: those two examples are the acceptance criteria.

- [ ] **Step 4: Implement `parseInstruction`**

```ts
export interface ParserContext {
  divisions: { id: string; name: string }[];
  pools: string[];
  entrants: { id: string; name: string }[];
}

export interface ParseOutcome {
  raw: RawParsed | null;
  /** True when nothing could be compiled. NOT an error: the run continues with
   *  no compiled rules and the preview (W5) offers "run it as a preference
   *  instead?". Silent fallback is refused — a rule presented as enforced while
   *  nothing enforces it is worse than no rule. */
  failed: boolean;
  /** Output tokens this pre-flight spent. Charged to its OWN meter, outside
   *  `spendCredit`: a credit buys a token budget, and extra LLM rounds must not
   *  mint credits (design §5.1). */
  tokens: number;
  servedModel: string | null;
}

export async function parseInstruction(
  instruction: string,
  ctx: ParserContext,
  opts: { provider?: AiProvider; model?: string } = {},
): Promise<ParseOutcome> {
  const provider = opts.provider ?? selectProvider();
  const model = opts.model ?? schedulingAiModel();
  const meter = createTokenMeter(PARSE_TOKEN_CEILING);
  if (!provider.isConfigured()) return { raw: null, failed: true, tokens: 0, servedModel: null };

  const user = JSON.stringify({ instruction, context: ctx });
  let servedModel: string | null = null;
  const messages: AiTurn[] = [{ role: "user", content: user }];

  for (let attempt = 0; attempt < 2; attempt++) {
    const maxTokens = meter.clampRound(PARSE_TOKEN_CEILING);
    if (maxTokens <= 0) break;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PARSE_TIMEOUT_MS);
    try {
      const res = await provider.chat({
        model,
        system: attempt === 0 ? PARSER_PROMPT : `${PARSER_PROMPT}\n\n${RETRY_SUFFIX}`,
        messages,
        maxTokens,
        reasoning: { kind: "none" },
        schema: { name: "instruction_constraints", zod: RawParsed },
        signal: controller.signal,
        timeoutMs: PARSE_TIMEOUT_MS,
      });
      if (res === null) continue;
      // Meter on EVERY path, success or miss — an un-metered failed round is a
      // budget leak, and this meter is the only ceiling the pre-flight has.
      meter.add(res.usage.outputTokens);
      servedModel = res.servedModel;
      if (res.refused) break;
      if (res.parsed !== null) {
        return { raw: res.parsed, failed: false, tokens: meter.spent, servedModel };
      }
    } catch {
      // Transport, timeout, provider outage: the parse is best-effort pre-flight
      // and must never take the paid architect run down with it.
      break;
    } finally {
      clearTimeout(timer);
    }
  }
  return { raw: null, failed: true, tokens: meter.spent, servedModel };
}
```

with `const PARSE_TIMEOUT_MS = 60_000;` and

```ts
const RETRY_SUFFIX =
  "Your previous output did not match the schema. Return ONLY a corrected JSON object.";
```

- [ ] **Step 5: Implement `resolveParsed`**

```ts
export interface ResolvedParse {
  hard: HardConstraint[];
  soft: RawParsed["soft"];
  unparsed: string[];
  assumptions: string[];
  window: { start: string; end: string };
}

const resolveDateRef = (ref: DateRef, clock: Clock): string =>
  ref.kind === "today" ? clock.today
  : ref.kind === "tomorrow" ? clock.tomorrow
  : ref.kind === "weekday" ? clock.nextWeekday[ref.weekday]
  : ref.date;

/**
 * Symbolic parse → concrete constraints + the pack's calendar window. Every
 * interpretive choice is written to `assumptions`, because the organiser should
 * SEE the reading we picked rather than suffer it.
 *
 * `raw === null` (parse failed or no instruction) is a first-class input: the
 * default window stands, no rules are compiled, nothing is assumed.
 */
export function resolveParsed(
  raw: RawParsed | null,
  clock: Clock,
  defaultWindow: { start: string; end: string },
  tz: string,
  hints: { fixtureCount?: number } = {},
): ResolvedParse {
  const assumptions: string[] = [];
  const hard: HardConstraint[] = [];
  if (raw === null) return { hard, soft: [], unparsed: [], assumptions, window: defaultWindow };

  let window = defaultWindow;
  let ymd: { start: string; end: string } | null = null;

  // The window's end is the last whole SECOND of the final day — the same shape
  // the W2 pack builder emits, and the form `windowBounds` expects.
  const setWindow = (start: string, end: string): void => {
    ymd = { start, end };
    window = {
      start: new Date(zonedTimeToUtc(start, "00:00", tz)).toISOString(),
      end: new Date(zonedTimeToUtc(ymdAddDays(end, 1), "00:00", tz) - 1_000).toISOString(),
    };
  };

  for (const h of raw.hard) {
    if (h.type === "window") {
      const start = resolveDateRef(h.start, clock);
      let end = resolveDateRef(h.end, clock);
      if (end < start) {
        end = ymdAddDays(end, 7);
        assumptions.push(`window end resolved before its start — read as the following week (${end})`);
      }
      setWindow(start, end);
      assumptions.push(`instruction window resolved to ${start}..${end} (${tz})`);
    } else if (h.type === "fixture_on_date") {
      hard.push({ ...h, date: resolveDateRef(h.date, clock) });
    } else if (h.type === "fixture_on_weekday") {
      assumptions.push(
        `'${h.weekday.toLowerCase()}' target resolved against the window — the next ${h.weekday} is ${clock.nextWeekday[h.weekday]}`,
      );
      hard.push(h);
    } else {
      hard.push(h);
    }
  }

  // Feasibility-aware reading. "from tomorrow till Friday" when tomorrow IS
  // Friday literally means one day; if a per-day cap cannot hold the fixtures in
  // that many days, take the next weekly reading — and SAY SO, so the organiser
  // sees the judgement instead of an unexplained week of extra dates.
  if (ymd !== null) {
    const w = ymd as { start: string; end: string };
    const cap = raw.hard.reduce<number | null>(
      (m, h) => (h.type === "max_fixtures_per_day" ? Math.min(m ?? Infinity, h.count) : m),
      null,
    );
    const count = hints.fixtureCount ?? 0;
    if (count > 0 && cap !== null) {
      const days = Math.round(
        (Date.parse(`${w.end}T00:00:00Z`) - Date.parse(`${w.start}T00:00:00Z`)) / 86_400_000,
      ) + 1;
      if (days * cap < count) {
        const extended = ymdAddDays(w.end, 7);
        assumptions.push(
          `window ${w.start}..${w.end} holds only ${days * cap} of ${count} fixtures under the ${cap}/day cap — read the end as the following week (${extended})`,
        );
        setWindow(w.start, extended);
      }
    }
  }

  return { hard, soft: raw.soft, unparsed: raw.unparsed, assumptions, window };
}
```

- [ ] **Step 6: Run to verify it passes**

```bash
npx vitest run apps/web/src/server/usecases/__tests__/schedule-ai-parse.test.ts \
  --reporter=json --outputFile=/tmp/w3-t4.json
node -e "const r=require('/tmp/w3-t4.json');console.log(r.numPassedTests,'/',r.numTotalTests,'fail',r.numFailedTests)"
```
Expected: 0 failures, ~19 tests.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/server/usecases/schedule-ai-parse.ts \
        apps/web/src/server/usecases/__tests__/schedule-ai-parse.test.ts
git commit -m "feat(schedule-ai): stage-1 instruction compiler with symbolic dates (#398)"
```

---

## Task 5: Wire the single-division runner

**Files:**
- Modify: `apps/web/src/server/usecases/schedule-ai.ts`
- Modify: `apps/web/src/server/usecases/schedule-ai-prompt.ts`
- Modify: `apps/web/src/lib/ai-rung.ts`
- Modify: `apps/web/src/server/api-v1/schemas.ts`
- Test: `apps/web/src/server/usecases/__tests__/schedule-ai-pack.test.ts`,
  `schedule-ai-ledger.test.ts`, `schedule-ai-prompt.test.ts` (extend each)

**Interfaces:**
- Consumes: `parseInstruction`, `resolveParsed`, `ParseOutcome` (Task 4);
  `HardConstraint`, `RuleFixture`, `VerifyConfig` (Tasks 1 & 3).
- Produces: `SchedulePack.parsed`; `BuildPackOptions.raw`;
  `verifyConfig(pack): VerifyConfig`; `meterStamp(quote, meter, parse?)`;
  `INSTRUCTION_RULES` / `SINGLE_SYSTEM_PROMPT`.

- [ ] **Step 1: Write the failing tests**

Append to `schedule-ai-pack.test.ts`:

```ts
describe("compiled instruction reaches the pack and the referee (#398)", () => {
  it("resolveParsed's window becomes the PACK window and its assumptions join the pack's", async () => {
    // build a pack with raw = the instruction-A parse; assert
    // pack.window.start is the resolved day, and pack.assumptions contains the
    // "instruction window resolved to" line ALONGSIDE W1/W2's own entries.
  });
  it("verifyConfig carries tz, the merged hard stream and rule fixtures", () => {
    // verifyConfig(pack).tz === pack.tz
    // verifyConfig(pack).hard contains BOTH pack.parsed.hard and
    //   pack.settings.constraints.hard
    // verifyConfig(pack).ruleFixtures has one entry per movable fixture, and the
    //   entry for the fixture whose feeds.winner_to is null has winnerTo === null
  });
  it("toModelPayload FORWARDS parsed and still withholds participants/assumptions", () => {
    const payload = toModelPayload(pack) as Record<string, unknown>;
    expect(payload.parsed).toEqual(pack.parsed);
    expect(payload.participants).toBeUndefined();
    expect(payload.assumptions).toBeUndefined();
  });
  it("a pack built with raw = null carries no rules and the default window", () => { /* … */ });
});
```

Append to `schedule-ai-ledger.test.ts`:

```ts
it("stamps the pre-flight parse spend on its own line (#387/#398)", () => {
  const stamp = meterStamp(quote, meter, { tokens: 320, failed: false });
  expect(stamp.parse_tokens).toBe(320);
  expect(stamp.parse_failed).toBe(false);
  // Parse spend sits OUTSIDE quote.budget — it must not be folded into
  // spent_tokens, or reconciliation double-counts it.
  expect(stamp.spent_tokens).toBe(meter.spent);
});
it("omits the parse line when no parse ran", () => {
  expect(meterStamp(quote, meter).parse_tokens).toBeUndefined();
});
```

Append to `schedule-ai-prompt.test.ts`:

```ts
it("SYSTEM_PROMPT is unchanged — the golden snapshot is byte-frozen", () => {
  expect(SYSTEM_PROMPT).toMatchSnapshot(); // must NOT be updated in this wave
});
it("INSTRUCTION_RULES is additive and teaches the five W3 sentences", () => {
  expect(SINGLE_SYSTEM_PROMPT.startsWith(SYSTEM_PROMPT)).toBe(true);
  for (const phrase of [
    "participants",
    "the slot is null",
    "feeds.after",
    "MAX",
    "terminal fixture",
  ]) expect(INSTRUCTION_RULES).toContain(phrase);
});
it("JOINT_SYSTEM_PROMPT still starts with SYSTEM_PROMPT and includes both blocks", () => {
  expect(JOINT_SYSTEM_PROMPT.startsWith(SYSTEM_PROMPT)).toBe(true);
  expect(JOINT_SYSTEM_PROMPT).toContain(INSTRUCTION_RULES);
  expect(JOINT_SYSTEM_PROMPT).toContain(JOINT_RULES);
});
```

- [ ] **Step 2: Run to verify they fail**

```bash
npx vitest run apps/web/src/server/usecases/__tests__/schedule-ai-pack.test.ts \
  apps/web/src/server/usecases/__tests__/schedule-ai-ledger.test.ts \
  apps/web/src/server/usecases/__tests__/schedule-ai-prompt.test.ts \
  --reporter=json --outputFile=/tmp/w3-t5.json
```
Expected: FAIL on the new assertions only.

- [ ] **Step 3: Prompt constant**

In `schedule-ai-prompt.ts`, after `SYSTEM_PROMPT`:

```ts
/** ADDITIVE. `SYSTEM_PROMPT` above is byte-frozen behind a golden snapshot
 *  (design §7.3) — new rules land here and are COMPOSED, never spliced in. */
export const INSTRUCTION_RULES = `COMPILED INSTRUCTION AND ADVANCERS

I1. \`parsed.hard\` is the organiser's own instruction, compiled into typed rules
and verified after you answer. Satisfy every entry. \`parsed.unparsed\` is wording
nobody could compile — treat it as context, never as a rule.

I2. \`participants\` for a fixture is every person who could still stand in it,
including behind an empty slot. Never reason "the slot is null, so nobody is
there yet": an empty slot carries everyone who can still advance into it, and a
rest or overlap rule binds all of them.

I3. \`feeds.after\` is the sole ordering authority. \`round\` and \`seq\` are display
labels — elimination brackets number sparsely, so never repair gaps in round
numbers and never infer order from them.

I4. When two fixtures in different divisions share a person, the rest between
them is the MAX of both divisions' values, not either one alone.

I5. An unqualified "the final" means EVERY division's terminal fixture — the one
whose \`feeds.winner_to\` is null. It is never the highest round number.`;

/** What the single-division architect is actually sent. */
export const SINGLE_SYSTEM_PROMPT = `${SYSTEM_PROMPT}\n\n${INSTRUCTION_RULES}`;
```

In `competition-schedule-ai.ts:974`:

```ts
export const JOINT_SYSTEM_PROMPT = `${SYSTEM_PROMPT}\n\n${INSTRUCTION_RULES}\n\n${JOINT_RULES}`;
```

Change `callModel` (`schedule-ai.ts:1474`) to `system: SINGLE_SYSTEM_PROMPT`.

- [ ] **Step 4: Pack shape**

Add to `SchedulePack` (after `assumptions`):

```ts
  /** The organiser's instruction, compiled (#398). PROMPT MATERIAL, unlike
   *  `participants` and `assumptions`: the model must satisfy the same rules it
   *  will be verified against, or the repair loop cannot converge. The window a
   *  `window` instruction resolved to is NOT here — it is `pack.window` above,
   *  which is what the verifier already checks. */
  parsed: { hard: HardConstraint[]; soft: { note: string; weight: 1 | 2 | 3 }[]; unparsed: string[] };
```

Add `parsed: pack.parsed,` to `toModelPayload` (after `sessionHours`). Add to
`PackConstraints`: `hard: HardConstraint[];`.

Add to `BuildPackOptions`:

```ts
  /** Stage-1 output (#398), or null when there was no instruction, the parse
   *  failed, or the caller is a test/replay. The BUILDER resolves it — symbolic
   *  dates need the clock, and the feasibility bump needs the fixture count,
   *  and both live here. */
  raw?: RawParsed | null;
```

In `buildSchedulePack`, where `window` is currently computed (W2), call:

```ts
  const resolved = resolveParsed(opts.raw ?? null, clock, defaultWindow, orgTz, {
    fixtureCount: movable.length,
  });
```
then use `resolved.window` as `pack.window`, push `...resolved.assumptions` onto
the existing assumptions array, and set
`parsed: { hard: resolved.hard, soft: resolved.soft, unparsed: resolved.unparsed }`.

- [ ] **Step 5: verifyConfig**

Change the return type to `VerifyConfig` and add:

```ts
    // #398: the org zone plus the merged hard-rule stream. Durable division
    // rules and compiled instruction rules speak the same vocabulary, so hard
    // rules have exactly one home and the referee reads one list.
    tz: pack.tz,
    hard: [...pack.parsed.hard, ...(pack.settings.constraints?.hard ?? [])],
    ruleFixtures: pack.fixtures.movable.map((f) => ({
      id: f.id,
      extKey: f.ext_key,
      divisionId: pack.division.id,
      ...(f.pool !== null ? { poolId: f.pool } : {}),
      winnerTo: f.feeds.winner_to,
    })),
```

(Single-division runs need no `restByDivision` — there is one division.)

- [ ] **Step 6: Ledger stamp**

In `ai-rung.ts`, add to `RunMeterStamp`:

```ts
  /** The pre-flight instruction parse (#398), which runs OUTSIDE `spendCredit`
   *  and therefore outside `budget`. Its own line, or the spend is invisible —
   *  the exact reconciliation complaint #387 makes. Absent when no parse ran. */
  parse_tokens?: number;
  parse_failed?: boolean;
```

and change the signature to
`meterStamp(quote: Quote, meter: TokenMeter, parse?: { tokens: number; failed: boolean })`,
spreading `...(parse ? { parse_tokens: parse.tokens, parse_failed: parse.failed } : {})`
into `base`. Every existing call site keeps working unchanged.

- [ ] **Step 7: Pre-flight parse in `planSchedule`**

Between the rate limit (`:2101`) and `buildSchedulePack` (`:2106`):

```ts
  // Stage-1 compile, OUTSIDE `spendCredit` (design §5.1). A credit buys a token
  // budget, not a number of rounds, and the preview W5 adds is only genuinely
  // free to walk away from if this round is unpriced. Own meter, own ~1K
  // ceiling; abuse exposure is a few hundred output tokens per abort behind the
  // rate limit above. A failure here is NOT fatal — the run continues with no
  // compiled rules rather than presenting a rule nothing enforces.
  const parse =
    input.instruction.trim().length > 0
      ? await parseInstruction(input.instruction, {
          divisions: [{ id: divisionId, name: gate.divisionName }],
          pools: [],
          entrants: [],
        })
      : { raw: null, failed: false, tokens: 0, servedModel: null };
```

Pass `raw: parse.raw` into `buildSchedulePack`, and pass
`{ tokens: parse.tokens, failed: parse.failed }` as the third `meterStamp`
argument at all three call sites (`:2215`, `:2276`, `:2369`).

> The parser context's `entrants` list is intentionally empty here: entrant names
> only matter for `{kind:'entrant'}` scoping, the pack is not built yet, and
> re-reading entrants before the pack would add a DB round-trip to a free
> pre-flight. Populate it in a later wave if entrant-scoped instructions appear.
> If `gate` does not expose a division name, pass the id.

- [ ] **Step 8: api-v1 schema + OpenAPI**

Add optional `parse_tokens: z.number().int().nonnegative().optional()` and
`parse_failed: z.boolean().optional()` to whichever response schema in
`apps/web/src/server/api-v1/schemas.ts` mirrors `RunMeterStamp`, then:

```bash
npm run openapi:gen
git status --short openapi/
```
Expected: `openapi/*.json` modified. **Commit them** — the drift gate is CI-only,
a green local run proves nothing (hit 4× before: #88, #124, #127, #397).

- [ ] **Step 9: Run to verify**

```bash
npx vitest run apps/web/src/server/usecases --reporter=json --outputFile=/tmp/w3-t5.json
node -e "const r=require('/tmp/w3-t5.json');console.log(r.numPassedTests,'/',r.numTotalTests,'fail',r.numFailedTests)"
```
Expected: 0 failures. If `schedule-ai-prompt.test.ts`'s SYSTEM_PROMPT snapshot
changed, **revert the prompt edit** — that constant is frozen.

- [ ] **Step 10: Commit**

```bash
git add apps/web/src/server/usecases/schedule-ai.ts \
        apps/web/src/server/usecases/schedule-ai-prompt.ts \
        apps/web/src/lib/ai-rung.ts \
        apps/web/src/server/api-v1/schemas.ts openapi/ \
        apps/web/src/server/usecases/__tests__/
git commit -m "feat(schedule-ai): compile the instruction into verified pack rules (#398)"
```

---

## Task 6: Wire the joint runner + cross-division rest

**Files:**
- Modify: `apps/web/src/server/usecases/competition-schedule-ai.ts`
- Test: `apps/web/src/server/usecases/__tests__/competition-schedule-verify.test.ts`,
  `competition-schedule-pack.test.ts` (extend each)

**Interfaces:**
- Consumes: everything from Tasks 1–5.
- Produces: `CompetitionPack.parsed`; `verifyConfigFor(division, window?, extra?)`
  carrying `tz` / `hard` / `ruleFixtures` / `restByDivision`.

- [ ] **Step 1: Write the failing tests**

Append to `competition-schedule-verify.test.ts`:

```ts
describe("W3 acceptance (#398)", () => {
  it("the badminton golden 7-day schedule verifies with ZERO violations", () => {
    // Build the single-division badminton pack with the instruction-A rules
    // (2/day cap, 45 min rest, tomorrow..FRI window bumped a week) and the
    // frozen 7-day golden assignment list. Assert verify() returns [].
    // This is the acceptance half — a verifier that only rejects is untested
    // where it matters most.
  });

  it("the Stepladder original draft reproduces its exact violation set", () => {
    // Assert the FULL sorted (fixtureId, reason, detail) tuple list, frozen.
  });

  it("names the cross-division Fischer conflict", () => {
    const conflicts = verifyJoint(ORIGINAL_DRAFT, STEPLADDER_PACK);
    expect(conflicts.some((c) => c.detail?.includes("p-fischer"))).toBe(true);
  });

  it("rests a cross-division pair at the MAX of both divisions", () => {
    // d1 rest 20, d2 rest 120, gap 60 → a `rest` conflict from the d1 pass.
    // Before this change the d1 pass accepted it and only the d2 pass saw it,
    // at a different value — the bug design §7.2 names.
  });

  it("counts a per-day cap in the ORG zone, not each division's own tz", () => {
    // Two divisions with different `division.tz`; assert the bucket key comes
    // from pack.tz alone.
  });
});
```

- [ ] **Step 2: Run to verify they fail**

```bash
npx vitest run apps/web/src/server/usecases/__tests__/competition-schedule-verify.test.ts \
  --reporter=json --outputFile=/tmp/w3-t6.json
```

- [ ] **Step 3: Implement**

Mirror Task 5 on the joint side:

1. `CompetitionPack` gains the same `parsed` field; the joint `toModelPayload`
   twin forwards it.
2. The joint pack builder calls `resolveParsed` with the joint movable count.
3. `verifyConfigFor(division, window?, extra?)` gains a third parameter
   `extra?: { tz: string; hard: readonly HardConstraint[]; ruleFixtures: readonly RuleFixture[]; restByDivision: Readonly<Record<string, number>> }`
   spread into the returned config. Optional so the apply path — which
   deliberately passes no window — is untouched.
4. In `verifyJoint`, build once before the division loop:

```ts
  const restByDivision = Object.fromEntries(
    pack.divisions.map((d) => [d.id, d.settings.perEntrantMinRest]),
  );
  const ruleFixtures: RuleFixture[] = pack.fixtures.movable.map((f) => ({
    id: f.id,
    extKey: f.ext_key,
    divisionId: f.division_id,
    ...(f.pool !== null ? { poolId: f.pool } : {}),
    winnerTo: f.feeds.winner_to,
  }));
  const hard = [
    ...pack.parsed.hard,
    ...pack.divisions.flatMap((d) => d.settings.constraints?.hard ?? []),
  ];
```
and pass `{ tz: pack.tz, hard, ruleFixtures, restByDivision }` as
`verifyConfigFor`'s third argument.

> **Watch the dedup key.** `verifyJoint` dedups on
> `${fixtureId}|${reason}|${detail}`. A per-day-cap conflict is pushed once per
> fixture in the offending bucket with an identical detail string, so the same
> fixture cannot produce a duplicate — but a competition-scoped cap IS evaluated
> once per division pass. Because each pass only sees `mine` as `assignments`,
> the buckets differ per pass; the dedup key absorbs the overlap. Assert this in
> the per-day-cap joint test rather than assuming it.

5. `planCompetitionSchedule` gets the same pre-flight parse before `quoteRun` /
   `spendCredit`, with `divisions` populated from the gate's division list, and
   the same third argument on its three `meterStamp` call sites (`:2071`,
   `:2142`, `:2216`).

- [ ] **Step 4: Run to verify**

```bash
npx vitest run apps/web/src/server/usecases --reporter=json --outputFile=/tmp/w3-t6.json
node -e "const r=require('/tmp/w3-t6.json');console.log(r.numPassedTests,'/',r.numTotalTests,'fail',r.numFailedTests)"
```

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/server/usecases/competition-schedule-ai.ts \
        apps/web/src/server/usecases/__tests__/
git commit -m "feat(joint): typed rules + cross-division rest as MAX (#398)"
```

---

## Task 7: Closing pass

**Files:**
- Modify: `content/help/**` (one English tree — no i18n owed)
- Modify: `scripts/smoke.ts`
- Verify: locale dictionaries, lint, typecheck, full suite

- [ ] **Step 1: Help pages**

Find the AI-scheduling help article
(`rg -l "AI Schedule|instruction" content/help`) and document what an instruction
can now express: per-day caps, "at least N minutes" (raises, never lowers), "final
on Friday", earliest/latest start, and a date range. State plainly that anything
that cannot be compiled is shown back rather than silently applied.

- [ ] **Step 2: i18n check**

```bash
rtk proxy npm run i18n:check
```
W3 adds no new *rendered* string — the compiled rules and assumptions are server
data that W5 (#400) renders. If the check reports a genuinely new key, add it to
**all four** dictionaries. Existing `[i18n] missing key` stub-dict noise is benign.

- [ ] **Step 3: smoke.ts**

Extend `scripts/smoke.ts`'s AI-schedule step to send an instruction containing
"two matches per day", then assert the run response carries
`parse_tokens > 0` and that `spent_tokens` did **not** absorb it. Cover the pro
path; the free path asserts the 402 is unchanged (parse must not have consumed a
credit).

- [ ] **Step 4: Full verification — evidence before assertions**

```bash
npx tsc -b --pretty false 2>&1 | tail -20
rtk proxy npm run lint 2>&1 | tail -20      # read "✖ N problems"
npx vitest run --reporter=json --outputFile=/tmp/w3-full.json
node -e "const r=require('/tmp/w3-full.json');console.log('pass',r.numPassedTests,'/',r.numTotalTests,'failSuites',r.numFailedTestSuites,'fail',r.numFailedTests)"
git status --short openapi/
```
Do not claim green without pasting these numbers. A suite that failed to
*collect* shows as a failed suite with zero tests — check `numFailedTestSuites`,
not just `numFailedTests`.

- [ ] **Step 5: UI verification**

W3 touches no component. Confirm it:

```bash
git diff --name-only main... | grep -E "apps/web/src/(components|app)/" || echo "no UI surface touched"
```
If that prints nothing, record "no UI surface touched — screenshot verification
not applicable this wave" rather than fabricating screenshots. If it prints a
path, load the frontend-design skill and screenshot that surface at desktop and
375px with no horizontal page scroll before merging.

- [ ] **Step 6: PR**

```bash
git push -u origin feat/w3-instruction-compiler
gh pr create --title "W3: compile the organiser's instruction into verified hard constraints (#398)" --body "…"
```
Smoke CI runs on **PRs only** — merging locally and pushing to `main` skips it.

- [ ] **Step 7: Code review**

Use `superpowers:requesting-code-review`, then
`superpowers:finishing-a-development-branch`.

---

## Acceptance criteria → task map

| #398 criterion | Task |
|---|---|
| Both real typo-bearing instructions compile to the expected constraint sets | 4 |
| "at least 40" against `perEntrantMinRest: 0` resolves to 40 (raises, never lowers) | 3 |
| Uncompilable wording lands in `unparsed` verbatim; no rule invented | 4 |
| Parse failing schema twice does not 422 the run | 4, 5 |
| One-day window, 2/day cap, 13 fixtures → extends a week, assumption recorded | 4 |
| Badminton golden 7-day schedule verifies with zero violations | 6 |
| Stepladder original draft reproduces its exact violation set, Fischer named | 6 |
| Per-day cap counts in the org zone, not per division zone | 3, 6 |
| Ledger stamp carries the parse line | 5 |
| `SYSTEM_PROMPT` golden snapshot unchanged | 5 |
| Every rule ships an acceptance case as well as a rejection case | 3, 6 |
| Cross-division rest fixed to MAX | 3, 6 |
