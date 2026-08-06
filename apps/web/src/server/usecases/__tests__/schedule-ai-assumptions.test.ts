// W5 (#400) Task 3 — the ARCHITECT's assumptions reach the client.
//
// `AiSchedulePlan.assumptions` (stage 2, model-authored: "I read 'the weekend'
// as Sat + Sun") has been produced by every run since v4 and dropped on the
// floor at the response build. The organiser reviewing a proposal could not see
// the interpretation the schedule was actually built on.
//
// These are NOT the resolver's assumptions. Those are stage 1, deterministic,
// and ride on the preview response before a credit is spent
// (AiParsePreviewResponse.compiled.assumptions). Two arrays, two requests, never
// merged — conflating them is the single most likely way to get this wave wrong.
//
// The second test in each pair is the load-bearing one: `assumptions` is
// `.max(10).optional()` on the prompt schema, so the model omits it routinely,
// and the client maps over the array. `undefined` there is a crash, not a
// cosmetic gap.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { AiChatResponse } from "@/server/ai/provider";

const { chat, parseInstructionMock } = vi.hoisted(() => ({
  chat: vi.fn(),
  // Neutralised: the stage-1 compiler makes its own LLM call and this suite's
  // architect queue is 1:1 with architect calls.
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
  return { selectProvider: () => provider, resolveProvider: () => provider };
});

import { sql } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { createStages, generateStageFixtures } from "../stages";
import { aiPlanForDivision } from "../schedule-ai";
import { aiPlanForCompetition } from "../competition-schedule-ai";
import { GENERIC_CONFIG, seedOrg } from "./_seed";
import { setOrgPlan } from "@/lib/__tests__/_billing-group";
import { recordPackPurchase, walletIdFor } from "@/lib/credits";

const HAS_DB = !!process.env.DATABASE_URL;
const TZ = "Europe/London";
const MIN = 60_000;
const T0 = Date.parse("2026-08-01T09:00:00.000Z");

const ASSUMED = ["Read 'the weekend' as Sat + Sun.", "Treated Court 3 as available all day."];

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

async function seedPlusOrg(): Promise<AuthCtx> {
  const { auth } = await seedOrg("community");
  await setOrgPlan(auth.orgId, "pro_plus");
  await invalidateOrgEntitlements(auth.orgId);
  await recordPackPurchase(await walletIdFor(auth.orgId), 100, `seed-${randomUUID()}`);
  return auth;
}

function legalPlan(divisions: SeededDivision[], over: Record<string, unknown> = {}): unknown {
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
    ...over,
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
  process.env.ANTHROPIC_API_KEY = "test-key";
});

describe.skipIf(!HAS_DB)("the architect's assumptions on the plan response (W5 #400)", () => {
  it("carries the model's assumptions into the single-division response", async () => {
    const auth = await seedPlusOrg();
    const comp = await createCompetition(auth, {
      ends_on: "2030-12-31",
      name: "W5 Assumptions",
      visibility: "public",
      branding: {},
    });
    const division = await seedDivision(auth, comp.id, "Open");
    chat.mockResolvedValueOnce(chatResponse(legalPlan([division], { assumptions: ASSUMED })));

    const res = await aiPlanForDivision(auth, division.id, {
      instruction: "plan it over the weekend",
      mode: "generate",
    });

    expect(res.assumptions).toEqual(ASSUMED);
  });

  it("defaults to an empty array when the model omits them", async () => {
    const auth = await seedPlusOrg();
    const comp = await createCompetition(auth, {
      ends_on: "2030-12-31",
      name: "W5 Assumptions Empty",
      visibility: "public",
      branding: {},
    });
    const division = await seedDivision(auth, comp.id, "Open");
    // No `assumptions` key at all — the shape the model emits most of the time.
    chat.mockResolvedValueOnce(chatResponse(legalPlan([division])));

    const res = await aiPlanForDivision(auth, division.id, {
      instruction: "plan it",
      mode: "generate",
    });

    // Never undefined: the review panel maps over this array.
    expect(res.assumptions).toEqual([]);
    expect(Array.isArray(res.assumptions)).toBe(true);
  });

  it("carries the model's assumptions into the joint response", async () => {
    const auth = await seedPlusOrg();
    const comp = await createCompetition(auth, {
      ends_on: "2030-12-31",
      name: "W5 Joint Assumptions",
      visibility: "public",
      branding: {},
    });
    const a = await seedDivision(auth, comp.id, "Alpha", ["Court 1", "Court 2"]);
    const b = await seedDivision(auth, comp.id, "Beta", ["Court 3", "Court 4"]);
    chat.mockResolvedValueOnce(chatResponse(legalPlan([a, b], { assumptions: ASSUMED })));

    const res = await aiPlanForCompetition(auth, comp.id, {
      division_ids: [a.id, b.id],
      instruction: "plan it over the weekend",
      mode: "generate",
    });

    expect(res.assumptions).toEqual(ASSUMED);
  });

  it("defaults the joint response to an empty array when the model omits them", async () => {
    const auth = await seedPlusOrg();
    const comp = await createCompetition(auth, {
      ends_on: "2030-12-31",
      name: "W5 Joint Assumptions Empty",
      visibility: "public",
      branding: {},
    });
    const a = await seedDivision(auth, comp.id, "Alpha", ["Court 1", "Court 2"]);
    const b = await seedDivision(auth, comp.id, "Beta", ["Court 3", "Court 4"]);
    chat.mockResolvedValueOnce(chatResponse(legalPlan([a, b])));

    const res = await aiPlanForCompetition(auth, comp.id, {
      division_ids: [a.id, b.id],
      instruction: "plan it",
      mode: "generate",
    });

    expect(res.assumptions).toEqual([]);
  });
});
