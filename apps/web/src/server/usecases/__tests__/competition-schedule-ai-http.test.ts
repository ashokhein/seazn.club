// #350 Task 5 — the HTTP surface over the joint orchestrator: the two route
// handlers, the request/response Zod contracts, and the OpenAPI/key-scope
// registrations they need to be reachable at all.
//
// The routes are exercised as REAL handlers over a REAL scoped API key, not
// with a mocked `requireResourceAuth`: the point of a route test here is the
// three things the usecase tests cannot see — the `{ok,data}` envelope and the
// HttpError `code` the `v1()` wrapper propagates, the request schema, and
// whether a key of a given scope can reach the endpoint at all. Mocking the
// auth door would delete all three.
//
// Deliberately a SEPARATE file from competition-schedule-ai-route.test.ts
// (Task 4's 35 orchestrator tests). These tests import route modules that did
// not exist when they were written; a module-resolution failure fails the whole
// FILE in vitest, so sharing one would have made Task 4's suite red for a
// reason that has nothing to do with Task 4.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

// vi.mock factories hoist above every import, so the handles they close over
// must be created with vi.hoisted (same reason as schedule-ai-route.test.ts).
const { parse, isServerFeatureEnabled, captureServer } = vi.hoisted(() => ({
  parse: vi.fn(),
  isServerFeatureEnabled: vi.fn(),
  captureServer: vi.fn(),
}));

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
    { APIError: class APIError extends Error {} },
  ),
}));
vi.mock("@/lib/posthog-server", () => ({ isServerFeatureEnabled, captureServer }));

// The expensive-run watch is fire-and-forget behind `deferred()`; stub it so a
// table scan plus an email send cannot leak past the end of a test.
const { maybeAlertExpensiveRun } = vi.hoisted(() => ({
  maybeAlertExpensiveRun: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../ai-runs-admin", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ai-runs-admin")>();
  return { ...actual, maybeAlertExpensiveRun };
});

import { sql } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import type { AuthCtx } from "@/server/api-v1/auth";
import { AiCompetitionLastResult, AiCompetitionPlanResponse } from "@/server/api-v1/schemas";
import type { AiCompetitionPlanResponse as CompetitionPlanWire } from "@/server/api-v1/schemas";
import type { AiCompetitionPlanResponse as CompetitionPlanDomain } from "../competition-schedule-ai";
import { ROUTES } from "@/server/api-v1/openapi";
import { matchKeyRoute } from "@/server/api-v1/key-scopes";
import { createApiKey } from "../api-keys";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { createStages, generateStageFixtures } from "../stages";
import { GENERIC_CONFIG, seedOrg } from "./_seed";
import { setOrgPlan } from "@/lib/__tests__/_billing-group";
import { recordPackPurchase, walletIdFor } from "@/lib/credits";
import { POST as planRoute } from "@/app/api/v1/competitions/[id]/schedule/ai-plan/route";
import { GET as lastRoute } from "@/app/api/v1/competitions/[id]/schedule/ai-last/route";

const HAS_DB = !!process.env.DATABASE_URL;
const TZ = "Europe/London";
const MIN = 60_000;
const T0 = Date.parse("2026-08-01T09:00:00.000Z");

function settingsConfig(courts: string[]) {
  return {
    startAt: "2026-08-01T09:00:00.000Z",
    matchMinutes: 30,
    gapMinutes: 0,
    courts,
    perEntrantMinRest: 0,
    blackouts: [],
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

/** One division of `entrants` entrants → `n*(n-1)/2` round-robin fixtures on
 *  its own courts. The count is a PARAMETER because the two seeded divisions
 *  must differ in it: with both at 6 fixtures, "every row carries its own
 *  division's movable count" and "every row carries the first division's
 *  count" produce identical assertions. */
async function seedDivision(
  auth: AuthCtx,
  competitionId: string,
  name: string,
  courts: string[],
  entrants: number,
): Promise<SeededDivision> {
  const slug = `${name.toLowerCase()}-${randomUUID().slice(0, 6)}`;
  const division = await createDivision(auth, competitionId, {
    name,
    slug,
    sport_key: "generic",
    variant_key: "score",
    config: GENERIC_CONFIG,
    eligibility: [],
  });
  await createEntrants(
    auth,
    division.id,
    Array.from({ length: entrants }, (_, i) => ({
      kind: "individual" as const,
      display_name: `${slug}-E${i + 1}`,
      seed: i + 1,
      members: [],
    })),
  );
  await sql`
    insert into schedule_settings (division_id, config, tz, updated_at)
    values (${division.id}, ${sql.json(settingsConfig(courts) as never)}, ${TZ}, now())
    on conflict (division_id) do update set config = excluded.config, tz = excluded.tz`;
  const [stage] = await createStages(auth, division.id, {
    seq: 1,
    kind: "league",
    name: "League",
    config: {},
  });
  const { fixtures } = await generateStageFixtures(auth, stage!.id);
  const fixtureIds = [...fixtures]
    .sort((a, b) => a.round_no - b.round_no || a.seq_in_round - b.seq_in_round)
    .map((f) => f.id);
  return { id: division.id, name, courts, fixtureIds };
}

/** Alpha: 4 entrants → 6 fixtures. Beta: 5 → 10. The counts are ASYMMETRIC on
 *  purpose — see `seedDivision` — and both are asserted by name-sorted position,
 *  never by id (the determinism contract forbids sorting on a UUID). */
const ALPHA_MOVABLE = 6;
const BETA_MOVABLE = 10;

/** pro_plus (scheduling.ai + scheduling.multi_division + api.access/api.write)
 *  with a funded wallet, plus two divisions on DISJOINT courts so a legal joint
 *  plan exists. */
async function seedBoard(): Promise<{
  auth: AuthCtx;
  competitionId: string;
  divisions: SeededDivision[];
}> {
  const { auth } = await seedOrg("community");
  await setOrgPlan(auth.orgId, "pro_plus");
  await invalidateOrgEntitlements(auth.orgId);
  await recordPackPurchase(await walletIdFor(auth.orgId), 100, `seed-${randomUUID()}`);
  const comp = await createCompetition(auth, {
    name: `Joint ${randomUUID().slice(0, 6)}`,
    visibility: "public",
    branding: {},
  });
  const divisions = [
    await seedDivision(auth, comp.id, "Alpha", ["Court 1", "Court 2"], 4),
    await seedDivision(auth, comp.id, "Beta", ["Court 3", "Court 4"], 5),
  ];
  return { auth, competitionId: comp.id, divisions };
}

async function keyFor(auth: AuthCtx, scopes: ("read" | "manage")[]): Promise<string> {
  const { secret } = await createApiKey(auth, { name: `k-${randomUUID().slice(0, 6)}`, scopes });
  return secret;
}

function keyed(secret: string, method: string, path: string, body?: unknown): Request {
  return new Request(`https://test.local/api/v1${path}`, {
    method,
    headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
    ...(body === undefined
      ? {}
      : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });
}

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

/** A legal plan: each fixture on one of ITS OWN division's courts, two per
 *  30-minute slot, inside the 09:00–21:00Z window. The divisions hold disjoint
 *  court sets, so there is no cross-division clash either. */
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

const planResponse = (p: unknown) => ({
  parsed_output: p,
  stop_reason: "end_turn",
  usage: { input_tokens: 1200, output_tokens: 600 },
  content: [],
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
  maybeAlertExpensiveRun.mockClear();
  process.env.ANTHROPIC_API_KEY = "test-key";
  // This worktree's .env.local carries a real OPENROUTER_API_KEY, which vitest
  // loads; left set, the ladder's first rung makes a genuine live call.
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.AI_PROVIDER;
});

/**
 * COMPILE-TIME bridge between the domain type and the wire contract. Nothing
 * else binds them: `competition-schedule-ai.ts` declares an interface and
 * `api-v1/schemas.ts` declares a Zod schema, both named
 * `AiCompetitionPlanResponse`, and the route hands the first to a client that
 * was promised the second.
 *
 * It costs one line and it has teeth on exactly the fields the runtime
 * round-trips cannot reach: the happy path returns empty `warnings`,
 * `blocking` and `skipped_divisions` and no `proposal[].schedule_locked`, so
 * their wire shape would otherwise be proved only against the hand-written
 * literal below — which can itself drift from the domain type. Substituting
 * `ScheduleConflict` for `AiPlanConflict` in the schema, for instance, is
 * invisible to `tsc` without this and fails with "Type 'Conflict[]' is not
 * assignable … missing fixture_id, code, blocking" with it.
 *
 * IT DOES NOT REPLACE THE RUNTIME ROUND-TRIPS. Structural assignability
 * tolerates excess properties, so it cannot see a Zod schema that STRIPS a
 * field it never declared — which is precisely the `divisions` collision
 * below. Two different nets, both load-bearing.
 */
const asWire = (r: CompetitionPlanDomain): CompetitionPlanWire => r;

// ---------------------------------------------------------------------------
// The `divisions` name collision. AiRunPriceFields already declares a
// `divisions` key (the meter stamp's per-division PRICE rows); the joint
// response needs a `divisions` key too (the board's picker data: name +
// movable count).
//
// The two spread orders fail DIFFERENTLY, which is why both nets exist:
//   * `divisions` before the spread → `tsc` catches it (TS2783, "specified
//     more than once"), so that one cannot ship.
//   * the CORRECT order → silent. Zod STRIPS the keys the winning sub-schema
//     does not declare, TypeScript is happy, and the route answers 200 with
//     `name` and `movable` simply gone.
// The second case is what the tests below exist for; no comment, no `tsc` run
// and no assertion on `divisions.length` can see it.
// ---------------------------------------------------------------------------
describe("AiCompetitionPlanResponse — the `divisions` collision", () => {
  /** Exactly what `aiPlanForCompetition` returns (competition-schedule-ai.ts):
   *  the meter stamp merged with the board's per-division data under ONE key.
   *
   *  Annotated with the DOMAIN type so the literal cannot drift from what the
   *  orchestrator actually returns — a hand-written fixture that has quietly
   *  stopped resembling its subject proves nothing. It exercises the fields the
   *  live happy path leaves empty: non-empty `warnings`/`blocking`,
   *  `skipped_divisions`, and `proposal[].schedule_locked`. */
  const jointResult: CompetitionPlanDomain = {
    proposal: [
      {
        fixture_id: "11111111-1111-1111-1111-111111111111",
        scheduled_at: "2026-08-01T09:00:00.000Z",
        court_label: "Court 1",
        division_id: "aaaaaaaa-1111-1111-1111-111111111111",
        schedule_locked: false,
      },
    ],
    unschedulable: [{ fixture_id: "22222222-2222-2222-2222-222222222222", reason: "no slot", rule: "CAP" as const }],
    warnings: [{ fixtureId: "33333333-3333-3333-3333-333333333333", reason: "rest", detail: "12m" }],
    blocking: [{ fixtureId: "44444444-4444-4444-4444-444444444444", reason: "order", direct: true }],
    diff: { moved: ["m1"], placed: ["p1"], unscheduled: ["u1"], unchanged: ["c1"] },
    explanations: [{ fixture_id: "11111111-1111-1111-1111-111111111111", note: "prime slot" }],
    summary: "two divisions solved",
    // W5 (#400): the architect's own assumptions (stage 2), always an array.
    assumptions: [],
    divergent_courts: ["Court 4"],
    skipped_divisions: [
      {
        id: "cccccccc-3333-3333-3333-333333333333",
        name: "Gamma",
        reason: "no_movable_fixtures" as const,
      },
    ],
    usage: { input_tokens: 1200, output_tokens: 600, repair_rounds: 1 },
    // W6 (#401): a non-trivial report, so the wire shape is exercised rather
    // than defaulted away — this run's solver tried, partly succeeded, and the
    // assistant finished the job.
    repair: {
      engine: "llm" as const,
      solver_ran: true,
      status: "partial" as const,
      moved: 2,
      ms: 1_800,
      checks: 4,
      minimality: "upper_bound" as const,
      components_solved: 3,
      components_skipped: 1,
      unresolved: 5,
      residual: 2,
      relaxed: ["blackout"],
      timed_out: true,
      fallback: "partial" as const,
    },
    credits: 3,
    budget: 96_000,
    spent_tokens: 41_000,
    est_tokens: 52_000,
    underfunded: false,
    stopped_on_budget: false,
    discount: 1,
    divisions: [
      {
        id: "aaaaaaaa-1111-1111-1111-111111111111",
        name: "Alpha",
        movable: 6,
        rung: 2 as const,
        predicted_rung: 2 as const,
        underfunded: false,
      },
      {
        id: "bbbbbbbb-2222-2222-2222-222222222222",
        name: "Beta",
        movable: 12,
        rung: 2 as const,
        predicted_rung: 3 as const,
        underfunded: true,
      },
    ],
  };

  it("keeps the BOARD's per-division fields (name, movable) through a parse", () => {
    const parsed = AiCompetitionPlanResponse.parse(asWire(jointResult));
    expect(parsed.divisions).toHaveLength(2);
    expect(parsed.divisions[0]!.name).toBe("Alpha");
    expect(parsed.divisions[0]!.movable).toBe(6);
    expect(parsed.divisions[1]!.name).toBe("Beta");
    expect(parsed.divisions[1]!.movable).toBe(12);
  });

  it("keeps the METER STAMP's per-division price fields through the same parse", () => {
    const parsed = AiCompetitionPlanResponse.parse(asWire(jointResult));
    expect(parsed.divisions[1]!.rung).toBe(2);
    expect(parsed.divisions[1]!.predicted_rung).toBe(3);
    expect(parsed.divisions[1]!.underfunded).toBe(true);
    // The run-level price block the confirm card reads, on the same object.
    expect(parsed.credits).toBe(3);
    expect(parsed.discount).toBe(1);
    expect(parsed.budget).toBe(96_000);
  });

  it("strips nothing at all from a real orchestrator result", () => {
    // The strongest form of the two assertions above and the guard against a
    // field being MISSING from the schema rather than merely losing a spread:
    // Zod's default `strip` deletes anything undeclared silently, so a
    // round-trip that is not `toEqual` its input is the only way to see it.
    expect(AiCompetitionPlanResponse.parse(asWire(jointResult))).toEqual(jointResult);
  });
});

describe.skipIf(!HAS_DB)("POST /competitions/{id}/schedule/ai-plan", () => {
  it("400s on a body that is not JSON", async () => {
    const { auth, competitionId } = await seedBoard();
    const secret = await keyFor(auth, ["manage"]);
    const res = await planRoute(
      keyed(secret, "POST", `/competitions/${competitionId}/schedule/ai-plan`, "{not json"),
      ctx(competitionId),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("VALIDATION");
  });

  it("400s AI_PLAN_SINGLE_DIVISION on one division — not a generic validation blob", async () => {
    const { auth, competitionId, divisions } = await seedBoard();
    const secret = await keyFor(auth, ["manage"]);
    const res = await planRoute(
      keyed(secret, "POST", `/competitions/${competitionId}/schedule/ai-plan`, {
        division_ids: [divisions[0]!.id],
        instruction: "plan it",
        mode: "generate",
      }),
      ctx(competitionId),
    );
    expect(res.status).toBe(400);
    // The distinguishable code, not `VALIDATION` — the board renders a specific
    // "use the division page" message off it.
    expect((await res.json()).error.code).toBe("AI_PLAN_SINGLE_DIVISION");
    expect(parse).not.toHaveBeenCalled();
  });

  it("400s AI_PLAN_SINGLE_DIVISION on the SAME division twice", async () => {
    // Two ids satisfy any array-length rule in the request schema; only the
    // orchestrator's de-duplication sees that this is one division. Proves the
    // rule is enforced where it can be right, not at the schema edge.
    const { auth, competitionId, divisions } = await seedBoard();
    const secret = await keyFor(auth, ["manage"]);
    const res = await planRoute(
      keyed(secret, "POST", `/competitions/${competitionId}/schedule/ai-plan`, {
        division_ids: [divisions[0]!.id, divisions[0]!.id],
        instruction: "plan it",
        mode: "generate",
      }),
      ctx(competitionId),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("AI_PLAN_SINGLE_DIVISION");
    expect(parse).not.toHaveBeenCalled();
  });

  it("403s a read-scoped key: planning is a manage-scope write", async () => {
    const { auth, competitionId, divisions } = await seedBoard();
    const secret = await keyFor(auth, ["read"]);
    const res = await planRoute(
      keyed(secret, "POST", `/competitions/${competitionId}/schedule/ai-plan`, {
        division_ids: divisions.map((d) => d.id),
        instruction: "plan it",
        mode: "generate",
      }),
      ctx(competitionId),
    );
    expect(res.status).toBe(403);
    expect(parse).not.toHaveBeenCalled();
  });

  it("returns the joint plan with per-division ids and the price block", async () => {
    const { auth, competitionId, divisions } = await seedBoard();
    const secret = await keyFor(auth, ["manage"]);
    parse.mockResolvedValue(planResponse(jointPlan(divisions)));
    const res = await planRoute(
      keyed(secret, "POST", `/competitions/${competitionId}/schedule/ai-plan`, {
        division_ids: divisions.map((d) => d.id),
        instruction: "plan the whole competition",
        mode: "generate",
      }),
      ctx(competitionId),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    const data = body.data;
    // Every proposed slot names the division the SERVER resolved it to.
    expect(data.proposal).toHaveLength(ALPHA_MOVABLE + BETA_MOVABLE);
    expect(new Set(data.proposal.map((p: { division_id: string }) => p.division_id))).toEqual(
      new Set(divisions.map((d) => d.id)),
    );
    // The price block, and the merged per-division array behind it.
    expect(typeof data.credits).toBe("number");
    expect(typeof data.discount).toBe("number");
    // Sorted by NAME, never by id — the determinism contract forbids ordering
    // on a UUID, and the pack's own division order is (name, slug) too.
    const byName = [...(data.divisions as { name: string; movable: number; rung: number }[])].sort(
      (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
    );
    expect(byName.map((d) => d.name)).toEqual(["Alpha", "Beta"]);
    // ASYMMETRIC by construction. Equal counts here would be satisfied just as
    // well by a merge that stamped the FIRST division's count onto every row.
    expect(byName.map((d) => d.movable)).toEqual([ALPHA_MOVABLE, BETA_MOVABLE]);
    expect(byName.every((d) => [1, 2, 3].includes(d.rung))).toBe(true);
    // The published contract must describe what the route actually sends: any
    // field the schema does not declare is stripped here and vanishes.
    expect(AiCompetitionPlanResponse.parse(data)).toEqual(data);
  });
});

// ---------------------------------------------------------------------------
// ai-last mirrors the division twin `lastAiApply` (schedule.ts:607) exactly:
// the last APPLIED plan (at + instruction + summary) plus a run counter. It is
// not a proposal recall — the single-division board has never persisted a
// proposal either, and a propose-only run writes no plan content anywhere.
// ---------------------------------------------------------------------------
describe.skipIf(!HAS_DB)("GET /competitions/{id}/schedule/ai-last", () => {
  /** Seed a competition_events row directly. Used for the DECOY types the
   *  counter must not count, and for the joint apply event Task 6 has not
   *  written yet — the reader cannot otherwise be exercised at all. */
  async function event(
    orgId: string,
    competitionId: string,
    type: string,
    payload: Record<string, unknown> = {},
  ): Promise<void> {
    await sql`
      insert into competition_events (competition_id, org_id, type, payload)
      values (${competitionId}, ${orgId}, ${type}, ${sql.json(payload as never)})`;
  }

  it("has no last apply and no runs before anything has happened, on a READ key", async () => {
    const { auth, competitionId } = await seedBoard();
    const secret = await keyFor(auth, ["read"]);
    const res = await lastRoute(
      keyed(secret, "GET", `/competitions/${competitionId}/schedule/ai-last`),
      ctx(competitionId),
    );
    expect(res.status).toBe(200);
    const data = (await res.json()).data;
    expect(data).toEqual({ last: null, runs: { used: 0, max: null } });
    expect(AiCompetitionLastResult.parse(data)).toEqual(data);
  });

  it("counts JOINT runs in runs.used — not single-division ones, not failures", async () => {
    const { auth, competitionId, divisions } = await seedBoard();
    const manage = await keyFor(auth, ["manage"]);
    // One REAL joint run, so the type the counter reads is the type the
    // orchestrator actually writes rather than one this test made up…
    parse.mockResolvedValue(planResponse(jointPlan(divisions)));
    const planned = await planRoute(
      keyed(manage, "POST", `/competitions/${competitionId}/schedule/ai-plan`, {
        division_ids: divisions.map((d) => d.id),
        instruction: "plan the whole competition",
        mode: "generate",
      }),
      ctx(competitionId),
    );
    expect(planned.status).toBe(200);
    // …plus a second joint run, so the expected count (2) can tell the joint
    // type apart from the three decoys below. With one of each, EVERY wrong
    // predicate would still return 1.
    await event(auth.orgId, competitionId, "schedule.ai_generated_multi", { phase: "schedule" });
    // Decoys: a SINGLE-division run on this same competition (the confusion
    // this branch has already produced four defects from), a failed joint run,
    // and an unrelated event.
    await event(auth.orgId, competitionId, "schedule.ai_generated", {
      division_id: divisions[0]!.id,
    });
    await event(auth.orgId, competitionId, "schedule.ai_failed_multi", { outcome: "failed" });
    await event(auth.orgId, competitionId, "discovery.opt_in");

    const read = await keyFor(auth, ["read"]);
    const res = await lastRoute(
      keyed(read, "GET", `/competitions/${competitionId}/schedule/ai-last`),
      ctx(competitionId),
    );
    expect(res.status).toBe(200);
    const data = (await res.json()).data;
    expect(data.runs).toEqual({ used: 2, max: null });
    // A run is not an apply: planning twice leaves nothing to recall.
    expect(data.last).toBeNull();
  });

  it("recalls the most recent joint APPLY once one exists", async () => {
    // Task 6 writes this event; nothing does yet, so the rows are synthesised
    // here. That makes this test the CONTRACT Task 6 has to honour — the type
    // string, `source: "ai"`, and `ai.instruction` / `ai.summary` — not a
    // restatement of code that already exists.
    const { auth, competitionId } = await seedBoard();
    await event(auth.orgId, competitionId, "schedule.applied_multi", {
      source: "ai",
      ai: { instruction: "the older one", summary: "older summary" },
    });
    await event(auth.orgId, competitionId, "schedule.applied_multi", {
      source: "ai",
      ai: { instruction: "spread the finals out", summary: "moved 4 fixtures across 2 divisions" },
    });
    // A MANUAL joint apply is not an AI recall — same event type, no `ai` block.
    await event(auth.orgId, competitionId, "schedule.applied_multi", { source: "manual" });

    const read = await keyFor(auth, ["read"]);
    const res = await lastRoute(
      keyed(read, "GET", `/competitions/${competitionId}/schedule/ai-last`),
      ctx(competitionId),
    );
    expect(res.status).toBe(200);
    const data = (await res.json()).data;
    expect(data.last).not.toBeNull();
    expect(data.last.instruction).toBe("spread the finals out");
    expect(data.last.summary).toBe("moved 4 fixtures across 2 divisions");
    // The recall carries the applied plan and nothing else — no proposal, no
    // price block. The whole envelope is asserted so a field cannot creep back.
    expect(Object.keys(data.last).sort()).toEqual(["at", "instruction", "summary"]);
    expect(data.runs).toEqual({ used: 0, max: null });
    // …and it satisfies the schema the OpenAPI spec publishes, `at`'s
    // ISO-with-offset format included. Nothing parses a response at runtime, so
    // without this the declared contract is never checked against a real one.
    expect(AiCompetitionLastResult.parse(data)).toEqual(data);
  });
});

describe("registration", () => {
  it("declares both routes in the OpenAPI registry", () => {
    const declared = ROUTES.map((r) => `${r.method} ${r.path}`);
    expect(declared).toContain("post /competitions/{id}/schedule/ai-plan");
    expect(declared).toContain("get /competitions/{id}/schedule/ai-last");
  });

  it("classifies both routes for API keys — plan is manage, last is read", () => {
    const id = "11111111-1111-1111-1111-111111111111";
    expect(matchKeyRoute("POST", `/api/v1/competitions/${id}/schedule/ai-plan`)).toMatchObject({
      scope: "manage",
      pin: "competition",
      resourceId: id,
    });
    expect(matchKeyRoute("GET", `/api/v1/competitions/${id}/schedule/ai-last`)).toMatchObject({
      scope: "read",
      pin: "competition",
      resourceId: id,
    });
  });
});
