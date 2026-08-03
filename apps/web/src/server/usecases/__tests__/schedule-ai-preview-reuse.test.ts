// W5 (#400) Task 2 — the run reuses the confirmed compile, or refuses.
//
// The preview (Task 1) showed the organiser what their sentence compiled into.
// This suite pins what the RUN then does with that confirmation, and every
// assertion here is about something that would otherwise be invisible:
//
//   * a confirmed preview means the run compiles ZERO times. Not "the run
//     succeeded" — the parse-call COUNT, because a second compile is a second
//     non-deterministic LLM answer, and the architect would then execute rules
//     the organiser never saw. That silent divergence is the entire failure this
//     wave exists to close, and only a count can catch it.
//   * a `preview_id` whose stored hash does not match the submitted instruction
//     is a 409 `preview_stale` with ZERO architect calls. Recompiling instead
//     would run — and CHARGE — under a confirmation given for a different
//     sentence.
//   * a preview is single-use. A double-submit off one confirmation must not
//     buy two runs.
//   * a preview from another org, another scope, or past its TTL is refused.
//     Cross-tenant reuse would be a security defect, not a bug.
//   * no `preview_id` compiles inline exactly as today, so smoke, e2e and every
//     external API consumer keep working unchanged.
//   * reuse does not consume a SECOND rate-limit token — the preview already
//     paid for it — while a run without one still consumes its own.
//
// Harness: the stage-1 compiler is replaced by a spy (so "compiles zero times"
// is countable and no compile ever reaches a network), the architect runs
// through a stubbed AiProvider, and the Redis window counter is an in-memory
// Map so the 429 path is genuinely exercised. Everything else — entitlements,
// credits, the pack builder, ai_parse_previews — is real Postgres.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { AiChatResponse } from "@/server/ai/provider";

const { chat, parseInstructionMock, incrWindow, rlCounts } = vi.hoisted(() => {
  const rlCounts = new Map<string, number>();
  return {
    chat: vi.fn(),
    parseInstructionMock: vi.fn(),
    incrWindow: vi.fn(async (key: string) => {
      const n = (rlCounts.get(key) ?? 0) + 1;
      rlCounts.set(key, n);
      return n;
    }),
    rlCounts,
  };
});

// The stage-1 compiler, as a SPY rather than a stub of the provider: both the
// preview and the run reach it through the same module binding, so one counter
// answers "how many times did this instruction get compiled" across the two
// requests — which is the question every test below asks.
vi.mock("../schedule-ai-parse", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../schedule-ai-parse")>();
  return { ...actual, parseInstruction: parseInstructionMock };
});

// Replacing resolveProvider outright, not just the Anthropic SDK: the shipped
// ladder's first rung is OpenRouter and a developer .env.local carries a real
// key, so an SDK-only mock still lets rung 1 make a live call.
vi.mock("@/server/ai/select-provider", () => {
  const provider = { id: "anthropic" as const, isConfigured: () => true, chat };
  return { selectProvider: () => provider, resolveProvider: () => provider };
});

vi.mock("@/lib/cache", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/cache")>();
  return { ...actual, incrWindow };
});

import { sql } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import type { AuthCtx } from "@/server/api-v1/auth";
import type { RawParsed } from "../schedule-ai-parse";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { createStages, generateStageFixtures } from "../stages";
import { aiPlanForDivision } from "../schedule-ai";
import { aiPlanForCompetition } from "../competition-schedule-ai";
import { previewScheduleAi, PREVIEW_TTL_MS } from "../schedule-ai-preview";
import { GENERIC_CONFIG, seedOrg } from "./_seed";
import { setOrgPlan } from "@/lib/__tests__/_billing-group";
import { recordPackPurchase, walletIdFor } from "@/lib/credits";

const HAS_DB = !!process.env.DATABASE_URL;
const TZ = "Europe/London";
const MIN = 60_000;
const T0 = Date.parse("2026-08-01T09:00:00.000Z");

const INSTRUCTION = "nothing before 8am please, and moar vibes";
const OTHER_INSTRUCTION = "nothing before 11am please, and moar vibes";

/** What the stubbed compiler answers with. `not_before 08:00` is satisfied by
 *  every plan below, so the rule is genuinely threaded through the pack without
 *  turning the run into a repair loop that would eat the queued architect
 *  answers and make the call counts meaningless. */
const COMPILED: RawParsed = {
  hard: [{ type: "not_before", time: "08:00", scope: { kind: "competition" } }],
  soft: [],
  unparsed: ["moar vibes"],
} as RawParsed;

/** Compiles of the instruction — preview AND run, across both requests. */
const parseCalls = (): number => parseInstructionMock.mock.calls.length;
/** Architect (stage-2) calls. A refusal must make none. */
const architectCalls = (): number => chat.mock.calls.length;

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
  courts: string[];
  fixtureIds: string[];
}

async function seedDivision(
  auth: AuthCtx,
  competitionId: string,
  name: string,
  courts: string[] = ["Court 1", "Court 2"],
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
    Array.from({ length: 4 }, (_, i) => ({
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
  return {
    id: division.id,
    courts,
    fixtureIds: [...fixtures]
      .sort((a, b) => a.round_no - b.round_no || a.seq_in_round - b.seq_in_round)
      .map((f) => f.id),
  };
}

/** pro_plus (scheduling.ai + scheduling.multi_division) with a funded wallet. */
async function seedPlusOrg(credits = 100): Promise<AuthCtx> {
  const { auth } = await seedOrg("community");
  await setOrgPlan(auth.orgId, "pro_plus");
  await invalidateOrgEntitlements(auth.orgId);
  await recordPackPurchase(await walletIdFor(auth.orgId), credits, `seed-${randomUUID()}`);
  return auth;
}

async function seedSingle(): Promise<{ auth: AuthCtx; division: SeededDivision }> {
  const auth = await seedPlusOrg();
  const comp = await createCompetition(auth, {
    name: "W5 Reuse",
    visibility: "public",
    branding: {},
  });
  return { auth, division: await seedDivision(auth, comp.id, "Open") };
}

async function seedJoint(): Promise<{
  auth: AuthCtx;
  competitionId: string;
  divisions: SeededDivision[];
}> {
  const auth = await seedPlusOrg();
  const comp = await createCompetition(auth, {
    name: "W5 Joint Reuse",
    visibility: "public",
    branding: {},
  });
  // Disjoint court sets, so a per-division-legal plan holds no cross-division
  // clash and the joint runner returns on the first round.
  const a = await seedDivision(auth, comp.id, "Alpha", ["Court 1", "Court 2"]);
  const b = await seedDivision(auth, comp.id, "Beta", ["Court 3", "Court 4"]);
  return { auth, competitionId: comp.id, divisions: [a, b] };
}

/** A legal plan for one division: two fixtures per 30-minute slot on its own
 *  courts, inside the 09:00–21:00Z session window. */
function legalPlan(divisions: SeededDivision[]): unknown {
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
    summary: "ok",
  };
}

function chatResponse(parsed: unknown): AiChatResponse<unknown> {
  return {
    parsed,
    assistantTurn: { role: "assistant", content: [] },
    usage: { inputTokens: 1000, outputTokens: 500, costUsd: 0.01 },
    servedModel: "claude-sonnet-5",
    refused: false,
  };
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
  rlCounts.clear();
  parseInstructionMock.mockReset().mockImplementation(async () => ({
    raw: COMPILED,
    failed: false,
    tokens: 300,
    servedModel: "stub-parser",
  }));
  process.env.ANTHROPIC_API_KEY = "test-key";
});

describe.skipIf(!HAS_DB)("the run reuses a confirmed compile (W5 #400, single division)", () => {
  it("does not recompile when a valid preview is confirmed", async () => {
    const { auth, division } = await seedSingle();
    const p = await previewScheduleAi(auth, { kind: "division", id: division.id }, {
      instruction: INSTRUCTION,
    });
    expect(p.preview_id).toBeTruthy();
    expect(parseCalls()).toBe(1);
    parseInstructionMock.mockClear();

    chat.mockResolvedValueOnce(chatResponse(legalPlan([division])));
    const run = await aiPlanForDivision(auth, division.id, {
      instruction: INSTRUCTION,
      mode: "generate",
      preview_id: p.preview_id,
    });

    // THE assertion of this wave: the confirmed compile is the one that ran.
    expect(parseCalls()).toBe(0);
    expect(architectCalls()).toBe(1);
    expect(run.proposal).toHaveLength(division.fixtureIds.length);
    expect(run.warnings).toBeDefined();

    // Single-use: the row is claimed by the run that used it.
    const [row] = await sql<{ consumed_at: Date | null }[]>`
      select consumed_at from ai_parse_previews where id = ${p.preview_id!}`;
    expect(row!.consumed_at).not.toBeNull();
  });

  it("409s rather than silently recompiling a changed instruction", async () => {
    const { auth, division } = await seedSingle();
    const p = await previewScheduleAi(auth, { kind: "division", id: division.id }, {
      instruction: INSTRUCTION,
    });
    parseInstructionMock.mockClear();

    await expect(
      aiPlanForDivision(auth, division.id, {
        instruction: OTHER_INSTRUCTION,
        mode: "generate",
        preview_id: p.preview_id,
      }),
    ).rejects.toMatchObject({ status: 409, code: "preview_stale" });

    // Nothing was spent on the mismatch, in either stage.
    expect(architectCalls()).toBe(0);
    expect(parseCalls()).toBe(0);
    // …and the mismatch did not destroy the preview the organiser DID confirm.
    const [row] = await sql<{ consumed_at: Date | null }[]>`
      select consumed_at from ai_parse_previews where id = ${p.preview_id!}`;
    expect(row!.consumed_at).toBeNull();
  });

  it("refuses a preview_id that names no row at all", async () => {
    const { auth, division } = await seedSingle();
    await expect(
      aiPlanForDivision(auth, division.id, {
        instruction: INSTRUCTION,
        mode: "generate",
        preview_id: randomUUID(),
      }),
    ).rejects.toMatchObject({ status: 409, code: "preview_stale" });
    expect(architectCalls()).toBe(0);
  });

  it("is single-use — a double-submit cannot run twice off one confirmation", async () => {
    const { auth, division } = await seedSingle();
    const p = await previewScheduleAi(auth, { kind: "division", id: division.id }, {
      instruction: INSTRUCTION,
    });

    chat.mockResolvedValueOnce(chatResponse(legalPlan([division])));
    await aiPlanForDivision(auth, division.id, {
      instruction: INSTRUCTION,
      mode: "generate",
      preview_id: p.preview_id,
    });
    expect(architectCalls()).toBe(1);

    await expect(
      aiPlanForDivision(auth, division.id, {
        instruction: INSTRUCTION,
        mode: "generate",
        preview_id: p.preview_id,
      }),
    ).rejects.toMatchObject({ status: 409, code: "preview_stale" });
    // The replay bought nothing.
    expect(architectCalls()).toBe(1);
  });

  it("refuses a preview belonging to another org", async () => {
    const a = await seedSingle();
    const b = await seedSingle();
    const p = await previewScheduleAi(a.auth, { kind: "division", id: a.division.id }, {
      instruction: INSTRUCTION,
    });
    parseInstructionMock.mockClear();

    // Org B quoting org A's preview id. Honouring it would be a cross-tenant
    // read of another organisation's compiled instruction.
    await expect(
      aiPlanForDivision(b.auth, b.division.id, {
        instruction: INSTRUCTION,
        mode: "generate",
        preview_id: p.preview_id,
      }),
    ).rejects.toMatchObject({ status: 409, code: "preview_stale" });
    expect(architectCalls()).toBe(0);
    expect(parseCalls()).toBe(0);
  });

  it("refuses a preview taken against a different division", async () => {
    const { auth } = await seedSingle();
    const comp = await createCompetition(auth, {
      name: "W5 Scope",
      visibility: "public",
      branding: {},
    });
    const one = await seedDivision(auth, comp.id, "One");
    const two = await seedDivision(auth, comp.id, "Two");
    const p = await previewScheduleAi(auth, { kind: "division", id: one.id }, {
      instruction: INSTRUCTION,
    });

    await expect(
      aiPlanForDivision(auth, two.id, {
        instruction: INSTRUCTION,
        mode: "generate",
        preview_id: p.preview_id,
      }),
    ).rejects.toMatchObject({ status: 409, code: "preview_stale" });
    expect(architectCalls()).toBe(0);
  });

  it("refuses an expired preview", async () => {
    const { auth, division } = await seedSingle();
    const p = await previewScheduleAi(auth, { kind: "division", id: division.id }, {
      instruction: INSTRUCTION,
    });
    // Age it past the TTL. The org clock can cross a day boundary inside a long
    // enough gap, and "tomorrow" with it, so a stale-by-wall-clock preview is
    // refused for the same reason a stale-by-content one is.
    await sql`
      update ai_parse_previews
         set expires_at = now() - interval '1 minute'
       where id = ${p.preview_id!}`;
    expect(PREVIEW_TTL_MS).toBeGreaterThan(0);

    await expect(
      aiPlanForDivision(auth, division.id, {
        instruction: INSTRUCTION,
        mode: "generate",
        preview_id: p.preview_id,
      }),
    ).rejects.toMatchObject({ status: 409, code: "preview_stale" });
    expect(architectCalls()).toBe(0);
  });

  it("still compiles inline when no preview_id is supplied", async () => {
    const { auth, division } = await seedSingle();
    chat.mockResolvedValueOnce(chatResponse(legalPlan([division])));

    const run = await aiPlanForDivision(auth, division.id, {
      instruction: INSTRUCTION,
      mode: "generate",
    });

    // API consumers, smoke and e2e never send one and must keep working.
    expect(parseCalls()).toBe(1);
    expect(run.proposal).toHaveLength(division.fixtureIds.length);
  });

  it("does not consume a second rate-limit token when a preview is reused", async () => {
    const { auth, division } = await seedSingle();
    // Five previews exhaust the 5/hour bucket the run shares.
    let last: string | undefined;
    for (let i = 0; i < 5; i++) {
      const p = await previewScheduleAi(auth, { kind: "division", id: division.id }, {
        instruction: INSTRUCTION,
      });
      last = p.preview_id;
    }
    expect(rlCounts.get(`rl:ai-plan:${division.id}`)).toBe(5);
    // A SIXTH look is refused — the bucket is genuinely spent.
    await expect(
      previewScheduleAi(auth, { kind: "division", id: division.id }, { instruction: INSTRUCTION }),
    ).rejects.toMatchObject({ status: 429 });

    // …but confirming what the organiser already paid a token to see must still
    // run. The preview WAS the LLM round the limit exists to bound.
    chat.mockResolvedValueOnce(chatResponse(legalPlan([division])));
    const run = await aiPlanForDivision(auth, division.id, {
      instruction: INSTRUCTION,
      mode: "generate",
      preview_id: last,
    });
    expect(run.proposal).toHaveLength(division.fixtureIds.length);
    expect(rlCounts.get(`rl:ai-plan:${division.id}`)).toBe(6);
  });

  it("a run WITHOUT a preview still consumes a rate-limit token", async () => {
    const { auth, division } = await seedSingle();
    chat.mockResolvedValueOnce(chatResponse(legalPlan([division])));
    await aiPlanForDivision(auth, division.id, { instruction: INSTRUCTION, mode: "generate" });
    expect(rlCounts.get(`rl:ai-plan:${division.id}`)).toBe(1);
  });
});

describe.skipIf(!HAS_DB)("the run reuses a confirmed compile (W5 #400, joint)", () => {
  it("does not recompile when a valid joint preview is confirmed", async () => {
    const { auth, competitionId, divisions } = await seedJoint();
    const ids = divisions.map((d) => d.id);
    const p = await previewScheduleAi(auth, { kind: "competition", id: competitionId }, {
      instruction: INSTRUCTION,
      division_ids: ids,
    });
    expect(p.preview_id).toBeTruthy();
    parseInstructionMock.mockClear();

    chat.mockResolvedValueOnce(chatResponse(legalPlan(divisions)));
    const run = await aiPlanForCompetition(auth, competitionId, {
      division_ids: ids,
      instruction: INSTRUCTION,
      mode: "generate",
      preview_id: p.preview_id,
    });

    expect(parseCalls()).toBe(0);
    expect(architectCalls()).toBe(1);
    expect(run.proposal).toHaveLength(divisions.flatMap((d) => d.fixtureIds).length);

    const [row] = await sql<{ consumed_at: Date | null }[]>`
      select consumed_at from ai_parse_previews where id = ${p.preview_id!}`;
    expect(row!.consumed_at).not.toBeNull();
  });

  it("409s rather than silently recompiling a changed joint instruction", async () => {
    const { auth, competitionId, divisions } = await seedJoint();
    const ids = divisions.map((d) => d.id);
    const p = await previewScheduleAi(auth, { kind: "competition", id: competitionId }, {
      instruction: INSTRUCTION,
      division_ids: ids,
    });
    parseInstructionMock.mockClear();

    await expect(
      aiPlanForCompetition(auth, competitionId, {
        division_ids: ids,
        instruction: OTHER_INSTRUCTION,
        mode: "generate",
        preview_id: p.preview_id,
      }),
    ).rejects.toMatchObject({ status: 409, code: "preview_stale" });
    expect(architectCalls()).toBe(0);
    expect(parseCalls()).toBe(0);
  });

  it("refuses a joint preview belonging to another org", async () => {
    const a = await seedJoint();
    const b = await seedJoint();
    const p = await previewScheduleAi(a.auth, { kind: "competition", id: a.competitionId }, {
      instruction: INSTRUCTION,
      division_ids: a.divisions.map((d) => d.id),
    });

    await expect(
      aiPlanForCompetition(b.auth, b.competitionId, {
        division_ids: b.divisions.map((d) => d.id),
        instruction: INSTRUCTION,
        mode: "generate",
        preview_id: p.preview_id,
      }),
    ).rejects.toMatchObject({ status: 409, code: "preview_stale" });
    expect(architectCalls()).toBe(0);
  });

  it("refuses a single-division preview quoted at the joint run", async () => {
    const { auth, competitionId, divisions } = await seedJoint();
    // Same org, same competition, right instruction — but compiled against ONE
    // division, so its window was resolved from a different fixture count than
    // the joint run's. Scope is part of a preview's identity, not decoration.
    const p = await previewScheduleAi(auth, { kind: "division", id: divisions[0]!.id }, {
      instruction: INSTRUCTION,
    });

    await expect(
      aiPlanForCompetition(auth, competitionId, {
        division_ids: divisions.map((d) => d.id),
        instruction: INSTRUCTION,
        mode: "generate",
        preview_id: p.preview_id,
      }),
    ).rejects.toMatchObject({ status: 409, code: "preview_stale" });
    expect(architectCalls()).toBe(0);
  });

  it("still compiles inline when the joint run supplies no preview_id", async () => {
    const { auth, competitionId, divisions } = await seedJoint();
    chat.mockResolvedValueOnce(chatResponse(legalPlan(divisions)));

    await aiPlanForCompetition(auth, competitionId, {
      division_ids: divisions.map((d) => d.id),
      instruction: INSTRUCTION,
      mode: "generate",
    });
    expect(parseCalls()).toBe(1);
  });

  it("does not consume a second joint rate-limit token when a preview is reused", async () => {
    const { auth, competitionId, divisions } = await seedJoint();
    const ids = divisions.map((d) => d.id);
    // Three previews exhaust the joint 3/hour bucket.
    let last: string | undefined;
    for (let i = 0; i < 3; i++) {
      const p = await previewScheduleAi(auth, { kind: "competition", id: competitionId }, {
        instruction: INSTRUCTION,
        division_ids: ids,
      });
      last = p.preview_id;
    }
    expect(rlCounts.get(`rl:ai-plan-competition:${competitionId}`)).toBe(3);

    chat.mockResolvedValueOnce(chatResponse(legalPlan(divisions)));
    const run = await aiPlanForCompetition(auth, competitionId, {
      division_ids: ids,
      instruction: INSTRUCTION,
      mode: "generate",
      preview_id: last,
    });
    expect(run.proposal.length).toBeGreaterThan(0);
    expect(rlCounts.get(`rl:ai-plan-competition:${competitionId}`)).toBe(3);
  });
});
