// #449 — ONE pool namespace at the engine boundary.
//
// `Assignment.poolId` used to be a pool UUID on the board path and a pool KEY
// ('A', 'B') on the AI path, and `RuleFixture.poolId` carried the key on both.
// `scopeCoversFixture` reads `f?.poolId ?? a.poolId`, so the RuleFixture value
// MASKS the assignment's — meaning that whatever namespace an organiser's
// stored rule was authored in, at most ONE of the two paths could ever bind it.
// The same split reached `effectiveRestMinutes`' `restByGroup` lookup, which is
// keyed on the same field.
//
// The UUID is canonical: it is what the board path already used, what the DB
// stores, and what `restByGroup` keys are authored against. A pool key is
// display metadata and is not even unique across divisions.
//
// WHY THIS FILE COMPARES TWO PATHS RATHER THAN ASSERTING ONE. A namespace split
// is invisible from inside either half — each is self-consistent, and a test
// that hands the engine two equal strings passes while proving nothing. Only
// running the SAME division, the SAME stored rules and the SAME board through
// both real builders and demanding the same verdict can catch it. So every
// assertion below is a comparison, and the fixed values are only there to stop
// "both paths report nothing" from counting as agreement.
import { describe, expect, it } from "vitest";
import {
  makeClock,
  validateAssignments,
  type Conflict,
} from "@seazn/engine/scheduling";
import { ScheduleConfig } from "@/server/api-v1/schemas";
import {
  toAssignment,
  toVerifyConfig,
  type FixtureLite,
  type ScheduleSettingsOut,
} from "../schedule";
import type { AiSchedulePlan } from "../schedule-ai-prompt";
import {
  toEngineAssignments,
  toModelPayload,
  verifyConfig,
  type SchedulePack,
} from "../schedule-ai";

const MIN = 60_000;
const T0 = Date.parse("2026-08-10T09:00:00.000Z");
const iso = (t: number) => new Date(t).toISOString();

const DIV_A = "11111111-1111-4111-8111-111111111111";
/** What the DB stores and what `fixtures.pool_id` holds. */
const POOL_A_ID = "22222222-2222-4222-8222-222222222222";
/** What `pools.key` holds and what the MODEL is shown as `PackFixture.pool`. */
const POOL_A_KEY = "A";

// One day, two fixtures in pool A sharing entrant e1, 40 minutes apart. Both a
// 180-minute pool rest and a 1/day pool cap are breached — by a wide margin, so
// neither verdict turns on an off-by-one.
const F1 = "f-1";
const F2 = "f-2";

/** The stored constraints, authored against the pool UUID — the namespace the
 *  console writes and the DB holds. */
const storedConstraints = (poolRef: string) => ({
  restByGroup: { [poolRef]: 180 },
  hard: [
    {
      type: "max_fixtures_per_day" as const,
      count: 1,
      scope: { kind: "pool" as const, divisionId: DIV_A, pool: poolRef },
    },
  ],
});

// --- the board path ---------------------------------------------------------

function row(over: Partial<FixtureLite> = {}): FixtureLite {
  return {
    id: F1,
    stage_id: "s-1",
    division_id: DIV_A,
    pool_id: POOL_A_ID,
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

const ROWS: FixtureLite[] = [
  row(),
  row({
    id: F2,
    seq_in_round: 1,
    away_entrant_id: "e3",
    scheduled_at: iso(T0 + 80 * MIN),
    court_label: "Court 2",
  }),
];

function settings(constraints: Record<string, unknown>): ScheduleSettingsOut {
  return {
    division_id: DIV_A,
    config: ScheduleConfig.parse({
      startAt: iso(T0),
      matchMinutes: 40,
      gapMinutes: 0,
      courts: ["Court 1", "Court 2"],
      perEntrantMinRest: 30,
      constraints,
    }),
    tz: "UTC",
    orgTz: "UTC",
    updated_at: iso(T0),
  };
}

function boardConflicts(poolRef: string): Conflict[] {
  const config = toVerifyConfig(settings(storedConstraints(poolRef)), ROWS, 0);
  const assignments = ROWS.map((r) => toAssignment(r, 40, new Map()));
  // `validateAssignments` runs `validateInstructionRules` itself, so this one
  // call covers both the `restByGroup` lookup and the pool-scoped day cap.
  return validateAssignments(assignments, config);
}

// --- the single-division AI path --------------------------------------------

function pack(poolRef: string): SchedulePack {
  const c = storedConstraints(poolRef);
  return {
    mode: "generate",
    division: { id: DIV_A, name: "Div A", sport: "generic", tz: "UTC" },
    tz: "UTC",
    clock: makeClock(T0, "UTC"),
    window: { start: "2026-08-10", end: "2026-08-17" },
    sessionHours: { start: "08:00", end: "22:00" },
    settings: {
      matchMinutes: 40,
      gapMinutes: 0,
      perEntrantMinRest: 30,
      courts: ["Court 1", "Court 2"],
      sessionWindows: [],
      blackouts: [],
      constraints: {
        noBackToBack: false,
        startWindows: [],
        fieldFairness: "off",
        parallelism: "mixed",
        crossPersonClash: "warn",
        restByGroup: c.restByGroup,
        hard: c.hard,
      },
    },
    entrants: [],
    people: [],
    participants: { [F1]: [], [F2]: [] },
    // THE POINT OF THE FIX. The model-facing `pool` below stays the KEY — the
    // prompts read it and it is a wire shape — and the UUID rides here, where
    // only the server sees it. `toModelPayload` omits this field for the same
    // reason it omits `participants`.
    poolIds: { [F1]: POOL_A_ID, [F2]: POOL_A_ID },
    assumptions: [],
    parsed: { hard: [], soft: [], unparsed: [] },
    fixtures: {
      movable: [
        {
          id: F1,
          ext_key: null,
          round: 0,
          seq: 0,
          pool: POOL_A_KEY,
          home: "e1",
          away: "e2",
          feeds: { winner_to: null, after: [] },
          current: { at: null, court: null },
          pinned: false,
        },
        {
          id: F2,
          ext_key: null,
          round: 0,
          seq: 1,
          pool: POOL_A_KEY,
          home: "e1",
          away: "e3",
          feeds: { winner_to: null, after: [] },
          current: { at: null, court: null },
          pinned: false,
        },
      ],
      obstacles: [],
    },
    draft: [],
    instruction: "",
    prior: null,
    officials: [],
  };
}

const PLAN: AiSchedulePlan = {
  assignments: [
    { fixture_id: F1, scheduled_at: iso(T0), court_label: "Court 1" },
    { fixture_id: F2, scheduled_at: iso(T0 + 80 * MIN), court_label: "Court 2" },
  ],
  unschedulable: [],
  explanations: [],
  summary: "",
};

function aiConflicts(poolRef: string): Conflict[] {
  const p = pack(poolRef);
  const config = verifyConfig(p);
  const assignments = toEngineAssignments(PLAN, p);
  return validateAssignments(assignments, config);
}

const tally = (cs: Conflict[]) =>
  [...cs].map((c) => `${c.fixtureId}|${c.reason}`).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

describe("one pool namespace across the engine boundary (#449)", () => {
  it("the AI path stamps the pool UUID on its assignments, as the board path does", () => {
    // Asserted directly so a regression fails here with a readable message and
    // not only through a verdict two functions away.
    expect(toEngineAssignments(PLAN, pack(POOL_A_ID))[1]!.poolId).toBe(POOL_A_ID);
    expect(toAssignment(ROWS[1]!, 40, new Map()).poolId).toBe(POOL_A_ID);
  });

  it("keeps the model-facing PackFixture.pool as the display KEY", () => {
    // The prompts read this field and it is a wire shape. Carrying the uuid must
    // not have been done by renaming it.
    expect(pack(POOL_A_ID).fixtures.movable[0]!.pool).toBe(POOL_A_KEY);
  });

  it("a pool-scoped rule and a pool-targeted rest bind IDENTICALLY on both paths", () => {
    const board = boardConflicts(POOL_A_ID);
    const ai = aiConflicts(POOL_A_ID);

    // The comparison that catches a namespace split. Everything else in this
    // test only proves the comparison is not vacuous.
    expect(tally(ai)).toEqual(tally(board));

    // Not vacuous: BOTH rules actually fire. `rest` is the `restByGroup` lookup
    // in `effectiveRestMinutes`; `instruction` is the pool-scoped day cap
    // resolved through `scopeCoversFixture`, where a RuleFixture's poolId masks
    // the assignment's.
    expect(board.map((c) => c.reason)).toContain("rest");
    expect(board.map((c) => c.reason)).toContain("instruction");
    // Two fixtures over a 1/day cap, both movable, so both are reported.
    expect(board.filter((c) => c.reason === "instruction")).toHaveLength(2);
    expect(ai.filter((c) => c.reason === "instruction")).toHaveLength(2);
  });

  it("a rule authored against the pool KEY binds on NEITHER path", () => {
    // The guard the assertion above needs. "One namespace" must mean the uuid on
    // both sides — a builder that matched the key as well would satisfy the
    // equality test while leaving two namespaces live.
    expect(boardConflicts(POOL_A_KEY).map((c) => c.reason)).not.toContain("instruction");
    expect(aiConflicts(POOL_A_KEY).map((c) => c.reason)).not.toContain("instruction");
    expect(boardConflicts(POOL_A_KEY).map((c) => c.reason)).not.toContain("rest");
    expect(aiConflicts(POOL_A_KEY).map((c) => c.reason)).not.toContain("rest");
  });

  it("the pool uuid stays off the fixture rows the model reads", () => {
    // `poolIds` is a server-side enforcement input like `participants`, not
    // prompt material: the model schedules by pool LABEL and has no use for a
    // uuid. Scoped to `fixtures` on purpose — `settings.constraints` genuinely
    // does carry pool uuids on the wire (a stored `restByGroup` key, a stored
    // rule's scope), and that predates this change.
    const payload = toModelPayload(pack(POOL_A_ID)) as Record<string, unknown>;
    expect("poolIds" in payload).toBe(false);
    expect(JSON.stringify(payload.fixtures)).not.toContain(POOL_A_ID);
    expect(JSON.stringify(payload.fixtures)).toContain(`"pool":"${POOL_A_KEY}"`);
  });
});
