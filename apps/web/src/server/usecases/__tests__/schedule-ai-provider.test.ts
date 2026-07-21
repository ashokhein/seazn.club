// Task 4 — schedule runner ↔ provider seam. Mocks one level higher than
// schedule-ai-run.test.ts: that suite mocks @anthropic-ai/sdk and exercises
// the real anthropic-provider adapter end to end (coverage worth keeping in
// its own file); this one mocks anthropicProvider() itself, so it proves
// runAiPlan talks to the AiProvider interface — not to Anthropic — without
// caring how the adapter fills that interface in.
import { describe, it, expect, vi, beforeEach } from "vitest";

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
