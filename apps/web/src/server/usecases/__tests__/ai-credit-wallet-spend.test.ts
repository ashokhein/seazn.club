// v17 Phase 2 Task 4 — AI credit wallet metering on the schedule + officials AI
// run paths (SPEC-2 §5.2, design/superpowers/plans/2026-07-24-v17-phase2-wallet).
// The model boundary is mocked at @/server/ai/select-provider (not just the
// Anthropic SDK): the shipped DEFAULT_LADDER's first rung is OpenRouter, and a
// developer .env.local carries a REAL OPENROUTER_API_KEY (vitest.config.ts only
// strips ANTHROPIC/POSTHOG/RESEND, not that one) — mocking only the Anthropic
// SDK still lets rung 1 make a genuine live network call. Replacing
// resolveProvider/selectProvider outright removes every live-network path
// regardless of which provider a rung asks for, so this suite exercises the
// WALLET behavior only: an empty wallet 402s before any run, a funded wallet
// debits exactly 1 credit per run (settled), and a failed run releases its
// hold back to zero net spend. Does NOT touch schedule-ai-route.test.ts /
// officials-ai-route.test.ts (red baseline — AI-route timeouts stay out of
// scope, see docs/superpowers/plans/2026-07-24-v17-phase2-wallet.md Task 4).
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { AiChatResponse } from "@/server/ai/provider";

const { chat } = vi.hoisted(() => ({ chat: vi.fn() }));
// The stage-1 instruction compiler (#398) makes its own LLM call, BEFORE the
// architect's. This suite drives the architect through a mocked SDK whose queue
// is 1:1 with architect calls, so an un-neutralised pre-flight silently eats the
// first queued response and every count below shifts by one. The compiler has
// its own suites (schedule-ai-parse.test.ts, calendar-instruction.test.ts); here
// it must simply not exist.
const { parseInstructionMock } = vi.hoisted(() => ({
  parseInstructionMock: vi.fn(async () => ({
    raw: null,
    failed: false,
    tokens: 0,
    servedModel: null,
  })),
}));
vi.mock("../schedule-ai-parse", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../schedule-ai-parse")>();
  return { ...actual, parseInstruction: parseInstructionMock };
});

vi.mock("@/server/ai/select-provider", () => {
  const provider = { id: "anthropic" as const, isConfigured: () => true, chat };
  return {
    selectProvider: () => provider,
    resolveProvider: () => provider,
  };
});

import { sql } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { createStages, generateStageFixtures } from "../stages";
import { aiPlanForDivision } from "../schedule-ai";
import { officialsAiPlanForDivision } from "../officials-ai";
import { GENERIC_CONFIG, seedOrg } from "./_seed";
import { setOrgPlan } from "@/lib/__tests__/_billing-group";
import { balance, walletIdFor } from "@/lib/credits";

const HAS_DB = !!process.env.DATABASE_URL;
const TZ = "Europe/London";
const MIN = 60_000;
const BASE = Date.parse("2026-08-01T09:00:00.000Z");

const SCHEDULE_SETTINGS_CONFIG = {
  startAt: "2026-08-01T09:00:00.000Z",
  matchMinutes: 30,
  gapMinutes: 0,
  courts: ["Court 1", "Court 2"],
  perEntrantMinRest: 20,
  blackouts: [],
  sessionWindows: [{ from: "2026-08-01T09:00:00.000Z", to: "2026-08-01T18:00:00.000Z" }],
  constraints: {
    restMin: 20,
    noBackToBack: false,
    startWindows: [],
    fieldFairness: "balance",
    parallelism: "mixed",
    crossPersonClash: "hard",
  },
};

async function setScheduleSettings(divisionId: string): Promise<void> {
  await sql`
    insert into schedule_settings (division_id, config, tz, updated_at)
    values (${divisionId}, ${sql.json(SCHEDULE_SETTINGS_CONFIG)}, ${TZ}, now())
    on conflict (division_id) do update set config = excluded.config, tz = excluded.tz`;
}

/** A timed division with 4 entrants (RR fixtures, all movable) + settings.
 *  Optionally seeds `officials` referees (buildOfficialsPack 422s on none). */
async function seedPlannableDivision(
  auth: AuthCtx,
  opts: { officials?: number } = {},
): Promise<{ divisionId: string; fixtureIds: string[] }> {
  const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "Wallet AI", visibility: "public", branding: {} });
  const division = await createDivision(auth, comp.id, {
    name: "Open",
    slug: `open-${randomUUID().slice(0, 6)}`,
    sport_key: "generic",
    variant_key: "score",
    config: GENERIC_CONFIG,
    eligibility: [],
  });
  await createEntrants(
    auth,
    division.id,
    Array.from({ length: 4 }, (_, i) => ({
      kind: "individual" as const,
      display_name: `E${i + 1}`,
      seed: i + 1,
      members: [],
    })),
  );
  await setScheduleSettings(division.id);
  const [stage] = await createStages(auth, division.id, { seq: 1, kind: "league", name: "League", config: {} });
  const { fixtures } = await generateStageFixtures(auth, stage!.id);
  for (let i = 0; i < (opts.officials ?? 0); i++) {
    await sql`
      insert into officials (org_id, display_name, role_keys)
      values (${auth.orgId}, ${"Ref " + i}, ${sql.json(["referee"])})`;
  }
  return { divisionId: division.id, fixtureIds: fixtures.map((f) => f.id) };
}

function legalPlan(fixtureIds: string[]): unknown {
  return {
    assignments: fixtureIds.map((id, i) => ({
      fixture_id: id,
      scheduled_at: new Date(BASE + Math.floor(i / 2) * 30 * MIN).toISOString(),
      court_label: `Court ${(i % 2) + 1}`,
    })),
    unschedulable: [],
    explanations: [],
    summary: "ok",
  };
}

/** AiChatResponse-shaped success — the fake provider's `chat()` return. */
function chatResponse(parsed: unknown): AiChatResponse<unknown> {
  return {
    parsed,
    assistantTurn: { role: "assistant", content: [] },
    usage: { inputTokens: 1000, outputTokens: 500, costUsd: 0.01 },
    servedModel: "claude-sonnet-5",
    refused: false,
  };
}

/** A model refusal — a genuine model failure the ladder cannot recover from
 *  (distinct from a config/timeout short-circuit). */
function refusalResponse(): AiChatResponse<unknown> {
  return {
    parsed: null,
    assistantTurn: { role: "assistant", content: [] },
    usage: { inputTokens: 700, outputTokens: 40, costUsd: 0 },
    servedModel: "claude-sonnet-5",
    refused: true,
  };
}

/** community org promoted to pro_plus directly — mirrors
 *  officials-ai-route.test.ts's seedPlusOrg. Plan no longer matters on the AI
 *  officials path (Task 4 review: officials.auto, Pro Plus post-V290, is the
 *  MANUAL officials.ts gate, not this one) — kept around for parity with the
 *  zero-LLM-call solver-draft test below, which isn't plan-specific either. */
async function seedPlusOrg(): Promise<AuthCtx> {
  const { auth } = await seedOrg("community");
  await setOrgPlan(auth.orgId, "pro_plus");
  await invalidateOrgEntitlements(auth.orgId);
  return auth;
}

/** Direct-insert grant, bypassing lib/credits.ts's grant plumbing (Task 2/6 —
 *  not wired into checkout yet) so these tests control the wallet balance
 *  precisely without depending on plan/billing-cycle timing. */
async function grantCredits(walletId: string, n: number): Promise<void> {
  await sql`
    insert into ai_credit_ledger (wallet_id, delta, source, bucket, balance_after)
    values (${walletId}, ${n}, 'admin_adjust', 'grant', ${n})`;
}

async function ledgerRows(
  walletId: string,
): Promise<{ delta: number; source: string; ref: string | null }[]> {
  return sql<{ delta: number; source: string; ref: string | null }[]>`
    select delta, source, ref from ai_credit_ledger where wallet_id = ${walletId} order by created_at`;
}

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

beforeEach(() => {
  chat.mockReset();
});

describe.skipIf(!HAS_DB)("AI credit wallet metering — schedule-ai (SPEC-2 §5.2, Task 4)", () => {
  it("a community org with 0 credits gets 402 before any model call", async () => {
    const { auth } = await seedOrg("community");
    const { divisionId } = await seedPlannableDivision(auth);
    const walletId = await walletIdFor(auth.orgId);
    expect(await balance(walletId)).toBe(0);

    await expect(
      aiPlanForDivision(auth, divisionId, { instruction: "plan it", mode: "generate" }),
    ).rejects.toMatchObject({ status: 402, featureKey: "ai.credits" });
    expect(chat).not.toHaveBeenCalled();
    expect(await balance(walletId)).toBe(0);
    expect(await ledgerRows(walletId)).toHaveLength(0);
  });

  it("a funded wallet spends exactly 1 credit per successful run (settled to the run)", async () => {
    const { auth } = await seedOrg("community");
    const { divisionId, fixtureIds } = await seedPlannableDivision(auth);
    const walletId = await walletIdFor(auth.orgId);
    await grantCredits(walletId, 5);

    chat.mockResolvedValueOnce(chatResponse(legalPlan(fixtureIds)));
    const out = await aiPlanForDivision(auth, divisionId, { instruction: "plan it", mode: "generate" });
    expect(out.proposal).toHaveLength(fixtureIds.length);
    expect(await balance(walletId)).toBe(4);

    const rows = await ledgerRows(walletId);
    const spends = rows.filter((r) => r.source === "run_spend");
    expect(spends).toHaveLength(1);
    expect(spends[0]).toMatchObject({ delta: -1 });
    expect(spends[0]!.ref).not.toBeNull(); // settle() linked the ai_run_id
  });

  it("a failed run (model refusal) releases the hold — net zero credits spent", async () => {
    const { auth } = await seedOrg("community");
    const { divisionId } = await seedPlannableDivision(auth);
    const walletId = await walletIdFor(auth.orgId);
    await grantCredits(walletId, 5);

    // A refusal is a genuine model failure (not a config/timeout short-circuit):
    // runAiPlan surfaces it as 422 AI_PLAN_FAILED, so spendCredit releases.
    chat.mockResolvedValueOnce(refusalResponse());
    await expect(
      aiPlanForDivision(auth, divisionId, { instruction: "plan it", mode: "generate" }),
    ).rejects.toMatchObject({ code: "AI_PLAN_FAILED" });

    expect(await balance(walletId)).toBe(5); // unchanged — release refunded the hold
    const rows = await ledgerRows(walletId);
    const spends = rows.filter((r) => r.source === "run_spend");
    const refunds = rows.filter((r) => r.source === "refund");
    expect(spends).toHaveLength(1);
    expect(refunds).toHaveLength(1);
    expect(spends[0]!.ref).toBeNull(); // never settled — the run never happened
  });

  // Token-weighted AI credit rung (design ai-rung.ts): the amount spendCredit
  // reserves is now `rung`, not a hardcoded 1 — these pin that the wallet and
  // the audit ledger both follow the chosen rung, not the prediction.
  it("an explicit rung above the prediction charges that many credits and stamps the ledger", async () => {
    const { auth } = await seedOrg("community");
    const { divisionId, fixtureIds } = await seedPlannableDivision(auth);
    const walletId = await walletIdFor(auth.orgId);
    await grantCredits(walletId, 5);

    // This pack (4 entrants, 2 courts, a handful of fixtures) predicts rung 1
    // under the default AI_RUNG_* thresholds — picking rung 2 is a deliberate
    // over-spend, never `underfunded`.
    chat.mockResolvedValueOnce(chatResponse(legalPlan(fixtureIds)));
    const out = await aiPlanForDivision(auth, divisionId, {
      instruction: "plan it",
      mode: "generate",
      rung: 2,
    });
    expect(out.rung).toBe(2);
    expect(out.predicted_rung).toBe(1);
    expect(out.underfunded).toBe(false);
    expect(out.budget).toBe(64_000);
    expect(await balance(walletId)).toBe(3); // 5 - 2

    const rows = await ledgerRows(walletId);
    const spends = rows.filter((r) => r.source === "run_spend");
    expect(spends).toHaveLength(1);
    expect(spends[0]).toMatchObject({ delta: -2 });

    const [event] = await sql<{ payload: Record<string, unknown> }[]>`
      select payload from competition_events
      where type = 'schedule.ai_generated' and payload->>'division_id' = ${divisionId}`;
    expect(event!.payload.rung).toBe(2);
    expect(event!.payload.predicted_rung).toBe(1);
    expect(event!.payload.underfunded).toBe(false);
    expect(event!.payload.budget).toBe(64_000);
  });

  it("choosing below the predicted rung is honoured and stamps underfunded", async () => {
    const savedS1 = process.env.AI_RUNG_S1;
    process.env.AI_RUNG_S1 = "0"; // force this pack's prediction above rung 1
    try {
      const { auth } = await seedOrg("community");
      const { divisionId, fixtureIds } = await seedPlannableDivision(auth);
      const walletId = await walletIdFor(auth.orgId);
      await grantCredits(walletId, 5);

      chat.mockResolvedValueOnce(chatResponse(legalPlan(fixtureIds)));
      const out = await aiPlanForDivision(auth, divisionId, {
        instruction: "plan it",
        mode: "generate",
        rung: 1,
      });
      expect(out.predicted_rung).toBeGreaterThan(1);
      expect(out.rung).toBe(1);
      expect(out.underfunded).toBe(true);
      expect(await balance(walletId)).toBe(4); // charged only the chosen rung (1)

      const [event] = await sql<{ payload: Record<string, unknown> }[]>`
        select payload from competition_events
        where type = 'schedule.ai_generated' and payload->>'division_id' = ${divisionId}`;
      expect(event!.payload.underfunded).toBe(true);
      expect(event!.payload.rung).toBe(1);
      expect(event!.payload.credits).toBe(1);
      // Finished inside its budget — this is what a healthy run looks like, so
      // the cliff stamp below means something.
      expect(event!.payload.stopped_on_budget).toBe(false);
    } finally {
      if (savedS1 === undefined) delete process.env.AI_RUNG_S1;
      else process.env.AI_RUNG_S1 = savedS1;
    }
  });

  // `underfunded` only records what the USER picked. It cannot tell a run that
  // finished cleanly from one the budget cut short — which is exactly the
  // signal needed to spot a mispriced rung while the predictor is still
  // uncalibrated. `stopped_on_budget` is that signal, and it must survive onto
  // the ledger on the failure path too.
  it("stamps stopped_on_budget on a run the token budget cut short, and charges nothing", async () => {
    const savedBudget = process.env.AI_RUNG_BUDGET_1;
    process.env.AI_RUNG_BUDGET_1 = "500"; // below the per-round reserve → no round can start
    try {
      const { auth } = await seedOrg("community");
      const { divisionId } = await seedPlannableDivision(auth);
      const walletId = await walletIdFor(auth.orgId);
      await grantCredits(walletId, 5);

      await expect(
        aiPlanForDivision(auth, divisionId, { instruction: "plan it", mode: "generate", rung: 1 }),
      ).rejects.toMatchObject({ code: "AI_PLAN_FAILED" });

      expect(chat).not.toHaveBeenCalled(); // refused before any COGS
      expect(await balance(walletId)).toBe(5); // hold released — a failed run is free

      const [event] = await sql<{ payload: Record<string, unknown> }[]>`
        select payload from competition_events
        where type = 'schedule.ai_failed' and payload->>'division_id' = ${divisionId}`;
      expect(event!.payload.stopped_on_budget).toBe(true);
      expect(event!.payload.budget).toBe(500);
      expect(event!.payload.credits).toBe(1);
    } finally {
      if (savedBudget === undefined) delete process.env.AI_RUNG_BUDGET_1;
      else process.env.AI_RUNG_BUDGET_1 = savedBudget;
    }
  });
});

const POLICY = {
  roles: ["referee"],
  poolLock: false,
  blockStay: false,
  fairness: "tournament" as const,
  teamRefKeepDivision: false,
  restMinMinutes: 0,
  blockGapMinutes: 30,
};

function spread(fixtureIds: string[], gapMin = 120): { fixture_id: string; scheduled_at: string; court_label: string }[] {
  return fixtureIds.map((id, i) => ({
    fixture_id: id,
    scheduled_at: new Date(BASE + i * gapMin * MIN).toISOString(),
    court_label: "Court 1",
  }));
}

describe.skipIf(!HAS_DB)("AI credit wallet metering — officials-ai (SPEC-2 §5.2, Task 4)", () => {
  it("a pro_plus org with 0 credits gets 402 before any model call", async () => {
    const auth = await seedPlusOrg();
    const { divisionId, fixtureIds } = await seedPlannableDivision(auth, { officials: 1 });
    const walletId = await walletIdFor(auth.orgId);
    expect(await balance(walletId)).toBe(0);

    await expect(
      officialsAiPlanForDivision(auth, divisionId, {
        instruction: "cover it",
        policy: POLICY,
        schedule: spread(fixtureIds),
      }),
    ).rejects.toMatchObject({ status: 402, featureKey: "ai.credits" });
    expect(chat).not.toHaveBeenCalled();
    expect(await balance(walletId)).toBe(0);
  });

  it("a funded wallet spends exactly 1 credit per run — including the zero-LLM-call solver draft", async () => {
    const auth = await seedPlusOrg();
    const { divisionId, fixtureIds } = await seedPlannableDivision(auth, { officials: 1 });
    const walletId = await walletIdFor(auth.orgId);
    await grantCredits(walletId, 3);

    // Empty instruction takes the deterministic solver-draft path (zero LLM
    // calls) — the wallet still meters it as one run (SPEC-2: 1 credit = 1 run).
    const out = await officialsAiPlanForDivision(auth, divisionId, {
      instruction: "",
      policy: POLICY,
      schedule: spread(fixtureIds),
    });
    expect(chat).not.toHaveBeenCalled();
    expect(out.usage).toEqual({ input_tokens: 0, output_tokens: 0, repair_rounds: 0 });
    expect(await balance(walletId)).toBe(2);

    const rows = await ledgerRows(walletId);
    const spends = rows.filter((r) => r.source === "run_spend");
    expect(spends).toHaveLength(1);
    expect(spends[0]).toMatchObject({ delta: -1 });
    expect(spends[0]!.ref).not.toBeNull();
  });

  // Task 4 review (CRITICAL): officials-ai.ts was calling
  // requireFeature(orgId, "officials.auto") — a Pro-Plus-only bool — BEFORE
  // the wallet spend, so a Community org got a plan-upgrade 402 even with
  // credits. The wallet must be the ONLY gate, on any tier (SPEC-1 §5, §7).
  it("a Community org WITH credits can run AI officials (no plan gate, wallet-metered)", async () => {
    const { auth } = await seedOrg("community");
    const { divisionId, fixtureIds } = await seedPlannableDivision(auth, { officials: 1 });
    const walletId = await walletIdFor(auth.orgId);
    await grantCredits(walletId, 3);

    const out = await officialsAiPlanForDivision(auth, divisionId, {
      instruction: "",
      policy: POLICY,
      schedule: spread(fixtureIds),
    });
    expect(chat).not.toHaveBeenCalled();
    expect(out.usage).toEqual({ input_tokens: 0, output_tokens: 0, repair_rounds: 0 });
    expect(await balance(walletId)).toBe(2);

    const rows = await ledgerRows(walletId);
    const spends = rows.filter((r) => r.source === "run_spend");
    expect(spends).toHaveLength(1);
    expect(spends[0]).toMatchObject({ delta: -1 });
    expect(spends[0]!.ref).not.toBeNull();
  });

  it("a Community org with 0 credits gets 402 from the wallet, not a plan gate", async () => {
    const { auth } = await seedOrg("community");
    const { divisionId, fixtureIds } = await seedPlannableDivision(auth, { officials: 1 });
    const walletId = await walletIdFor(auth.orgId);
    expect(await balance(walletId)).toBe(0);

    await expect(
      officialsAiPlanForDivision(auth, divisionId, {
        instruction: "cover it",
        policy: POLICY,
        schedule: spread(fixtureIds),
      }),
    ).rejects.toMatchObject({ status: 402, featureKey: "ai.credits" });
    expect(chat).not.toHaveBeenCalled();
    expect(await balance(walletId)).toBe(0);
  });

  // REGRESSION (token-weighted rungs, lib/ai-rung.ts): the empty-instruction
  // path returns the deterministic solver draft with ZERO model calls, so it
  // burns no COGS at all. Pricing it from the pack — as every other run is
  // priced — charged a large division 2 or 3 credits for that free draft. It
  // cost 1 credit before rung pricing existed; it must still cost 1.
  it("prices the zero-LLM-call solver draft at 1 credit even when the pack predicts a higher rung", async () => {
    const savedS1 = process.env.AI_RUNG_OFFICIALS_S1;
    const savedS2 = process.env.AI_RUNG_OFFICIALS_S2;
    process.env.AI_RUNG_OFFICIALS_S1 = "0"; // force this pack above rung 1...
    process.env.AI_RUNG_OFFICIALS_S2 = "0"; // ...all the way to rung 3
    try {
      const { auth } = await seedOrg("community");
      const { divisionId, fixtureIds } = await seedPlannableDivision(auth, { officials: 1 });
      const walletId = await walletIdFor(auth.orgId);
      await grantCredits(walletId, 3);

      const out = await officialsAiPlanForDivision(auth, divisionId, {
        instruction: "",
        policy: POLICY,
        schedule: spread(fixtureIds),
      });

      expect(chat).not.toHaveBeenCalled();
      expect(out.credits).toBe(1);
      expect(out.rung).toBe(1);
      expect(out.underfunded).toBe(false); // not "cheaped out" — there is nothing to fund
      expect(await balance(walletId)).toBe(2); // 3 − 1, NOT 3 − 3

      const spends = (await ledgerRows(walletId)).filter((r) => r.source === "run_spend");
      expect(spends).toHaveLength(1);
      expect(spends[0]).toMatchObject({ delta: -1 });
    } finally {
      if (savedS1 === undefined) delete process.env.AI_RUNG_OFFICIALS_S1;
      else process.env.AI_RUNG_OFFICIALS_S1 = savedS1;
      if (savedS2 === undefined) delete process.env.AI_RUNG_OFFICIALS_S2;
      else process.env.AI_RUNG_OFFICIALS_S2 = savedS2;
    }
  });
});
