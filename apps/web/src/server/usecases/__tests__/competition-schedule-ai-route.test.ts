// #350 Task 4 — `aiPlanForCompetition`: the joint orchestrator, i.e. the money
// path. What is proved here is GATE ORDER (each test picks a state where two
// gates would both fire and asserts the EARLIER one wins), that nothing which
// can refuse charges a credit (asserted on the WALLET BALANCE, never on the
// thrown error alone — an error raised after a settle still satisfies a
// rejects-assertion), the `max(1, Σ rungs − 1)` batch price with its
// undiscounted budget, and the two competition-level ledger events.
//
// Modelled on schedule-ai-route.test.ts: the Anthropic SDK, PostHog and the
// Redis window counter are mocked; entitlements, credits and the pack builder
// hit real Postgres, so the suite is skipped without DATABASE_URL.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

// Hoisted mock handles — vi.mock factories hoist above the imports, so these
// must be created with vi.hoisted (same reason as schedule-ai-route.test.ts).
const { parse, isServerFeatureEnabled, captureServer, incrWindow, rlCounts, MockAPIError } =
  vi.hoisted(() => {
    const rlCounts = new Map<string, number>();
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
vi.mock("@/lib/posthog-server", () => ({ isServerFeatureEnabled, captureServer }));
// Real cache-aside helpers (entitlement resolution) but an in-memory fixed
// window, so the 429 path is genuinely exercised and its KEY is observable.
vi.mock("@/lib/cache", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/cache")>();
  return { ...actual, incrWindow };
});

// vi.hoisted for the same reason as the block above: this factory is hoisted
// over every import, so a plain const would still be in its TDZ.
const { maybeAlertExpensiveRun } = vi.hoisted(() => ({
  maybeAlertExpensiveRun: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../ai-runs-admin", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ai-runs-admin")>();
  return { ...actual, maybeAlertExpensiveRun };
});

// A pass-through spy over the real per-division pack builder. Behaviour is
// unchanged; it exists so the AI_PLAN_EMPTY_SCOPE race (a division emptied
// between the orchestrator's gate query and the build, which run in different
// transactions) can be reproduced without a second connection racing the test.
// `aiPlanForDivision` still comes from `actual`, and its INTERNAL call to
// buildSchedulePack is a module-local binding this mock does not intercept — so
// the per-division path exercised in this file runs entirely unmocked.
vi.mock("../schedule-ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../schedule-ai")>();
  return { ...actual, buildSchedulePack: vi.fn(actual.buildSchedulePack) };
});

import { sql } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import { HttpError } from "@/lib/errors";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { createStages, generateStageFixtures } from "../stages";
import { aiPlanForCompetition } from "../competition-schedule-ai";
import { aiPlanForDivision, buildSchedulePack } from "../schedule-ai";
import { aiMarginReport, listAiRuns } from "../ai-runs-admin";
import { GENERIC_CONFIG, seedOrg } from "./_seed";
import { setOrgPlan } from "@/lib/__tests__/_billing-group";
import { balance, recordPackPurchase, walletIdFor } from "@/lib/credits";
import { tokenBudgetForCredits } from "@/lib/ai-rung";

const HAS_DB = !!process.env.DATABASE_URL;
const TZ = "Europe/London";
const MIN = 60_000;
const T0 = Date.parse("2026-08-01T09:00:00.000Z");

function settingsConfig(courts: string[], blackouts: { from: string; to: string }[] = []) {
  return {
    startAt: "2026-08-01T09:00:00.000Z",
    matchMinutes: 30,
    gapMinutes: 0,
    courts,
    perEntrantMinRest: 0,
    blackouts,
    sessionWindows: [{ from: "2026-08-01T09:00:00.000Z", to: "2026-08-01T21:00:00.000Z" }],
    constraints: {
      restMin: 0,
      noBackToBack: false,
      startWindows: [],
      fieldFairness: "balance",
      parallelism: "mixed",
      crossPersonClash: "hard",
    },
  };
}

interface SeededDivision {
  id: string;
  name: string;
  courts: string[];
  fixtureIds: string[];
}

interface DivSpec {
  name: string;
  courts?: string[];
  /** 4 entrants → 6 round-robin fixtures. 0 → no stage, no fixtures at all. */
  entrants?: number;
  /** Raw settings config override (used to seed a zero-courts division). */
  rawConfig?: unknown;
  blackouts?: { from: string; to: string }[];
  /** No schedule_settings row at all. */
  noSettings?: boolean;
  locked?: boolean;
}

async function seedDivision(
  auth: AuthCtx,
  competitionId: string,
  spec: DivSpec,
): Promise<SeededDivision> {
  const courts = spec.courts ?? ["Court 1", "Court 2"];
  const slug = `${spec.name.toLowerCase()}-${randomUUID().slice(0, 6)}`;
  const division = await createDivision(auth, competitionId, {
    name: spec.name,
    slug,
    sport_key: "generic",
    variant_key: "score",
    config: GENERIC_CONFIG,
    eligibility: [],
  });
  const n = spec.entrants ?? 4;
  if (n > 0) {
    await createEntrants(
      auth,
      division.id,
      Array.from({ length: n }, (_, i) => ({
        kind: "individual" as const,
        display_name: `${slug}-E${i + 1}`,
        seed: i + 1,
        members: [],
      })),
    );
  }
  if (spec.noSettings !== true) {
    await sql`
      insert into schedule_settings (division_id, config, tz, updated_at)
      values (${division.id}, ${sql.json(
        (spec.rawConfig ?? settingsConfig(courts, spec.blackouts)) as never,
      )}, ${TZ}, now())
      on conflict (division_id) do update set config = excluded.config, tz = excluded.tz`;
  }
  let fixtureIds: string[] = [];
  if (n > 0) {
    const [stage] = await createStages(auth, division.id, {
      seq: 1,
      kind: "league",
      name: "League",
      config: {},
    });
    const { fixtures } = await generateStageFixtures(auth, stage!.id);
    fixtureIds = [...fixtures]
      .sort((a, b) => a.round_no - b.round_no || a.seq_in_round - b.seq_in_round)
      .map((f) => f.id);
  }
  if (spec.locked === true) {
    await sql`update divisions set schedule_locked = true where id = ${division.id}`;
  }
  return { id: division.id, name: spec.name, courts, fixtureIds };
}

async function seedCompetition(
  auth: AuthCtx,
  name: string,
  specs: DivSpec[],
): Promise<{ competitionId: string; divisions: SeededDivision[] }> {
  const comp = await createCompetition(auth, { ends_on: "2030-12-31", name, visibility: "public", branding: {} });
  const divisions: SeededDivision[] = [];
  for (const spec of specs) divisions.push(await seedDivision(auth, comp.id, spec));
  return { competitionId: comp.id, divisions };
}

/** Direct-insert bulk seeder to trip the summed 500 cap without the generator. */
async function seedBigDivision(auth: AuthCtx, competitionId: string, n: number): Promise<string> {
  const division = await createDivision(auth, competitionId, {
    name: "Big",
    slug: `big-${randomUUID().slice(0, 6)}`,
    sport_key: "generic",
    variant_key: "score",
    config: GENERIC_CONFIG,
    eligibility: [],
  });
  await sql`
    insert into schedule_settings (division_id, config, tz, updated_at)
    values (${division.id}, ${sql.json(settingsConfig(["Court 9"]))}, ${TZ}, now())`;
  const [stage] = await createStages(auth, division.id, {
    seq: 1,
    kind: "league",
    name: "L",
    config: {},
  });
  await sql`
    insert into fixtures (stage_id, division_id, org_id, round_no, seq_in_round, ext_key, status)
    select ${stage!.id}, ${division.id}, ${auth.orgId}, (g / 20)::int, (g % 20)::int,
           'big-' || lpad(g::text, 5, '0'), 'scheduled'
    from generate_series(1, ${n}) g`;
  return division.id;
}

/** A legal plan over the given divisions: each fixture on one of ITS OWN
 *  division's courts, two per 30-minute slot (round-robin rounds pair disjoint
 *  entrants), inside the 09:00–21:00Z session window. Divisions in these seeds
 *  hold disjoint court sets, so there is no cross-division clash either. */
function jointPlan(divisions: SeededDivision[]): unknown {
  return {
    assignments: divisions.flatMap((d) =>
      d.fixtureIds.map((id, i) => ({
        fixture_id: id,
        scheduled_at: new Date(T0 + Math.floor(i / d.courts.length) * 30 * MIN).toISOString(),
        court_label: d.courts[i % d.courts.length]!,
      })),
    ),
    unschedulable: [],
    explanations: [],
    summary: "joint ok",
  };
}

/** The same slotting for every division — legal within each one, but a
 *  cross-division court clash on any shared court label, so every round comes
 *  back BLOCKING and the runner keeps repairing. Only meaningful when the
 *  divisions share courts. */
function clashingPlan(divisions: SeededDivision[]): unknown {
  return {
    assignments: divisions.flatMap((d) =>
      d.fixtureIds.map((id, i) => ({
        fixture_id: id,
        scheduled_at: new Date(T0 + Math.floor(i / 2) * 30 * MIN).toISOString(),
        court_label: d.courts[i % 2]!,
      })),
    ),
    unschedulable: [],
    explanations: [],
    summary: "clashing",
  };
}

function planResponse(p: unknown, usage: unknown = { input_tokens: 1200, output_tokens: 600 }) {
  return { parsed_output: p, stop_reason: "end_turn", usage, content: [] };
}

/** pro_plus (scheduling.ai + scheduling.multi_division) with a funded wallet. */
async function seedPlusOrg(): Promise<AuthCtx> {
  const { auth } = await seedOrg("community");
  await setOrgPlan(auth.orgId, "pro_plus");
  await invalidateOrgEntitlements(auth.orgId);
  await recordPackPurchase(await walletIdFor(auth.orgId), 100, `seed-${randomUUID()}`);
  return auth;
}

/** Drive `competitions.max_active` to 0 so every active competition the org
 *  holds is frozen by the downgrade selector (entitlement-freeze.ts). */
async function freezeCompetitions(orgId: string): Promise<void> {
  await sql`
    insert into org_entitlement_overrides (org_id, feature_key, int_value)
    values (${orgId}, 'competitions.max_active', 0)
    on conflict (org_id, feature_key) do update set int_value = 0`;
  await invalidateOrgEntitlements(orgId);
}

async function orgName(orgId: string): Promise<string> {
  const [row] = await sql<{ name: string }[]>`select name from organizations where id = ${orgId}`;
  return row!.name;
}

async function denyFeature(orgId: string, featureKey: string): Promise<void> {
  await sql`
    insert into org_entitlement_overrides (org_id, feature_key, bool_value)
    values (${orgId}, ${featureKey}, false)
    on conflict (org_id, feature_key) do update set bool_value = false`;
  await invalidateOrgEntitlements(orgId);
}

const run = (auth: AuthCtx, competitionId: string, divisionIds: string[], extra = {}) =>
  aiPlanForCompetition(auth, competitionId, {
    division_ids: divisionIds,
    instruction: "plan the whole competition",
    mode: "generate",
    ...extra,
  });

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
  // mockClear, never mockReset: the spy's base implementation IS the real
  // builder, and resetting it would replace every joint pack with undefined.
  vi.mocked(buildSchedulePack).mockClear();
  maybeAlertExpensiveRun.mockClear();
  rlCounts.clear();
  process.env.ANTHROPIC_API_KEY = "test-key";
  // This worktree's .env.local carries a real OPENROUTER_API_KEY, which vitest
  // loads; left set, the ladder's first rung makes a genuine live call.
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.AI_PROVIDER;
  // W6 (#401): these tests pin behaviour that assumes a blocking board STAYS
  // blocking — escalation, budget stops, and the verifier's own report. The z3
  // solver now repairs such boards ahead of the LLM round, so it is switched off
  // here; its own behaviour is covered by schedule-ai-repair.test.ts and
  // competition-schedule-ai-repair.test.ts.
  process.env.SCHEDULING_REPAIR_SOLVER = "off";
});

// `process.env` is per WORKER, not per file.
afterAll(() => {
  delete process.env.SCHEDULING_REPAIR_SOLVER;
});


describe.skipIf(!HAS_DB)("aiPlanForCompetition gates (#350 Task 4)", () => {
  it("kill switch → 403 FEATURE_DISABLED before BOTH paid gates", async () => {
    // Community lacks scheduling.multi_division but HOLDS scheduling.ai (true
    // on every plan since V302), so the switch must also be pinned ahead of the
    // FIRST paid gate — deny scheduling.ai as well, and the 403 is then only
    // reachable if the kill switch is asked before either requireFeature.
    const { auth } = await seedOrg("community");
    await denyFeature(auth.orgId, "scheduling.ai");
    const { competitionId, divisions } = await seedCompetition(auth, "Killed", [
      { name: "Alpha" },
      { name: "Bravo", courts: ["Court 3", "Court 4"] },
    ]);
    isServerFeatureEnabled.mockResolvedValue(false);
    await expect(run(auth, competitionId, divisions.map((d) => d.id))).rejects.toMatchObject({
      status: 403,
      code: "FEATURE_DISABLED",
    });
    expect(parse).not.toHaveBeenCalled();
  });

  it("no scheduling.ai → 402 on that key, ahead of the multi-division gate", async () => {
    // Both paid gates are shut. `scheduling.ai` is the one that must name
    // itself, which is what pins its position ahead of scheduling.multi_division.
    const { auth } = await seedOrg("community");
    await denyFeature(auth.orgId, "scheduling.ai");
    const { competitionId, divisions } = await seedCompetition(auth, "NoAi", [
      { name: "Alpha" },
      { name: "Bravo", courts: ["Court 3", "Court 4"] },
    ]);
    await expect(run(auth, competitionId, divisions.map((d) => d.id))).rejects.toMatchObject({
      status: 402,
      featureKey: "scheduling.ai",
    });
  });

  it("scheduling.ai but no scheduling.multi_division → 402, ahead of the single-division 400", async () => {
    // The FIRST server-side enforcement of scheduling.multi_division anywhere.
    // Community holds scheduling.ai (true on every plan) and not
    // multi_division. One division id is sent, so the 400 would also fire —
    // the 402 winning is what pins the order.
    const { auth } = await seedOrg("community");
    const { competitionId, divisions } = await seedCompetition(auth, "NoMulti", [
      { name: "Alpha" },
      { name: "Bravo", courts: ["Court 3", "Court 4"] },
    ]);
    await expect(run(auth, competitionId, [divisions[0]!.id])).rejects.toMatchObject({
      status: 402,
      featureKey: "scheduling.multi_division",
    });
  });

  it("a single division id → 400 AI_PLAN_SINGLE_DIVISION, and no credit is spent", async () => {
    const auth = await seedPlusOrg();
    const walletId = await walletIdFor(auth.orgId);
    const before = await balance(walletId);
    const { competitionId, divisions } = await seedCompetition(auth, "Single", [
      { name: "Alpha" },
      { name: "Bravo", courts: ["Court 3", "Court 4"] },
    ]);
    await expect(run(auth, competitionId, [divisions[0]!.id])).rejects.toMatchObject({
      status: 400,
      code: "AI_PLAN_SINGLE_DIVISION",
    });
    expect(await balance(walletId)).toBe(before);
    expect(parse).not.toHaveBeenCalled();
  });

  it("the same division id twice is still one division → 400, no spend", async () => {
    const auth = await seedPlusOrg();
    const walletId = await walletIdFor(auth.orgId);
    const before = await balance(walletId);
    const { competitionId, divisions } = await seedCompetition(auth, "Dupe", [
      { name: "Alpha" },
      { name: "Bravo", courts: ["Court 3", "Court 4"] },
    ]);
    await expect(
      run(auth, competitionId, [divisions[0]!.id, divisions[0]!.id]),
    ).rejects.toMatchObject({ status: 400, code: "AI_PLAN_SINGLE_DIVISION" });
    expect(await balance(walletId)).toBe(before);
  });

  it("an unknown competition → 404, no spend", async () => {
    const auth = await seedPlusOrg();
    const walletId = await walletIdFor(auth.orgId);
    const before = await balance(walletId);
    const { divisions } = await seedCompetition(auth, "Ghost", [
      { name: "Alpha" },
      { name: "Bravo", courts: ["Court 3", "Court 4"] },
    ]);
    await expect(
      run(auth, randomUUID(), divisions.map((d) => d.id)),
    ).rejects.toMatchObject({ status: 404 });
    expect(await balance(walletId)).toBe(before);
  });

  it("a frozen COMPETITION → 402 competitions.max_active, before any spend", async () => {
    // A competition over competitions.max_active after a downgrade is
    // read-only: applySchedule refuses with this same 402. Planning one would
    // charge up to N credits for a proposal that can never be applied — the
    // identical argument the schedule_locked 409 makes, and the joint charge is
    // N times larger.
    const auth = await seedPlusOrg();
    const walletId = await walletIdFor(auth.orgId);
    const { competitionId, divisions } = await seedCompetition(auth, "Chilled", [
      { name: "Alpha" },
      { name: "Bravo", courts: ["Court 3", "Court 4"] },
    ]);
    await freezeCompetitions(auth.orgId);
    const before = await balance(walletId);
    await expect(run(auth, competitionId, divisions.map((d) => d.id))).rejects.toMatchObject({
      status: 402,
      featureKey: "competitions.max_active",
    });
    expect(await balance(walletId)).toBe(before);
    expect(parse).not.toHaveBeenCalled();
  });

  it("a division id from another competition → 404 naming it, before any spend", async () => {
    const auth = await seedPlusOrg();
    const walletId = await walletIdFor(auth.orgId);
    const before = await balance(walletId);
    const { competitionId, divisions } = await seedCompetition(auth, "Mine", [
      { name: "Alpha" },
      { name: "Bravo", courts: ["Court 3", "Court 4"] },
    ]);
    const other = await seedCompetition(auth, "Theirs", [{ name: "Charlie" }]);
    await expect(
      run(auth, competitionId, [divisions[0]!.id, other.divisions[0]!.id]),
    ).rejects.toMatchObject({ status: 404, message: expect.stringContaining(other.divisions[0]!.id) });
    expect(await balance(walletId)).toBe(before);
  });

  it("a frozen division → 409 SCHEDULE_LOCKED naming it, before any spend", async () => {
    const auth = await seedPlusOrg();
    const walletId = await walletIdFor(auth.orgId);
    const before = await balance(walletId);
    const { competitionId, divisions } = await seedCompetition(auth, "Frozen", [
      { name: "Alpha" },
      { name: "Bravo", courts: ["Court 3", "Court 4"], locked: true },
    ]);
    await expect(run(auth, competitionId, divisions.map((d) => d.id))).rejects.toMatchObject({
      status: 409,
      code: "SCHEDULE_LOCKED",
      message: expect.stringContaining("Bravo"),
    });
    expect(await balance(walletId)).toBe(before);
    expect(parse).not.toHaveBeenCalled();
  });

  it("a division with zero courts → 422 naming it, before any spend", async () => {
    const auth = await seedPlusOrg();
    const walletId = await walletIdFor(auth.orgId);
    const before = await balance(walletId);
    const { competitionId, divisions } = await seedCompetition(auth, "NoCourts", [
      { name: "Alpha" },
      {
        name: "Bravo",
        courts: ["Court 3"],
        // Written straight to the row: ScheduleConfig.courts is min(1), so this
        // shape can only arrive from outside the API — and it makes the pack
        // builder's own parse throw a 500 unless this gate catches it first.
        rawConfig: { ...settingsConfig(["Court 3"]), courts: [] },
      },
    ]);
    await expect(run(auth, competitionId, divisions.map((d) => d.id))).rejects.toMatchObject({
      status: 422,
      code: "AI_PLAN_DIVISION_UNPLANNABLE",
      // Named AND diagnosed: "invalid schedule settings" would also be a 422
      // mentioning Bravo, so the assertion pins the courts-specific branch.
      message: expect.stringContaining('division "Bravo" has no courts configured'),
    });
    expect(await balance(walletId)).toBe(before);
    expect(parse).not.toHaveBeenCalled();
  });

  it("a division whose settings do not parse at all → 422 naming it, not a 500", async () => {
    // The generic arm of the same gate. Without it a hand-edited config reaches
    // ScheduleConfig.parse inside the pack builder and surfaces as a ZodError.
    const auth = await seedPlusOrg();
    const walletId = await walletIdFor(auth.orgId);
    const before = await balance(walletId);
    const { competitionId, divisions } = await seedCompetition(auth, "BadSettings", [
      { name: "Alpha" },
      {
        name: "Bravo",
        courts: ["Court 3"],
        rawConfig: { ...settingsConfig(["Court 3"]), matchMinutes: 0 },
      },
    ]);
    await expect(run(auth, competitionId, divisions.map((d) => d.id))).rejects.toMatchObject({
      status: 422,
      code: "AI_PLAN_DIVISION_UNPLANNABLE",
      message: expect.stringContaining('division "Bravo" has invalid schedule settings'),
    });
    expect(await balance(walletId)).toBe(before);
  });

  it("a division with NO settings row is plannable on the default court", async () => {
    // The other direction of the same gate: an absent row parses to
    // ScheduleConfig's defaults (one "Court 1"), which is the state of every
    // board before its first settings PUT. Refusing it would 422 half the
    // product.
    const auth = await seedPlusOrg();
    const { competitionId, divisions } = await seedCompetition(auth, "Defaulted", [
      { name: "Alpha", courts: ["Court 3", "Court 4"] },
      { name: "Bravo", courts: ["Court 1"], noSettings: true },
    ]);
    parse.mockResolvedValue(planResponse(jointPlan(divisions)));
    const out = await run(auth, competitionId, divisions.map((d) => d.id));
    expect(out.divisions.map((d) => d.name).sort()).toEqual(["Alpha", "Bravo"]);
    expect(out.proposal).toHaveLength(12);
  });

  it("501 summed movable fixtures → 409 AI_PLAN_TOO_LARGE, wallet untouched", async () => {
    const auth = await seedPlusOrg();
    const walletId = await walletIdFor(auth.orgId);
    const before = await balance(walletId);
    const comp = await createCompetition(auth, {
      ends_on: "2030-12-31",
      name: "Huge",
      visibility: "public",
      branding: {},
    });
    const small = await seedDivision(auth, comp.id, { name: "Alpha" }); // 6 movable
    const big = await seedBigDivision(auth, comp.id, 495); // 495 movable → 501
    await expect(run(auth, comp.id, [small.id, big])).rejects.toMatchObject({
      status: 409,
      code: "AI_PLAN_TOO_LARGE",
    });
    expect(await balance(walletId)).toBe(before);
    expect(parse).not.toHaveBeenCalled();
  });

  it("4th joint call in the hour → 429, and the refused call spends nothing", async () => {
    const auth = await seedPlusOrg();
    const walletId = await walletIdFor(auth.orgId);
    const { competitionId, divisions } = await seedCompetition(auth, "Limited", [
      { name: "Alpha" },
      { name: "Bravo", courts: ["Court 3", "Court 4"] },
    ]);
    parse.mockResolvedValue(planResponse(jointPlan(divisions)));
    for (let i = 0; i < 3; i++) await run(auth, competitionId, divisions.map((d) => d.id));
    // The 429 is the LAST refusal before the pack build and the only one after
    // walletIdFor, so it is the one whose balance assertion matters most.
    const before = await balance(walletId);
    await expect(run(auth, competitionId, divisions.map((d) => d.id))).rejects.toMatchObject({
      status: 429,
    });
    expect(await balance(walletId)).toBe(before);
    expect(parse).toHaveBeenCalledTimes(3);
  });

  it("a division emptied between the gate and the build → retryable 409, never AI_PLAN_EMPTY_SCOPE", async () => {
    // R6 says that 422 must not escape a joint call. The orchestrator drops
    // zero-movable divisions, but its gate query and buildSchedulePack run in
    // different transactions, so a concurrent unschedule can empty one in
    // between. Simulated here by making the builder raise exactly what it
    // raises in that case.
    const auth = await seedPlusOrg();
    const walletId = await walletIdFor(auth.orgId);
    const before = await balance(walletId);
    const { competitionId, divisions } = await seedCompetition(auth, "Raced", [
      { name: "Alpha" },
      { name: "Bravo", courts: ["Court 3", "Court 4"] },
    ]);
    vi.mocked(buildSchedulePack).mockImplementationOnce(async () => {
      throw new HttpError(422, "AI_PLAN_EMPTY_SCOPE", "AI_PLAN_EMPTY_SCOPE");
    });
    await expect(
      run(auth, competitionId, divisions.map((d) => d.id), { mode: "repair" }),
    ).rejects.toMatchObject({ status: 409, code: "AI_PLAN_SCOPE_CHANGED" });
    expect(await balance(walletId)).toBe(before);
    expect(parse).not.toHaveBeenCalled();
  });

  it("a joint run does not consume the per-division 5/hr bucket", async () => {
    const auth = await seedPlusOrg();
    const { competitionId, divisions } = await seedCompetition(auth, "Buckets", [
      { name: "Alpha" },
      { name: "Bravo", courts: ["Court 3", "Court 4"] },
    ]);
    parse.mockResolvedValue(planResponse(jointPlan(divisions)));
    // Exhaust the joint bucket entirely…
    for (let i = 0; i < 3; i++) await run(auth, competitionId, divisions.map((d) => d.id));
    expect(rlCounts.get(`rl:ai-plan-competition:${competitionId}`)).toBe(3);
    expect(rlCounts.has(`rl:ai-plan:${divisions[0]!.id}`)).toBe(false);
    // …and a per-division run on one of the very same divisions still lands.
    parse.mockResolvedValueOnce(planResponse(jointPlan([divisions[0]!])));
    const single = await aiPlanForDivision(auth, divisions[0]!.id, {
      instruction: "plan",
      mode: "generate",
    });
    expect(single.proposal).toHaveLength(divisions[0]!.fixtureIds.length);
  });
});

describe.skipIf(!HAS_DB)("aiPlanForCompetition pricing + events (#350 Task 4)", () => {
  it("charges max(1, Σ rungs − 1) — two rung-1 divisions cost 1 credit", async () => {
    const auth = await seedPlusOrg();
    const walletId = await walletIdFor(auth.orgId);
    const before = await balance(walletId);
    const { competitionId, divisions } = await seedCompetition(auth, "Priced", [
      { name: "Alpha" },
      { name: "Bravo", courts: ["Court 3", "Court 4"] },
    ]);
    parse.mockResolvedValue(planResponse(jointPlan(divisions)));
    const out = await run(auth, competitionId, divisions.map((d) => d.id));

    expect(out.credits).toBe(1);
    expect(out.discount).toBe(1);
    expect(await balance(walletId)).toBe(before - 1);
    const rows = await sql<{ delta: number }[]>`
      select delta from ai_credit_ledger
      where wallet_id = ${walletId} and source = 'run_spend'`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.delta).toBe(-1);
  });

  it("sizes the budget from the UNDISCOUNTED rung total", async () => {
    const auth = await seedPlusOrg();
    const { competitionId, divisions } = await seedCompetition(auth, "Budgeted", [
      { name: "Alpha" },
      { name: "Bravo", courts: ["Court 3", "Court 4"] },
    ]);
    parse.mockResolvedValue(planResponse(jointPlan(divisions)));
    const out = await run(auth, competitionId, divisions.map((d) => d.id));
    // Σ rungs = 2 → 64000, NOT the 32000 the 1 credit charged would buy.
    expect(out.budget).toBe(tokenBudgetForCredits(2));
    expect(out.budget).not.toBe(tokenBudgetForCredits(out.credits!));
    const [row] = await sql<{ payload: Record<string, unknown> }[]>`
      select payload from competition_events
      where competition_id = ${competitionId} and type = 'schedule.ai_generated_multi'`;
    expect(row!.payload.budget).toBe(tokenBudgetForCredits(2));
  });

  it("the RUN's token meter gets the undiscounted budget, not the discounted one", async () => {
    // The assertion above only pins what quoteRun returns. This one pins what
    // the orchestrator actually hands the meter, which is the thing that
    // decides whether a joint run can afford its repair rounds.
    //
    // Both divisions share courts here and the plan double-books Court 1, so
    // every round comes back BLOCKING and the runner keeps repairing. At 31K
    // output tokens a round: a 64K budget affords round 2 (31K + the 2K
    // per-round reserve ≤ 64K) and runs to MAX_REPAIR_ROUNDS; a 32K budget —
    // what the 1 credit charged would buy — cannot, and stops on budget after
    // one round.
    const auth = await seedPlusOrg();
    const { competitionId, divisions } = await seedCompetition(auth, "Metered", [
      { name: "Alpha", courts: ["Court 1", "Court 2"] },
      { name: "Bravo", courts: ["Court 1", "Court 2"] },
    ]);
    parse.mockResolvedValue(
      planResponse(clashingPlan(divisions), { input_tokens: 1000, output_tokens: 31_000 }),
    );
    const out = await run(auth, competitionId, divisions.map((d) => d.id));

    expect(out.blocking.length).toBeGreaterThan(0); // the clash is real
    expect(out.budget).toBe(tokenBudgetForCredits(2));
    expect(out.stopped_on_budget).toBe(false);
    expect(out.spent_tokens).toBe(93_000);
    expect(parse).toHaveBeenCalledTimes(3);
  });

  it("writes schedule.ai_generated_multi with the per-division breakdown", async () => {
    const auth = await seedPlusOrg();
    const { competitionId, divisions } = await seedCompetition(auth, "Evented", [
      { name: "Alpha" },
      { name: "Bravo", courts: ["Court 3", "Court 4"] },
    ]);
    parse.mockResolvedValue(planResponse(jointPlan(divisions)));
    await run(auth, competitionId, divisions.map((d) => d.id));

    const [row] = await sql<{ payload: Record<string, unknown> }[]>`
      select payload from competition_events
      where competition_id = ${competitionId} and type = 'schedule.ai_generated_multi'`;
    const payload = row!.payload as {
      division_ids: string[];
      mode: string;
      model: string;
      cost_usd: number | null;
      pack_units: number;
      discount: number;
      credits: number;
      divisions: { id: string; rung: number; predicted_rung: number; underfunded: boolean }[];
      usage: { input_tokens: number };
    };
    expect(payload.division_ids).toEqual([...divisions.map((d) => d.id)].sort());
    expect(payload.mode).toBe("generate");
    expect(payload.model).toBe("claude-sonnet-5");
    expect(payload.pack_units).toBe(divisions.reduce((n, d) => n + d.fixtureIds.length, 0));
    expect(payload.usage.input_tokens).toBeGreaterThan(0);
    expect(typeof payload.cost_usd).toBe("number");
    expect(payload.credits).toBe(1);
    expect(payload.discount).toBe(1);
    expect(payload.divisions).toHaveLength(2);
    for (const d of payload.divisions) {
      expect(divisions.map((x) => x.id)).toContain(d.id);
      expect(d.rung).toBe(1);
      expect(d.predicted_rung).toBe(1);
      expect(d.underfunded).toBe(false);
    }
  });

  it("honours a per-division rung override, and prices from the override", async () => {
    const auth = await seedPlusOrg();
    const walletId = await walletIdFor(auth.orgId);
    const before = await balance(walletId);
    const { competitionId, divisions } = await seedCompetition(auth, "Overridden", [
      { name: "Alpha" },
      { name: "Bravo", courts: ["Court 3", "Court 4"] },
    ]);
    parse.mockResolvedValue(planResponse(jointPlan(divisions)));
    const out = await run(auth, competitionId, divisions.map((d) => d.id), {
      rung_overrides: { [divisions[0]!.id]: 3 },
    });
    // Σ rungs = 3 + 1 = 4 → credits 3, budget = the 4-credit budget.
    expect(out.credits).toBe(3);
    expect(out.discount).toBe(1);
    expect(out.budget).toBe(tokenBudgetForCredits(4));
    expect(await balance(walletId)).toBe(before - 3);
  });

  it("a failed run releases the hold, charges nothing, and writes schedule.ai_failed_multi", async () => {
    const auth = await seedPlusOrg();
    const walletId = await walletIdFor(auth.orgId);
    const before = await balance(walletId);
    const { competitionId, divisions } = await seedCompetition(auth, "Failing", [
      { name: "Alpha" },
      { name: "Bravo", courts: ["Court 3", "Court 4"] },
    ]);
    parse.mockResolvedValue({
      parsed_output: null,
      stop_reason: "refusal",
      usage: { input_tokens: 800, output_tokens: 50 },
    });
    await expect(run(auth, competitionId, divisions.map((d) => d.id))).rejects.toMatchObject({
      code: "AI_PLAN_FAILED",
    });
    expect(await balance(walletId)).toBe(before);
    const [failed] = await sql<{ payload: Record<string, unknown> }[]>`
      select payload from competition_events
      where competition_id = ${competitionId} and type = 'schedule.ai_failed_multi'`;
    expect(failed!.payload.outcome).toBe("failed");
    expect((failed!.payload.usage as { input_tokens: number }).input_tokens).toBe(800);
    expect(failed!.payload.credits).toBe(1);
    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from competition_events
      where competition_id = ${competitionId} and type = 'schedule.ai_generated_multi'`;
    expect(n).toBe(0);
  });

  // Regression, observed live on the single-division path 2026-07-20: an
  // exhausted provider credit balance made the SDK throw a 400 APIError, which
  // matched neither failure branch, propagated raw as a 500, and left no ledger
  // row — a billing lapse took AI scheduling down silently. The joint path is a
  // hand-copy of that logic, so it needs its own proof.
  it("a provider APIError → 503, metered as provider_error, message not leaked, nothing charged", async () => {
    const auth = await seedPlusOrg();
    const walletId = await walletIdFor(auth.orgId);
    const before = await balance(walletId);
    const { competitionId, divisions } = await seedCompetition(auth, "Outage", [
      { name: "Alpha" },
      { name: "Bravo", courts: ["Court 3", "Court 4"] },
    ]);
    const providerMessage = "Your credit balance is too low to access the Anthropic API.";
    parse.mockRejectedValue(new MockAPIError(400, providerMessage));

    const err = await run(auth, competitionId, divisions.map((d) => d.id)).catch(
      (e: unknown) => e,
    );
    expect(err).toMatchObject({ status: 503, code: "AI_PROVIDER_UNAVAILABLE" });
    // OUR billing state, not the tenant's.
    expect((err as Error).message).not.toContain("credit balance");
    // The hold is released — an outage is not a service the org received.
    expect(await balance(walletId)).toBe(before);

    const [failed] = await sql<{ payload: Record<string, unknown> }[]>`
      select payload from competition_events
      where competition_id = ${competitionId} and type = 'schedule.ai_failed_multi'`;
    expect(failed!.payload.outcome).toBe("provider_error");
    expect(failed!.payload.provider_status).toBe(400);
    expect(failed!.payload.provider_type).toBe("APIError");
    // …and the diagnostic stays server-side, in the row only.
    expect(JSON.stringify(failed!.payload)).not.toContain("credit balance");
    expect(captureServer).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "ai_plan_run",
        properties: expect.objectContaining({ outcome: "provider_error", provider_status: 400 }),
      }),
    );
  });

  it("budget exhausted with a usable plan → returns it, stamped stopped_on_budget, still charged", async () => {
    // The `true` arm of stopped_on_budget, and the branch where the meter cuts
    // a run short but a best-so-far exists: 63K of a 64K budget leaves less
    // than the per-round reserve, so round 2 never starts.
    const auth = await seedPlusOrg();
    const walletId = await walletIdFor(auth.orgId);
    const before = await balance(walletId);
    const { competitionId, divisions } = await seedCompetition(auth, "Starved", [
      { name: "Alpha", courts: ["Court 1", "Court 2"] },
      { name: "Bravo", courts: ["Court 1", "Court 2"] },
    ]);
    parse.mockResolvedValue(
      planResponse(clashingPlan(divisions), { input_tokens: 900, output_tokens: 63_000 }),
    );
    const out = await run(auth, competitionId, divisions.map((d) => d.id));

    expect(out.stopped_on_budget).toBe(true);
    expect(out.blocking.length).toBeGreaterThan(0); // cut short mid-repair
    expect(parse).toHaveBeenCalledTimes(1);
    // Credits buy a token BUDGET, not a result: a run stopped by its own budget
    // is still a run, and is still charged.
    expect(await balance(walletId)).toBe(before - 1);
    const [row] = await sql<{ payload: Record<string, unknown> }[]>`
      select payload from competition_events
      where competition_id = ${competitionId} and type = 'schedule.ai_generated_multi'`;
    expect(row!.payload.stopped_on_budget).toBe(true);
  });

  it("budget exhausted with NOTHING usable → 422, no charge, failure row stamped stopped_on_budget", async () => {
    const auth = await seedPlusOrg();
    const walletId = await walletIdFor(auth.orgId);
    const before = await balance(walletId);
    const { competitionId, divisions } = await seedCompetition(auth, "Starved2", [
      { name: "Alpha" },
      { name: "Bravo", courts: ["Court 3", "Court 4"] },
    ]);
    // Unparseable → the corrective retry is armed, but the meter refuses the
    // round that would have used it, and no best-so-far exists.
    parse.mockResolvedValue({
      parsed_output: null,
      stop_reason: "end_turn",
      usage: { input_tokens: 900, output_tokens: 63_000 },
      content: [],
    });
    await expect(run(auth, competitionId, divisions.map((d) => d.id))).rejects.toMatchObject({
      code: "AI_PLAN_FAILED",
    });
    expect(parse).toHaveBeenCalledTimes(1);
    expect(await balance(walletId)).toBe(before);
    const [failed] = await sql<{ payload: Record<string, unknown> }[]>`
      select payload from competition_events
      where competition_id = ${competitionId} and type = 'schedule.ai_failed_multi'`;
    expect(failed!.payload.stopped_on_budget).toBe(true);
    expect(failed!.payload.spent_tokens).toBe(63_000);
  });

  it("an empty wallet → 402 ai.credits before the model is called", async () => {
    const { auth } = await seedOrg("community");
    await setOrgPlan(auth.orgId, "pro_plus");
    await invalidateOrgEntitlements(auth.orgId);
    const { competitionId, divisions } = await seedCompetition(auth, "Broke", [
      { name: "Alpha" },
      { name: "Bravo", courts: ["Court 3", "Court 4"] },
    ]);
    parse.mockResolvedValue(planResponse(jointPlan(divisions)));
    await expect(run(auth, competitionId, divisions.map((d) => d.id))).rejects.toMatchObject({
      status: 402,
      featureKey: "ai.credits",
    });
    expect(parse).not.toHaveBeenCalled();
  });
});

describe.skipIf(!HAS_DB)("aiPlanForCompetition results (#350 Task 4)", () => {
  it("returns the joint proposal with every fixture tagged with its division", async () => {
    const auth = await seedPlusOrg();
    const { competitionId, divisions } = await seedCompetition(auth, "Result", [
      { name: "Alpha" },
      { name: "Bravo", courts: ["Court 3", "Court 4"] },
    ]);
    parse.mockResolvedValue(planResponse(jointPlan(divisions)));
    const out = await run(auth, competitionId, divisions.map((d) => d.id));

    const total = divisions.reduce((n, d) => n + d.fixtureIds.length, 0);
    expect(out.proposal).toHaveLength(total);
    for (const d of divisions) {
      const mine = out.proposal.filter((p) => p.division_id === d.id);
      expect(mine.map((p) => p.fixture_id).sort()).toEqual([...d.fixtureIds].sort());
    }
    expect(out.blocking).toEqual([]);
    expect(out.divisions.map((d) => d.name).sort()).toEqual(["Alpha", "Bravo"]);
    expect(out.divisions.every((d) => d.movable === 6)).toBe(true);
    expect(out.usage.input_tokens).toBeGreaterThan(0);
  });

  it("does not leak epoch-ms constraint_suggestions into the joint response", async () => {
    // The model emits startWindows as epoch ms; the single-division endpoint
    // renders them to ISO in ITS division's timezone. A joint run has no single
    // zone (R8), so the field is dropped rather than answered wrongly — and
    // "dropped" has to mean absent, not passed through unconverted.
    const auth = await seedPlusOrg();
    const { competitionId, divisions } = await seedCompetition(auth, "Suggested", [
      { name: "Alpha" },
      { name: "Bravo", courts: ["Court 3", "Court 4"] },
    ]);
    parse.mockResolvedValue(
      planResponse({
        ...(jointPlan(divisions) as Record<string, unknown>),
        constraint_suggestions: {
          restMin: 25,
          startWindows: [
            { target: { kind: "division", id: divisions[0]!.id }, notBefore: T0 },
          ],
        },
      }),
    );
    const out = await run(auth, competitionId, divisions.map((d) => d.id));
    expect(out.proposal).toHaveLength(12);
    expect("constraint_suggestions" in out).toBe(false);
    expect(JSON.stringify(out)).not.toContain(String(T0));
  });

  it("reports divergent courts so the board can warn on them", async () => {
    const auth = await seedPlusOrg();
    const { competitionId, divisions } = await seedCompetition(auth, "Divergent", [
      { name: "Alpha", courts: ["Court 1", "Court 2"] },
      { name: "Bravo", courts: ["Court 2", "Court 3"] },
    ]);
    parse.mockResolvedValue(planResponse(jointPlan(divisions)));
    const out = await run(auth, competitionId, divisions.map((d) => d.id));
    expect(out.divergent_courts).toEqual(["Court 1", "Court 3"]);
  });

  it("returns warnings IN FULL — a non-blocking violation is never swallowed (R13)", async () => {
    // isBlocking covers only `court` and direct `order`, so a blackout
    // violation fires no repair round and no automated gate downstream ever
    // sees it. The response is the last line of defence: the board cannot
    // render what the orchestrator does not return.
    const auth = await seedPlusOrg();
    const walletId = await walletIdFor(auth.orgId);
    const before = await balance(walletId);
    const { competitionId, divisions } = await seedCompetition(auth, "Warned", [
      {
        name: "Alpha",
        blackouts: [{ from: "2026-08-01T09:00:00.000Z", to: "2026-08-01T12:00:00.000Z" }],
      },
      { name: "Bravo", courts: ["Court 3", "Court 4"] },
    ]);
    parse.mockResolvedValue(planResponse(jointPlan(divisions)));
    const out = await run(auth, competitionId, divisions.map((d) => d.id));

    // Every one of Alpha's six fixtures sits inside its own blackout…
    const blackout = out.warnings.filter((w) => w.reason === "blackout");
    expect(blackout.map((w) => w.fixtureId).sort()).toEqual([...divisions[0]!.fixtureIds].sort());
    // …and none of it blocks, so the run still succeeds and still charges.
    expect(out.blocking).toEqual([]);
    expect(out.proposal).toHaveLength(12);
    expect(await balance(walletId)).toBe(before - 1);
  });
});

describe.skipIf(!HAS_DB)("aiPlanForCompetition drops zero-movable divisions (R6)", () => {
  it("drops a fully-scheduled division from the run, never charges for it, and reports it", async () => {
    const auth = await seedPlusOrg();
    const walletId = await walletIdFor(auth.orgId);
    const before = await balance(walletId);
    const { competitionId, divisions } = await seedCompetition(auth, "Dropped", [
      { name: "Alpha" },
      { name: "Bravo", courts: ["Court 3", "Court 4"] },
      { name: "Charlie", courts: ["Court 5"], entrants: 0 }, // nothing movable
    ]);
    parse.mockResolvedValue(planResponse(jointPlan(divisions.slice(0, 2))));
    const out = await run(auth, competitionId, divisions.map((d) => d.id));

    expect(out.divisions.map((d) => d.id).sort()).toEqual(
      [divisions[0]!.id, divisions[1]!.id].sort(),
    );
    expect(out.skipped_divisions).toEqual([
      { id: divisions[2]!.id, name: "Charlie", reason: "no_movable_fixtures" },
    ]);
    // Priced as TWO divisions, not three: max(1, 1+1−1) = 1 credit.
    expect(out.credits).toBe(1);
    expect(await balance(walletId)).toBe(before - 1);
    const [row] = await sql<{ payload: Record<string, unknown> }[]>`
      select payload from competition_events
      where competition_id = ${competitionId} and type = 'schedule.ai_generated_multi'`;
    const payload = row!.payload as {
      division_ids: string[];
      divisions: { id: string }[];
      skipped_division_ids: string[];
    };
    expect(payload.division_ids).not.toContain(divisions[2]!.id);
    expect(payload.divisions.map((d) => d.id)).not.toContain(divisions[2]!.id);
    expect(payload.skipped_division_ids).toEqual([divisions[2]!.id]);
  });

  it("fewer than 2 divisions left after the drop → the single-division 400, no spend", async () => {
    const auth = await seedPlusOrg();
    const walletId = await walletIdFor(auth.orgId);
    const before = await balance(walletId);
    const { competitionId, divisions } = await seedCompetition(auth, "AllButOne", [
      { name: "Alpha" },
      { name: "Bravo", courts: ["Court 3"], entrants: 0 },
    ]);
    await expect(run(auth, competitionId, divisions.map((d) => d.id))).rejects.toMatchObject({
      status: 400,
      code: "AI_PLAN_SINGLE_DIVISION",
    });
    expect(await balance(walletId)).toBe(before);
    expect(parse).not.toHaveBeenCalled();
  });

  it("repair mode never lets the per-division AI_PLAN_EMPTY_SCOPE 422 escape", async () => {
    // buildSchedulePack 422s AI_PLAN_EMPTY_SCOPE for a repair over a division
    // with nothing movable. Refusing a five-division joint repair because one
    // division is already done is exactly what R6 forbids.
    const auth = await seedPlusOrg();
    const { competitionId, divisions } = await seedCompetition(auth, "Repairing", [
      { name: "Alpha" },
      { name: "Bravo", courts: ["Court 3", "Court 4"] },
      { name: "Charlie", courts: ["Court 5"], entrants: 0 },
    ]);
    parse.mockResolvedValue(planResponse(jointPlan(divisions.slice(0, 2))));
    const out = await run(auth, competitionId, divisions.map((d) => d.id), { mode: "repair" });
    expect(out.divisions).toHaveLength(2);
    expect(out.skipped_divisions.map((s) => s.id)).toEqual([divisions[2]!.id]);
  });
});

describe.skipIf(!HAS_DB)("aiPlanForCompetition refine + bad input (R14)", () => {
  it("carries the prior into the pack, drops a fixture outside the run, and never 500s", async () => {
    // Two claims in one run, because they share a setup and the second is
    // meaningless without the first: the prior REACHES the model (otherwise
    // "refine" is just "generate" and every assertion below is satisfied by a
    // dropped prior), and an id outside the run is filtered rather than
    // reaching toJointEngineAssignments, whose AI_PLAN_INVALID_ASSIGNMENT is
    // deliberately outside isRecoverable and would surface as a 500.
    const auth = await seedPlusOrg();
    const { competitionId, divisions } = await seedCompetition(auth, "Refined", [
      { name: "Alpha" },
      { name: "Bravo", courts: ["Court 3", "Court 4"] },
    ]);
    const realFixture = divisions[0]!.fixtureIds[0]!;
    const strayFixture = randomUUID();
    parse.mockResolvedValue(planResponse(jointPlan(divisions)));
    const out = await run(auth, competitionId, divisions.map((d) => d.id), {
      mode: "refine",
      prior: {
        instruction: "keep the Sunday finals late",
        assignments: [
          {
            fixture_id: realFixture,
            scheduled_at: "2026-08-01T16:00:00.000Z",
            court_label: "Court 1",
            division_id: divisions[0]!.id,
          },
          {
            fixture_id: strayFixture, // not in this competition at all
            scheduled_at: "2026-08-01T09:00:00.000Z",
            court_label: "Court 1",
            division_id: divisions[0]!.id,
          },
        ],
      },
    });
    expect(out.proposal).toHaveLength(12);

    // What the model actually received — the first user turn is the pack.
    const sent = parse.mock.calls[0]![0] as { messages: { content: string }[] };
    const pack = JSON.parse(sent.messages[0]!.content) as {
      mode: string;
      draft: { fixture_id: string }[];
      prior: { instruction: string; assignments: { fixture_id: string }[] } | null;
    };
    expect(pack.mode).toBe("refine");
    expect(pack.prior?.instruction).toBe("keep the Sunday finals late");
    expect(pack.prior?.assignments.map((a) => a.fixture_id)).toContain(realFixture);
    // In refine mode the DRAFT is the prior intersected with the movable set —
    // the load-bearing half, since it is the starting point the model is asked
    // to improve. The stray id is filtered out of it; only division A had a
    // prior, so this is the whole draft.
    expect(pack.draft.map((a) => a.fixture_id)).toEqual([realFixture]);
    // (The prior ECHO is not filtered — that is pre-existing single-division
    // behaviour in buildSchedulePack, shared code, and reaches nothing but the
    // model's context. Nothing downstream resolves ids out of it, so it cannot
    // raise AI_PLAN_INVALID_ASSIGNMENT.)
  });
});

describe.skipIf(!HAS_DB)("joint runs are visible to the admin cost/margin surfaces", () => {
  it("a joint run books its COGS against the credits it sold, under the schedule phase", async () => {
    // The margin monitor reads REVENUE from ai_credit_ledger (which counts
    // every run_spend, joint included) and COGS from competition_events
    // filtered by AI_RUN_EVENT_TYPES. A run class missing from that list books
    // revenue against zero cost and reads as pure margin — silently, and on the
    // most expensive runs on the platform.
    const auth = await seedPlusOrg();
    const name = await orgName(auth.orgId);
    const { competitionId, divisions } = await seedCompetition(auth, "Booked", [
      { name: "Alpha" },
      { name: "Bravo", courts: ["Court 3", "Court 4"] },
    ]);
    parse.mockResolvedValue(planResponse(jointPlan(divisions)));
    await run(auth, competitionId, divisions.map((d) => d.id));
    // …plus one failure, which must also be visible and must not read as "ok".
    parse.mockResolvedValue({
      parsed_output: null,
      stop_reason: "refusal",
      usage: { input_tokens: 500, output_tokens: 40 },
    });
    await expect(run(auth, competitionId, divisions.map((d) => d.id))).rejects.toMatchObject({
      code: "AI_PLAN_FAILED",
    });

    const report = await aiMarginReport(30);
    const mine = report.byOrg.find((r) => r.org_id === auth.orgId);
    expect(mine).toBeDefined();
    expect(mine!.credits_spent).toBe(1); // the failed run released its hold
    expect(mine!.cogs_usd).toBeGreaterThan(0); // …and the COGS is not zero

    // The other two cost surfaces the single-division path feeds and this one
    // must too: product analytics, and the expensive-run staff alert — a joint
    // run being the class that alert exists for.
    expect(captureServer).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "ai_plan_run",
        properties: expect.objectContaining({
          outcome: "ok",
          phase: "schedule",
          divisions: 2,
          credits: 1,
        }),
      }),
    );
    // Deferred tail work — the tenant's paid response must not wait on a median
    // scan plus an email send, so it lands a tick later.
    await vi.waitFor(() => expect(maybeAlertExpensiveRun).toHaveBeenCalledTimes(1), {
      timeout: 5000,
    });
    expect(maybeAlertExpensiveRun).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: auth.orgId,
        competitionId,
        phase: "schedule",
        mode: "generate",
        packUnits: 12,
      }),
    );

    const rows = (await listAiRuns(500)).filter((r) => r.org_name === name);
    expect(rows).toHaveLength(2);
    // Phase attribution: both readers fall back to payload->>'phase', whose
    // default arm is 'officials'. An unstamped joint run lands in the wrong
    // phase and skews both phases' $/unit.
    expect(rows.every((r) => r.phase === "schedule")).toBe(true);
    expect(rows.map((r) => r.outcome).sort()).toEqual(["failed", "ok"]);
  });
});
