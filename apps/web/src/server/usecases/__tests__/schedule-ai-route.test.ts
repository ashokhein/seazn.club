// v4/00 §5 + 03 §2 — aiPlanForDivision orchestrator (Task 6): the gate order
// (kill switch → paid gate → rate limit), the dry officials coverage preview,
// the constraint-suggestions epoch→ISO round-trip, and telemetry on success and
// on a 422. The Anthropic SDK, PostHog, and the Redis window counter are mocked;
// everything else (entitlements, the pack builder) hits real Postgres, so the
// suite is skipped without DATABASE_URL.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

// Hoisted mock handles — referenced from vi.mock factories (which hoist above
// imports), so they must be created with vi.hoisted.
const { parse, isServerFeatureEnabled, captureServer, incrWindow, rlCounts, MockAPIError } =
  vi.hoisted(() => {
    const rlCounts = new Map<string, number>();
    // The real SDK exposes `Anthropic.APIError`; schedule-ai.ts branches on it to
    // tell a provider outage (billing/rate-limit/overload) from a planning
    // failure. The mock must carry it or that branch is unreachable under test.
    class MockAPIError extends Error {
      status: number;
      constructor(status: number, message: string) {
        super(message);
        this.name = "APIError";
        this.status = status;
      }
    }
    return {
      MockAPIError,
      parse: vi.fn(),
      isServerFeatureEnabled: vi.fn(),
      captureServer: vi.fn(),
      incrWindow: vi.fn(async (key: string) => {
        const n = (rlCounts.get(key) ?? 0) + 1;
        rlCounts.set(key, n);
        return n;
      }),
      rlCounts,
    };
  });

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

vi.mock("@anthropic-ai/sdk", () => ({
  default: Object.assign(
    class Anthropic {
      messages = { parse };
    },
    { APIError: MockAPIError },
  ),
}));
vi.mock("@/lib/posthog-server", () => ({
  isServerFeatureEnabled,
  captureServer,
}));
// Keep the real cache-aside helpers (entitlements resolution) but drive the
// fixed-window rate limiter off an in-memory counter so the 429 path is real.
vi.mock("@/lib/cache", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/cache")>();
  return { ...actual, incrWindow };
});

// vi.hoisted for the same reason as the block at the top of this file: the
// vi.mock factory below is hoisted above every import, so a plain top-level
// const would still be in its TDZ when schedule-ai.ts pulls ai-runs-admin in.
const { maybeAlertExpensiveRun } = vi.hoisted(() => ({
  maybeAlertExpensiveRun: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/server/usecases/ai-runs-admin", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ai-runs-admin")>();
  return { ...actual, maybeAlertExpensiveRun };
});

import { sql } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { createStages, generateStageFixtures } from "../stages";
import { aiPlanForDivision } from "../schedule-ai";
import { maybeAlertExpensiveRun as maybeAlertExpensiveRunSpy } from "../ai-runs-admin";
import { GENERIC_CONFIG, seedOrg } from "./_seed";

import { setOrgPlan } from "@/lib/__tests__/_billing-group";
import { balance, recordPackPurchase, reserve, walletIdFor } from "@/lib/credits";
import { recordPassPurchase } from "@/lib/billing";
import { PASS_CREDIT_GRANT } from "@/lib/pricing-cards";
const HAS_DB = !!process.env.DATABASE_URL;
const TZ = "Europe/London";
const MIN = 60_000;

const SETTINGS_CONFIG = {
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

async function setSettings(divisionId: string): Promise<void> {
  await sql`
    insert into schedule_settings (division_id, config, tz, updated_at)
    values (${divisionId}, ${sql.json(SETTINGS_CONFIG)}, ${TZ}, now())
    on conflict (division_id) do update set config = excluded.config, tz = excluded.tz`;
}

/** community org promoted to pro_plus directly (seedOrg only knows pro/community).
 *  AI runs are wallet-metered on every tier now (v17 SPEC-2 §5.2), and seedOrg
 *  never runs the org-creation bootstrap grant, so fund the wallet with a pack
 *  well above any test's run count — otherwise every "should-run" test would
 *  402 ai.credits at the reserve before reaching the mocked provider. */
async function seedPlusOrg(): Promise<AuthCtx> {
  const { auth } = await seedOrg("community");
  await setOrgPlan(auth.orgId, "pro_plus");
  await invalidateOrgEntitlements(auth.orgId);
  await recordPackPurchase(await walletIdFor(auth.orgId), 100, `seed-${randomUUID()}`);
  return auth;
}

/** A timed division with 4 entrants (6 RR fixtures, all movable) + settings.
 *  Optionally seeds one referee official for the coverage preview. */
async function seedPlannable(
  auth: AuthCtx,
  opts: { officials?: boolean } = {},
): Promise<{ divisionId: string; fixtureIds: string[] }> {
  const comp = await createCompetition(auth, {
    name: "AI Arch",
    visibility: "public",
    branding: {},
  });
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
  await setSettings(division.id);
  const [stage] = await createStages(auth, division.id, {
    seq: 1,
    kind: "league",
    name: "League",
    config: {},
  });
  const { fixtures } = await generateStageFixtures(auth, stage!.id);
  if (opts.officials) {
    await sql`
      insert into officials (org_id, display_name, role_keys)
      values (${auth.orgId}, 'Zed Referee', ${sql.json(["referee"])})`;
  }
  return { divisionId: division.id, fixtureIds: fixtures.map((f) => f.id) };
}

// Direct-insert bulk seeder to trip the >500 movable limit.
async function seedBigDivision(auth: AuthCtx, n: number): Promise<string> {
  const comp = await createCompetition(auth, {
    name: `Big ${randomUUID().slice(0, 6)}`,
    visibility: "public",
    branding: {},
  });
  const division = await createDivision(auth, comp.id, {
    name: "Big",
    slug: `big-${randomUUID().slice(0, 6)}`,
    sport_key: "generic",
    variant_key: "score",
    config: GENERIC_CONFIG,
    eligibility: [],
  });
  await setSettings(division.id);
  const [stage] = await createStages(auth, division.id, {
    seq: 1,
    kind: "league",
    name: "L",
    config: {},
  });
  await sql`
    insert into fixtures (stage_id, division_id, org_id, round_no, seq_in_round, ext_key, status)
    select ${stage!.id}, ${division.id}, ${auth.orgId}, (g / 20)::int, (g % 20)::int, 'big-' || g, 'scheduled'
    from generate_series(1, ${n}) g`;
  return division.id;
}

// A legal plan over the given fixture ids: 2 courts, 30-min slots from 10:00
// local (inside the 09:00-18:00Z window) — no court clash, so no blocking.
const BASE = Date.parse("2026-08-01T10:00:00+01:00");
function legalPlan(
  fixtureIds: string[],
  extra: { constraint_suggestions?: unknown } = {},
): unknown {
  return {
    assignments: fixtureIds.map((id, i) => ({
      fixture_id: id,
      scheduled_at: new Date(BASE + Math.floor(i / 2) * 30 * MIN).toISOString(),
      court_label: `Court ${(i % 2) + 1}`,
    })),
    unschedulable: [],
    explanations: [],
    summary: "ok",
    ...extra,
  };
}

function planResponse(p: unknown, usage: unknown = { input_tokens: 1000, output_tokens: 500 }) {
  return { parsed_output: p, stop_reason: "end_turn", usage, content: [] };
}

const POLICY = {
  roles: ["referee"],
  poolLock: false,
  blockStay: false,
  fairness: "tournament" as const,
  teamRefKeepDivision: false,
  restMinMinutes: 0,
  blockGapMinutes: 30,
};

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

beforeEach(() => {
  parse.mockReset();
  parseInstructionMock.mockClear();
  isServerFeatureEnabled.mockReset().mockResolvedValue(true);
  captureServer.mockReset().mockResolvedValue(undefined);
  maybeAlertExpensiveRun.mockClear();
  rlCounts.clear();
  process.env.ANTHROPIC_API_KEY = "test-key";
  // Keep the model ladder on the mocked Anthropic rung: this worktree's dev
  // .env.local carries a real OPENROUTER_API_KEY, which vitest loads. Left set,
  // DEFAULT_LADDER's first (OpenRouter) rung reports configured and the runner
  // makes a genuine live call that hangs the test. Unsetting it (as CI's env is)
  // makes the OpenRouter rungs skip to the mocked sonnet rung — hermetic again.
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.AI_PROVIDER;
});

describe.skipIf(!HAS_DB)("aiPlanForDivision gates (v4/00 §5, credit-metered v17)", () => {
  it("each AI run spends 1 credit; a community org runs until its wallet empties, then 402 ai.credits", async () => {
    // The V302 per-division run cap is retired (Phase 2 Task 5, V322). The only
    // spend limit now is the credit wallet: every run costs exactly 1 credit,
    // runs succeed while ≥1 remains, then the reserve throws 402 ai.credits.
    const { auth } = await seedOrg("community");
    const { divisionId, fixtureIds } = await seedPlannable(auth);
    // Community starts with an empty wallet (seedOrg skips the bootstrap grant);
    // fund exactly two credits so two runs land and the third exhausts it.
    await recordPackPurchase(await walletIdFor(auth.orgId), 2, `fund-${randomUUID()}`);
    parse.mockResolvedValue(planResponse(legalPlan(fixtureIds)));
    for (let i = 0; i < 2; i++) {
      const out = await aiPlanForDivision(auth, divisionId, {
        instruction: "plan it",
        mode: "generate",
      });
      expect(out.proposal).toHaveLength(fixtureIds.length);
    }
    await expect(
      aiPlanForDivision(auth, divisionId, {
        instruction: "plan it",
        mode: "generate",
      }),
    ).rejects.toMatchObject({
      status: 402,
      featureKey: "ai.credits",
    });
    expect(parse).toHaveBeenCalledTimes(2); // the exhausted run never reaches the LLM
    // ...and neither does the stage-1 compiler (#398). It is UNPRICED, which is
    // not the same as free: an org that cannot pay for the run must not be able
    // to spend our tokens compiling an instruction for it. Two funded runs
    // compiled; the exhausted third did not.
    expect(parseInstructionMock).toHaveBeenCalledTimes(2);
  });

  it("real runs record schedule.ai_generated events; a credit-exhausted run records nothing", async () => {
    const { auth } = await seedOrg("pro");
    const { divisionId, fixtureIds } = await seedPlannable(auth);
    await recordPackPurchase(await walletIdFor(auth.orgId), 2, `fund-${randomUUID()}`);
    parse.mockResolvedValue(planResponse(legalPlan(fixtureIds)));
    // Two real generations append schedule.ai_generated events…
    for (let i = 0; i < 2; i++) {
      const out = await aiPlanForDivision(auth, divisionId, {
        instruction: "plan",
        mode: "generate",
      });
      expect(out.proposal).toHaveLength(fixtureIds.length);
    }
    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from competition_events
      where type = 'schedule.ai_generated'
        and payload->>'division_id' = ${divisionId} and payload->>'mode' = 'generate'`;
    expect(n).toBe(2);
    // …and once the wallet is empty the next run is blocked at the reserve,
    // BEFORE the LLM → 402 ai.credits, and a blocked run is never recorded.
    await expect(
      aiPlanForDivision(auth, divisionId, {
        instruction: "plan",
        mode: "generate",
      }),
    ).rejects.toMatchObject({
      status: 402,
      featureKey: "ai.credits",
    });
    expect(parse).toHaveBeenCalledTimes(2);
    // A blocked run is never recorded (still two).
    const [{ n: after }] = await sql<{ n: number }[]>`
      select count(*)::int as n from competition_events
      where type = 'schedule.ai_generated' and payload->>'division_id' = ${divisionId}`;
    expect(after).toBe(2);
  });

  it("run ledger carries model/usage/cost; failures land as schedule.ai_failed and never record a generation", async () => {
    const auth = await seedPlusOrg();
    const { divisionId, fixtureIds } = await seedPlannable(auth);

    // Success: audit payload + capture both stamp model, usage and cost_usd.
    parse.mockResolvedValueOnce(planResponse(legalPlan(fixtureIds)));
    await aiPlanForDivision(auth, divisionId, {
      instruction: "plan",
      mode: "generate",
    });
    const [ok] = await sql<{ payload: Record<string, unknown> }[]>`
      select payload from competition_events
      where type = 'schedule.ai_generated' and payload->>'division_id' = ${divisionId}`;
    expect(ok!.payload.model).toBe("claude-sonnet-5");
    expect((ok!.payload.usage as { input_tokens: number }).input_tokens).toBeGreaterThan(0);
    expect(typeof ok!.payload.cost_usd).toBe("number");
    const okCall = captureServer.mock.calls.find(
      (c) => (c[0] as { properties: { outcome: string } }).properties.outcome === "ok",
    )![0] as { properties: { model: string; cost_usd: number } };
    expect(okCall.properties.model).toBe("claude-sonnet-5");
    expect(typeof okCall.properties.cost_usd).toBe("number");

    // Failure (refusal → 422 AI_PLAN_FAILED): metered as schedule.ai_failed…
    parse.mockResolvedValueOnce({
      parsed_output: null,
      stop_reason: "refusal",
      usage: { input_tokens: 700, output_tokens: 40 },
    });
    await expect(
      aiPlanForDivision(auth, divisionId, {
        instruction: "plan",
        mode: "generate",
      }),
    ).rejects.toMatchObject({ code: "AI_PLAN_FAILED" });
    const [failed] = await sql<{ payload: Record<string, unknown> }[]>`
      select payload from competition_events
      where type = 'schedule.ai_failed' and payload->>'division_id' = ${divisionId}`;
    expect(failed!.payload.outcome).toBe("failed");
    expect((failed!.payload.usage as { input_tokens: number }).input_tokens).toBe(700);
    // …and the generated-event type still shows exactly the one success (a
    // failed run releases its credit hold and records no schedule.ai_generated).
    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from competition_events
      where type = 'schedule.ai_generated' and payload->>'division_id' = ${divisionId}`;
    expect(n).toBe(1);
  });

  it("records pack_units alongside cost, and calls the expensive-run alert check with the run's numbers (v17 gap #295)", async () => {
    const auth = await seedPlusOrg();
    const { divisionId, fixtureIds } = await seedPlannable(auth);
    parse.mockResolvedValueOnce(planResponse(legalPlan(fixtureIds)));

    // CALL-ORDER PIN: the alert must run AFTER the schedule.ai_generated row is
    // committed. maybeAlertExpensiveRun reads its baseline median out of that
    // same competition_events table, so the order decides whether a run is
    // counted in its own baseline. At AI_RUN_MEDIAN_MIN_SAMPLE=20 the effect is
    // arithmetically moot, but the contract must not drift silently — so the
    // spy snapshots the committed row count at the moment it is called.
    let generatedRowsWhenAlerted = -1;
    maybeAlertExpensiveRun.mockImplementationOnce(async () => {
      const [row] = await sql<{ n: number }[]>`
        select count(*)::int as n from competition_events
        where type = 'schedule.ai_generated' and payload->>'division_id' = ${divisionId}`;
      generatedRowsWhenAlerted = row!.n;
    });

    await aiPlanForDivision(auth, divisionId, { instruction: "plan", mode: "generate" });

    const [ok] = await sql<{ payload: Record<string, unknown> }[]>`
      select payload from competition_events
      where type = 'schedule.ai_generated' and payload->>'division_id' = ${divisionId}`;
    // buildSchedulePack put every fixture in scope (no repair scope) — pack_units
    // is the same count already reported to PostHog as `fixtures`.
    expect(ok!.payload.pack_units).toBe(fixtureIds.length);

    expect(maybeAlertExpensiveRun).toHaveBeenCalledTimes(1);
    // The call is deferred tail work (the tenant's response must not block on a
    // median scan + email send), so the snapshot lands a tick later — but it
    // still proves the ledger row was committed before the alert ran. Generous
    // timeout: the spy body runs a real count(*) against a loaded CI database.
    await vi.waitFor(() => expect(generatedRowsWhenAlerted).toBe(1), { timeout: 5000 });
    const call = vi.mocked(maybeAlertExpensiveRunSpy).mock.calls[0]![0] as {
      orgId: string;
      competitionId: string;
      phase: string;
      model: string;
      costUsd: number | null;
      mode?: string | null;
      packUnits?: number | null;
    };
    expect(call.orgId).toBe(auth.orgId);
    expect(call.phase).toBe("schedule");
    expect(typeof call.costUsd).toBe("number");
    // The staff alert has to be triageable on its own (v17 gap #295 fold): the
    // requested mode and the pack size travel with the cost, and the size is
    // the SAME number stamped on the ledger row above — the alert and the
    // audit trail can never disagree about how big the run was.
    expect(call.mode).toBe("generate");
    expect(call.packUnits).toBe(fixtureIds.length);
    expect(call.packUnits).toBe(ok!.payload.pack_units);

    // Failures carry pack_units too (same fixture count the failed attempt saw).
    parse.mockResolvedValueOnce({
      parsed_output: null,
      stop_reason: "refusal",
      usage: { input_tokens: 700, output_tokens: 40 },
    });
    await expect(
      aiPlanForDivision(auth, divisionId, { instruction: "plan", mode: "generate" }),
    ).rejects.toMatchObject({ code: "AI_PLAN_FAILED" });
    const [failed] = await sql<{ payload: Record<string, unknown> }[]>`
      select payload from competition_events
      where type = 'schedule.ai_failed' and payload->>'division_id' = ${divisionId}`;
    expect(failed!.payload.pack_units).toBe(fixtureIds.length);
    // A failed run is not compared for the expensive-run alert (only ok) — a
    // costly failure is a different alert class (#295 scope decision).
    expect(maybeAlertExpensiveRun).toHaveBeenCalledTimes(1);
  });

  // The V302 per-division run caps (Pro 20 / Pro Plus 50) and their admin
  // int-override lift are retired outright (Phase 2 Task 5, V322 deleted the
  // scheduling.ai.runs_per_division.max plan rows). There is no "cap at N runs"
  // behavior left to assert — credit exhaustion (the two tests above) is the
  // only spend limit now, so the cap/override-lift cases are gone, not rewritten.

  it("an Event Pass grants PASS_CREDIT_GRANT one-time AI credits; once drained the org 402s again", async () => {
    const { auth } = await seedOrg("community");
    const { divisionId, fixtureIds } = await seedPlannable(auth);
    const [{ competition_id }] = await sql<{ competition_id: string }[]>`
      select competition_id from divisions where id = ${divisionId}`;
    // The pass buyer's wallet starts empty (seedOrg skips the bootstrap grant).
    const walletId = await walletIdFor(auth.orgId);
    expect(await balance(walletId)).toBe(0);
    // Buying the Event Pass tops the wallet up by the one-time grant the /pricing
    // card advertises (SPEC-1 fn3 / SPEC-2 §5, SPEC-6 §A7) — NOT a resetting
    // ai.credits.monthly allowance, a single purchase-time top-up. This is the
    // real grant path (recordPassPurchase, the one production insert of the pass
    // row) so the credits actually land, unlike a bare SQL insert.
    const res = await recordPassPurchase({
      orgId: auth.orgId,
      competitionId: competition_id,
      passKey: "event_pass",
      paymentIntent: `pi_pass_${randomUUID()}`,
    });
    expect(res.recorded).toBe(true);
    expect(await balance(walletId)).toBe(PASS_CREDIT_GRANT);
    // The granted credits are spendable: a real run succeeds and debits one.
    parse.mockResolvedValue(planResponse(legalPlan(fixtureIds)));
    const out = await aiPlanForDivision(auth, divisionId, {
      instruction: "plan it",
      mode: "generate",
    });
    expect(out.proposal).toHaveLength(fixtureIds.length);
    expect(await balance(walletId)).toBe(PASS_CREDIT_GRANT - 1);
    // Drain the rest — a pass is a finite top-up, not an unlimited lift: once the
    // wallet empties the next run 402s at the reserve, before the LLM.
    await reserve(walletId, auth.orgId, PASS_CREDIT_GRANT - 1);
    expect(await balance(walletId)).toBe(0);
    await expect(
      aiPlanForDivision(auth, divisionId, {
        instruction: "plan it",
        mode: "generate",
      }),
    ).rejects.toMatchObject({
      status: 402,
      featureKey: "ai.credits",
    });
    expect(parse).toHaveBeenCalledTimes(1); // only the funded run reached the LLM
  });

  it("override bool_value=false kills a pro_plus org → 402", async () => {
    const auth = await seedPlusOrg();
    const { divisionId } = await seedPlannable(auth);
    await sql`
      insert into org_entitlement_overrides (org_id, feature_key, bool_value)
      values (${auth.orgId}, 'scheduling.ai', false)`;
    await invalidateOrgEntitlements(auth.orgId);
    await expect(
      aiPlanForDivision(auth, divisionId, {
        instruction: "plan it",
        mode: "generate",
      }),
    ).rejects.toMatchObject({ status: 402, featureKey: "scheduling.ai" });
    expect(parse).not.toHaveBeenCalled();
  });

  it("kill-switch off → 403 FEATURE_DISABLED (before the paid gate)", async () => {
    isServerFeatureEnabled.mockResolvedValueOnce(false);
    const auth = await seedPlusOrg();
    const { divisionId } = await seedPlannable(auth);
    await expect(
      aiPlanForDivision(auth, divisionId, {
        instruction: "plan it",
        mode: "generate",
      }),
    ).rejects.toMatchObject({ status: 403, code: "FEATURE_DISABLED" });
    expect(parse).not.toHaveBeenCalled();
  });

  // A frozen division rejects every applied plan (applySchedule, 422), so a run
  // could only ever produce a proposal the organiser is then blocked from
  // using — and that block landed at Apply, minutes and one paid generation
  // later. The guard belongs ahead of the quota and spend gates.
  it("frozen division → 409 SCHEDULE_LOCKED, before any spend", async () => {
    const auth = await seedPlusOrg();
    const { divisionId, fixtureIds } = await seedPlannable(auth);
    await sql`update divisions set schedule_locked = true where id = ${divisionId}`;

    await expect(
      aiPlanForDivision(auth, divisionId, {
        instruction: "plan it",
        mode: "generate",
      }),
    ).rejects.toMatchObject({ status: 409, code: "SCHEDULE_LOCKED" });

    // No model call, no generation consumed, no rate-limit slot burned.
    expect(parse).not.toHaveBeenCalled();
    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from competition_events
      where payload->>'division_id' = ${divisionId}
        and type in ('schedule.ai_generated', 'schedule.ai_failed')`;
    expect(n).toBe(0);
    expect(rlCounts.size).toBe(0);

    // Unfreezing restores the normal path — the guard gates on state, not identity.
    await sql`update divisions set schedule_locked = false where id = ${divisionId}`;
    parse.mockResolvedValueOnce(planResponse(legalPlan(fixtureIds)));
    const out = await aiPlanForDivision(auth, divisionId, {
      instruction: "plan it",
      mode: "generate",
    });
    expect(out.proposal.length).toBeGreaterThan(0);
  });

  // Runtime model escalation: try a cheap model, keep it only if the referee
  // says the plan is good enough, otherwise re-run on the primary. Opt-in via
  // SCHEDULING_AI_CHEAP_MODEL, so the default path is untouched.
  describe("cheap-model escalation", () => {
    afterEach(() => {
      delete process.env.SCHEDULING_AI_CHEAP_MODEL;
      delete process.env.SCHEDULING_AI_ESCALATE_WARN_RATIO;
    });

    it("keeps the cheap plan when the referee is happy — one call, no escalation", async () => {
      process.env.SCHEDULING_AI_CHEAP_MODEL = "claude-haiku-4-5";
      // legalPlan is conflict-free but not warning-free: it packs fixtures 30
      // minutes apart at matchMinutes:30, so entrants get zero rest against the
      // 20-minute minimum. A tolerant ratio isolates what this test is about
      // (an acceptable plan is kept) from the warning threshold, which the
      // sibling tests exercise.
      process.env.SCHEDULING_AI_ESCALATE_WARN_RATIO = "999";
      const auth = await seedPlusOrg();
      const { divisionId, fixtureIds } = await seedPlannable(auth);
      parse.mockResolvedValueOnce(planResponse(legalPlan(fixtureIds)));

      const out = await aiPlanForDivision(auth, divisionId, {
        instruction: "plan",
        mode: "generate",
      });

      expect(parse).toHaveBeenCalledTimes(1);
      expect((parse.mock.calls[0][0] as { model: string }).model).toBe("claude-haiku-4-5");
      expect(out.proposal.length).toBe(fixtureIds.length);
    });

    // A cheap model that gives up entirely must not surface as a 422 — an
    // opt-in cost optimisation that lowers success rate is not a trade worth
    // making. Its spent tokens still ride on the escalated run's bill.
    it("escalates when the cheap model fails outright, and still bills its tokens", async () => {
      process.env.SCHEDULING_AI_CHEAP_MODEL = "claude-haiku-4-5";
      const auth = await seedPlusOrg();
      const { divisionId, fixtureIds } = await seedPlannable(auth);

      // Refusal → runAiPlan throws 422 AI_PLAN_FAILED carrying usage.
      parse.mockResolvedValueOnce({
        parsed_output: null,
        stop_reason: "refusal",
        usage: { input_tokens: 100, output_tokens: 50 },
        content: [],
      });
      parse.mockResolvedValueOnce(
        planResponse(legalPlan(fixtureIds), {
          input_tokens: 700,
          output_tokens: 300,
        }),
      );

      const out = await aiPlanForDivision(auth, divisionId, {
        instruction: "plan",
        mode: "generate",
      });
      expect(out.proposal.length).toBe(fixtureIds.length);

      const models = parse.mock.calls.map((c) => (c[0] as { model: string }).model);
      expect(models).toEqual(["claude-haiku-4-5", "claude-sonnet-5"]);

      const [row] = await sql<
        {
          payload: {
            usage: { input_tokens: number; output_tokens: number };
            escalated_from?: string;
          };
        }[]
      >`
        select payload from competition_events
        where type = 'schedule.ai_generated' and payload->>'division_id' = ${divisionId}
        order by created_at desc limit 1`;
      expect(row?.payload.escalated_from).toBe("claude-haiku-4-5");
      // 100+700 in, 50+300 out — the abandoned attempt is not free.
      expect(row!.payload.usage.input_tokens).toBe(800);
      expect(row!.payload.usage.output_tokens).toBe(350);
    });

    it("escalates on blocking conflicts, and bills BOTH attempts", async () => {
      process.env.SCHEDULING_AI_CHEAP_MODEL = "claude-haiku-4-5";
      const auth = await seedPlusOrg();
      const { divisionId, fixtureIds } = await seedPlannable(auth);

      // Otherwise-legal plan with ONE court double-booking: fixture[1] is moved
      // onto fixture[0]'s exact slot and court. Structurally valid (every
      // movable id appears once) so it reaches the verifier, which reports a
      // blocking court conflict — the condition escalation exists for.
      const legal = legalPlan(fixtureIds) as {
        assignments: {
          fixture_id: string;
          scheduled_at: string;
          court_label: string;
        }[];
      };
      const clash = {
        ...legal,
        assignments: legal.assignments.map((a, i) =>
          i === 1
            ? {
                ...a,
                scheduled_at: legal.assignments[0].scheduled_at,
                court_label: legal.assignments[0].court_label,
              }
            : a,
        ),
      };
      // Persistent fallback is the clean plan; the first three calls (the cheap
      // model's initial attempt + MAX_REPAIR_ROUNDS) are the clash. Written this
      // way so the test does not depend on the exact call count of the repair
      // loop — only on "cheap keeps failing, primary succeeds".
      parse.mockResolvedValue(planResponse(legal, { input_tokens: 700, output_tokens: 300 }));
      for (let i = 0; i < 3; i++) {
        parse.mockResolvedValueOnce(planResponse(clash, { input_tokens: 100, output_tokens: 50 }));
      }

      const out = await aiPlanForDivision(auth, divisionId, {
        instruction: "plan",
        mode: "generate",
      }).catch(() => null);

      // Both models were tried: cheap first, primary second.
      const models = parse.mock.calls.map((c) => (c[0] as { model: string }).model);
      expect(models[0]).toBe("claude-haiku-4-5");
      expect(models).toContain("claude-sonnet-5");

      // A wasted cheap attempt is real spend. If the ledger only counted the
      // winning half it would under-report every escalated run.
      if (out) {
        const [row] = await sql<
          {
            payload: {
              usage: { input_tokens: number };
              escalated_from?: string;
            };
          }[]
        >`
          select payload from competition_events
          where type = 'schedule.ai_generated' and payload->>'division_id' = ${divisionId}
          order by created_at desc limit 1`;
        expect(row?.payload.escalated_from).toBe("claude-haiku-4-5");
        // Strictly more than any single attempt spent.
        expect(row!.payload.usage.input_tokens).toBeGreaterThan(100);
      }
    });

    it("unset cheap model → single call on the primary (default behaviour)", async () => {
      const auth = await seedPlusOrg();
      const { divisionId, fixtureIds } = await seedPlannable(auth);
      parse.mockResolvedValueOnce(planResponse(legalPlan(fixtureIds)));

      await aiPlanForDivision(auth, divisionId, {
        instruction: "plan",
        mode: "generate",
      });

      expect(parse).toHaveBeenCalledTimes(1);
      expect((parse.mock.calls[0][0] as { model: string }).model).toBe("claude-sonnet-5");
    });
  });

  it("6th call in the hour → 429", async () => {
    const auth = await seedPlusOrg();
    const { divisionId, fixtureIds } = await seedPlannable(auth);
    parse.mockResolvedValue(planResponse(legalPlan(fixtureIds)));
    for (let i = 0; i < 5; i++) {
      await aiPlanForDivision(auth, divisionId, {
        instruction: "plan",
        mode: "generate",
      });
    }
    await expect(
      aiPlanForDivision(auth, divisionId, {
        instruction: "plan",
        mode: "generate",
      }),
    ).rejects.toMatchObject({ status: 429 });
  });

  it("501 movable → 422; unknown scope court → 400", async () => {
    const auth = await seedPlusOrg();

    // The flexible-division 409 used to be asserted here. That mode was never
    // selectable — no screen read the column — so it is gone, and with it the
    // status code; see schedule-ai-pack.test.ts for the proof the guard no
    // longer fires.

    // >500 movable → 422 AI_PLAN_TOO_LARGE
    const bigId = await seedBigDivision(auth, 501);
    await expect(
      aiPlanForDivision(auth, bigId, { instruction: "x", mode: "generate" }),
    ).rejects.toMatchObject({ status: 422, message: "AI_PLAN_TOO_LARGE" });

    // repair scope naming a court the division does not have → 400
    const { divisionId } = await seedPlannable(auth);
    await expect(
      aiPlanForDivision(auth, divisionId, {
        instruction: "x",
        mode: "repair",
        scope: { courts: ["Court 9"] },
      }),
    ).rejects.toMatchObject({ status: 400 });

    expect(parse).not.toHaveBeenCalled();
  });
});

describe.skipIf(!HAS_DB)("aiPlanForDivision coverage + telemetry (v4/03 §2, 00 §5)", () => {
  it("officials_policy present → officials_coverage populated; absent → null", async () => {
    const auth = await seedPlusOrg();
    const { divisionId, fixtureIds } = await seedPlannable(auth, {
      officials: true,
    });

    parse.mockResolvedValueOnce(planResponse(legalPlan(fixtureIds)));
    const withPolicy = await aiPlanForDivision(auth, divisionId, {
      instruction: "cover it",
      mode: "generate",
      officials_policy: POLICY,
    });
    expect(withPolicy.officials_coverage).not.toBeNull();
    const cov = withPolicy.officials_coverage!;
    expect(cov.total).toBe(fixtureIds.length * POLICY.roles.length);
    expect(cov.fillable).toBe(cov.total - cov.unfilled.length);
    expect(Array.isArray(cov.unfilled)).toBe(true);

    parse.mockResolvedValueOnce(planResponse(legalPlan(fixtureIds)));
    const noPolicy = await aiPlanForDivision(auth, divisionId, {
      instruction: "no cover",
      mode: "generate",
    });
    expect(noPolicy.officials_coverage).toBeNull();
  });

  it("constraint_suggestions startWindows round-trip: epoch-ms → ISO in the division tz", async () => {
    const auth = await seedPlusOrg();
    const { divisionId, fixtureIds } = await seedPlannable(auth);
    // The model returns the engine constraint family: startWindow bounds in epoch ms.
    const notBeforeMs = Date.parse("2026-08-01T14:00:00+01:00");
    const suggestions = {
      constraint_suggestions: {
        noBackToBack: true,
        startWindows: [
          {
            target: { kind: "division", id: divisionId },
            notBefore: notBeforeMs,
          },
        ],
      },
    };
    parse.mockResolvedValueOnce(planResponse(legalPlan(fixtureIds, suggestions)));
    const out = await aiPlanForDivision(auth, divisionId, {
      instruction: "juniors before 2pm",
      mode: "generate",
    });
    const cs = out.constraint_suggestions!;
    expect(cs.noBackToBack).toBe(true);
    // Europe/London is +01:00 in August: epoch → ISO-with-offset in the division tz.
    expect(cs.startWindows![0]!.notBefore).toBe("2026-08-01T14:00:00+01:00");
  });

  it("telemetry: ai_plan_run fires on success with usage + blocking count", async () => {
    const auth = await seedPlusOrg();
    const { divisionId, fixtureIds } = await seedPlannable(auth);
    parse.mockResolvedValueOnce(
      planResponse(legalPlan(fixtureIds), {
        input_tokens: 1200,
        output_tokens: 340,
      }),
    );
    await aiPlanForDivision(auth, divisionId, {
      instruction: "plan",
      mode: "generate",
    });
    expect(captureServer).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "ai_plan_run",
        distinctId: auth.userId,
        orgId: auth.orgId,
        properties: expect.objectContaining({
          phase: "schedule",
          mode: "generate",
          fixtures: fixtureIds.length,
          input_tokens: 1200,
          output_tokens: 340,
          blocking: 0,
          outcome: "ok",
        }),
      }),
    );
  });

  it("telemetry: a 422 AI_PLAN_FAILED still meters the spent tokens", async () => {
    const auth = await seedPlusOrg();
    const { divisionId } = await seedPlannable(auth);
    // Refusal → runAiPlan throws 422 AI_PLAN_FAILED with usage on the extra.
    parse.mockResolvedValueOnce({
      parsed_output: null,
      stop_reason: "refusal",
      usage: { input_tokens: 100, output_tokens: 50 },
      content: [],
    });
    await expect(
      aiPlanForDivision(auth, divisionId, {
        instruction: "plan",
        mode: "generate",
      }),
    ).rejects.toMatchObject({ status: 422, code: "AI_PLAN_FAILED" });
    expect(captureServer).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "ai_plan_run",
        properties: expect.objectContaining({
          input_tokens: 100,
          output_tokens: 50,
          outcome: "failed",
        }),
      }),
    );
    // A failed run never consumes quota — no schedule.ai_generated event lands.
    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from competition_events
      where type = 'schedule.ai_generated' and payload->>'division_id' = ${divisionId}`;
    expect(n).toBe(0);
  });

  // Regression (observed live 2026-07-20): an exhausted credit balance made the
  // SDK throw a 400 APIError. It matched neither failure branch, propagated raw
  // out of aiPlanForDivision as a 500, and left no ledger row — so a billing
  // lapse took AI scheduling down silently. It must now be a 503 with its own
  // outcome, and the provider's message must never reach the tenant.
  it("a provider APIError → 503 AI_PROVIDER_UNAVAILABLE, metered, message not leaked", async () => {
    const auth = await seedPlusOrg();
    const { divisionId } = await seedPlannable(auth);
    const providerMessage = "Your credit balance is too low to access the Anthropic API.";
    parse.mockRejectedValueOnce(new MockAPIError(400, providerMessage));

    const err = await aiPlanForDivision(auth, divisionId, {
      instruction: "plan",
      mode: "generate",
    }).catch((e: unknown) => e);
    expect(err).toMatchObject({
      status: 503,
      code: "AI_PROVIDER_UNAVAILABLE",
    });
    // Billing state is ours, not the tenant's.
    expect((err as Error).message).not.toContain("credit balance");

    expect(captureServer).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "ai_plan_run",
        properties: expect.objectContaining({
          outcome: "provider_error",
          provider_status: 400,
        }),
      }),
    );
    // The outage is auditable, and it never consumes a generation.
    const [failed] = await sql<{ payload: { outcome: string; provider_status: number } }[]>`
      select payload from competition_events
      where type = 'schedule.ai_failed' and payload->>'division_id' = ${divisionId}
      order by created_at desc limit 1`;
    expect(failed?.payload.outcome).toBe("provider_error");
    expect(failed?.payload.provider_status).toBe(400);
    const [{ n: generated }] = await sql<{ n: number }[]>`
      select count(*)::int as n from competition_events
      where type = 'schedule.ai_generated' and payload->>'division_id' = ${divisionId}`;
    expect(generated).toBe(0);
  });
});
