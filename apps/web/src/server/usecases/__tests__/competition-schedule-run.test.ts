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

import {
  runCompetitionAiPlan,
  runCompetitionAiPlanLadder,
  toJointModelPayload,
} from "../competition-schedule-ai";
import type { CompetitionPack } from "../competition-schedule-ai";
import { JOINT_RULES, SYSTEM_PROMPT } from "../schedule-ai-prompt";
import { createTokenMeter } from "@/lib/ai-rung";

const D1 = "d1111111-1111-4111-8111-111111111111"; // "Alpha"
const D2 = "d2222222-2222-4222-8222-222222222222"; // "Beta"
const F1 = "11111111-1111-4111-8111-111111111111";
const F2 = "22222222-2222-4222-8222-222222222222";
const F3 = "33333333-3333-4333-8333-333333333333";
const F4 = "44444444-4444-4444-8444-444444444444";
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
    // #397: the calendar anchor. Frozen, so this fixture pack is stable.
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
    // No rostered persons on this board, so every movable fixture's advancer set
    // is empty — but the key must exist for each of them, exactly as
    // buildCompetitionPack emits it (#396).
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
  delete process.env.SCHEDULING_AI_LADDER;
  delete process.env.SCHEDULING_AI_CHEAP_MODEL;
});

describe("runCompetitionAiPlan (#350)", () => {
  it("sends SYSTEM_PROMPT followed by JOINT_RULES as the system prompt", () => {
    parse.mockResolvedValueOnce(planResponse(cleanPlan));
    return runCompetitionAiPlan(pack, movableIds).then(() => {
      const body = parse.mock.calls[0]![0] as { system: { text: string }[] };
      expect(body.system[0]!.text).toBe(`${SYSTEM_PROMPT}\n\n${JOINT_RULES}`);
    });
  });

  it("sends the joint pack as the first user turn, MINUS the server-side fields", async () => {
    parse.mockResolvedValueOnce(planResponse(cleanPlan));
    await runCompetitionAiPlan(pack, movableIds);
    const body = parse.mock.calls[0]![0] as { messages: { role: string; content: string }[] };
    expect(body.messages[0]!.role).toBe("user");
    // #396: `participants` and `assumptions` are enforcement inputs for the
    // placer and the referee, never prompt material — and inlining them re-breaks
    // the joint token budget. Everything else goes over verbatim.
    expect(JSON.parse(body.messages[0]!.content)).toEqual(toJointModelPayload(pack));
    expect(body.messages[0]!.content).not.toContain("participants");
    expect(body.messages[0]!.content).not.toContain("assumptions");
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

// ===========================================================================
// The diff, which the board colours the proposal from.
// ===========================================================================

describe("runCompetitionAiPlan — joint diff (#350)", () => {
  it("groups every movable fixture of every division as placed / unchanged / moved / unscheduled", async () => {
    // computeJointDiff is a copy of computeDiff and inherits none of its
    // coverage: returning an empty diff kept the whole suite green.
    // F1 (Alpha) already sits at 09:00 Court 1 and stays → unchanged.
    // F2 (Beta) already sits at 09:00 Court 1 and is proposed elsewhere → moved.
    // F3 (Beta) has no slot at all → placed.
    // F4 (Beta) has a slot and is dropped → unscheduled.
    const withSlots = makePack();
    const beta = withSlots.fixtures.movable[1]!;
    withSlots.fixtures.movable[0]!.current = { at: at("09:00"), court: "Court 1" };
    beta.current = { at: at("09:00"), court: "Court 1" };
    withSlots.fixtures.movable.push(
      { ...beta, id: F3, ext_key: "b2", seq: 1, current: { at: null, court: null } },
      { ...beta, id: F4, ext_key: "b3", seq: 2, current: { at: at("11:00"), court: "Court 2" } },
    );
    withSlots.divisions[1]!.movableIds = [F2, F3, F4];
    const ids = new Set([F1, F2, F3, F4]);

    parse.mockResolvedValueOnce(
      planResponse({
        assignments: [
          assign(F1, at("09:00"), "Court 1"),
          assign(F2, at("10:00"), "Court 2"),
          assign(F3, at("11:00"), "Court 2"),
        ],
        unschedulable: [{ fixture_id: F4, reason: "H2" }],
        explanations: [],
        summary: "ok",
      }),
    );
    const r = await runCompetitionAiPlan(withSlots, ids);
    expect(r.diff.unchanged).toEqual([F1]);
    expect(r.diff.moved).toEqual([F2]);
    expect(r.diff.placed).toEqual([F3]);
    expect(r.diff.unscheduled).toEqual([F4]);
  });
});

// ===========================================================================
// The money seam: the token meter and the model ladder.
//
// runCompetitionAiPlan is a HAND COPY of runAiPlan, and a copy is exactly where
// a `meter.add` drifts below a `throw`. The single-division twin carries five
// dedicated meter tests (schedule-ai-run.test.ts:498-552) for that reason; these
// mirror the ones that can actually be got wrong here, plus the ladder wiring
// that has no twin at all — runCompetitionAiPlanLadder is what the orchestrator
// is told to call, so "the same meter reaches every rung" is its whole purpose.
// ===========================================================================

describe("runCompetitionAiPlan — hard token budget", () => {
  it("clamps the round's max_tokens to what is left of the budget", async () => {
    parse.mockResolvedValueOnce(planResponse(cleanPlan));
    await runCompetitionAiPlan(pack, movableIds, undefined, undefined, createTokenMeter(3_000));
    expect((parse.mock.calls[0]![0] as { max_tokens: number }).max_tokens).toBe(3_000);
  });

  it("charges the meter for a round that spent tokens and then refused", async () => {
    // The meter is charged the moment usage is known, BEFORE the refusal throw.
    // Move that call below the throw and a run loops past its cap on failures
    // alone — every round free, the budget never reached.
    parse.mockResolvedValueOnce({
      parsed_output: null,
      stop_reason: "refusal",
      usage: { input_tokens: 100, output_tokens: 7_000 },
      content: [],
    });
    const meter = createTokenMeter(64_000);
    await expect(
      runCompetitionAiPlan(pack, movableIds, undefined, undefined, meter),
    ).rejects.toMatchObject({ code: "AI_PLAN_FAILED" });
    expect(meter.spent).toBe(7_000);
  });

  it("fails without a model call when the budget is already exhausted", async () => {
    const meter = createTokenMeter(10_000);
    meter.add(9_000); // an earlier rung already spent this
    await expect(
      runCompetitionAiPlan(pack, movableIds, undefined, undefined, meter),
    ).rejects.toMatchObject({ code: "AI_PLAN_FAILED" });
    expect(parse).not.toHaveBeenCalled();
    expect(meter.stoppedOnBudget).toBe(true);
  });
});

describe("runCompetitionAiPlanLadder (#350)", () => {
  it("escalates on a plan the referee will not accept, and reports the chain", async () => {
    // Rung 1 never clears its cross-division court clash, so it returns a
    // DEGRADED plan (blocking > 0) rather than throwing. Escalation therefore
    // depends on `acceptable` actually being planIsAcceptable — a constant
    // `true` would ship rung 1's clashing board and never call rung 2.
    process.env.SCHEDULING_AI_LADDER = "claude-rung-a,claude-rung-b";
    parse
      .mockResolvedValueOnce(planResponse(crossClashPlan)) // round 0
      .mockResolvedValueOnce(planResponse(crossClashPlan)) // repair 1
      .mockResolvedValueOnce(planResponse(crossClashPlan)) // repair 2 → give up
      .mockResolvedValueOnce(planResponse(cleanPlan)); // rung 2, clean
    const out = await runCompetitionAiPlanLadder(pack, movableIds, createTokenMeter(1_000_000));
    expect(out.rungs_tried).toEqual(["claude-rung-a", "claude-rung-b"]);
    expect(out.served_model).toBe("claude-rung-b");
    expect(out.escalated_from).toBe("claude-rung-a");
    expect(out.blocking).toEqual([]);
    expect((parse.mock.calls[3]![0] as { model: string }).model).toBe("claude-rung-b");
  });

  it("hands the SAME meter to every rung, so the budget spans the ladder", async () => {
    // The one thing the wrapper exists for. A fresh meter per rung would let a
    // 3-rung ladder spend 3x the budget the organiser paid for.
    process.env.SCHEDULING_AI_LADDER = "claude-rung-a,claude-rung-b";
    parse
      // Rung 1 burns 25,000 and then refuses → recoverable, escalate.
      .mockResolvedValueOnce({
        parsed_output: null,
        stop_reason: "refusal",
        usage: { input_tokens: 100, output_tokens: 25_000 },
        content: [],
      })
      .mockResolvedValueOnce(planResponse(cleanPlan, { input_tokens: 100, output_tokens: 500 }));
    const meter = createTokenMeter(32_000);
    const out = await runCompetitionAiPlanLadder(pack, movableIds, meter);
    expect(out.served_model).toBe("claude-rung-b");
    // Rung 2 starts where rung 1 left off: 32,000 − 25,000 = 7,000 left, so its
    // round is clamped to that rather than to a fresh MAX_TOKENS.
    expect((parse.mock.calls[1]![0] as { max_tokens: number }).max_tokens).toBe(7_000);
    expect(meter.spent).toBe(25_500);
  });

  it("stops escalating once the meter refuses a round", async () => {
    // canEscalate is `() => !meter.stoppedOnBudget`. Without it the ladder walks
    // every remaining rung, each throwing before any network call — spending
    // nothing but writing models into rungs_tried that were never asked.
    process.env.SCHEDULING_AI_LADDER = "claude-rung-a,claude-rung-b";
    const meter = createTokenMeter(32_000);
    // Rung 1 spends past the reserve, so rung 2 must not be entered.
    parse.mockResolvedValueOnce(
      planResponse(crossClashPlan, { input_tokens: 100, output_tokens: 31_500 }),
    );
    const out = await runCompetitionAiPlanLadder(pack, movableIds, meter);
    expect(meter.stoppedOnBudget).toBe(true);
    expect(parse).toHaveBeenCalledTimes(1);
    expect(out.rungs_tried).toEqual(["claude-rung-a"]);
    expect(out.served_model).toBe("claude-rung-a");
    // Degraded, but shipped — a real plan beats a failure.
    expect(out.blocking.length).toBeGreaterThan(0);
  });
});
