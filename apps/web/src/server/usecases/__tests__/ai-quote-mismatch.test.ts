// #387 — the server compares what it CHARGED to what the confirm card QUOTED,
// reports the divergence on the response and records it as a competition_event.
//
// What makes this worth a suite of its own: the comparison lives on three
// separate run paths (`aiPlanForDivision`, `aiPlanForCompetition`,
// `officialsAiPlanForDivision`) behind ONE helper. A helper with a missing call
// site is completely silent — the run succeeds, the response simply omits the
// field, and every other suite stays green. So each path is driven here, not
// just the division one.
//
// Model boundary is mocked at @/server/ai/select-provider (not just the
// Anthropic SDK): the shipped ladder's first rung is OpenRouter and a developer
// .env.local carries a real key, so mocking the SDK alone still leaves a live
// network path. Entitlements, credits and the pack builder hit real Postgres.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { AiChatResponse } from "@/server/ai/provider";

const { chat } = vi.hoisted(() => ({ chat: vi.fn() }));

// The stage-1 instruction compiler (#398) makes its own LLM call BEFORE the
// architect's. This suite's fake provider queue is 1:1 with architect calls, so
// an un-neutralised pre-flight eats the first queued response and every
// assertion shifts by one. It has its own suites; here it must not exist.
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
  return { selectProvider: () => provider, resolveProvider: () => provider };
});

import { sql } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import type { AuthCtx } from "@/server/api-v1/auth";
import { AiCompetitionPlanRequest, AiOfficialsPlanRequest, AiPlanRequest } from "@/server/api-v1/schemas";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { createStages, generateStageFixtures } from "../stages";
import { aiPlanForDivision } from "../schedule-ai";
import { aiPlanForCompetition } from "../competition-schedule-ai";
import { officialsAiPlanForDivision } from "../officials-ai";
import { GENERIC_CONFIG, seedOrg } from "./_seed";
import { setOrgPlan } from "@/lib/__tests__/_billing-group";
import { recordPackPurchase, walletIdFor } from "@/lib/credits";
import { QUOTE_MISMATCH_EVENT } from "../ai-quote-mismatch";

/** The officials-auto policy body, in full — `AssignPolicyBody` has no
 *  defaults, so a partial literal does not typecheck. */
const REFEREE_POLICY = {
  roles: ["referee"],
  poolLock: false,
  blockStay: true,
  fairness: "tournament" as const,
  teamRefKeepDivision: false,
  restMinMinutes: 0,
  blockGapMinutes: 30,
};

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
  courts: string[];
  fixtureIds: string[];
}

async function seedDivision(
  auth: AuthCtx,
  competitionId: string,
  opts: { courts?: string[]; officials?: number } = {},
): Promise<SeededDivision> {
  const courts = opts.courts ?? ["Court 1", "Court 2"];
  const slug = `d-${randomUUID().slice(0, 8)}`;
  const division = await createDivision(auth, competitionId, {
    name: slug,
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
  const [stage] = await createStages(auth, division.id, { seq: 1, kind: "league", name: "League", config: {} });
  const { fixtures } = await generateStageFixtures(auth, stage!.id);
  for (let i = 0; i < (opts.officials ?? 0); i++) {
    await sql`
      insert into officials (org_id, display_name, role_keys)
      values (${auth.orgId}, ${"Ref " + i}, ${sql.json(["referee"])})`;
  }
  return {
    id: division.id,
    courts,
    fixtureIds: [...fixtures]
      .sort((a, b) => a.round_no - b.round_no || a.seq_in_round - b.seq_in_round)
      .map((f) => f.id),
  };
}

/** pro_plus (scheduling.ai + scheduling.multi_division) with a funded wallet. */
async function seedPlusOrg(): Promise<AuthCtx> {
  const { auth } = await seedOrg("community");
  await setOrgPlan(auth.orgId, "pro_plus");
  await invalidateOrgEntitlements(auth.orgId);
  await recordPackPurchase(await walletIdFor(auth.orgId), 100, `seed-${randomUUID()}`);
  return auth;
}

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

interface MismatchEvent {
  payload: { quoted: number; charged: number; division_ids: string[]; direction: string };
  competition_id: string;
  org_id: string;
}

async function mismatchEvents(competitionId: string): Promise<MismatchEvent[]> {
  return sql<MismatchEvent[]>`
    select payload, competition_id, org_id from competition_events
     where competition_id = ${competitionId} and type = ${QUOTE_MISMATCH_EVENT}
     order by created_at`;
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

// ---------------------------------------------------------------------------
// The wire contract. These run without a DB — an absent quote and a zero quote
// must not be the same thing, and the boundary is where that is enforced
// (usecases never re-parse their input).
// ---------------------------------------------------------------------------
describe("quoted_credits on the wire (#387)", () => {
  const base = { instruction: "plan it", mode: "generate" as const };

  it("is carried through when a client sends one", () => {
    expect(AiPlanRequest.parse({ ...base, quoted_credits: 2 }).quoted_credits).toBe(2);
    expect(
      AiOfficialsPlanRequest.parse({ instruction: "", policy: REFEREE_POLICY, quoted_credits: 3 })
        .quoted_credits,
    ).toBe(3);
    expect(
      AiCompetitionPlanRequest.parse({
        division_ids: [randomUUID(), randomUUID()],
        instruction: "plan it",
        quoted_credits: 5,
      }).quoted_credits,
    ).toBe(5);
  });

  it("is absent, not zero, when a caller sends none", () => {
    // Server-side callers and every external consumer send nothing. Silence
    // must never read as "quoted zero" — that would file a mismatch against
    // every one of them.
    expect(AiPlanRequest.parse(base).quoted_credits).toBeUndefined();
    expect("quoted_credits" in AiPlanRequest.parse(base)).toBe(false);
  });

  it("refuses 0 and negatives at the boundary", () => {
    // There is no such thing as a zero-credit quote: `quoteRun` floors every
    // line at rung 1. Accepting 0 here would let a client claim it showed a
    // free run and have the server agree it was a mismatch rather than nonsense.
    for (const bad of [0, -1, -3]) {
      expect(AiPlanRequest.safeParse({ ...base, quoted_credits: bad }).success).toBe(false);
      expect(
        AiOfficialsPlanRequest.safeParse({ instruction: "", policy: REFEREE_POLICY, quoted_credits: bad })
          .success,
      ).toBe(false);
      expect(
        AiCompetitionPlanRequest.safeParse({
          division_ids: [randomUUID(), randomUUID()],
          instruction: "plan it",
          quoted_credits: bad,
        }).success,
      ).toBe(false);
    }
  });

  it("refuses a fractional quote", () => {
    expect(AiPlanRequest.safeParse({ ...base, quoted_credits: 1.5 }).success).toBe(false);
  });
});

describe.skipIf(!HAS_DB)("quote/charge mismatch — schedule-ai (#387)", () => {
  it("records a competition_event when the charge differs from the quote", async () => {
    const auth = await seedPlusOrg();
    const comp = await createCompetition(auth, { name: "QM", visibility: "public", branding: {} });
    const division = await seedDivision(auth, comp.id);
    chat.mockResolvedValueOnce(chatResponse(legalPlan([division])));

    // The card said 2; this division prices at 1.
    const plan = await aiPlanForDivision(auth, division.id, {
      instruction: "plan it",
      mode: "generate",
      quoted_credits: 2,
    });

    expect(plan.credits).toBe(1);
    expect(plan.quote_mismatch).toEqual({ quoted: 2, charged: 1 });

    const events = await mismatchEvents(comp.id);
    expect(events).toHaveLength(1);
    expect(events[0]!.payload.quoted).toBe(2);
    expect(events[0]!.payload.charged).toBe(1);
    // Traceable back to the pack that was priced, and scoped to the tenant.
    expect(events[0]!.payload.division_ids).toEqual([division.id]);
    expect(events[0]!.org_id).toBe(auth.orgId);
    expect(events[0]!.competition_id).toBe(comp.id);
    // The organiser still gets their plan. This is telemetry, not a gate: they
    // have already been charged, so refusing here would take the credit and
    // hand back nothing.
    expect(plan.proposal).toHaveLength(division.fixtureIds.length);
  });

  it("reports an UNDER-quote too — the billing-complaint direction", async () => {
    const auth = await seedPlusOrg();
    const comp = await createCompetition(auth, { name: "QM under", visibility: "public", branding: {} });
    // Forcing rung 3 makes the server charge 3 against a card that said 1.
    const division = await seedDivision(auth, comp.id);
    chat.mockResolvedValueOnce(chatResponse(legalPlan([division])));

    const plan = await aiPlanForDivision(auth, division.id, {
      instruction: "plan it",
      mode: "generate",
      rung: 3,
      quoted_credits: 1,
    });

    expect(plan.credits).toBe(3);
    expect(plan.quote_mismatch).toEqual({ quoted: 1, charged: 3 });
    const events = await mismatchEvents(comp.id);
    expect(events).toHaveLength(1);
    expect(events[0]!.payload.direction).toBe("over"); // charged > quoted
  });

  it("records nothing and reports nothing when they agree", async () => {
    const auth = await seedPlusOrg();
    const comp = await createCompetition(auth, { name: "QM agree", visibility: "public", branding: {} });
    const division = await seedDivision(auth, comp.id);
    chat.mockResolvedValueOnce(chatResponse(legalPlan([division])));

    const plan = await aiPlanForDivision(auth, division.id, {
      instruction: "plan it",
      mode: "generate",
      quoted_credits: 1,
    });

    expect(plan.credits).toBe(1);
    expect(plan.quote_mismatch).toBeUndefined();
    expect(await mismatchEvents(comp.id)).toHaveLength(0);
  });

  it("an omitted quoted_credits is not a mismatch", async () => {
    const auth = await seedPlusOrg();
    const comp = await createCompetition(auth, { name: "QM silent", visibility: "public", branding: {} });
    const division = await seedDivision(auth, comp.id);
    chat.mockResolvedValueOnce(chatResponse(legalPlan([division])));

    const plan = await aiPlanForDivision(auth, division.id, { instruction: "plan it", mode: "generate" });

    expect(plan.quote_mismatch).toBeUndefined();
    expect(await mismatchEvents(comp.id)).toHaveLength(0);
  });
});

describe.skipIf(!HAS_DB)("quote/charge mismatch — the joint solve (#387)", () => {
  it("records it on the competition path too", async () => {
    const auth = await seedPlusOrg();
    const comp = await createCompetition(auth, { name: "QM joint", visibility: "public", branding: {} });
    const a = await seedDivision(auth, comp.id, { courts: ["Court 1", "Court 2"] });
    const b = await seedDivision(auth, comp.id, { courts: ["Court 3", "Court 4"] });
    chat.mockResolvedValueOnce(chatResponse(legalPlan([a, b])));

    // Two rung-1 divisions price at max(1, 2 - 1) = 1; the card said 4.
    const plan = await aiPlanForCompetition(auth, comp.id, {
      division_ids: [a.id, b.id],
      instruction: "plan the whole competition",
      mode: "generate",
      quoted_credits: 4,
    });

    expect(plan.credits).toBe(1);
    expect(plan.quote_mismatch).toEqual({ quoted: 4, charged: 1 });
    const events = await mismatchEvents(comp.id);
    expect(events).toHaveLength(1);
    // BOTH divisions, so the event names the run that was priced rather than an
    // arbitrary one of them.
    expect([...events[0]!.payload.division_ids].sort()).toEqual([a.id, b.id].sort());
    expect(events[0]!.payload.direction).toBe("under");
  });

  it("records nothing when the joint quote agrees", async () => {
    const auth = await seedPlusOrg();
    const comp = await createCompetition(auth, { name: "QM joint ok", visibility: "public", branding: {} });
    const a = await seedDivision(auth, comp.id, { courts: ["Court 1", "Court 2"] });
    const b = await seedDivision(auth, comp.id, { courts: ["Court 3", "Court 4"] });
    chat.mockResolvedValueOnce(chatResponse(legalPlan([a, b])));

    const plan = await aiPlanForCompetition(auth, comp.id, {
      division_ids: [a.id, b.id],
      instruction: "plan the whole competition",
      mode: "generate",
      quoted_credits: 1,
    });

    expect(plan.quote_mismatch).toBeUndefined();
    expect(await mismatchEvents(comp.id)).toHaveLength(0);
  });
});

describe.skipIf(!HAS_DB)("quote/charge mismatch — officials (#387)", () => {
  it("records it on the officials path too", async () => {
    const auth = await seedPlusOrg();
    const comp = await createCompetition(auth, { name: "QM officials", visibility: "public", branding: {} });
    const division = await seedDivision(auth, comp.id, { officials: 2 });

    // The empty-instruction path is the deterministic solver draft: no model
    // call, flat 1 credit. The card claimed 3.
    const plan = await officialsAiPlanForDivision(auth, division.id, {
      instruction: "",
      policy: REFEREE_POLICY,
      quoted_credits: 3,
    });

    expect(chat).not.toHaveBeenCalled();
    expect(plan.credits).toBe(1);
    expect(plan.quote_mismatch).toEqual({ quoted: 3, charged: 1 });
    const events = await mismatchEvents(comp.id);
    expect(events).toHaveLength(1);
    expect(events[0]!.payload.division_ids).toEqual([division.id]);
  });

  it("records nothing when the officials quote agrees", async () => {
    const auth = await seedPlusOrg();
    const comp = await createCompetition(auth, { name: "QM officials ok", visibility: "public", branding: {} });
    const division = await seedDivision(auth, comp.id, { officials: 2 });

    const plan = await officialsAiPlanForDivision(auth, division.id, {
      instruction: "",
      policy: REFEREE_POLICY,
      quoted_credits: 1,
    });

    expect(plan.quote_mismatch).toBeUndefined();
    expect(await mismatchEvents(comp.id)).toHaveLength(0);
  });
});
