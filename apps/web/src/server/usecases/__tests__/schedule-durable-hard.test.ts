// #447 — a durable `constraints.hard` rule must reach the verifier on the board
// paths, not only on the AI one.
//
// WHAT THE DEFECT WAS. `toSlotConfig` copied every field of the durable
// `constraints` object except `hard`, and a `SlotConfig` is structurally
// assignable to a `VerifyConfig` with `tz`, `hard`, `ruleFixtures` and
// `restByDivision` all `undefined`. So all four board call sites handed
// `validateAssignments` a config that type-checked perfectly and carried no
// typed rule at all. `effectiveHard`'s own docstring calls a rule that binds on
// one entry point and not the other "the worst kind".
//
// WHY THESE TESTS BUILD THE CONFIG WITH THE REAL BUILDER. The engine suite
// already proves the verifier honours `hard`: `calendar-instruction.test.ts`
// hand-writes `hard: [...]` into a `VerifyConfig` literal. That literal is
// exactly what the product never produced — it bypasses the one function that
// dropped the field — so a literal-based test here would score zero. Everything
// below goes through `ScheduleConfig.parse` (the durable schema, the same one
// `loadSettings` uses on the stored jsonb) and then through `toVerifyConfig`.
//
// No database: every builder under test is pure. The DB round trip through
// `putScheduleSettings` and the four surfaces lives in
// `schedule-durable-hard-surfaces.test.ts`.
import { describe, expect, it } from "vitest";
import { validateAssignments, type VerifyConfig } from "@seazn/engine/scheduling";
import { ScheduleConfig } from "@/server/api-v1/schemas";
import {
  rowToRuleFixture,
  toAssignment,
  toSlotConfig,
  toVerifyConfig,
  type FixtureLite,
  type ScheduleSettingsOut,
} from "../schedule";

const MIN = 60_000;
const T0 = Date.parse("2026-08-10T09:00:00.000Z");
const iso = (t: number) => new Date(t).toISOString();

const DIV_A = "11111111-1111-4111-8111-111111111111";
const DIV_B = "44444444-4444-4444-8444-444444444444";
const POOL_A = "22222222-2222-4222-8222-222222222222";
const F1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const F2 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";

// A fixtures row exactly as `FIXTURE_LITE_COLS` selects it.
function row(over: Partial<FixtureLite> = {}): FixtureLite {
  return {
    id: F1,
    stage_id: "s-1",
    division_id: DIV_A,
    pool_id: POOL_A,
    round_no: 0,
    seq_in_round: 0,
    ext_key: null,
    home_entrant_id: "e1",
    away_entrant_id: "e2",
    scheduled_at: iso(T0),
    court_label: "Court 1",
    venue: null,
    status: "scheduled",
    schedule_locked: false,
    winner_to_fixture: null,
    loser_to_fixture: null,
    ...over,
  };
}

// Settings as `loadSettings` returns them: the config parsed by the REAL zod
// schema, so what the runtime stores in `schedule_settings.config` is what is
// under test — including the `hard` array, which is what #447 is about.
function settings(constraints: Record<string, unknown>): ScheduleSettingsOut {
  return {
    division_id: DIV_A,
    config: ScheduleConfig.parse({
      startAt: iso(T0),
      matchMinutes: 40,
      gapMinutes: 0,
      courts: ["Court 1", "Court 2"],
      perEntrantMinRest: 0,
      constraints,
    }),
    displayTz: "UTC",
    orgTz: "UTC",
    updated_at: iso(T0),
  };
}

const people = new Map<string, string[]>();
const reasons = (c: readonly { reason: string }[]) => c.map((x) => x.reason);

describe("the durable hard-rule seam (#447)", () => {
  const NOT_BEFORE_TEN = { type: "not_before", time: "10:00", scope: { kind: "competition" } };

  it("toSlotConfig carries the durable rules the copy used to drop", () => {
    const s = settings({ hard: [NOT_BEFORE_TEN] });
    // Asserted on the builder itself, not only through a verdict: this is the
    // exact field that was missing, and a future drop should fail here with a
    // readable message rather than as a silent absence of conflicts.
    expect(toSlotConfig(s, 0).constraints?.hard).toEqual([NOT_BEFORE_TEN]);
  });

  it("leaves `hard` absent when the organiser stored none", () => {
    // `.optional()`, never `.default([])` — the schema says so, and every
    // `toSlotConfig` literal the rest of the suite compares against depends on it.
    expect("hard" in (toSlotConfig(settings({}), 0).constraints ?? {})).toBe(false);
  });

  it("toVerifyConfig adds the two fields a SlotConfig cannot express", () => {
    const s = settings({ hard: [NOT_BEFORE_TEN] });
    const cfg = toVerifyConfig(s, [row()], 0);
    expect(cfg.constraints?.hard).toEqual([NOT_BEFORE_TEN]);
    // The ORG zone (#397), never the division's display override.
    expect(cfg.tz).toBe("UTC");
    expect(cfg.ruleFixtures).toEqual([
      { id: F1, extKey: null, divisionId: DIV_A, poolId: POOL_A, winnerTo: null },
    ]);
  });

  it("binds a durable wall-clock rule through the real builders", () => {
    const s = settings({ hard: [NOT_BEFORE_TEN] });
    const a = toAssignment(row(), 40, people);
    // 09:00 in the org zone, against a 10:00 floor.
    expect(reasons(validateAssignments([a], toVerifyConfig(s, [row()], 0)))).toContain("instruction");
  });

  it("stays silent when the same rule is satisfied", () => {
    // Guard the guard: without this, an adapter that reported "instruction"
    // unconditionally would satisfy every assertion above.
    const s = settings({ hard: [{ type: "not_before", time: "08:00", scope: { kind: "competition" } }] });
    const a = toAssignment(row(), 40, people);
    expect(reasons(validateAssignments([a], toVerifyConfig(s, [row()], 0)))).not.toContain("instruction");
  });

  it("stays silent when the rule is scoped to a different division", () => {
    const s = settings({
      hard: [{ type: "not_before", time: "10:00", scope: { kind: "division", divisionId: DIV_B } }],
    });
    const a = toAssignment(row(), 40, people);
    expect(reasons(validateAssignments([a], toVerifyConfig(s, [row()], 0)))).not.toContain("instruction");
  });
});

// The trap that would have made the whole fix a no-op that passes review.
describe("the tz dependency (#447)", () => {
  const s = settings({
    hard: [{ type: "max_fixtures_per_day", count: 1, scope: { kind: "competition" } }],
  });
  const rows = [row({ id: F1 }), row({ id: F2, court_label: "Court 2", home_entrant_id: "e3", away_entrant_id: "e4" })];
  const assignments = rows.map((r) => toAssignment(r, 40, people));

  it("binds the day cap when the org zone is carried", () => {
    expect(reasons(validateAssignments(assignments, toVerifyConfig(s, rows, 0)))).toContain("instruction");
  });

  // DOCUMENTATION, NOT REGRESSION COVER. The next two hand-degrade a config and
  // assert an absence, so they pass with the source fix fully reverted — they
  // cannot fail for the bug this file exists for. They are here to state WHY
  // `toVerifyConfig` carries what it carries, so the next reader does not
  // "simplify" it back to `toSlotConfig`. The test above ("binds the day cap
  // when the org zone is carried") is the one with teeth; do not count these
  // two as proof of anything.
  it("SKIPS every typed rule when the zone is absent — the documented behaviour", () => {
    // `validateInstructionRules` wraps its entire block in `if (tz !== undefined)`
    // on purpose: a day boundary bucketed in UTC would report a violation the
    // organiser never expressed. Which is why carrying `hard` WITHOUT `tz` is a
    // fix that binds nothing, ships, and looks correct in review.
    const noTz: VerifyConfig = { ...toVerifyConfig(s, rows, 0), tz: undefined };
    expect(reasons(validateAssignments(assignments, noTz))).not.toContain("instruction");
  });

  it("is exactly what a bare toSlotConfig cannot supply", () => {
    // The pre-fix shape, pinned: a SlotConfig is assignable to VerifyConfig with
    // tz/ruleFixtures undefined, so even a toSlotConfig that DOES carry `hard`
    // reports nothing. Half a fix is no fix.
    expect(reasons(validateAssignments(assignments, toSlotConfig(s, 0)))).not.toContain("instruction");
  });
});

// The half of `min_rest_minutes` that needs `ruleFixtures`, and the half that
// does not. Both are durable rules; only one is reported as "instruction".
describe("durable min_rest_minutes across a feed edge (#447)", () => {
  // f-1 feeds f-2 by a winner feed. Disjoint entrants on separate courts, so the
  // feed edge is the only thing in play — no rest pair, no court clash.
  const feeder = row({ id: F1, winner_to_fixture: F2, ext_key: "SF1" });
  const dependent = row({
    id: F2,
    ext_key: "F",
    court_label: "Court 2",
    home_entrant_id: "e3",
    away_entrant_id: "e4",
    scheduled_at: iso(T0 + 60 * MIN), // 20 min after the feeder's 09:40 finish
  });
  const rows = [feeder, dependent];
  const assignments = rows.map((r) => toAssignment(r, 40, people));
  const s = settings({
    hard: [
      {
        type: "min_rest_minutes",
        minutes: 60,
        rest_scope: "feeder_to_dependent",
        scope: { kind: "competition" },
      },
    ],
  });

  it("reports the short turnaround the feed edge owes", () => {
    const conflicts = validateAssignments(assignments, toVerifyConfig(s, rows, 0));
    const instruction = conflicts.filter((c) => c.reason === "instruction");
    expect(instruction).toHaveLength(1);
    expect(instruction[0]!.fixtureId).toBe(F2);
    expect(instruction[0]!.detail).toContain("20 min after its feeder");
  });

  it("binds nothing without ruleFixtures — the join has no left side", () => {
    // DOCUMENTATION, NOT REGRESSION COVER — same shape as the two in the tz
    // block: it degrades a config and asserts an absence, so it cannot fail for
    // this bug. The teeth are in "reports the short turnaround the feed edge
    // owes" above; this only records WHY `ruleFixtures` is load-bearing.
    //
    // The feeder→dependent loop iterates `ruleFixtures`; `assignments` carry no
    // feed edge at all. So this half of the rule is the one that proves the
    // fixtures actually reached the verifier, rather than the zone alone.
    const noFixtures: VerifyConfig = { ...toVerifyConfig(s, rows, 0), ruleFixtures: undefined };
    expect(reasons(validateAssignments(assignments, noFixtures))).not.toContain("instruction");
  });

  it("joins the feed edge on the fixture id, never the ext key", () => {
    // #443's namespace tripwire, on the row adapter this issue added. `extKey`
    // is nullable text; `winnerTo` is a uuid FK to `fixtures.id`. `RuleFixture`
    // types both `string | null`, so a swap type-checks and then silently
    // resolves nothing.
    const rf = rows.map(rowToRuleFixture);
    const ids = new Set(rf.map((f) => f.id));
    const extKeys = new Set(rf.map((f) => f.extKey).filter((k): k is string => k !== null));
    expect([...ids].some((id) => extKeys.has(id))).toBe(false);
    const feeds = rf.filter((f) => f.winnerTo !== null);
    expect(feeds).toHaveLength(1);
    expect(ids.has(feeds[0]!.winnerTo!)).toBe(true);
    expect(extKeys.has(feeds[0]!.winnerTo!)).toBe(false);
  });

  it("raises the PAIR rest bound for a per_person rule, with no zone needed", () => {
    // The issue's own example. This half never reaches
    // `validateInstructionRules` — it is folded into `pairRestMinutesWith` so one
    // short gap is reported once as `rest`, not twice — and it therefore binds
    // off `constraints.hard` ALONE, with no tz and no ruleFixtures. Carrying the
    // field is the whole fix for this half.
    const perPerson = settings({
      hard: [
        {
          type: "min_rest_minutes",
          minutes: 120,
          rest_scope: "per_person",
          scope: { kind: "competition" },
        },
      ],
    });
    // Same entrant, 45 minutes apart: clears the 0-minute default, breaches 120.
    const first = toAssignment(row({ id: F1 }), 40, people);
    const second = toAssignment(
      row({ id: F2, court_label: "Court 2", scheduled_at: iso(T0 + 85 * MIN) }),
      40,
      people,
    );
    expect(second.startAt - first.endAt).toBe(45 * MIN);
    expect(reasons(validateAssignments([second], toVerifyConfig(perPerson, rows, 0), [first]))).toContain("rest");
    // And it is the durable rule doing it, not the settings tab.
    expect(reasons(validateAssignments([second], toVerifyConfig(settings({}), rows, 0), [first]))).not.toContain("rest");
  });
});
