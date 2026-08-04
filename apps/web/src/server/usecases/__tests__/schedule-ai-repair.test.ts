// W6 (#401) — the z3 repair solver inside `runAiPlan`.
//
// The point of every test here is that the solver replaces an LLM repair round
// rather than joining it. The SDK mock is a QUEUE that is 1:1 with architect
// calls (#399/#400): a solver path that made one extra call would desynchronise
// it and take ~32 tests down across four other suites, so "the queue was not
// touched" is asserted directly rather than assumed.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const parse = vi.fn();
vi.mock("@anthropic-ai/sdk", () => ({
  default: class Anthropic {
    messages = { parse };
    constructor() {}
  },
}));

import { packRuleFixtures, runAiPlan } from "../schedule-ai";
import type { SchedulePack } from "../schedule-ai";
import { resetZ3 } from "@seazn/engine/scheduling";

const F1 = "11111111-1111-4111-8111-111111111111";
const F2 = "22222222-2222-4222-8222-222222222222";
const F3 = "33333333-3333-4333-8333-333333333333";
const F4 = "44444444-4444-4444-8444-444444444444";
const E = (n: number) =>
  `${n}${n}${n}${n}${n}${n}${n}${n}-${n}${n}${n}${n}-4${n}${n}${n}-8${n}${n}${n}-${n}${n}${n}${n}${n}${n}${n}${n}${n}${n}${n}${n}`;

/** The same 4-fixture / 2-court pack `schedule-ai-run.test.ts` uses, so a plan
 *  that is clean there is clean here. One 09:00-18:00 session window on
 *  2026-08-01 gives the solver 18 legal half-hour slots per court to move into. */
function makePack(overrides: Partial<SchedulePack> = {}): SchedulePack {
  return {
    mode: "generate",
    division: { id: "d1", name: "Open", sport: "generic", tz: "Europe/London" },
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
    settings: {
      matchMinutes: 30,
      gapMinutes: 0,
      perEntrantMinRest: 0,
      courts: ["Court 1", "Court 2"],
      sessionWindows: [{ from: "2026-08-01T09:00:00+01:00", to: "2026-08-01T18:00:00+01:00" }],
      blackouts: [],
      constraints: {
        restMin: 20,
        noBackToBack: false,
        startWindows: [],
        fieldFairness: "balance",
        parallelism: "mixed",
        crossPersonClash: "hard",
      },
    },
    entrants: [],
    people: [],
    participants: Object.fromEntries([F1, F2, F3, F4].map((id) => [id, [] as string[]])),
    assumptions: [],
    fixtures: {
      movable: [F1, F2, F3, F4].map((id, i) => ({
        id,
        ext_key: `f${i + 1}`,
        round: 1,
        seq: i,
        pool: null,
        home: E(2 * i + 1),
        away: E(2 * i + 2),
        feeds: { winner_to: null, after: [] },
        current: { at: null, court: null },
        pinned: false,
      })),
      obstacles: [],
    },
    draft: [],
    instruction: "Finish by 6pm.",
    prior: null,
    officials: [],
    ...overrides,
  };
}

const pack = makePack();
const movableIds = new Set([F1, F2, F3, F4]);

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

/** F1 and F2 double-booked on Court 1 at 14:00 — exactly one blocking court
 *  clash, fixable by moving exactly one fixture. */
const clashingPlan = plan([
  assign(F1, "2026-08-01T14:00:00+01:00", "Court 1"),
  assign(F2, "2026-08-01T14:00:00+01:00", "Court 1"),
  assign(F3, "2026-08-01T14:00:00+01:00", "Court 2"),
  assign(F4, "2026-08-01T14:30:00+01:00", "Court 2"),
]);
const cleanPlan = plan([
  assign(F1, "2026-08-01T09:00:00+01:00", "Court 1"),
  assign(F2, "2026-08-01T09:00:00+01:00", "Court 2"),
  assign(F3, "2026-08-01T09:30:00+01:00", "Court 1"),
  assign(F4, "2026-08-01T09:30:00+01:00", "Court 2"),
]);

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
  delete process.env.SCHEDULING_REPAIR_SOLVER;
  delete process.env.SCHEDULING_REPAIR_BUDGET_MS;
});

afterEach(async () => {
  delete process.env.SCHEDULING_REPAIR_SOLVER;
  delete process.env.SCHEDULING_REPAIR_BUDGET_MS;
  await resetZ3();
});

describe("solver repair in runAiPlan (#401)", () => {
  it("repairs a clashing board without spending an LLM repair round, a token or an SDK call", async () => {
    // ONE queued response. A solver path that asked the model anything would
    // fall off the end of the queue and fail here rather than somewhere else.
    parse.mockResolvedValueOnce(planResponse(clashingPlan));

    const out = await runAiPlan(pack, movableIds);

    expect(out.blocking).toEqual([]);
    expect(out.repair.engine).toBe("z3");
    expect(out.repair.solver_ran).toBe(true);
    expect(out.repair.status).toBe("repaired");
    expect(out.repair.moved).toBe(1);
    expect(out.repair.minimality).toBe("proved");
    expect(out.repair.fallback).toBeUndefined();
    // The LLM was never asked again, and the solver spent nothing.
    expect(out.usage.repair_rounds).toBe(0);
    expect(parse).toHaveBeenCalledTimes(1);
    expect(out.usage.input_tokens).toBe(1000);
    expect(out.usage.output_tokens).toBe(500);

    // Exactly one fixture moved, and every other slot is the model's own.
    const changed = out.proposal.filter((p) => {
      const before = clashingPlan.assignments.find((a) => a.fixture_id === p.fixture_id)!;
      return before.scheduled_at !== p.scheduled_at || before.court_label !== p.court_label;
    });
    expect(changed).toHaveLength(1);
  });

  it("stamps engine 'none' and never runs the solver when the first plan verifies clean", async () => {
    parse.mockResolvedValueOnce(planResponse(cleanPlan));

    const out = await runAiPlan(pack, movableIds);

    expect(out.blocking).toEqual([]);
    expect(out.repair).toEqual({ engine: "none", solver_ran: false });
    expect(parse).toHaveBeenCalledTimes(1);
  });

  it("falls back to the LLM round when the solver is switched off, and says so", async () => {
    process.env.SCHEDULING_REPAIR_SOLVER = "off";
    parse
      .mockResolvedValueOnce(planResponse(clashingPlan))
      .mockResolvedValueOnce(planResponse(cleanPlan));

    const out = await runAiPlan(pack, movableIds);

    expect(out.blocking).toEqual([]);
    expect(out.repair.engine).toBe("llm");
    expect(out.repair.solver_ran).toBe(false);
    expect(out.repair.fallback).toBe("disabled");
    expect(out.usage.repair_rounds).toBe(1);
    expect(parse).toHaveBeenCalledTimes(2);
  });

  it("falls back to the LLM round when the solver budget runs out, and hands it only the unresolved fixtures", async () => {
    // 1 ms leaves the budget already spent by the time the first component is
    // reached, so every component is skipped `budget_exhausted`.
    process.env.SCHEDULING_REPAIR_BUDGET_MS = "1";
    parse
      .mockResolvedValueOnce(planResponse(clashingPlan))
      .mockResolvedValueOnce(planResponse(cleanPlan));

    const out = await runAiPlan(pack, movableIds);

    expect(out.blocking).toEqual([]);
    expect(out.repair.engine).toBe("llm");
    expect(out.repair.solver_ran).toBe(true);
    expect(out.repair.timed_out).toBe(true);
    expect(out.repair.fallback).toBe("unrepaired");
    expect(out.repair.unresolved).toBeGreaterThan(0);
    expect(out.usage.repair_rounds).toBe(1);

    // The repair turn names the fixtures the solver could not resolve instead of
    // leaving the model to work that out from the whole board.
    const repairTurn = JSON.parse(
      (parse.mock.calls[1]![0] as { messages: { role: string; content: string }[] }).messages.at(-1)!
        .content,
    ) as { focus_fixture_ids?: string[]; verifier_conflicts: unknown[] };
    expect(repairTurn.focus_fixture_ids).toEqual(expect.arrayContaining([F1, F2]));
  });
});

// A TRIPWIRE, not a bug reproduction — the producer is already correct and this
// passes today. It exists because the engine's feed-edge join now reads
// `winnerTo` as a FIXTURE ID (#443), and the way that rule dies is silent: a
// join that resolves nothing reports nothing, so `min_rest_minutes` would go on
// compiling and displaying as enforced while binding nothing at all. Nothing in
// the engine can catch a producer that starts emitting an ext_key here, because
// `RuleFixture` types both fields as `string | null`.
//
// SCOPE: this covers `packRuleFixtures` — the single-division path — by calling
// it. It does NOT reach the two joint producers on its own; they are covered in
// `competition-schedule-ai-repair.test.ts`, which also pins that all three go
// through the one shared `toRuleFixture` builder.
//
// `makePack` is the right board for it: its ids are uuids and its ext keys are
// "f1".."f4", so the two namespaces are disjoint and "resolves to an id" cannot
// pass by coincidence.
describe("packRuleFixtures namespace tripwire (#443)", () => {
  it("emits winnerTo in the FIXTURE-ID namespace, never the ext_key one", () => {
    const base = makePack();
    const movable = base.fixtures.movable.map((f, i) =>
      i === 0 ? { ...f, feeds: { ...f.feeds, winner_to: F2 } } : f,
    );
    const withFeed: SchedulePack = { ...base, fixtures: { ...base.fixtures, movable } };

    const rf = packRuleFixtures(withFeed);
    const ids = new Set(rf.map((f) => f.id));
    const extKeys = new Set(rf.map((f) => f.extKey).filter((k): k is string => k !== null));
    // Guard the guard: if the fixture ever made ids and ext keys equal, every
    // assertion below would pass in both states.
    expect([...ids].some((id) => extKeys.has(id))).toBe(false);

    const feeds = rf.filter((f) => f.winnerTo !== null);
    expect(feeds).toHaveLength(1);
    expect(ids.has(feeds[0]!.winnerTo!)).toBe(true);
    expect(extKeys.has(feeds[0]!.winnerTo!)).toBe(false);
  });
});
