// Task 4 — schedule runner ↔ provider seam. Mocks one level higher than
// schedule-ai-run.test.ts: that suite mocks @anthropic-ai/sdk and exercises
// the real anthropic-provider adapter end to end (coverage worth keeping in
// its own file); this one mocks anthropicProvider() itself, so it proves
// runAiPlan talks to the AiProvider interface — not to Anthropic — without
// caring how the adapter fills that interface in.
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest";

const anthropicProvider = vi.fn();
vi.mock("@/server/ai/anthropic-provider", () => ({ anthropicProvider }));

// --- Fixtures duplicated from schedule-ai-run.test.ts:25-126 (not exported
//     there, so copied verbatim rather than imported). ---------------------
const F1 = "11111111-1111-4111-8111-111111111111";
const F2 = "22222222-2222-4222-8222-222222222222";
const F3 = "33333333-3333-4333-8333-333333333333";
const F4 = "44444444-4444-4444-8444-444444444444";
const E = (n: number) => `${n}${n}${n}${n}${n}${n}${n}${n}-${n}${n}${n}${n}-4${n}${n}${n}-8${n}${n}${n}-${n}${n}${n}${n}${n}${n}${n}${n}${n}${n}${n}${n}`;

function makePack(overrides: Partial<import("../schedule-ai").SchedulePack> = {}): import("../schedule-ai").SchedulePack {
  return {
    mode: "generate",
    division: { id: "d1", name: "Open", sport: "generic", tz: "Europe/London" },
    // #397: the calendar anchor. The org zone matches the division zone here,
    // so this fixture pack keeps every offset it had.
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
    // #396: keyed for every movable fixture; no persons in this pack, so empty.
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

function assign(fixture_id: string, scheduled_at: string, court_label: string) {
  return { fixture_id, scheduled_at, court_label };
}

function plan(assignments: ReturnType<typeof assign>[], unschedulable: { fixture_id: string; reason: string }[] = []) {
  return { assignments, unschedulable, explanations: [], summary: "ok" };
}

// SF1+SF2 double-booked on Court 1 @ 14:00 → verifier court clash.
const clashingPlan = plan([
  assign(F1, "2026-08-01T14:00:00+01:00", "Court 1"),
  assign(F2, "2026-08-01T14:00:00+01:00", "Court 1"),
  assign(F3, "2026-08-01T14:00:00+01:00", "Court 2"),
  assign(F4, "2026-08-01T14:30:00+01:00", "Court 2"),
]);
// Repair moves F2 off Court 1 → clean.
const fixedPlan = plan([
  assign(F1, "2026-08-01T14:00:00+01:00", "Court 1"),
  assign(F2, "2026-08-01T14:00:00+01:00", "Court 2"),
  assign(F3, "2026-08-01T14:30:00+01:00", "Court 2"),
  assign(F4, "2026-08-01T14:30:00+01:00", "Court 1"),
]);

const round = (parsed: unknown) => ({
  parsed,
  assistantTurn: { role: "assistant" as const, content: [] },
  usage: { inputTokens: 1000, outputTokens: 500, costUsd: null },
  servedModel: "claude-sonnet-5",
  refused: false,
});

beforeEach(() => {
  anthropicProvider.mockReset();
  process.env.ANTHROPIC_API_KEY = "test-key";
  // W6 (#401): these tests drive the LLM REPAIR LOOP, which the z3 solver now
  // runs ahead of. That loop is still live code — it is what runs when the
  // solver is switched off, out of budget, queued, or unable to finish a board —
  // and this suite is its coverage, so the solver is switched off here and
  // exercised in schedule-ai-repair.test.ts instead.
  process.env.SCHEDULING_REPAIR_SOLVER = "off";
});

// `process.env` is per WORKER, not per file — a switch left off here would
// silently disable the solver in whichever suite this worker picks up next.
afterAll(() => {
  delete process.env.SCHEDULING_REPAIR_SOLVER;
});

describe("schedule runner ↔ provider seam", () => {
  it("resolves the provider once per run and reuses it across repair rounds", async () => {
    // Reasoning blocks are provider-specific and replayed verbatim on repair.
    // A run that resolved a provider per round could send one service's
    // reasoning to another, so the factory must run once and chat twice.
    const chat = vi
      .fn()
      .mockResolvedValueOnce(round(clashingPlan))
      .mockResolvedValueOnce(round(fixedPlan));
    anthropicProvider.mockReturnValue({ id: "anthropic", isConfigured: () => true, chat });

    const { runAiPlan } = await import("../schedule-ai");
    const out = await runAiPlan(pack, movableIds);

    expect(anthropicProvider).toHaveBeenCalledTimes(1);
    expect(chat).toHaveBeenCalledTimes(2);
    expect(out.usage.repair_rounds).toBe(1);
    expect(out.blocking).toHaveLength(0);
  });

  it("asks for effort reasoning and the 32k output budget", async () => {
    const chat = vi.fn().mockResolvedValue(round(fixedPlan));
    anthropicProvider.mockReturnValue({ id: "anthropic", isConfigured: () => true, chat });

    const { runAiPlan } = await import("../schedule-ai");
    await runAiPlan(pack, movableIds);

    const req = chat.mock.calls[0]![0];
    expect(req.reasoning).toEqual({ kind: "effort", effort: "high", thinking: "adaptive" });
    expect(req.maxTokens).toBe(32_000);
    expect(req.schema.name).toBe("schedule_plan");
  });

  it("refuses with 503 before calling when the provider is unconfigured", async () => {
    const chat = vi.fn();
    anthropicProvider.mockReturnValue({ id: "anthropic", isConfigured: () => false, chat });

    const { runAiPlan } = await import("../schedule-ai");
    await expect(runAiPlan(pack, movableIds)).rejects.toMatchObject({ status: 503 });
    expect(chat).not.toHaveBeenCalled();
  });

  it("accumulates usage across rounds and prefers the cost the provider reports", async () => {
    const chat = vi
      .fn()
      .mockResolvedValueOnce({ ...round(clashingPlan), usage: { inputTokens: 1000, outputTokens: 500, costUsd: 0.2 } })
      .mockResolvedValueOnce({ ...round(fixedPlan), usage: { inputTokens: 1000, outputTokens: 500, costUsd: 0.3 } });
    anthropicProvider.mockReturnValue({ id: "anthropic", isConfigured: () => true, chat });

    const { runAiPlan } = await import("../schedule-ai");
    const out = await runAiPlan(pack, movableIds);

    expect(out.usage.input_tokens).toBe(2000);
    expect(out.usage.output_tokens).toBe(1000);
    // Both rounds reported a real cost, so the total is their sum — not a
    // recomputed estimate from the aggregate tokens.
    expect(out.usage.cost_usd).toBeCloseTo(0.5);
  });

  it("refusal fails fast without spending a corrective retry", async () => {
    const chat = vi.fn().mockResolvedValue({ ...round(null), refused: true });
    anthropicProvider.mockReturnValue({ id: "anthropic", isConfigured: () => true, chat });

    const { runAiPlan } = await import("../schedule-ai");
    await expect(runAiPlan(pack, movableIds)).rejects.toMatchObject({ status: 422, code: "AI_PLAN_FAILED" });
    expect(chat).toHaveBeenCalledTimes(1);
  });
});

describe("aiReasoning — the provider-neutral function callModel actually sends", () => {
  // aiReasoningParams (Anthropic-shaped, tested in schedule-ai-run.test.ts) is
  // now derived from this function, but that derivation only proves the two
  // agree — it does not by itself prove `aiReasoning` gets the "disabled
  // thinking still carries effort" case right. Direct coverage here closes
  // that gap: a regression that collapses disabled-thinking to `kind:"none"`
  // must fail a test that calls `aiReasoning` itself.
  afterEach(() => {
    delete process.env.SCHEDULING_AI_THINKING;
    delete process.env.SCHEDULING_AI_EFFORT;
  });

  it("keeps effort present when thinking is disabled", async () => {
    process.env.SCHEDULING_AI_THINKING = "disabled";
    process.env.SCHEDULING_AI_EFFORT = "medium";

    const { aiReasoning } = await import("../schedule-ai");
    expect(aiReasoning("claude-sonnet-5")).toEqual({ kind: "effort", effort: "medium", thinking: "disabled" });
  });
});
