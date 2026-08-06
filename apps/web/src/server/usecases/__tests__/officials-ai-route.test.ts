// v4/03 §2 — officialsAiPlanForDivision orchestrator + runner (Task 9). Covers
// the gate order (kill switch → officials.auto → officials.roles_multi → rate
// limit), the empty-instruction short-circuit (solver draft, zero LLM calls),
// locked-row echo, and the overlap → repair → clean loop. The Anthropic SDK,
// PostHog, and the Redis window counter are mocked; everything else (entitlements,
// the pack builder, the referee) hits real Postgres, so the suite is skipped
// without DATABASE_URL.
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
// const would still be in its TDZ when officials-ai.ts pulls ai-runs-admin in.
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
import { patchFixtureOfficials } from "../officials";
import { officialsAiPlanForDivision } from "../officials-ai";
import { maybeAlertExpensiveRun as maybeAlertExpensiveRunSpy } from "../ai-runs-admin";
import { GENERIC_CONFIG, seedOrg } from "./_seed";

import { setOrgPlan } from "@/lib/__tests__/_billing-group";
import { balance, recordPackPurchase, walletIdFor } from "@/lib/credits";
const HAS_DB = !!process.env.DATABASE_URL;
const TZ = "Europe/London";
const MIN = 60_000;
const BASE = Date.parse("2026-08-01T09:00:00.000Z");

const SETTINGS_CONFIG = {
  startAt: "2026-08-01T09:00:00.000Z",
  matchMinutes: 30,
  gapMinutes: 0,
  courts: ["Court 1", "Court 2"],
  perEntrantMinRest: 0,
  blackouts: [],
  sessionWindows: [{ from: "2026-08-01T09:00:00.000Z", to: "2026-08-01T23:00:00.000Z" }],
};

const POLICY = {
  roles: ["referee"],
  poolLock: false,
  blockStay: false,
  fairness: "tournament" as const,
  teamRefKeepDivision: false,
  restMinMinutes: 0,
  blockGapMinutes: 30,
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

/** A timed division with `n` entrants (RR fixtures, all movable) + settings, plus
 *  `officials` referees. Returns fixture ids in stable (round, seq) order. */
async function seedOfficials(
  auth: AuthCtx,
  opts: {
    entrants?: number;
    officials?: { name: string; roles: string[] }[];
  } = {},
): Promise<{
  divisionId: string;
  fixtureIds: string[];
  officialIds: string[];
}> {
  const comp = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: "AI Off",
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
  const n = opts.entrants ?? 3;
  await createEntrants(
    auth,
    division.id,
    Array.from({ length: n }, (_, i) => ({
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
  const officialIds: string[] = [];
  for (const o of opts.officials ?? []) {
    const [row] = await sql<{ id: string }[]>`
      insert into officials (org_id, display_name, role_keys)
      values (${auth.orgId}, ${o.name}, ${sql.json(o.roles)}) returning id`;
    officialIds.push(row!.id);
  }
  const fixtureIds = [...fixtures]
    .sort((a, b) => a.round_no - b.round_no || a.seq_in_round - b.seq_in_round)
    .map((f) => f.id);
  return { divisionId: division.id, fixtureIds, officialIds };
}

/** Dry-run schedule: each fixture `gapMin` apart on Court 1 (spaced so one
 *  referee can legally cover them all). */
function spread(
  fixtureIds: string[],
  gapMin = 120,
): { fixture_id: string; scheduled_at: string; court_label: string }[] {
  return fixtureIds.map((id, i) => ({
    fixture_id: id,
    scheduled_at: new Date(BASE + i * gapMin * MIN).toISOString(),
    court_label: "Court 1",
  }));
}

/** A plan assigning one referee to every fixture, nothing unfilled. */
function assignAll(fixtureIds: string[], officialId: string): unknown {
  return {
    assignments: fixtureIds.map((id) => ({
      fixture_id: id,
      official_id: officialId,
      role_key: "referee",
    })),
    unfilled: [],
    explanations: [],
    summary: "ok",
  };
}

function resp(plan: unknown, usage: unknown = { input_tokens: 200, output_tokens: 80 }) {
  return { parsed_output: plan, stop_reason: "end_turn", usage, content: [] };
}

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

describe.skipIf(!HAS_DB)("officialsAiPlanForDivision — runner (v4/03 §2)", () => {
  it("echoes a locked assignment in the proposal (LLM path)", async () => {
    const auth = await seedPlusOrg();
    const { divisionId, fixtureIds, officialIds } = await seedOfficials(auth, {
      entrants: 3,
      officials: [{ name: "Ref A", roles: ["referee"] }],
    });
    const refA = officialIds[0]!;
    await patchFixtureOfficials(auth, fixtureIds[0]!, {
      set: [{ official_id: refA, role_key: "referee", locked: true }],
    });

    parse.mockResolvedValueOnce(resp(assignAll(fixtureIds, refA)));
    const out = await officialsAiPlanForDivision(auth, divisionId, {
      instruction: "Ref A everywhere.",
      policy: POLICY,
      schedule: spread(fixtureIds),
    });

    expect(parse).toHaveBeenCalledTimes(1);
    // Explicit request timeout is load-bearing: the SDK refuses non-streaming
    // max_tokens:32000 calls without one ("Streaming is required…").
    const callOpts = parse.mock.calls[0]![1] as {
      timeout?: number;
      signal?: unknown;
    };
    expect(callOpts.timeout).toBeTypeOf("number");
    expect(callOpts.timeout!).toBeGreaterThan(0);
    // Phase B stays on effort:high while Phase A moved to medium — that move
    // was justified by a bench over SCHEDULE packs, and officials has never
    // been measured. Guards against someone "harmonising" the two defaults.
    const body = parse.mock.calls[0]![0] as {
      output_config: { effort: string };
    };
    expect(body.output_config.effort).toBe("high");
    const lockedRow = out.assignments.find(
      (a) => a.fixtureId === fixtureIds[0] && a.officialId === refA,
    );
    expect(lockedRow).toMatchObject({ roleKey: "referee", locked: true });
    expect(out.usage.repair_rounds).toBe(0);
  });

  it("empty instruction returns the solver draft with zero LLM calls; a locked row survives", async () => {
    const auth = await seedPlusOrg();
    const { divisionId, fixtureIds, officialIds } = await seedOfficials(auth, {
      entrants: 3,
      officials: [{ name: "Ref A", roles: ["referee"] }],
    });
    const refA = officialIds[0]!;
    await patchFixtureOfficials(auth, fixtureIds[0]!, {
      set: [{ official_id: refA, role_key: "referee", locked: true }],
    });

    const out = await officialsAiPlanForDivision(auth, divisionId, {
      instruction: "",
      policy: POLICY,
      schedule: spread(fixtureIds),
    });

    expect(parse).not.toHaveBeenCalled();
    expect(out.usage).toEqual({
      input_tokens: 0,
      output_tokens: 0,
      repair_rounds: 0,
    });
    expect(out.assignments.length).toBeGreaterThan(0);
    expect(
      out.assignments.some(
        (a) => a.fixtureId === fixtureIds[0] && a.officialId === refA && a.locked === true,
      ),
    ).toBe(true);

    // Run ledger: the zero-token draft is stamped solver-draft with $0 cost —
    // never attributed to the LLM.
    const [ev] = await sql<{ payload: Record<string, unknown> }[]>`
      select payload from competition_events
      where type = 'schedule.ai_officials_generated' and payload->>'division_id' = ${divisionId}`;
    expect(ev!.payload.model).toBe("solver-draft");
    expect(ev!.payload.cost_usd).toBe(0);
    expect(ev!.payload.outcome).toBe("ok");
  });

  it("records pack_units alongside cost, and calls the expensive-run alert check (v17 gap #295)", async () => {
    const auth = await seedPlusOrg();
    const { divisionId, fixtureIds, officialIds } = await seedOfficials(auth, {
      entrants: 3,
      officials: [{ name: "Ref A", roles: ["referee"] }],
    });
    parse.mockResolvedValueOnce(resp(assignAll(fixtureIds, officialIds[0]!)));

    // CALL-ORDER PIN: the alert must run AFTER the officials ledger row is
    // committed — maybeAlertExpensiveRun reads its baseline median out of that
    // same competition_events table, so the order decides whether a run counts
    // in its own baseline. Moot at AI_RUN_MEDIAN_MIN_SAMPLE=20, but the contract
    // must not drift silently, so the spy snapshots the row count when called.
    let generatedRowsWhenAlerted = -1;
    maybeAlertExpensiveRun.mockImplementationOnce(async () => {
      const [row] = await sql<{ n: number }[]>`
        select count(*)::int as n from competition_events
        where type = 'schedule.ai_officials_generated' and payload->>'division_id' = ${divisionId}`;
      generatedRowsWhenAlerted = row!.n;
    });

    await officialsAiPlanForDivision(auth, divisionId, {
      instruction: "assign",
      policy: POLICY,
      schedule: spread(fixtureIds),
    });

    const [ok] = await sql<{ payload: Record<string, unknown> }[]>`
      select payload from competition_events
      where type = 'schedule.ai_officials_generated' and payload->>'division_id' = ${divisionId}`;
    // buildOfficialsPack put every fixture in the pack — pack_units is the same
    // count already reported to PostHog as `fixtures`.
    expect(ok!.payload.pack_units).toBe(fixtureIds.length);

    expect(maybeAlertExpensiveRun).toHaveBeenCalledTimes(1);
    // The call is deferred tail work (the tenant's response must not block on a
    // median scan + email send), so the snapshot lands a tick later. Generous
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
    expect(call.phase).toBe("officials");
    expect(call.competitionId).toBeTruthy();
    expect(typeof call.costUsd).toBe("number");
    // Pack size travels with the cost so the staff alert is triageable on its
    // own (v17 gap #295 fold), and it is the SAME number stamped on the ledger
    // row — alert and audit trail can never disagree about the run's size.
    expect(call.packUnits).toBe(fixtureIds.length);
    expect(call.packUnits).toBe(ok!.payload.pack_units);
    // Officials runs have no mode concept at all — nothing to forward, and
    // nothing invented.
    expect(call.mode).toBeUndefined();

    // Failures carry pack_units too (same fixture count the failed attempt saw).
    parse.mockResolvedValueOnce({
      parsed_output: null,
      stop_reason: "refusal",
      usage: { input_tokens: 60, output_tokens: 20 },
      content: [],
    });
    await expect(
      officialsAiPlanForDivision(auth, divisionId, {
        instruction: "assign",
        policy: POLICY,
        schedule: spread(fixtureIds),
      }),
    ).rejects.toMatchObject({ status: 422, code: "AI_PLAN_FAILED" });
    const [failed] = await sql<{ payload: Record<string, unknown> }[]>`
      select payload from competition_events
      where type = 'schedule.ai_failed' and payload->>'division_id' = ${divisionId}`;
    expect(failed!.payload.pack_units).toBe(fixtureIds.length);
    // A failed run is not compared for the expensive-run alert (only ok) — a
    // costly failure is a different alert class (#295 scope decision).
    expect(maybeAlertExpensiveRun).toHaveBeenCalledTimes(1);
  });

  it("an overlap is repaired: repair_rounds:1 and no residual official_overlap", async () => {
    const auth = await seedPlusOrg();
    const { divisionId, fixtureIds, officialIds } = await seedOfficials(auth, {
      entrants: 3,
      officials: [{ name: "Ref A", roles: ["referee"] }],
    });
    const refA = officialIds[0]!;
    const [f0, f1, f2] = fixtureIds as [string, string, string];
    // f0 09:00–09:30 and f1 09:15–09:45 overlap; f2 far away.
    const schedule = [
      {
        fixture_id: f0,
        scheduled_at: new Date(BASE).toISOString(),
        court_label: "Court 1",
      },
      {
        fixture_id: f1,
        scheduled_at: new Date(BASE + 15 * MIN).toISOString(),
        court_label: "Court 1",
      },
      {
        fixture_id: f2,
        scheduled_at: new Date(BASE + 180 * MIN).toISOString(),
        court_label: "Court 1",
      },
    ];
    // Round 1: Ref A on all three (double-booked on f0/f1). Round 2: drop f1.
    parse.mockResolvedValueOnce(resp(assignAll(fixtureIds, refA))).mockResolvedValueOnce(
      resp({
        assignments: [
          { fixture_id: f0, official_id: refA, role_key: "referee" },
          { fixture_id: f2, official_id: refA, role_key: "referee" },
        ],
        unfilled: [
          {
            fixture_id: f1,
            role_key: "referee",
            reason: "Ref A already on f0",
          },
        ],
        explanations: [],
        summary: "dropped one overlap",
      }),
    );

    const out = await officialsAiPlanForDivision(auth, divisionId, {
      instruction: "Cover everything with Ref A.",
      policy: POLICY,
      schedule,
    });

    expect(parse).toHaveBeenCalledTimes(2);
    expect(out.usage.repair_rounds).toBe(1);
    expect(out.conflicts.some((c) => c.kind === "official_overlap")).toBe(false);
    expect(out.diff.unfilled).toEqual([
      { fixture_id: f1, role_key: "referee", reason: "Ref A already on f0" },
    ]);
  });

  it("a locked row survives an actual repair round (overlap + lock combined)", async () => {
    // Review follow-up (T9 minor): the locked-echo test never went through a
    // repair round, and the overlap-repair test never had a locked row —
    // this drives both through the SAME repair loop: f0 is locked to Ref A,
    // f0/f1 overlap (both proposed to Ref A round 1), round 2 must drop f1
    // without ever touching (or being allowed to touch) the locked f0 row.
    const auth = await seedPlusOrg();
    const { divisionId, fixtureIds, officialIds } = await seedOfficials(auth, {
      entrants: 3,
      officials: [{ name: "Ref A", roles: ["referee"] }],
    });
    const refA = officialIds[0]!;
    const [f0, f1, f2] = fixtureIds as [string, string, string];
    await patchFixtureOfficials(auth, f0, {
      set: [{ official_id: refA, role_key: "referee", locked: true }],
    });
    const schedule = [
      {
        fixture_id: f0,
        scheduled_at: new Date(BASE).toISOString(),
        court_label: "Court 1",
      },
      {
        fixture_id: f1,
        scheduled_at: new Date(BASE + 15 * MIN).toISOString(),
        court_label: "Court 1",
      },
      {
        fixture_id: f2,
        scheduled_at: new Date(BASE + 180 * MIN).toISOString(),
        court_label: "Court 1",
      },
    ];
    parse.mockResolvedValueOnce(resp(assignAll(fixtureIds, refA))).mockResolvedValueOnce(
      resp({
        assignments: [
          { fixture_id: f0, official_id: refA, role_key: "referee" },
          { fixture_id: f2, official_id: refA, role_key: "referee" },
        ],
        unfilled: [
          {
            fixture_id: f1,
            role_key: "referee",
            reason: "Ref A already locked on f0",
          },
        ],
        explanations: [],
        summary: "dropped the non-locked overlap",
      }),
    );

    const out = await officialsAiPlanForDivision(auth, divisionId, {
      instruction: "Cover everything with Ref A.",
      policy: POLICY,
      schedule,
    });

    expect(parse).toHaveBeenCalledTimes(2);
    expect(out.usage.repair_rounds).toBe(1);
    expect(out.conflicts.some((c) => c.kind === "official_overlap")).toBe(false);
    const lockedRow = out.assignments.find((a) => a.fixtureId === f0 && a.officialId === refA);
    expect(lockedRow).toMatchObject({ roleKey: "referee", locked: true });
  });

  it("diff baseline falls back to locked when there is no prior — locked fixture is unchanged, not changed", async () => {
    // Review follow-up (T9 M-diff): schemas.ts documents diff.changed/unchanged
    // as bare fixture ids vs a baseline of "the prior proposal when given, else
    // the locked assignments". With no prior, a from-scratch proposal that only
    // echoes the lock must report that fixture as unchanged.
    const auth = await seedPlusOrg();
    const { divisionId, fixtureIds, officialIds } = await seedOfficials(auth, {
      entrants: 3,
      officials: [{ name: "Ref A", roles: ["referee"] }],
    });
    const refA = officialIds[0]!;
    const [f0, f1, f2] = fixtureIds as [string, string, string];
    await patchFixtureOfficials(auth, f0, {
      set: [{ official_id: refA, role_key: "referee", locked: true }],
    });

    parse.mockResolvedValueOnce(resp(assignAll(fixtureIds, refA)));
    const out = await officialsAiPlanForDivision(auth, divisionId, {
      instruction: "Ref A everywhere.",
      policy: POLICY,
      schedule: spread(fixtureIds),
    });

    expect(out.diff.unchanged).toEqual([f0]);
    expect([...out.diff.changed].sort()).toEqual([f1, f2].sort());
  });

  it("diff.changed/unchanged in refine mode: only genuinely re-assigned fixtures are changed", async () => {
    // Second half of the same contract: with a prior, diff entries are bare
    // fixture ids and a fixture is `changed` only when its assignment set
    // actually differs from the prior — not the whole plan.
    const auth = await seedPlusOrg();
    const { divisionId, fixtureIds, officialIds } = await seedOfficials(auth, {
      entrants: 3,
      officials: [
        { name: "Ref A", roles: ["referee"] },
        { name: "Ref B", roles: ["referee"] },
      ],
    });
    const [refA, refB] = officialIds as [string, string];
    const [f0, f1, f2] = fixtureIds as [string, string, string];

    parse.mockResolvedValueOnce(
      resp({
        assignments: [
          { fixture_id: f0, official_id: refA, role_key: "referee" }, // same as prior
          { fixture_id: f1, official_id: refB, role_key: "referee" }, // re-assigned (was refA)
          { fixture_id: f2, official_id: refB, role_key: "referee" }, // same as prior
        ],
        unfilled: [],
        explanations: [],
        summary: "refine",
      }),
    );
    const out = await officialsAiPlanForDivision(auth, divisionId, {
      instruction: "Refine.",
      policy: POLICY,
      schedule: spread(fixtureIds),
      prior: {
        instruction: "assign",
        assignments: [
          { fixtureId: f0, officialId: refA, roleKey: "referee" },
          { fixtureId: f1, officialId: refA, roleKey: "referee" },
          { fixtureId: f2, officialId: refB, roleKey: "referee" },
        ],
      },
    });

    expect(out.diff.changed).toEqual([f1]);
    expect([...out.diff.unchanged].sort()).toEqual([f0, f2].sort());
  });

  it("empty roster → 422 NO_OFFICIALS before any LLM call", async () => {
    const auth = await seedPlusOrg();
    const { divisionId, fixtureIds } = await seedOfficials(auth, {
      entrants: 3,
      officials: [],
    });
    await expect(
      officialsAiPlanForDivision(auth, divisionId, {
        instruction: "assign",
        policy: POLICY,
        schedule: spread(fixtureIds),
      }),
    ).rejects.toMatchObject({ status: 422, message: "NO_OFFICIALS" });
    expect(parse).not.toHaveBeenCalled();
  });

  it("a hallucinated fixture id fails the structural gate (never silently skipped) → 422", async () => {
    // Binding decision (project ledger): the structural gate MUST reject a plan
    // row whose fixture id is not in the pack. The engine referee silently skips
    // unknown ids, so without the gate a hallucinated id would vanish instead of
    // failing. Both the initial output and the one corrective retry carry it, so
    // the runner 422s AI_PLAN_FAILED after exactly two calls.
    const auth = await seedPlusOrg();
    const { divisionId, fixtureIds, officialIds } = await seedOfficials(auth, {
      entrants: 3,
      officials: [{ name: "Ref A", roles: ["referee"] }],
    });
    const refA = officialIds[0]!;
    const ghost = randomUUID();
    const bad = resp({
      assignments: [
        { fixture_id: ghost, official_id: refA, role_key: "referee" },
        ...fixtureIds.slice(1).map((id) => ({
          fixture_id: id,
          official_id: refA,
          role_key: "referee",
        })),
      ],
      unfilled: [],
      explanations: [],
      summary: "x",
    });
    parse.mockResolvedValueOnce(bad).mockResolvedValueOnce(bad);
    await expect(
      officialsAiPlanForDivision(auth, divisionId, {
        instruction: "assign",
        policy: POLICY,
        schedule: spread(fixtureIds),
      }),
    ).rejects.toMatchObject({ status: 422, code: "AI_PLAN_FAILED" });
    expect(parse).toHaveBeenCalledTimes(2);
  });

  it("a hallucinated official id fails the structural gate the same way → 422", async () => {
    // Second branch of the same binding decision: an official_id outside the
    // pack roster must also fail loudly, not be silently dropped by the referee.
    const auth = await seedPlusOrg();
    const { divisionId, fixtureIds } = await seedOfficials(auth, {
      entrants: 3,
      officials: [{ name: "Ref A", roles: ["referee"] }],
    });
    const ghostRef = randomUUID();
    const bad = resp({
      assignments: fixtureIds.map((id) => ({
        fixture_id: id,
        official_id: ghostRef,
        role_key: "referee",
      })),
      unfilled: [],
      explanations: [],
      summary: "x",
    });
    parse.mockResolvedValueOnce(bad).mockResolvedValueOnce(bad);
    await expect(
      officialsAiPlanForDivision(auth, divisionId, {
        instruction: "assign",
        policy: POLICY,
        schedule: spread(fixtureIds),
      }),
    ).rejects.toMatchObject({ status: 422, code: "AI_PLAN_FAILED" });
    expect(parse).toHaveBeenCalledTimes(2);
  });
});

describe.skipIf(!HAS_DB)("officialsAiPlanForDivision — gates (v4/03 §2, corpus 00 §6)", () => {
  // Task 4 review: officials.auto (Pro Plus) was removed from this path — AI
  // officials is wallet-metered on any tier now, so a community org is blocked
  // by an empty credit wallet, not a plan gate (see [[v17_ai_credit_wallet]]).
  it("community org with 0 credits → 402 with feature_key ai.credits", async () => {
    const { auth } = await seedOrg("community");
    const { divisionId, fixtureIds } = await seedOfficials(auth, {
      entrants: 3,
      officials: [{ name: "Ref A", roles: ["referee"] }],
    });
    const walletId = await walletIdFor(auth.orgId);
    expect(await balance(walletId)).toBe(0);
    await expect(
      officialsAiPlanForDivision(auth, divisionId, {
        instruction: "assign",
        policy: POLICY,
        schedule: spread(fixtureIds),
      }),
    ).rejects.toMatchObject({ status: 402, featureKey: "ai.credits" });
    expect(parse).not.toHaveBeenCalled();
  });

  it("kill-switch off → 403 FEATURE_DISABLED (before the paid gate)", async () => {
    isServerFeatureEnabled.mockResolvedValueOnce(false);
    const auth = await seedPlusOrg();
    const { divisionId, fixtureIds } = await seedOfficials(auth, {
      entrants: 3,
      officials: [{ name: "Ref A", roles: ["referee"] }],
    });
    await expect(
      officialsAiPlanForDivision(auth, divisionId, {
        instruction: "assign",
        policy: POLICY,
        schedule: spread(fixtureIds),
      }),
    ).rejects.toMatchObject({ status: 403, code: "FEATURE_DISABLED" });
    expect(parse).not.toHaveBeenCalled();
  });

  it("policy asking for >1 role without officials.roles_multi → 402", async () => {
    // pro_plus grants officials.roles_multi; override it off so the >1-role branch
    // is what 402s (not the base officials.auto gate that precedes it).
    const auth = await seedPlusOrg();
    const { divisionId, fixtureIds } = await seedOfficials(auth, {
      entrants: 3,
      officials: [{ name: "Ref A", roles: ["referee"] }],
    });
    await sql`
      insert into org_entitlement_overrides (org_id, feature_key, bool_value)
      values (${auth.orgId}, 'officials.roles_multi', false)`;
    await invalidateOrgEntitlements(auth.orgId);
    await expect(
      officialsAiPlanForDivision(auth, divisionId, {
        instruction: "assign",
        policy: { ...POLICY, roles: ["referee", "umpire"] },
        schedule: spread(fixtureIds),
      }),
    ).rejects.toMatchObject({
      status: 402,
      featureKey: "officials.roles_multi",
    });
    expect(parse).not.toHaveBeenCalled();
  });

  it("6th call in the hour → 429 (5/h per division, no run cap)", async () => {
    const auth = await seedPlusOrg();
    const { divisionId, fixtureIds, officialIds } = await seedOfficials(auth, {
      entrants: 3,
      officials: [{ name: "Ref A", roles: ["referee"] }],
    });
    parse.mockResolvedValue(resp(assignAll(fixtureIds, officialIds[0]!)));
    for (let i = 0; i < 5; i++) {
      await officialsAiPlanForDivision(auth, divisionId, {
        instruction: "assign",
        policy: POLICY,
        schedule: spread(fixtureIds),
      });
    }
    await expect(
      officialsAiPlanForDivision(auth, divisionId, {
        instruction: "assign",
        policy: POLICY,
        schedule: spread(fixtureIds),
      }),
    ).rejects.toMatchObject({ status: 429 });
    expect(parse).toHaveBeenCalledTimes(5);
  });
});

describe.skipIf(!HAS_DB)("officialsAiPlanForDivision — telemetry (v4/03 §2)", () => {
  it("ai_plan_run fires with phase officials + usage on success", async () => {
    const auth = await seedPlusOrg();
    const { divisionId, fixtureIds, officialIds } = await seedOfficials(auth, {
      entrants: 3,
      officials: [{ name: "Ref A", roles: ["referee"] }],
    });
    parse.mockResolvedValueOnce(
      resp(assignAll(fixtureIds, officialIds[0]!), {
        input_tokens: 900,
        output_tokens: 220,
      }),
    );
    await officialsAiPlanForDivision(auth, divisionId, {
      instruction: "assign",
      policy: POLICY,
      schedule: spread(fixtureIds),
    });
    expect(captureServer).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "ai_plan_run",
        distinctId: auth.userId,
        orgId: auth.orgId,
        properties: expect.objectContaining({
          phase: "officials",
          input_tokens: 900,
          output_tokens: 220,
          blocking: 0,
          outcome: "ok",
        }),
      }),
    );
  });

  it("a refusal 422 still meters the spent tokens (phase officials)", async () => {
    const auth = await seedPlusOrg();
    const { divisionId, fixtureIds } = await seedOfficials(auth, {
      entrants: 3,
      officials: [{ name: "Ref A", roles: ["referee"] }],
    });
    parse.mockResolvedValueOnce({
      parsed_output: null,
      stop_reason: "refusal",
      usage: { input_tokens: 60, output_tokens: 20 },
      content: [],
    });
    await expect(
      officialsAiPlanForDivision(auth, divisionId, {
        instruction: "assign",
        policy: POLICY,
        schedule: spread(fixtureIds),
      }),
    ).rejects.toMatchObject({ status: 422, code: "AI_PLAN_FAILED" });
    expect(captureServer).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "ai_plan_run",
        properties: expect.objectContaining({
          phase: "officials",
          input_tokens: 60,
          output_tokens: 20,
          outcome: "failed",
        }),
      }),
    );
  });
});
