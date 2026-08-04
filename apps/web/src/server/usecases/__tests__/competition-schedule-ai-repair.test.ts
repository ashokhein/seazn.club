// W6 (#401) — the z3 repair solver inside the JOINT runner.
//
// The property this file exists for is in the first test: the clash is between
// two divisions that each hold exactly ONE fixture, so every per-division board
// is clean on its own and only a solve over the WHOLE board can see it. A
// per-division solver would report nothing to fix and hand a double-booked court
// to the organiser.
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const parse = vi.fn();
vi.mock("@anthropic-ai/sdk", () => ({
  default: class Anthropic {
    messages = { parse };
    constructor() {}
  },
}));

import { jointSolverConfig, runCompetitionAiPlan } from "../competition-schedule-ai";
import type { CompetitionPack } from "../competition-schedule-ai";
import { resetZ3 } from "@seazn/engine/scheduling";

const D1 = "d1111111-1111-4111-8111-111111111111"; // "Alpha" — Court 1 only
const D2 = "d2222222-2222-4222-8222-222222222222"; // "Beta"  — Court 1 and 2
const F1 = "11111111-1111-4111-8111-111111111111";
const F2 = "22222222-2222-4222-8222-222222222222";
const E = (n: number) =>
  `${n}${n}${n}${n}${n}${n}${n}${n}-${n}${n}${n}${n}-4${n}${n}${n}-8${n}${n}${n}-${n}${n}${n}${n}${n}${n}${n}${n}${n}${n}${n}${n}`;

const at = (hhmm: string): string => `2026-08-01T${hhmm}:00+01:00`;

/** The pack from `competition-schedule-run.test.ts`: Alpha owns Court 1 alone,
 *  Beta owns both, so "which courts may the solver use" is a live question and
 *  not a formality. */
function makePack(): CompetitionPack {
  const base = {
    matchMinutes: 30,
    gapMinutes: 0,
    perEntrantMinRest: 0,
    sessionWindows: [],
    blackouts: [],
    constraints: null,
  };
  return {
    mode: "generate",
    competition: { id: "c1", name: "Summer Open" },
    tz: "Europe/London",
    clock: {
      now: "2026-08-06T23:30:00.000Z",
      today: "2026-08-07",
      tomorrow: "2026-08-08",
      nextWeekday: {
        SUN: "2026-08-09", MON: "2026-08-10", TUE: "2026-08-11", WED: "2026-08-12",
        THU: "2026-08-13", FRI: "2026-08-14", SAT: "2026-08-08",
      },
    },
    window: { start: "2026-08-01T00:00:00+01:00", end: "2026-08-13T23:59:59+01:00" },
    sessionHours: { start: "08:00", end: "22:00" },
    parsed: { hard: [], soft: [], unparsed: [] },
    divisions: [
      {
        id: D1,
        name: "Alpha",
        sport: "generic",
        tz: "Europe/London",
        settings: { ...base, courts: ["Court 1"] },
        movableIds: [F1],
        draftPlaced: 1,
      },
      {
        id: D2,
        name: "Beta",
        sport: "generic",
        tz: "Europe/London",
        settings: { ...base, courts: ["Court 1", "Court 2"] },
        movableIds: [F2],
        draftPlaced: 1,
      },
    ],
    courts: ["Court 1", "Court 2"],
    divergentCourts: ["Court 2"],
    entrants: [],
    people: [],
    participants: { [F1]: [], [F2]: [] },
    assumptions: [],
    fixtures: {
      movable: [
        {
          id: F1,
          division_id: D1,
          ext_key: "a1",
          round: 1,
          seq: 0,
          pool: null,
          home: E(1),
          away: E(2),
          feeds: { winner_to: null, after: [] },
          current: { at: null, court: null },
          pinned: false,
        },
        {
          id: F2,
          division_id: D2,
          ext_key: "b1",
          round: 1,
          seq: 0,
          pool: null,
          home: E(3),
          away: E(4),
          feeds: { winner_to: null, after: [] },
          current: { at: null, court: null },
          pinned: false,
        },
      ],
      obstacles: [],
    },
    draft: [],
    instruction: "Finish by 6pm.",
    prior: null,
  };
}

const pack = makePack();
const movableIds = new Set([F1, F2]);
const courtsOf: Record<string, string[]> = { [D1]: ["Court 1"], [D2]: ["Court 1", "Court 2"] };

const assign = (fixture_id: string, scheduled_at: string, court_label: string) => ({
  fixture_id,
  scheduled_at,
  court_label,
});
const plan = (assignments: ReturnType<typeof assign>[]) => ({
  assignments,
  unschedulable: [],
  explanations: [],
  summary: "ok",
});

const cleanPlan = plan([assign(F1, at("09:00"), "Court 1"), assign(F2, at("09:00"), "Court 2")]);
/** Both divisions on Court 1 at the same instant. Each division's own board is
 *  clean; only the joint pass reports it. */
const crossClashPlan = plan([assign(F1, at("09:00"), "Court 1"), assign(F2, at("09:00"), "Court 1")]);

const planResponse = (p: unknown, usage: unknown = { input_tokens: 1000, output_tokens: 500 }) => ({
  parsed_output: p,
  stop_reason: "end_turn",
  usage,
  content: [],
});

beforeEach(() => {
  parse.mockReset();
  process.env.ANTHROPIC_API_KEY = "test-key";
  delete process.env.AI_PROVIDER;
  delete process.env.SCHEDULING_AI_MODEL;
  delete process.env.SCHEDULING_AI_LADDER;
  delete process.env.SCHEDULING_REPAIR_SOLVER;
  delete process.env.SCHEDULING_REPAIR_BUDGET_MS;
});

afterEach(async () => {
  delete process.env.SCHEDULING_REPAIR_SOLVER;
  delete process.env.SCHEDULING_REPAIR_BUDGET_MS;
  await resetZ3();
});

describe("solver repair in runCompetitionAiPlan (#401)", () => {
  it("solves the whole board at once, so a cross-division clash no per-division pass can see is fixed for free", async () => {
    parse.mockResolvedValueOnce(planResponse(crossClashPlan));

    const out = await runCompetitionAiPlan(pack, movableIds);

    expect(out.blocking).toEqual([]);
    expect(out.repair.engine).toBe("z3");
    expect(out.repair.moved).toBe(1);
    expect(out.repair.status).toBe("repaired");
    expect(out.usage.repair_rounds).toBe(0);
    // One SDK call. The queue is 1:1 with architect calls across four other
    // suites; an extra call here is how those go red.
    expect(parse).toHaveBeenCalledTimes(1);
  });

  it("never places a fixture on a court its own division does not own", async () => {
    // Alpha owns Court 1 alone. Nothing in the joint VERIFIER enforces that —
    // court ownership is a structural rule — so a solver handed the union of
    // courts would be free to park Alpha on Court 2 and be graded clean.
    parse.mockResolvedValueOnce(planResponse(crossClashPlan));

    const out = await runCompetitionAiPlan(pack, movableIds);

    expect(out.repair.engine).toBe("z3");
    for (const p of out.proposal) {
      expect(courtsOf[p.division_id]).toContain(p.court_label);
    }
  });

  it("stamps engine 'none' when the joint board verifies clean", async () => {
    parse.mockResolvedValueOnce(planResponse(cleanPlan));

    const out = await runCompetitionAiPlan(pack, movableIds);

    expect(out.repair).toEqual({ engine: "none", solver_ran: false });
    expect(parse).toHaveBeenCalledTimes(1);
  });

  it("falls back to the LLM repair round when the solver is switched off, and says so", async () => {
    process.env.SCHEDULING_REPAIR_SOLVER = "off";
    parse
      .mockResolvedValueOnce(planResponse(crossClashPlan))
      .mockResolvedValueOnce(planResponse(cleanPlan));

    const out = await runCompetitionAiPlan(pack, movableIds);

    expect(out.blocking).toEqual([]);
    expect(out.repair.engine).toBe("llm");
    expect(out.repair.solver_ran).toBe(false);
    expect(out.repair.fallback).toBe("disabled");
    expect(out.usage.repair_rounds).toBe(1);
  });

  it("falls back and hands the LLM the fixtures it could not resolve when the budget runs out", async () => {
    process.env.SCHEDULING_REPAIR_BUDGET_MS = "1";
    parse
      .mockResolvedValueOnce(planResponse(crossClashPlan))
      .mockResolvedValueOnce(planResponse(cleanPlan));

    const out = await runCompetitionAiPlan(pack, movableIds);

    expect(out.repair.engine).toBe("llm");
    expect(out.repair.solver_ran).toBe(true);
    expect(out.repair.timed_out).toBe(true);
    expect(out.repair.unresolved).toBeGreaterThan(0);
    expect(out.usage.repair_rounds).toBe(1);

    const repairTurn = JSON.parse(
      (parse.mock.calls[1]![0] as { messages: { role: string; content: string }[] }).messages.at(-1)!
        .content,
    ) as { focus_fixture_ids?: string[] };
    expect(repairTurn.focus_fixture_ids).toEqual(expect.arrayContaining([F1, F2]));
  });
});

// The JOINT half of the #443 namespace guard. `schedule-ai-repair.test.ts`
// covers the single-division producer; these two cover the competition path,
// where the same mistake would be even quieter — a joint run spans divisions, so
// a feed edge that resolves to nothing takes the whole competition's feeder-rest
// enforcement with it while still displaying as a compiled rule.
//
// TRIPWIRES, not bug reproductions: both pass against correct code today.
describe("joint RuleFixture producers stay in the fixture-id namespace (#443)", () => {
  /** `makePack`'s ids are uuids and its ext keys are "a1"/"b1", so the two
   *  namespaces are disjoint and "resolves to an id" cannot pass by coincidence.
   *  F1 (Alpha) feeds F2 (Beta) — deliberately CROSS-DIVISION, which is the edge
   *  the engine only began enforcing once the division guard came off. */
  const feedPack = (): CompetitionPack => {
    const p = makePack();
    return {
      ...p,
      fixtures: {
        ...p.fixtures,
        movable: p.fixtures.movable.map((f) =>
          f.id === F1 ? { ...f, feeds: { ...f.feeds, winner_to: F2 } } : f,
        ),
      },
    };
  };

  it("jointSolverConfig emits winnerTo as a fixture id, never an ext_key", () => {
    const rf = jointSolverConfig(feedPack()).ruleFixtures ?? [];
    const ids = new Set(rf.map((f) => f.id));
    const extKeys = new Set(rf.map((f) => f.extKey).filter((k): k is string => k !== null));
    // Guard the guard: if the fixture ever made ids and ext keys equal, every
    // assertion below would pass in both states.
    expect([...ids].some((id) => extKeys.has(id))).toBe(false);

    const feeds = rf.filter((f) => f.winnerTo !== null);
    expect(feeds).toHaveLength(1);
    expect(ids.has(feeds[0]!.winnerTo!)).toBe(true);
    expect(extKeys.has(feeds[0]!.winnerTo!)).toBe(false);
    // And the edge is the one that was wired, attributed to the FEEDER's own
    // division — not the dependent's.
    expect(feeds[0]!.id).toBe(F1);
    expect(feeds[0]!.winnerTo).toBe(F2);
    expect(feeds[0]!.divisionId).toBe(D1);
  });

  it("every RuleFixture in all three usecases comes from the ONE shared builder", () => {
    // This is what makes the guard above cover `verifyJoint` too, which needs a
    // whole plan to call and is not worth building one for. #443 was two copies
    // of a join drifting onto a shared wrong assumption; the durable fix is that
    // there is only ever one copy. `winnerTo:` is the field only a RuleFixture
    // literal carries, so counting it counts the producers.
    //
    // `schedule.ts` joined the list in #447: the board paths need RuleFixtures
    // too, and they hold the same five facts on a `fixtures` ROW under different
    // column names. That is a signature problem, not a data one, so
    // `rowToRuleFixture` renames its columns and delegates rather than writing a
    // fourth literal — which is why the count below stays at one.
    const read = (rel: string): string =>
      readFileSync(new URL(rel, import.meta.url), "utf8");
    const single = read("../schedule-ai.ts");
    const joint = read("../competition-schedule-ai.ts");
    const board = read("../schedule.ts");
    const producers = (s: string): number => (s.match(/winnerTo:/g) ?? []).length;

    expect(/export function toRuleFixture\(/.test(single)).toBe(true);
    expect(producers(single)).toBe(1); // the builder itself
    expect(producers(joint)).toBe(0); // both joint sites delegate to it
    expect(producers(board)).toBe(0); // and so does the board's row adapter
    // Anchored on the RETURN, not on a bare `toRuleFixture(`: the loose form is
    // a substring of `export function rowToRuleFixture(`, so it would pass even
    // if the delegation had been replaced by a literal. The real teeth are the
    // zero above; this pins that the delegate is what produces the value.
    expect(/return toRuleFixture\(/.test(board)).toBe(true);
  });
});
