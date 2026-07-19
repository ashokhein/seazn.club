// v4/00 §5 + 03 §2 — aiPlanForDivision orchestrator (Task 6): the gate order
// (kill switch → paid gate → rate limit), the dry officials coverage preview,
// the constraint-suggestions epoch→ISO round-trip, and telemetry on success and
// on a 422. The Anthropic SDK, PostHog, and the Redis window counter are mocked;
// everything else (entitlements, the pack builder) hits real Postgres, so the
// suite is skipped without DATABASE_URL.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

// Hoisted mock handles — referenced from vi.mock factories (which hoist above
// imports), so they must be created with vi.hoisted.
const { parse, isServerFeatureEnabled, captureServer, incrWindow, rlCounts } = vi.hoisted(() => {
  const rlCounts = new Map<string, number>();
  return {
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

vi.mock("@anthropic-ai/sdk", () => ({
  default: class Anthropic {
    messages = { parse };
  },
}));
vi.mock("@/lib/posthog-server", () => ({ isServerFeatureEnabled, captureServer }));
// Keep the real cache-aside helpers (entitlements resolution) but drive the
// fixed-window rate limiter off an in-memory counter so the 429 path is real.
vi.mock("@/lib/cache", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/cache")>();
  return { ...actual, incrWindow };
});

import { sql } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { createStages, generateStageFixtures } from "../stages";
import { aiPlanForDivision } from "../schedule-ai";
import { GENERIC_CONFIG, seedOrg } from "./_seed";

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

/** community org promoted to pro_plus directly (seedOrg only knows pro/community). */
async function seedPlusOrg(): Promise<AuthCtx> {
  const { auth } = await seedOrg("community");
  await sql`
    insert into subscriptions (org_id, plan_key, status)
    values (${auth.orgId}, 'pro_plus', 'active')
    on conflict (org_id) do update set plan_key = 'pro_plus'`;
  await invalidateOrgEntitlements(auth.orgId);
  return auth;
}

/** A timed division with 4 entrants (6 RR fixtures, all movable) + settings.
 *  Optionally seeds one referee official for the coverage preview. */
async function seedPlannable(
  auth: AuthCtx,
  opts: { officials?: boolean } = {},
): Promise<{ divisionId: string; fixtureIds: string[] }> {
  const comp = await createCompetition(auth, { name: "AI Arch", visibility: "public", branding: {} });
  const division = await createDivision(auth, comp.id, {
    name: "Open", slug: `open-${randomUUID().slice(0, 6)}`, sport_key: "generic",
    variant_key: "score", config: GENERIC_CONFIG, eligibility: [],
  });
  await createEntrants(
    auth,
    division.id,
    Array.from({ length: 4 }, (_, i) => ({
      kind: "individual" as const, display_name: `E${i + 1}`, seed: i + 1, members: [],
    })),
  );
  await setSettings(division.id);
  const [stage] = await createStages(auth, division.id, { seq: 1, kind: "league", name: "League", config: {} });
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
  const comp = await createCompetition(auth, { name: `Big ${randomUUID().slice(0, 6)}`, visibility: "public", branding: {} });
  const division = await createDivision(auth, comp.id, {
    name: "Big", slug: `big-${randomUUID().slice(0, 6)}`, sport_key: "generic",
    variant_key: "score", config: GENERIC_CONFIG, eligibility: [],
  });
  await setSettings(division.id);
  const [stage] = await createStages(auth, division.id, { seq: 1, kind: "league", name: "L", config: {} });
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
  roles: ["referee"], poolLock: false, blockStay: false, fairness: "tournament" as const,
  teamRefKeepDivision: false, restMinMinutes: 0, blockGapMinutes: 30,
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
  isServerFeatureEnabled.mockReset().mockResolvedValue(true);
  captureServer.mockReset().mockResolvedValue(undefined);
  rlCounts.clear();
  process.env.ANTHROPIC_API_KEY = "test-key";
});

describe.skipIf(!HAS_DB)("aiPlanForDivision gates (v4/00 §5)", () => {
  it("free (community) org → 402 with feature_key scheduling.ai", async () => {
    const { auth } = await seedOrg("community");
    const { divisionId } = await seedPlannable(auth);
    await expect(
      aiPlanForDivision(auth, divisionId, { instruction: "plan it", mode: "generate" }),
    ).rejects.toMatchObject({ status: 402, featureKey: "scheduling.ai" });
    expect(parse).not.toHaveBeenCalled();
  });

  it("Pro AI scheduling is capped at 5 runs/division; each run records an event, the 6th is 402 (owner 2026-07-18, V291)", async () => {
    const { auth } = await seedOrg("pro");
    const { divisionId, fixtureIds } = await seedPlannable(auth);
    parse.mockResolvedValue(planResponse(legalPlan(fixtureIds)));
    // Five generations succeed; each appends a schedule.ai_generated event that
    // advances the per-division counter.
    for (let i = 0; i < 5; i++) {
      const out = await aiPlanForDivision(auth, divisionId, { instruction: "plan", mode: "generate" });
      expect(out.proposal).toHaveLength(fixtureIds.length);
    }
    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from competition_events
      where type = 'schedule.ai_generated'
        and payload->>'division_id' = ${divisionId} and payload->>'mode' = 'generate'`;
    expect(n).toBe(5);
    // The sixth breaches the cap BEFORE the LLM is called → 402 on the run-cap key.
    await expect(
      aiPlanForDivision(auth, divisionId, { instruction: "plan", mode: "generate" }),
    ).rejects.toMatchObject({ status: 402, featureKey: "scheduling.ai.runs_per_division.max" });
    expect(parse).toHaveBeenCalledTimes(5); // over-quota never burned a request
    // A blocked run is never recorded (still five).
    const [{ n: after }] = await sql<{ n: number }[]>`
      select count(*)::int as n from competition_events
      where type = 'schedule.ai_generated' and payload->>'division_id' = ${divisionId}`;
    expect(after).toBe(5);
  });

  it("Pro Plus AI scheduling is uncapped (null limit) even past five prior runs", async () => {
    const auth = await seedPlusOrg();
    const { divisionId, fixtureIds } = await seedPlannable(auth);
    const [{ competition_id }] = await sql<{ competition_id: string }[]>`
      select competition_id from divisions where id = ${divisionId}`;
    // Seed six prior runs directly — more than the Pro cap of five.
    for (let i = 0; i < 6; i++) {
      await sql`
        insert into competition_events (competition_id, org_id, type, payload)
        values (${competition_id}, ${auth.orgId}, 'schedule.ai_generated',
                ${sql.json({ division_id: divisionId })})`;
    }
    parse.mockResolvedValueOnce(planResponse(legalPlan(fixtureIds)));
    const out = await aiPlanForDivision(auth, divisionId, { instruction: "plan", mode: "generate" });
    expect(out.proposal).toHaveLength(fixtureIds.length);
  });

  it("org_entitlement_overrides (scheduling.ai + run cap) grant a community org → 200", async () => {
    const { auth } = await seedOrg("community");
    const { divisionId, fixtureIds } = await seedPlannable(auth);
    await sql`
      insert into org_entitlement_overrides (org_id, feature_key, bool_value)
      values (${auth.orgId}, 'scheduling.ai', true)`;
    // The per-division run cap (V291) is a distinct key — without an override it
    // resolves to the community matrix (limit 0) and blocks the run, so grant it too.
    await sql`
      insert into org_entitlement_overrides (org_id, feature_key, int_value)
      values (${auth.orgId}, 'scheduling.ai.runs_per_division.max', 5)`;
    await invalidateOrgEntitlements(auth.orgId);
    parse.mockResolvedValueOnce(planResponse(legalPlan(fixtureIds)));
    const out = await aiPlanForDivision(auth, divisionId, { instruction: "plan it", mode: "generate" });
    expect(out.proposal).toHaveLength(fixtureIds.length);
    expect(out.blocking).toHaveLength(0);
  });

  it("override bool_value=false kills a pro_plus org → 402", async () => {
    const auth = await seedPlusOrg();
    const { divisionId } = await seedPlannable(auth);
    await sql`
      insert into org_entitlement_overrides (org_id, feature_key, bool_value)
      values (${auth.orgId}, 'scheduling.ai', false)`;
    await invalidateOrgEntitlements(auth.orgId);
    await expect(
      aiPlanForDivision(auth, divisionId, { instruction: "plan it", mode: "generate" }),
    ).rejects.toMatchObject({ status: 402, featureKey: "scheduling.ai" });
    expect(parse).not.toHaveBeenCalled();
  });

  it("kill-switch off → 403 FEATURE_DISABLED (before the paid gate)", async () => {
    isServerFeatureEnabled.mockResolvedValueOnce(false);
    const auth = await seedPlusOrg();
    const { divisionId } = await seedPlannable(auth);
    await expect(
      aiPlanForDivision(auth, divisionId, { instruction: "plan it", mode: "generate" }),
    ).rejects.toMatchObject({ status: 403, code: "FEATURE_DISABLED" });
    expect(parse).not.toHaveBeenCalled();
  });

  it("6th call in the hour → 429", async () => {
    const auth = await seedPlusOrg();
    const { divisionId, fixtureIds } = await seedPlannable(auth);
    parse.mockResolvedValue(planResponse(legalPlan(fixtureIds)));
    for (let i = 0; i < 5; i++) {
      await aiPlanForDivision(auth, divisionId, { instruction: "plan", mode: "generate" });
    }
    await expect(
      aiPlanForDivision(auth, divisionId, { instruction: "plan", mode: "generate" }),
    ).rejects.toMatchObject({ status: 429 });
  });

  it("flexible division → 409; 501 movable → 422; unknown scope court → 400", async () => {
    const auth = await seedPlusOrg();

    // flexible → 409 AI_PLAN_UNSUPPORTED
    const { divisionId: flexId } = await seedPlannable(auth);
    await sql`update divisions set scheduling_mode = 'flexible' where id = ${flexId}`;
    await invalidateOrgEntitlements(auth.orgId);
    await expect(
      aiPlanForDivision(auth, flexId, { instruction: "x", mode: "generate" }),
    ).rejects.toMatchObject({ status: 409, message: "AI_PLAN_UNSUPPORTED" });

    // >500 movable → 422 AI_PLAN_TOO_LARGE
    const bigId = await seedBigDivision(auth, 501);
    await expect(
      aiPlanForDivision(auth, bigId, { instruction: "x", mode: "generate" }),
    ).rejects.toMatchObject({ status: 422, message: "AI_PLAN_TOO_LARGE" });

    // repair scope naming a court the division does not have → 400
    const { divisionId } = await seedPlannable(auth);
    await expect(
      aiPlanForDivision(auth, divisionId, { instruction: "x", mode: "repair", scope: { courts: ["Court 9"] } }),
    ).rejects.toMatchObject({ status: 400 });

    expect(parse).not.toHaveBeenCalled();
  });
});

describe.skipIf(!HAS_DB)("aiPlanForDivision coverage + telemetry (v4/03 §2, 00 §5)", () => {
  it("officials_policy present → officials_coverage populated; absent → null", async () => {
    const auth = await seedPlusOrg();
    const { divisionId, fixtureIds } = await seedPlannable(auth, { officials: true });

    parse.mockResolvedValueOnce(planResponse(legalPlan(fixtureIds)));
    const withPolicy = await aiPlanForDivision(auth, divisionId, {
      instruction: "cover it", mode: "generate", officials_policy: POLICY,
    });
    expect(withPolicy.officials_coverage).not.toBeNull();
    const cov = withPolicy.officials_coverage!;
    expect(cov.total).toBe(fixtureIds.length * POLICY.roles.length);
    expect(cov.fillable).toBe(cov.total - cov.unfilled.length);
    expect(Array.isArray(cov.unfilled)).toBe(true);

    parse.mockResolvedValueOnce(planResponse(legalPlan(fixtureIds)));
    const noPolicy = await aiPlanForDivision(auth, divisionId, { instruction: "no cover", mode: "generate" });
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
        startWindows: [{ target: { kind: "division", id: divisionId }, notBefore: notBeforeMs }],
      },
    };
    parse.mockResolvedValueOnce(planResponse(legalPlan(fixtureIds, suggestions)));
    const out = await aiPlanForDivision(auth, divisionId, { instruction: "juniors before 2pm", mode: "generate" });
    const cs = out.constraint_suggestions!;
    expect(cs.noBackToBack).toBe(true);
    // Europe/London is +01:00 in August: epoch → ISO-with-offset in the division tz.
    expect(cs.startWindows![0]!.notBefore).toBe("2026-08-01T14:00:00+01:00");
  });

  it("telemetry: ai_plan_run fires on success with usage + blocking count", async () => {
    const auth = await seedPlusOrg();
    const { divisionId, fixtureIds } = await seedPlannable(auth);
    parse.mockResolvedValueOnce(planResponse(legalPlan(fixtureIds), { input_tokens: 1200, output_tokens: 340 }));
    await aiPlanForDivision(auth, divisionId, { instruction: "plan", mode: "generate" });
    expect(captureServer).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "ai_plan_run",
        distinctId: auth.userId,
        orgId: auth.orgId,
        properties: expect.objectContaining({
          phase: "schedule", mode: "generate", fixtures: fixtureIds.length,
          input_tokens: 1200, output_tokens: 340, blocking: 0, outcome: "ok",
        }),
      }),
    );
  });

  it("telemetry: a 422 AI_PLAN_FAILED still meters the spent tokens", async () => {
    const auth = await seedPlusOrg();
    const { divisionId } = await seedPlannable(auth);
    // Refusal → runAiPlan throws 422 AI_PLAN_FAILED with usage on the extra.
    parse.mockResolvedValueOnce({
      parsed_output: null, stop_reason: "refusal", usage: { input_tokens: 100, output_tokens: 50 }, content: [],
    });
    await expect(
      aiPlanForDivision(auth, divisionId, { instruction: "plan", mode: "generate" }),
    ).rejects.toMatchObject({ status: 422, code: "AI_PLAN_FAILED" });
    expect(captureServer).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "ai_plan_run",
        properties: expect.objectContaining({ input_tokens: 100, output_tokens: 50, outcome: "failed" }),
      }),
    );
  });
});
