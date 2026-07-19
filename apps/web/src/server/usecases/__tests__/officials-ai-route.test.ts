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
import { patchFixtureOfficials } from "../officials";
import { officialsAiPlanForDivision } from "../officials-ai";
import { GENERIC_CONFIG, seedOrg } from "./_seed";

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
  roles: ["referee"], poolLock: false, blockStay: false, fairness: "tournament" as const,
  teamRefKeepDivision: false, restMinMinutes: 0, blockGapMinutes: 30,
};

async function setSettings(divisionId: string): Promise<void> {
  await sql`
    insert into schedule_settings (division_id, config, tz, updated_at)
    values (${divisionId}, ${sql.json(SETTINGS_CONFIG)}, ${TZ}, now())
    on conflict (division_id) do update set config = excluded.config, tz = excluded.tz`;
}

/** community org promoted to pro_plus directly (seedOrg only knows pro/community);
 *  officials.auto is Pro Plus post-V290. */
async function seedPlusOrg(): Promise<AuthCtx> {
  const { auth } = await seedOrg("community");
  await sql`
    insert into subscriptions (org_id, plan_key, status)
    values (${auth.orgId}, 'pro_plus', 'active')
    on conflict (org_id) do update set plan_key = 'pro_plus'`;
  await invalidateOrgEntitlements(auth.orgId);
  return auth;
}

/** A timed division with `n` entrants (RR fixtures, all movable) + settings, plus
 *  `officials` referees. Returns fixture ids in stable (round, seq) order. */
async function seedOfficials(
  auth: AuthCtx,
  opts: { entrants?: number; officials?: { name: string; roles: string[] }[] } = {},
): Promise<{ divisionId: string; fixtureIds: string[]; officialIds: string[] }> {
  const comp = await createCompetition(auth, { name: "AI Off", visibility: "public", branding: {} });
  const division = await createDivision(auth, comp.id, {
    name: "Open", slug: `open-${randomUUID().slice(0, 6)}`, sport_key: "generic",
    variant_key: "score", config: GENERIC_CONFIG, eligibility: [],
  });
  const n = opts.entrants ?? 3;
  await createEntrants(
    auth,
    division.id,
    Array.from({ length: n }, (_, i) => ({
      kind: "individual" as const, display_name: `E${i + 1}`, seed: i + 1, members: [],
    })),
  );
  await setSettings(division.id);
  const [stage] = await createStages(auth, division.id, { seq: 1, kind: "league", name: "League", config: {} });
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
function spread(fixtureIds: string[], gapMin = 120): { fixture_id: string; scheduled_at: string; court_label: string }[] {
  return fixtureIds.map((id, i) => ({
    fixture_id: id, scheduled_at: new Date(BASE + i * gapMin * MIN).toISOString(), court_label: "Court 1",
  }));
}

/** A plan assigning one referee to every fixture, nothing unfilled. */
function assignAll(fixtureIds: string[], officialId: string): unknown {
  return {
    assignments: fixtureIds.map((id) => ({ fixture_id: id, official_id: officialId, role_key: "referee" })),
    unfilled: [], explanations: [], summary: "ok",
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
  rlCounts.clear();
  process.env.ANTHROPIC_API_KEY = "test-key";
});

describe.skipIf(!HAS_DB)("officialsAiPlanForDivision — runner (v4/03 §2)", () => {
  it("echoes a locked assignment in the proposal (LLM path)", async () => {
    const auth = await seedPlusOrg();
    const { divisionId, fixtureIds, officialIds } = await seedOfficials(auth, {
      entrants: 3, officials: [{ name: "Ref A", roles: ["referee"] }],
    });
    const refA = officialIds[0]!;
    await patchFixtureOfficials(auth, fixtureIds[0]!, {
      set: [{ official_id: refA, role_key: "referee", locked: true }],
    });

    parse.mockResolvedValueOnce(resp(assignAll(fixtureIds, refA)));
    const out = await officialsAiPlanForDivision(auth, divisionId, {
      instruction: "Ref A everywhere.", policy: POLICY, schedule: spread(fixtureIds),
    });

    expect(parse).toHaveBeenCalledTimes(1);
    const lockedRow = out.assignments.find((a) => a.fixtureId === fixtureIds[0] && a.officialId === refA);
    expect(lockedRow).toMatchObject({ roleKey: "referee", locked: true });
    expect(out.usage.repair_rounds).toBe(0);
  });

  it("empty instruction returns the solver draft with zero LLM calls; a locked row survives", async () => {
    const auth = await seedPlusOrg();
    const { divisionId, fixtureIds, officialIds } = await seedOfficials(auth, {
      entrants: 3, officials: [{ name: "Ref A", roles: ["referee"] }],
    });
    const refA = officialIds[0]!;
    await patchFixtureOfficials(auth, fixtureIds[0]!, {
      set: [{ official_id: refA, role_key: "referee", locked: true }],
    });

    const out = await officialsAiPlanForDivision(auth, divisionId, {
      instruction: "", policy: POLICY, schedule: spread(fixtureIds),
    });

    expect(parse).not.toHaveBeenCalled();
    expect(out.usage).toEqual({ input_tokens: 0, output_tokens: 0, repair_rounds: 0 });
    expect(out.assignments.length).toBeGreaterThan(0);
    expect(
      out.assignments.some((a) => a.fixtureId === fixtureIds[0] && a.officialId === refA && a.locked === true),
    ).toBe(true);
  });

  it("an overlap is repaired: repair_rounds:1 and no residual official_overlap", async () => {
    const auth = await seedPlusOrg();
    const { divisionId, fixtureIds, officialIds } = await seedOfficials(auth, {
      entrants: 3, officials: [{ name: "Ref A", roles: ["referee"] }],
    });
    const refA = officialIds[0]!;
    const [f0, f1, f2] = fixtureIds as [string, string, string];
    // f0 09:00–09:30 and f1 09:15–09:45 overlap; f2 far away.
    const schedule = [
      { fixture_id: f0, scheduled_at: new Date(BASE).toISOString(), court_label: "Court 1" },
      { fixture_id: f1, scheduled_at: new Date(BASE + 15 * MIN).toISOString(), court_label: "Court 1" },
      { fixture_id: f2, scheduled_at: new Date(BASE + 180 * MIN).toISOString(), court_label: "Court 1" },
    ];
    // Round 1: Ref A on all three (double-booked on f0/f1). Round 2: drop f1.
    parse
      .mockResolvedValueOnce(resp(assignAll(fixtureIds, refA)))
      .mockResolvedValueOnce(
        resp({
          assignments: [
            { fixture_id: f0, official_id: refA, role_key: "referee" },
            { fixture_id: f2, official_id: refA, role_key: "referee" },
          ],
          unfilled: [{ fixture_id: f1, role_key: "referee", reason: "Ref A already on f0" }],
          explanations: [], summary: "dropped one overlap",
        }),
      );

    const out = await officialsAiPlanForDivision(auth, divisionId, {
      instruction: "Cover everything with Ref A.", policy: POLICY, schedule,
    });

    expect(parse).toHaveBeenCalledTimes(2);
    expect(out.usage.repair_rounds).toBe(1);
    expect(out.conflicts.some((c) => c.kind === "official_overlap")).toBe(false);
    expect(out.diff.unfilled).toEqual([{ fixture_id: f1, role_key: "referee", reason: "Ref A already on f0" }]);
  });

  it("empty roster → 422 NO_OFFICIALS before any LLM call", async () => {
    const auth = await seedPlusOrg();
    const { divisionId, fixtureIds } = await seedOfficials(auth, { entrants: 3, officials: [] });
    await expect(
      officialsAiPlanForDivision(auth, divisionId, {
        instruction: "assign", policy: POLICY, schedule: spread(fixtureIds),
      }),
    ).rejects.toMatchObject({ status: 422, message: "NO_OFFICIALS" });
    expect(parse).not.toHaveBeenCalled();
  });
});

describe.skipIf(!HAS_DB)("officialsAiPlanForDivision — gates (v4/03 §2, corpus 00 §6)", () => {
  it("community org → 402 with feature_key officials.auto", async () => {
    const { auth } = await seedOrg("community");
    const { divisionId, fixtureIds } = await seedOfficials(auth, {
      entrants: 3, officials: [{ name: "Ref A", roles: ["referee"] }],
    });
    await expect(
      officialsAiPlanForDivision(auth, divisionId, {
        instruction: "assign", policy: POLICY, schedule: spread(fixtureIds),
      }),
    ).rejects.toMatchObject({ status: 402, featureKey: "officials.auto" });
    expect(parse).not.toHaveBeenCalled();
  });

  it("kill-switch off → 403 FEATURE_DISABLED (before the paid gate)", async () => {
    isServerFeatureEnabled.mockResolvedValueOnce(false);
    const auth = await seedPlusOrg();
    const { divisionId, fixtureIds } = await seedOfficials(auth, {
      entrants: 3, officials: [{ name: "Ref A", roles: ["referee"] }],
    });
    await expect(
      officialsAiPlanForDivision(auth, divisionId, {
        instruction: "assign", policy: POLICY, schedule: spread(fixtureIds),
      }),
    ).rejects.toMatchObject({ status: 403, code: "FEATURE_DISABLED" });
    expect(parse).not.toHaveBeenCalled();
  });

  it("6th call in the hour → 429", async () => {
    const auth = await seedPlusOrg();
    const { divisionId, fixtureIds, officialIds } = await seedOfficials(auth, {
      entrants: 3, officials: [{ name: "Ref A", roles: ["referee"] }],
    });
    parse.mockResolvedValue(resp(assignAll(fixtureIds, officialIds[0]!)));
    for (let i = 0; i < 5; i++) {
      await officialsAiPlanForDivision(auth, divisionId, {
        instruction: "assign", policy: POLICY, schedule: spread(fixtureIds),
      });
    }
    await expect(
      officialsAiPlanForDivision(auth, divisionId, {
        instruction: "assign", policy: POLICY, schedule: spread(fixtureIds),
      }),
    ).rejects.toMatchObject({ status: 429 });
  });
});
