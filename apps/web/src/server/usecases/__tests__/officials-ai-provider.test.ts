// Task 5 — officials runner ↔ provider seam. Mocks one level higher than
// officials-ai-route.test.ts: that suite mocks @anthropic-ai/sdk and exercises
// the real anthropic-provider adapter end to end (coverage worth keeping in
// its own file); this one mocks anthropicProvider() itself, so it proves
// runOfficialsAiPlan talks to the AiProvider interface — not to Anthropic —
// without caring how the adapter fills that interface in. Mirrors
// schedule-ai-provider.test.ts (Task 4).
import { describe, it, expect, vi, beforeEach } from "vitest";

const anthropicProvider = vi.fn();
vi.mock("@/server/ai/anthropic-provider", () => ({ anthropicProvider }));

// --- Minimal self-contained pack (no DB): one referee covering three
//     non-overlapping fixtures, nothing locked. --------------------------
const F1 = "11111111-1111-4111-8111-111111111111";
const F2 = "22222222-2222-4222-8222-222222222222";
const F3 = "33333333-3333-4333-8333-333333333333";
const REF_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const fixtureIds = [F1, F2, F3];
const refA = REF_A;

function makePack(): import("../officials-ai").OfficialsPack {
  return {
    division: { id: "d1", name: "Open", sport: "generic", tz: "Europe/London" },
    match_minutes: 30,
    policy: {
      roles: ["referee"],
      poolLock: false,
      blockStay: false,
      fairness: "tournament",
      teamRefKeepDivision: false,
      restMinMinutes: 0,
      blockGapMinutes: 30,
    },
    fixtures: fixtureIds.map((id, i) => ({
      id,
      start_at: `2026-08-01T${String(9 + i * 2).padStart(2, "0")}:00:00+01:00`,
      court: "Court 1",
      pool: null,
      entrants: [],
    })),
    officials: [
      {
        id: refA,
        name: "Ref A",
        role_keys: ["referee"],
        home_pool_id: null,
        max_per_day: null,
        blackout_dates: [],
        busy_elsewhere: [],
        entrant_ids: [],
      },
    ],
    locked: [],
    draft: [],
    instruction: "Ref A everywhere.",
    prior: null,
  };
}

const pack = makePack();

function assignAll(ids: string[], officialId: string) {
  return {
    assignments: ids.map((id) => ({ fixture_id: id, official_id: officialId, role_key: "referee" })),
    unfilled: [],
    explanations: [],
    summary: "ok",
  };
}

const round = (parsed: unknown) => ({
  parsed,
  assistantTurn: { role: "assistant" as const, content: [] },
  usage: { inputTokens: 900, outputTokens: 220, costUsd: null },
  servedModel: "claude-sonnet-5",
  refused: false,
});

beforeEach(() => {
  anthropicProvider.mockReset();
  process.env.ANTHROPIC_API_KEY = "test-key";
  delete process.env.OFFICIALS_AI_EFFORT;
});

describe("officials runner ↔ provider seam", () => {
  it("asks for effort reasoning at the officials effort, with the 32k budget", async () => {
    const chat = vi.fn().mockResolvedValue(round(assignAll(fixtureIds, refA)));
    anthropicProvider.mockReturnValue({ id: "anthropic", isConfigured: () => true, chat });

    const { runOfficialsAiPlan } = await import("../officials-ai");
    await runOfficialsAiPlan(pack);

    const req = chat.mock.calls[0]![0];
    // Phase B has no legacy-model branch and must not grow one: it always
    // asks for effort, never a token budget.
    expect(req.reasoning).toEqual({ kind: "effort", effort: "high", thinking: "adaptive" });
    expect(req.maxTokens).toBe(32_000);
    expect(req.schema.name).toBe("officials_plan");
  });

  it("resolves the provider once per run", async () => {
    const chat = vi.fn().mockResolvedValue(round(assignAll(fixtureIds, refA)));
    anthropicProvider.mockReturnValue({ id: "anthropic", isConfigured: () => true, chat });

    const { runOfficialsAiPlan } = await import("../officials-ai");
    await runOfficialsAiPlan(pack);

    expect(anthropicProvider).toHaveBeenCalledTimes(1);
  });

  it("refuses with 503 before calling when the provider is unconfigured", async () => {
    const chat = vi.fn();
    anthropicProvider.mockReturnValue({ id: "anthropic", isConfigured: () => false, chat });

    const { runOfficialsAiPlan } = await import("../officials-ai");
    await expect(runOfficialsAiPlan(pack)).rejects.toMatchObject({ status: 503 });
    expect(chat).not.toHaveBeenCalled();
  });

  it("refusal fails fast without spending a corrective retry", async () => {
    const chat = vi.fn().mockResolvedValue({ ...round(null), refused: true });
    anthropicProvider.mockReturnValue({ id: "anthropic", isConfigured: () => true, chat });

    const { runOfficialsAiPlan } = await import("../officials-ai");
    await expect(runOfficialsAiPlan(pack)).rejects.toMatchObject({ status: 422, code: "AI_PLAN_FAILED" });
    expect(chat).toHaveBeenCalledTimes(1);
  });

  it("prefers the cost the provider reports over the derived estimate", async () => {
    const chat = vi
      .fn()
      .mockResolvedValue({ ...round(assignAll(fixtureIds, refA)), usage: { inputTokens: 900, outputTokens: 220, costUsd: 0.12 } });
    anthropicProvider.mockReturnValue({ id: "anthropic", isConfigured: () => true, chat });

    const { runOfficialsAiPlan } = await import("../officials-ai");
    const out = await runOfficialsAiPlan(pack);

    expect(out.usage.input_tokens).toBe(900);
    expect(out.usage.output_tokens).toBe(220);
    expect(out.usage.cost_usd).toBeCloseTo(0.12);
  });
});
