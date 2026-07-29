// #350 Task 3 — the JOINT RUNNER. The Anthropic SDK is mocked exactly as
// schedule-ai-run.test.ts mocks it (`messages.parse` is a vi.fn whose queued
// resolutions stand in for structured-output responses), so there is no network
// and no DB: runCompetitionAiPlan takes the joint pack as data.
//
// The first test here is the reason this file exists. Task 2 shipped
// JOINT_RULES with NO consumer, and its preamble makes a promise about the
// grader ("the verifier checks each division's own fixtures against that
// division's own settings … while the court and person checks additionally see
// every division's fixtures"). Until something asserts that the runner actually
// concatenates it onto SYSTEM_PROMPT, the prompt could be silently unsent and
// every test still pass.
import { beforeEach, describe, expect, it, vi } from "vitest";

const parse = vi.fn();
vi.mock("@anthropic-ai/sdk", () => ({
  default: class Anthropic {
    messages = { parse };
    constructor() {}
  },
}));

import { runCompetitionAiPlan } from "../competition-schedule-ai";
import type { CompetitionPack } from "../competition-schedule-ai";
import { JOINT_RULES, SYSTEM_PROMPT } from "../schedule-ai-prompt";

const D1 = "d1111111-1111-4111-8111-111111111111"; // "Alpha"
const D2 = "d2222222-2222-4222-8222-222222222222"; // "Beta"
const F1 = "11111111-1111-4111-8111-111111111111";
const F2 = "22222222-2222-4222-8222-222222222222";
const E = (n: number) => `${n}${n}${n}${n}${n}${n}${n}${n}-${n}${n}${n}${n}-4${n}${n}${n}-8${n}${n}${n}-${n}${n}${n}${n}${n}${n}${n}${n}${n}${n}${n}${n}`;

const at = (hhmm: string): string => `2026-08-01T${hhmm}:00+01:00`;

// Alpha owns only Court 1; Beta owns both. So "F1 on Court 2" is a per-division
// court violation that a union check would wave through.
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
// Both divisions on Court 1 at the same instant — the cross-division clash only
// verifyJoint can see.
const crossClashPlan = plan([
  assign(F1, at("09:00"), "Court 1"),
  assign(F2, at("09:00"), "Court 1"),
]);
// Court 2 is in pack.courts but NOT in Alpha's own settings.courts.
const foreignCourtPlan = plan([
  assign(F1, at("09:00"), "Court 2"),
  assign(F2, at("10:00"), "Court 2"),
]);

function planResponse(p: unknown, usage: unknown = { input_tokens: 1000, output_tokens: 500 }) {
  return { parsed_output: p, stop_reason: "end_turn", usage, content: [] };
}

beforeEach(() => {
  parse.mockReset();
  process.env.ANTHROPIC_API_KEY = "test-key";
  delete process.env.AI_PROVIDER;
  delete process.env.SCHEDULING_AI_MODEL;
});

describe("runCompetitionAiPlan (#350)", () => {
  it("sends SYSTEM_PROMPT followed by JOINT_RULES as the system prompt", () => {
    parse.mockResolvedValueOnce(planResponse(cleanPlan));
    return runCompetitionAiPlan(pack, movableIds).then(() => {
      const body = parse.mock.calls[0]![0] as { system: { text: string }[] };
      expect(body.system[0]!.text).toBe(`${SYSTEM_PROMPT}\n\n${JOINT_RULES}`);
    });
  });

  it("sends the joint pack as the first user turn", async () => {
    parse.mockResolvedValueOnce(planResponse(cleanPlan));
    await runCompetitionAiPlan(pack, movableIds);
    const body = parse.mock.calls[0]![0] as { messages: { role: string; content: string }[] };
    expect(body.messages[0]!.role).toBe("user");
    expect(JSON.parse(body.messages[0]!.content)).toEqual(pack);
  });

  it("tags every proposal entry with its own division_id", async () => {
    parse.mockResolvedValueOnce(planResponse(cleanPlan));
    const out = await runCompetitionAiPlan(pack, movableIds);
    expect(out.blocking).toEqual([]);
    expect(out.proposal.map((p) => [p.fixture_id, p.division_id])).toEqual([
      [F1, D1],
      [F2, D2],
    ]);
  });

  it("a cross-division court clash drives a repair round", async () => {
    parse
      .mockResolvedValueOnce(planResponse(crossClashPlan))
      .mockResolvedValueOnce(planResponse(cleanPlan));
    const out = await runCompetitionAiPlan(pack, movableIds);
    expect(out.usage.repair_rounds).toBe(1);
    expect(out.blocking).toEqual([]);
    const repairTurn = JSON.stringify(parse.mock.calls[1]![0].messages.at(-1));
    expect(repairTurn).toContain("verifier_conflicts");
    expect(repairTurn).toContain("court");
    // BOTH sides of the clash are named, so the model can move either one.
    expect(repairTurn).toContain(F1);
    expect(repairTurn).toContain(F2);
  });

  it("rejects a court the fixture's own division does not have, before verification", async () => {
    parse
      .mockResolvedValueOnce(planResponse(foreignCourtPlan))
      .mockResolvedValueOnce(planResponse(cleanPlan));
    const out = await runCompetitionAiPlan(pack, movableIds);
    // A corrective (not repair) round: the plan never reached the verifier.
    expect(out.usage.repair_rounds).toBe(0);
    const corrective = JSON.stringify(parse.mock.calls[1]![0].messages.at(-1));
    expect(corrective).toContain("structural_error");
    expect(corrective).toContain("Court 2");
    expect(out.blocking).toEqual([]);
  });
});
