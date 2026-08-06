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
import { dayKeyInTz, ymdAddDays, zonedTimeToUtc } from "@seazn/engine/scheduling";
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
import { hashInstruction, previewScheduleAi, PREVIEW_TTL_MS } from "../schedule-ai-preview";
import { GENERIC_CONFIG, seedOrg } from "./_seed";
import { setOrgPlan } from "@/lib/__tests__/_billing-group";
import { balance, recordPackPurchase, walletIdFor } from "@/lib/credits";

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
    ends_on: "2030-12-31",
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
    ends_on: "2030-12-31",
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

/** The same plan shape as {@link legalPlan}, but anchored on a named DAY rather
 *  than on the fixed `T0`. The window tests below move the org clock, so their
 *  assignments have to move with it or every card arrives outside `pack.window`
 *  — a BLOCKING conflict (`isBlockingConflict`), which would turn the run into a
 *  repair loop and make the architect call count meaningless. */
function planOnDay(d: SeededDivision, ymd: string): unknown {
  const base = zonedTimeToUtc(ymd, "10:00", TZ);
  return {
    assignments: d.fixtureIds.map((id, i) => ({
      fixture_id: id,
      scheduled_at: new Date(base + Math.floor(i / d.courts.length) * 30 * MIN).toISOString(),
      court_label: d.courts[i % d.courts.length]!,
    })),
    unschedulable: [],
    explanations: [],
    summary: "ok",
  };
}

/** Move a seeded division's settings onto `ymd`, so its session window and start
 *  anchor agree with the day the run is actually placing on. */
async function retargetSettingsTo(d: SeededDivision, ymd: string): Promise<void> {
  const from = new Date(zonedTimeToUtc(ymd, "08:00", TZ)).toISOString();
  const to = new Date(zonedTimeToUtc(ymd, "22:00", TZ)).toISOString();
  const config = { ...settingsConfig(d.courts), startAt: from, sessionWindows: [{ from, to }] };
  await sql`
    update schedule_settings set config = ${sql.json(config as never)}, updated_at = now()
     where division_id = ${d.id}`;
}

/** The pack as the architect actually received it on round `n`. The pack is the
 *  ONE artefact that carries the executed window, and it reaches the model as
 *  the first user turn's JSON — asserting on it is the only way to tell "the run
 *  used the window we showed" apart from "the run happened to succeed". */
function packSentToArchitect(n = 0): { window: { start: string; end: string } } {
  const call = chat.mock.calls[n]![0] as { messages: { role: string; content: string }[] };
  return JSON.parse(call.messages[0]!.content) as { window: { start: string; end: string } };
}

/** A model REFUSAL — the cheapest way to make the ladder fail for real. It is
 *  fatal rather than retried, so the run surfaces 422 AI_PLAN_FAILED and
 *  `spendCredit` releases the hold it had already taken. */
function refusalResponse(): AiChatResponse<unknown> {
  return {
    parsed: null,
    assistantTurn: { role: "assistant", content: [] },
    usage: { inputTokens: 700, outputTokens: 40, costUsd: 0 },
    servedModel: "claude-sonnet-5",
    refused: true,
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
      ends_on: "2030-12-31",
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

// ---------------------------------------------------------------------------
// Task 2b — the three holes the Task 2/3 review found in the gate above.
// ---------------------------------------------------------------------------

/** H1. A joint preview's identity has to include WHICH divisions it compiled
 *  for, because `scope_id` is the competition and says nothing about the set.
 *  The window is resolved from the SUMMED movable-fixture count of the
 *  divisions in scope, and the stage-1 prompt lists them by name — so the same
 *  sentence over a different set is a different compile, and honouring it would
 *  place the extra division's fixtures under a window resolved without them. */
describe.skipIf(!HAS_DB)("a joint preview is bound to its division SET (W5 #400 H1)", () => {
  it("refuses a run that adds a division the preview never compiled for", async () => {
    const { auth, competitionId, divisions } = await seedJoint();
    // Disjoint courts again, so the extra division cannot be refused for a
    // reason other than the one under test.
    const gamma = await seedDivision(auth, competitionId, "Gamma", ["Court 5", "Court 6"]);
    const p = await previewScheduleAi(auth, { kind: "competition", id: competitionId }, {
      instruction: INSTRUCTION,
      division_ids: divisions.map((d) => d.id),
    });
    expect(p.preview_id).toBeTruthy();
    parseInstructionMock.mockClear();

    await expect(
      aiPlanForCompetition(auth, competitionId, {
        division_ids: [...divisions.map((d) => d.id), gamma.id],
        instruction: INSTRUCTION,
        mode: "generate",
        preview_id: p.preview_id,
      }),
    ).rejects.toMatchObject({ status: 409, code: "preview_stale" });
    // Nothing spent, and the confirmation the organiser DID give survives.
    expect(architectCalls()).toBe(0);
    expect(parseCalls()).toBe(0);
    const [row] = await sql<{ consumed_at: Date | null }[]>`
      select consumed_at from ai_parse_previews where id = ${p.preview_id!}`;
    expect(row!.consumed_at).toBeNull();
  });

  it("refuses a run that DROPS a division the preview compiled for", async () => {
    const { auth, competitionId, divisions } = await seedJoint();
    const gamma = await seedDivision(auth, competitionId, "Gamma", ["Court 5", "Court 6"]);
    const p = await previewScheduleAi(auth, { kind: "competition", id: competitionId }, {
      instruction: INSTRUCTION,
      division_ids: [...divisions.map((d) => d.id), gamma.id],
    });
    parseInstructionMock.mockClear();

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

  it("reuses a preview when the SAME set arrives in a different order", async () => {
    const { auth, competitionId, divisions } = await seedJoint();
    const ids = divisions.map((d) => d.id);
    const p = await previewScheduleAi(auth, { kind: "competition", id: competitionId }, {
      instruction: INSTRUCTION,
      division_ids: ids,
    });
    parseInstructionMock.mockClear();

    // The multi-select's order is a UI accident, not a fact about the run: the
    // check is on the SET, so reordering must not cost a recompile.
    chat.mockResolvedValueOnce(chatResponse(legalPlan(divisions)));
    const run = await aiPlanForCompetition(auth, competitionId, {
      division_ids: [...ids].reverse(),
      instruction: INSTRUCTION,
      mode: "generate",
      preview_id: p.preview_id,
    });
    expect(parseCalls()).toBe(0);
    expect(architectCalls()).toBe(1);
    expect(run.proposal).toHaveLength(divisions.flatMap((d) => d.fixtureIds).length);
  });
});

/** H2. The stored `resolved` is the one the run must execute. Without it,
 *  `buildSchedulePack` falls back to re-resolving the same `raw` against the
 *  CURRENT clock — no extra model call, no visible difference, and a "tomorrow"
 *  that has quietly become a different day. Only a test that moves the org clock
 *  between the preview and the run can see it. */
describe.skipIf(!HAS_DB)("the run executes the window it SHOWED (W5 #400 H2)", () => {
  it("keeps the previewed window when the org clock crosses a day boundary", async () => {
    const { auth, division } = await seedSingle();
    // The ORG clock is what "tomorrow" is resolved against (#397) — never a
    // division override — so this test has to state which one it is.
    await sql`update organizations set timezone = ${TZ} where id = ${auth.orgId}`;

    // A day comfortably ahead of the real clock: only `Date` is faked below, so
    // the row's TTL — which Postgres checks against ITS OWN now() — stays live
    // while the JS clock moves. Timers are left real so the pg driver is
    // untouched.
    const previewDay = dayKeyInTz(Date.now() + 3 * 24 * 3600_000, TZ);
    const runDay = ymdAddDays(previewDay, 1);
    await retargetSettingsTo(division, runDay);

    // "…and run it all tomorrow" — the one word whose meaning depends entirely
    // on which day it was compiled.
    parseInstructionMock.mockImplementation(async () => ({
      raw: {
        hard: [
          { type: "not_before", time: "08:00", scope: { kind: "competition" } },
          {
            type: "window",
            start: { kind: "tomorrow" },
            end: { kind: "tomorrow" },
            scope: { kind: "competition" },
          },
        ],
        soft: [],
        unparsed: [],
      } as RawParsed,
      failed: false,
      tokens: 300,
      servedModel: "stub-parser",
    }));

    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(zonedTimeToUtc(previewDay, "23:30", TZ));
      const p = await previewScheduleAi(auth, { kind: "division", id: division.id }, {
        instruction: INSTRUCTION,
      });
      // What the organiser was shown, and then confirmed.
      expect(p.window).toMatchObject({ start: runDay, end: runDay, tz: TZ });

      // One hour later on the wall clock — but a different DAY in the org zone,
      // so re-resolving the same `raw` would now land on runDay + 1.
      vi.setSystemTime(zonedTimeToUtc(runDay, "00:30", TZ));
      chat.mockResolvedValue(chatResponse(planOnDay(division, runDay)));
      const run = await aiPlanForDivision(auth, division.id, {
        instruction: INSTRUCTION,
        mode: "generate",
        preview_id: p.preview_id,
      });
      expect(run.proposal).toHaveLength(division.fixtureIds.length);
    } finally {
      vi.useRealTimers();
    }

    // THE assertion: the calendar the architect was handed is the calendar the
    // organiser approved, not one re-derived from a clock that has since moved.
    const sent = packSentToArchitect();
    expect(sent.window.start.slice(0, 10)).toBe(runDay);
    expect(sent.window.end.slice(0, 10)).toBe(runDay);
    // …and only one round happened, so the window above is the one that ran.
    expect(architectCalls()).toBe(1);
  });
});

/** H3. The claim is taken before the pack, the quote and the reserve. A run that
 *  falls over on the way there used to leave `consumed_at` set with nothing
 *  bought: the retry 409s and the organiser pays for another compile. Both
 *  properties have to hold at once — a failed run gives the confirmation back,
 *  and a double-submit still buys exactly one run. */
describe.skipIf(!HAS_DB)("a failed run gives the confirmation back (W5 #400 H3)", () => {
  it("releases the claim when the run is refused before a credit is reserved", async () => {
    const { auth, division } = await seedSingle();
    const p = await previewScheduleAi(auth, { kind: "division", id: division.id }, {
      instruction: INSTRUCTION,
    });
    parseInstructionMock.mockClear();

    // The wallet empties between looking and confirming — an ordinary sequence
    // when a second run of the same org lands first.
    const walletId = await walletIdFor(auth.orgId);
    await sql`delete from ai_credit_ledger where wallet_id = ${walletId}`;

    await expect(
      aiPlanForDivision(auth, division.id, {
        instruction: INSTRUCTION,
        mode: "generate",
        preview_id: p.preview_id,
      }),
    ).rejects.toMatchObject({ status: 402 });
    expect(architectCalls()).toBe(0);

    // Nothing was bought, so nothing was spent: the confirmation survives.
    const [row] = await sql<{ consumed_at: Date | null }[]>`
      select consumed_at from ai_parse_previews where id = ${p.preview_id!}`;
    expect(row!.consumed_at).toBeNull();

    // …and the retry runs on the compile the organiser already approved rather
    // than paying for a second one.
    await recordPackPurchase(walletId, 100, `refund-${randomUUID()}`);
    chat.mockResolvedValueOnce(chatResponse(legalPlan([division])));
    const run = await aiPlanForDivision(auth, division.id, {
      instruction: INSTRUCTION,
      mode: "generate",
      preview_id: p.preview_id,
    });
    expect(parseCalls()).toBe(0);
    expect(run.proposal).toHaveLength(division.fixtureIds.length);
  });

  it("releases the claim when the ARCHITECT fails and the hold is refunded", async () => {
    const { auth, division } = await seedSingle();
    const walletId = await walletIdFor(auth.orgId);
    const p = await previewScheduleAi(auth, { kind: "division", id: division.id }, {
      instruction: INSTRUCTION,
    });
    parseInstructionMock.mockClear();
    const funded = await balance(walletId);

    // The failure the reserve does NOT protect against: the credit is taken and
    // then given straight back (`spendCredit` releases on any throw from the
    // ladder). "The reserve succeeded" is therefore not the same question as
    // "was anything bought".
    chat.mockResolvedValue(refusalResponse());
    await expect(
      aiPlanForDivision(auth, division.id, {
        instruction: INSTRUCTION,
        mode: "generate",
        preview_id: p.preview_id,
      }),
    ).rejects.toMatchObject({ status: 422, code: "AI_PLAN_FAILED" });

    // The organiser paid nothing…
    expect(await balance(walletId)).toBe(funded);
    // …so they still hold their confirmation.
    const [row] = await sql<{ consumed_at: Date | null }[]>`
      select consumed_at from ai_parse_previews where id = ${p.preview_id!}`;
    expect(row!.consumed_at).toBeNull();

    // And the retry runs on the compile they already approved rather than
    // buying a second one.
    chat.mockReset();
    chat.mockResolvedValueOnce(chatResponse(legalPlan([division])));
    const run = await aiPlanForDivision(auth, division.id, {
      instruction: INSTRUCTION,
      mode: "generate",
      preview_id: p.preview_id,
    });
    expect(parseCalls()).toBe(0);
    expect(run.proposal).toHaveLength(division.fixtureIds.length);
  });

  it("refuses an unaffordable reuse BEFORE the board is read", async () => {
    const { auth, division } = await seedSingle();
    const p = await previewScheduleAi(auth, { kind: "division", id: division.id }, {
      instruction: INSTRUCTION,
    });
    const walletId = await walletIdFor(auth.orgId);
    await sql`delete from ai_credit_ledger where wallet_id = ${walletId}`;

    // `scope.courts` names a court this division does not have — a 400 that ONLY
    // `buildSchedulePack` can raise. Getting the 402 instead is the proof that
    // the restored affordability bound refused before any of the board was read;
    // without it the reserve's own 402 would arrive several queries too late.
    await expect(
      aiPlanForDivision(auth, division.id, {
        instruction: INSTRUCTION,
        mode: "generate",
        scope: { courts: ["Court 99"] },
        preview_id: p.preview_id,
      }),
    ).rejects.toMatchObject({ status: 402 });
    expect(architectCalls()).toBe(0);
  });

  it("still buys exactly one run when the same preview_id is submitted twice at once", async () => {
    const { auth, division } = await seedSingle();
    const p = await previewScheduleAi(auth, { kind: "division", id: division.id }, {
      instruction: INSTRUCTION,
    });
    // Both submits are answered, so nothing but the claim itself can serialise
    // them.
    chat.mockResolvedValue(chatResponse(legalPlan([division])));

    const submit = (): Promise<unknown> =>
      aiPlanForDivision(auth, division.id, {
        instruction: INSTRUCTION,
        mode: "generate",
        preview_id: p.preview_id,
      });
    const settled = await Promise.allSettled([submit(), submit()]);

    expect(settled.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = settled.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toMatchObject({ status: 409, code: "preview_stale" });
    // One architect call — the double-submit bought one run, not two.
    expect(architectCalls()).toBe(1);
  });

  it("refuses a stored parse whose shape the engine no longer accepts", async () => {
    const { auth, division } = await seedSingle();
    const p = await previewScheduleAi(auth, { kind: "division", id: division.id }, {
      instruction: INSTRUCTION,
    });
    // A deploy lands inside the preview's 30-minute life and `HardConstraint` no
    // longer has this shape. Feeding it to the verifier would present a rule as
    // enforced while nothing can check it — refuse, and let the organiser
    // recompile against the code that is actually running.
    await sql`
      update ai_parse_previews
         set resolved = ${sql.json({
           hard: [{ type: "not_before", time: "half past eight", scope: { kind: "competition" } }],
           soft: [],
           unparsed: [],
           assumptions: [],
           windowMs: null,
         } as never)}
       where id = ${p.preview_id!}`;

    await expect(
      aiPlanForDivision(auth, division.id, {
        instruction: INSTRUCTION,
        mode: "generate",
        preview_id: p.preview_id,
      }),
    ).rejects.toMatchObject({ status: 409, code: "preview_stale" });
    expect(architectCalls()).toBe(0);
  });
});

/** The instruction's identity. Two spellings that a human would call the same
 *  sentence must hash the same, or the organiser pays for a recompile of a
 *  sentence they did not change — and two that a human would call different must
 *  not, or a changed rule executes under an old confirmation. */
describe("hashInstruction normalises spelling, not meaning (W5 #400)", () => {
  it("hashes the NFC and NFD spellings of one sentence equal", () => {
    // A macOS paste can arrive decomposed while the same sentence typed into the
    // box arrives composed. They are different byte strings and the identical
    // instruction.
    const composed = "no matches before café hours".normalize("NFC");
    const decomposed = composed.normalize("NFD");
    expect(decomposed).not.toBe(composed);
    expect(hashInstruction(decomposed)).toBe(hashInstruction(composed));
  });

  it("still collapses surrounding and repeated whitespace", () => {
    expect(hashInstruction("  finals   on Friday ")).toBe(hashInstruction("finals on Friday"));
  });

  it("keeps case significant", () => {
    // Deliberately strict: no normalisation form folds case, and an organiser
    // who retyped a sentence differently gets a cheap recompile rather than a
    // silent match.
    expect(hashInstruction("Finals on Friday")).not.toBe(hashInstruction("finals on friday"));
  });

  it("does not fold a curly apostrophe into a straight one", () => {
    // Also deliberate: no standard normalisation merges these, and inventing a
    // fold here would let two visibly different sentences share a confirmation.
    expect(hashInstruction("don't start early")).not.toBe(hashInstruction("don’t start early"));
  });
});
