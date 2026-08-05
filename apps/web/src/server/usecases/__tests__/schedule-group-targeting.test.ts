// #446 — pool- and division-targeted rules must survive the apps/web adapters.
//
// `constraints.restByGroup` and `constraints.startWindows` target a POOL or a
// DIVISION. The engine resolves both off two fields on the row being judged:
// `SchedulableFixture.poolId`/`divisionId` in the placer, and
// `Assignment.poolId`/`divisionId` in the verifier. Every apps/web adapter
// stamped the first pair and dropped the second, so a pool rule bound for
// Auto-schedule and evaporated the moment the same board was verified — a
// dragged card, an apply gate, an AI proposal.
//
// WHY THESE TESTS BUILD NOTHING BY HAND. The engine's own suite already proves
// the verifier honours `restByGroup` when the field is present: it hand-stamps
// `{ poolId: "p1" }` onto an `Assignment` literal (calendar-windows.test.ts).
// That literal is exactly what the product never produced. So every assertion
// below runs a REAL apps/web adapter over a REAL row shape and asserts on what
// `validateAssignments` then says. A literal here would score zero.
//
// No database: every adapter under test is pure (row/pack in, Assignment out),
// and the config comes from `toSlotConfig`/`verifyConfig`, the same builders the
// runtime uses.
import { describe, expect, it } from "vitest";
import { makeClock, validateAssignments } from "@seazn/engine/scheduling";
import { ScheduleConfig } from "@/server/api-v1/schemas";
import { toAssignment, toSlotConfig, type FixtureLite, type ScheduleSettingsOut } from "../schedule";
import type { AiSchedulePlan } from "../schedule-ai-prompt";
import { toEngineAssignments, verifyConfig, type SchedulePack } from "../schedule-ai";

const MIN = 60_000;
const T0 = Date.parse("2026-08-10T09:00:00.000Z");
const iso = (t: number) => new Date(t).toISOString();

const DIV_A = "11111111-1111-4111-8111-111111111111";
const POOL_A = "22222222-2222-4222-8222-222222222222";
/** What `pools.key` holds — the display label `PackFixture.pool` carries (#449). */
const POOL_A_KEY = "A";

// A fixtures row exactly as `FIXTURE_LITE_COLS` selects it.
function row(over: Partial<FixtureLite> = {}): FixtureLite {
  return {
    id: "f-1",
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

// Settings as `loadSettings` returns them — the config parsed by the real zod
// schema, so the defaults the runtime applies are the defaults under test.
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

const people = new Map<string, string[]>();

describe("pool-targeted rules through the board adapters (#446)", () => {
  // The issue's exact scenario: a 180-minute pool rest, a 30-minute default, and
  // a card sitting 40 minutes after its poolmate. Before the fix `toAssignment`
  // emitted no `poolId`, `effectiveRestMinutes` fell through to the 30, and the
  // organiser's move was accepted with no badge.
  it("a pool-targeted restByGroup binds on an assignment built by toAssignment", () => {
    const s = settings({ restByGroup: { [POOL_A]: 180 } });
    const config = toSlotConfig(s, 0);
    const first = toAssignment(row({ id: "f-1" }), 40, people);
    const dragged = toAssignment(
      row({ id: "f-2", home_entrant_id: "e1", away_entrant_id: "e3", scheduled_at: iso(T0 + 80 * MIN) }),
      40,
      people,
    );
    // The adapter must carry the group identity at all — asserted directly so a
    // future drop fails here with a readable message and not only via a verdict.
    expect(dragged.poolId).toBe(POOL_A);
    expect(dragged.divisionId).toBe(DIV_A);

    // 40 minutes of rest: clears the 30-minute default, breaches the 180.
    expect(dragged.startAt - first.endAt).toBe(40 * MIN);
    const conflicts = validateAssignments([dragged], config, [first]);
    expect(conflicts.map((c) => c.reason)).toContain("rest");
  });

  // Same board, same adapter, but the rule is keyed by DIVISION and the fixture
  // is in NO pool — the non-joint path, which had zero coverage (the only
  // division-keyed test in the suite runs the joint verifier).
  it("a division-targeted restByGroup binds on the non-joint path", () => {
    const s = settings({ restByGroup: { [DIV_A]: 180 } });
    const config = toSlotConfig(s, 0);
    const first = toAssignment(row({ id: "f-1", pool_id: null }), 40, people);
    const dragged = toAssignment(
      row({
        id: "f-2",
        pool_id: null,
        home_entrant_id: "e1",
        away_entrant_id: "e3",
        scheduled_at: iso(T0 + 80 * MIN),
      }),
      40,
      people,
    );
    // A null pool omits the key rather than setting it to undefined — the
    // convention `SchedulableFixture` already uses, and what keeps
    // `restByGroup[undefined]` from ever being asked for.
    expect("poolId" in dragged).toBe(false);
    expect(dragged.divisionId).toBe(DIV_A);
    expect(validateAssignments([dragged], config, [first]).map((c) => c.reason)).toContain("rest");
  });

  // The other half of the same defect: `startWindows` targets a pool too, and
  // `startWindowFor` returns (-inf, +inf) for an assignment with no `poolId`.
  // That unbounded answer is also what emptied the repair solver's
  // `start_window` family, since `repair-domain` clips to the same call.
  it("a pool-targeted startWindow binds on an assignment built by toAssignment", () => {
    const s = settings({
      startWindows: [{ target: { kind: "pool", id: POOL_A }, notAfter: iso(T0 + 120 * MIN) }],
    });
    const config = toSlotConfig(s, 0);
    const late = toAssignment(row({ id: "f-3", scheduled_at: iso(T0 + 300 * MIN) }), 40, people);
    expect(validateAssignments([late], config).map((c) => c.reason)).toContain("start_window");
  });

  // A rule keyed on a DIFFERENT pool must stay silent. Without this the two
  // tests above are satisfied by an adapter that stamps any non-empty string.
  it("a rule keyed on another pool does not bind", () => {
    const s = settings({ restByGroup: { "33333333-3333-4333-8333-333333333333": 180 } });
    const config = toSlotConfig(s, 0);
    const first = toAssignment(row({ id: "f-1" }), 40, people);
    const dragged = toAssignment(
      row({ id: "f-2", home_entrant_id: "e1", away_entrant_id: "e3", scheduled_at: iso(T0 + 80 * MIN) }),
      40,
      people,
    );
    expect(validateAssignments([dragged], config, [first]).map((c) => c.reason)).not.toContain("rest");
  });
});

// The single-division AI verify seam. `verifyConfig` copies `restByGroup` and
// `startWindows` off the pack verbatim, so the ONLY reason a pool rule was
// unenforced on this path is that `toEngineAssignments` emitted no group id.
describe("pool-targeted rules through the single-division AI adapter (#446)", () => {
  function pack(constraints: Record<string, unknown>): SchedulePack {
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
          ...constraints,
        },
      },
      entrants: [],
      people: [],
      participants: { "f-1": [], "f-2": [] },
      // #449: the pool UUID, which is what the engine matches a stored rule
      // against. `PackFixture.pool` below is the display KEY the model reads —
      // this test used to author the uuid there, a shape the real builder never
      // produces, so the two namespaces looked like one.
      poolIds: { "f-1": POOL_A, "f-2": POOL_A },
      assumptions: [],
      parsed: { hard: [], soft: [], unparsed: [] },
      fixtures: {
        movable: [
          {
            id: "f-1",
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
            id: "f-2",
            ext_key: null,
            round: 1,
            seq: 0,
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

  const plan: AiSchedulePlan = {
    assignments: [
      { fixture_id: "f-1", scheduled_at: iso(T0), court_label: "Court 1" },
      { fixture_id: "f-2", scheduled_at: iso(T0 + 80 * MIN), court_label: "Court 2" },
    ],
    unschedulable: [],
    explanations: [],
    summary: "",
  };

  it("toEngineAssignments carries the pool and division the pack already holds", () => {
    const p = pack({ restByGroup: { [POOL_A]: 180 } });
    const [, second] = toEngineAssignments(plan, p);
    expect(second!.poolId).toBe(POOL_A);
    expect(second!.divisionId).toBe(DIV_A);
  });

  it("a pool-targeted restByGroup makes the AI referee report the 40-minute gap", () => {
    const p = pack({ restByGroup: { [POOL_A]: 180 } });
    const assignments = toEngineAssignments(plan, p);
    const conflicts = validateAssignments(assignments, verifyConfig(p));
    expect(conflicts.map((c) => c.reason)).toContain("rest");
  });

  // #458: this path used to pin `startWindows: []`, so the single-division AI
  // referee was blind to EVERY start window whatever it targeted — pool rules
  // bound for the board and evaporated for the AI proposal, and `repair-domain`
  // clipped the repair domain to the same empty config. All three engine-config
  // builders now go through `buildEngineConstraints`, so the window arrives here
  // in epoch ms exactly as it does on the board path above.
  it("a pool-targeted startWindow binds on the AI verify path too", () => {
    const p = pack({
      startWindows: [{ target: { kind: "pool", id: POOL_A }, notAfter: iso(T0 + 40 * MIN) }],
    });
    // Carried, with its pool target intact and its bound converted ISO → ms.
    expect(verifyConfig(p).constraints?.startWindows).toEqual([
      { target: { kind: "pool", id: POOL_A }, notAfter: T0 + 40 * MIN },
    ]);
    // And it BINDS: f-2 sits in pool A at T0+80min, past the window's notAfter.
    const assignments = toEngineAssignments(plan, p);
    expect(assignments[1]!.poolId).toBe(POOL_A);
    expect(validateAssignments(assignments, verifyConfig(p)).map((c) => c.reason)).toContain(
      "start_window",
    );
  });

  // The guard the assertion above needs: a window keyed on ANOTHER pool must
  // stay silent, or "carries the window" is satisfied by a builder that matches
  // every row.
  it("a startWindow keyed on another pool does not bind on the AI path", () => {
    const p = pack({
      startWindows: [
        {
          target: { kind: "pool", id: "33333333-3333-4333-8333-333333333333" },
          notAfter: iso(T0 + 40 * MIN),
        },
      ],
    });
    const conflicts = validateAssignments(toEngineAssignments(plan, p), verifyConfig(p));
    expect(conflicts.map((c) => c.reason)).not.toContain("start_window");
  });
});
