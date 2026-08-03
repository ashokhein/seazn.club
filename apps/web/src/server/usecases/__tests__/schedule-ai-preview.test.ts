// W5 (#400) — the parse-only preview endpoint.
//
// This is the wave's load-bearing suite: it is what makes "showing the
// organiser what we compiled costs nothing" a fact rather than a claim. Three
// properties are asserted directly against real Postgres:
//
//   1. a preview moves NO credit and makes NO architect call,
//   2. a wallet that cannot afford the run it precedes is refused with the
//      run's own 402 BEFORE any model call — `balance > 0` is not the test,
//      `minimumCredits` is,
//   3. the unpriced parse spend lands on the ledger under the SAME
//      `parse_tokens` / `parse_failed` vocabulary W3 stamps on a run
//      (lib/ai-rung.ts RunMeterStamp), so reconciliation sees one field set,
//      not two.
//
// The stage-1 compiler is driven through a stubbed AiProvider (the pattern
// schedule-ai-parse.test.ts uses); the Anthropic SDK is mocked separately and
// asserted UNCALLED, which is what "no architect round" means here.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

const {
  chat,
  resolveProviderMock,
  architectParse,
  isServerFeatureEnabled,
  captureServer,
  incrWindow,
  rlCounts,
} = vi.hoisted(() => {
  const rlCounts = new Map<string, number>();
  return {
    chat: vi.fn(),
    resolveProviderMock: vi.fn(),
    architectParse: vi.fn(),
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

vi.mock("@/server/ai/select-provider", () => ({
  resolveProvider: resolveProviderMock,
  selectProvider: () => resolveProviderMock("anthropic"),
}));
// Present only so the suite can prove it is never touched: a preview that
// reached the architect would be a credit spent behind the organiser's back.
vi.mock("@anthropic-ai/sdk", () => ({
  default: class Anthropic {
    messages = { parse: architectParse };
  },
}));
vi.mock("@/lib/posthog-server", () => ({ isServerFeatureEnabled, captureServer }));
vi.mock("@/lib/cache", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/cache")>();
  return { ...actual, incrWindow };
});

import { sql } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import { balance, recordPackPurchase, walletIdFor } from "@/lib/credits";
import { setOrgPlan } from "@/lib/__tests__/_billing-group";
import type { AuthCtx } from "@/server/api-v1/auth";
import type { RawParsed } from "../schedule-ai-parse";
import { previewScheduleAi } from "../schedule-ai-preview";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { createStages, generateStageFixtures } from "../stages";
import { GENERIC_CONFIG, seedOrg } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;
const TZ = "Europe/London";

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

const INSTRUCTION = "at most 2 matches a day and keep mornings relaxed, and moar vibes pls";

/** What the stubbed compiler answers with: one enforceable rule, one preference,
 *  one phrase nobody can compile. All three have to survive to the response. */
const COMPILED: RawParsed = {
  hard: [{ type: "max_fixtures_per_day", count: 2, scope: { kind: "competition" } }],
  soft: [{ note: "keep mornings relaxed", weight: 2 }],
  unparsed: ["moar vibes pls"],
};

/** Calls into the stage-1 compiler's provider — one per compile attempt. */
const parseCalls = (): number => chat.mock.calls.length;
/** Calls into the stage-2 architect. A preview must never make one. */
const architectCalls = (): number => architectParse.mock.calls.length;

async function seedPlusOrg(): Promise<AuthCtx> {
  const { auth } = await seedOrg("community");
  await setOrgPlan(auth.orgId, "pro_plus");
  await invalidateOrgEntitlements(auth.orgId);
  return auth;
}

async function seedPlannable(auth: AuthCtx): Promise<{ divisionId: string; competitionId: string }> {
  const comp = await createCompetition(auth, { name: "W5 Preview", visibility: "public", branding: {} });
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
  await sql`
    insert into schedule_settings (division_id, config, tz, updated_at)
    values (${division.id}, ${sql.json(SETTINGS_CONFIG)}, ${TZ}, now())
    on conflict (division_id) do update set config = excluded.config, tz = excluded.tz`;
  const [stage] = await createStages(auth, division.id, {
    seq: 1,
    kind: "league",
    name: "League",
    config: {},
  });
  await generateStageFixtures(auth, stage!.id);
  return { divisionId: division.id, competitionId: comp.id };
}

/** The competition_events rows a preview appended for this org. */
async function previewLedgerFor(orgId: string): Promise<{ payload: Record<string, unknown> }[]> {
  return sql<{ payload: Record<string, unknown> }[]>`
    select payload from competition_events
     where org_id = ${orgId} and type = 'schedule.ai_previewed'
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
  architectParse.mockReset();
  resolveProviderMock.mockReset().mockImplementation((id: string) => ({
    id,
    isConfigured: () => true,
    chat,
  }));
  isServerFeatureEnabled.mockReset().mockResolvedValue(true);
  captureServer.mockReset().mockResolvedValue(undefined);
  rlCounts.clear();
  process.env.ANTHROPIC_API_KEY = "test-key";
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.AI_PROVIDER;
});

/** A compiler answer. `null` models the adapter's schema-invalid path. */
function compilerAnswers(...bodies: (RawParsed | null)[]): void {
  let i = 0;
  chat.mockImplementation(async () => {
    const body = bodies[Math.min(i, bodies.length - 1)];
    i += 1;
    return {
      parsed: body as never,
      assistantTurn: { role: "assistant" as const, content: {} },
      usage: { inputTokens: 120, outputTokens: 300, costUsd: null },
      servedModel: "stub-parser",
      refused: false,
    };
  });
}

describe.skipIf(!HAS_DB)("previewScheduleAi (W5 #400)", () => {
  it("spends no credit and makes no architect call", async () => {
    const auth = await seedPlusOrg();
    const walletId = await walletIdFor(auth.orgId);
    await recordPackPurchase(walletId, 10, `fund-${randomUUID()}`);
    const { divisionId } = await seedPlannable(auth);
    compilerAnswers(COMPILED);

    const before = await balance(walletId);
    const res = await previewScheduleAi(auth, { kind: "division", id: divisionId }, {
      instruction: INSTRUCTION,
    });

    expect(res.failed).toBe(false);
    expect(res.compiled.hard).toHaveLength(1);
    expect(res.compiled.soft).toEqual([{ note: "keep mornings relaxed", weight: 2 }]);
    // Verbatim, never converted into a rule.
    expect(res.compiled.unparsed).toEqual(["moar vibes pls"]);
    expect(res.preview_id).toBeTruthy();
    // The three properties the wave rests on.
    expect(await balance(walletId)).toBe(before);
    expect(architectCalls()).toBe(0);
    expect(parseCalls()).toBe(1);
    // Resolved from the MODEL SLUG, never from a global AI_PROVIDER: the
    // parser's default is a bare Anthropic id, and a bare id sent to OpenRouter
    // is a 404 this path would swallow as "no compiled rules".
    expect(resolveProviderMock).toHaveBeenCalledWith("anthropic");

    const [row] = await sql<{ org_id: string; scope: string; scope_id: string; consumed_at: Date | null }[]>`
      select org_id, scope, scope_id, consumed_at from ai_parse_previews where id = ${res.preview_id!}`;
    expect(row).toMatchObject({ org_id: auth.orgId, scope: "division", scope_id: divisionId });
    expect(row!.consumed_at).toBeNull();
  });

  it("refuses before any model call when the wallet cannot afford the run", async () => {
    const auth = await seedPlusOrg();
    const walletId = await walletIdFor(auth.orgId);
    // Deliberately NON-EMPTY but short: a 2-credit wallet against a rung-3 run.
    // `balance > 0` passes here and is exactly the check this test forbids.
    await recordPackPurchase(walletId, 2, `fund-${randomUUID()}`);
    const { divisionId } = await seedPlannable(auth);
    compilerAnswers(COMPILED);

    await expect(
      previewScheduleAi(auth, { kind: "division", id: divisionId }, {
        instruction: INSTRUCTION,
        rung: 3,
      }),
    ).rejects.toMatchObject({ status: 402 });
    // Unpriced is not free.
    expect(parseCalls()).toBe(0);
    expect(architectCalls()).toBe(0);
    expect(await previewLedgerFor(auth.orgId)).toHaveLength(0);
  });

  it("stamps the parse spend on the ledger", async () => {
    const auth = await seedPlusOrg();
    await recordPackPurchase(await walletIdFor(auth.orgId), 10, `fund-${randomUUID()}`);
    const { divisionId } = await seedPlannable(auth);
    compilerAnswers(COMPILED);

    await previewScheduleAi(auth, { kind: "division", id: divisionId }, { instruction: INSTRUCTION });

    const lines = await previewLedgerFor(auth.orgId);
    expect(lines).toHaveLength(1);
    // The SAME field names a run stamps (lib/ai-rung.ts RunMeterStamp) — one
    // vocabulary, so reconciliation never has to know which surface wrote it.
    expect(lines[0]!.payload).toMatchObject({
      division_id: divisionId,
      parse_tokens: 300,
      parse_failed: false,
    });
  });

  it("returns a failed compile as a state, not an error", async () => {
    const auth = await seedPlusOrg();
    const walletId = await walletIdFor(auth.orgId);
    await recordPackPurchase(walletId, 10, `fund-${randomUUID()}`);
    const { divisionId } = await seedPlannable(auth);
    // Schema miss twice — the compiler's own retry is exhausted.
    compilerAnswers(null, null);

    const before = await balance(walletId);
    const res = await previewScheduleAi(auth, { kind: "division", id: divisionId }, {
      instruction: INSTRUCTION,
    });

    expect(res.failed).toBe(true);
    // Nothing to confirm — only a fallback to choose. The client must never
    // reach the run path off a failed compile.
    expect(res.preview_id).toBeUndefined();
    expect(res.compiled.hard).toEqual([]);
    // The organiser's own words come back verbatim so the card has something
    // honest to show.
    expect(res.compiled.unparsed).toEqual([INSTRUCTION]);
    expect(parseCalls()).toBe(2);
    expect(architectCalls()).toBe(0);
    expect(await balance(walletId)).toBe(before);
    // Still metered: a failed compile spent real tokens.
    const lines = await previewLedgerFor(auth.orgId);
    expect(lines[0]!.payload).toMatchObject({ parse_tokens: 600, parse_failed: true });
    // …and no row is left behind for a run to reuse.
    const rows = await sql<{ n: number }[]>`
      select count(*)::int as n from ai_parse_previews where org_id = ${auth.orgId}`;
    expect(rows[0]!.n).toBe(0);
  });
});
