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
  cacheEnabled,
  rlCounts,
} = vi.hoisted(() => {
  const rlCounts = new Map<string, number>();
  return {
    chat: vi.fn(),
    resolveProviderMock: vi.fn(),
    architectParse: vi.fn(),
    isServerFeatureEnabled: vi.fn(),
    captureServer: vi.fn(),
    incrWindow: vi.fn(async (key: string): Promise<number | null> => {
      const n = (rlCounts.get(key) ?? 0) + 1;
      rlCounts.set(key, n);
      return n;
    }),
    // Default false — no REDIS_URL in the test env, which is what the real
    // `cacheEnabled` would answer. Only the fail-closed test flips it, because
    // "Redis configured but unreachable" is the ONLY state in which the preview's
    // policy differs from the run's.
    cacheEnabled: vi.fn(() => false),
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
  return { ...actual, incrWindow, cacheEnabled };
});

import { sql } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import { balance, recordPackPurchase, walletIdFor } from "@/lib/credits";
import { setOrgPlan } from "@/lib/__tests__/_billing-group";
import type { AuthCtx } from "@/server/api-v1/auth";
import type { RawParsed } from "../schedule-ai-parse";
import { hashInstruction, previewScheduleAi } from "../schedule-ai-preview";
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

/** A compile whose only rule is a calendar window. Deliberately carries NO
 *  competition-scoped per-day cap: `resolveParsed`'s feasibility re-reading only
 *  extends a window when one exists, so the resolved days are exactly the ones
 *  stated and the assertion below cannot drift. */
const COMPILED_WINDOW: RawParsed = {
  hard: [
    {
      type: "window",
      start: { kind: "date", date: "2026-09-01" },
      end: { kind: "date", date: "2026-09-07" },
      scope: { kind: "competition" },
    },
  ],
  soft: [],
  unparsed: [],
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

/** One division of `competitionId`, entrants seeded. `fixtures: false` leaves it
 *  with nothing MOVABLE, which is the state ruling R6 drops. */
async function seedDivision(
  auth: AuthCtx,
  competitionId: string,
  opts: { name?: string; fixtures?: boolean } = {},
): Promise<string> {
  const division = await createDivision(auth, competitionId, {
    name: opts.name ?? "Open",
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
  if (opts.fixtures !== false) await generateStageFixtures(auth, stage!.id);
  return division.id;
}

async function seedPlannable(auth: AuthCtx): Promise<{ divisionId: string; competitionId: string }> {
  const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "W5 Preview", visibility: "public", branding: {} });
  return { divisionId: await seedDivision(auth, comp.id), competitionId: comp.id };
}

/** A competition with `count` divisions. `emptyLast` leaves the final one with
 *  no movable fixtures. */
async function seedJoint(
  auth: AuthCtx,
  count: number,
  opts: { emptyLast?: boolean } = {},
): Promise<{ competitionId: string; divisionIds: string[] }> {
  const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "W5 Joint", visibility: "public", branding: {} });
  const divisionIds: string[] = [];
  for (let i = 0; i < count; i += 1) {
    divisionIds.push(
      await seedDivision(auth, comp.id, {
        name: `Div ${i + 1}`,
        fixtures: !(opts.emptyLast && i === count - 1),
      }),
    );
  }
  return { competitionId: comp.id, divisionIds };
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
  incrWindow.mockReset().mockImplementation(async (key: string) => {
    const n = (rlCounts.get(key) ?? 0) + 1;
    rlCounts.set(key, n);
    return n;
  });
  cacheEnabled.mockReset().mockReturnValue(false);
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
    // The preview took a slot out of the RUN's bucket, by the run's own key.
    // Without this the limiter call could be deleted outright and every other
    // assertion in this file would still pass — which is the difference between
    // "bounded LLM access" and "a free one".
    expect(rlCounts.get(`rl:ai-plan:${divisionId}`)).toBe(1);
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

  it("resolves a stated window to both its days in the org's zone", async () => {
    const auth = await seedPlusOrg();
    await recordPackPurchase(await walletIdFor(auth.orgId), 10, `fund-${randomUUID()}`);
    // A zone that is neither UTC nor the machine's, and far enough east that a
    // day boundary rendered in the WRONG zone lands on a different date.
    await sql`update organizations set timezone = 'Pacific/Auckland' where id = ${auth.orgId}`;
    const { divisionId } = await seedPlannable(auth);
    compilerAnswers(COMPILED_WINDOW);

    const res = await previewScheduleAi(auth, { kind: "division", id: divisionId }, {
      instruction: "between the 1st and the 7th of September",
    });

    // Both ends, not one: `to` is the last whole SECOND of the final day, so a
    // swapped or mis-zoned end silently renders the day before.
    expect(res.window).toEqual({ start: "2026-09-01", end: "2026-09-07", tz: "Pacific/Auckland" });
  });

  it("refuses the 6th preview in the window before it reaches the model", async () => {
    const auth = await seedPlusOrg();
    await recordPackPurchase(await walletIdFor(auth.orgId), 10, `fund-${randomUUID()}`);
    const { divisionId } = await seedPlannable(auth);
    compilerAnswers(COMPILED);

    for (let i = 0; i < 5; i += 1) {
      await previewScheduleAi(auth, { kind: "division", id: divisionId }, { instruction: INSTRUCTION });
    }
    expect(parseCalls()).toBe(5);

    await expect(
      previewScheduleAi(auth, { kind: "division", id: divisionId }, { instruction: INSTRUCTION }),
    ).rejects.toMatchObject({ status: 429 });
    // A limiter that incremented AFTER the model call would leave this at 6 —
    // it would be a counter, not a limit.
    expect(parseCalls()).toBe(5);
    expect(architectCalls()).toBe(0);
  });

  it("refuses the preview when the limiter backend is unreachable", async () => {
    const auth = await seedPlusOrg();
    await recordPackPurchase(await walletIdFor(auth.orgId), 10, `fund-${randomUUID()}`);
    const { divisionId } = await seedPlannable(auth);
    compilerAnswers(COMPILED);
    // Redis CONFIGURED but not answering — `incrWindow` yields no count. This is
    // the only state in which the preview's policy diverges from the run's: the
    // run is still bounded by the credit wallet, the preview is bounded by
    // nothing, so an Upstash blip would otherwise be unmetered model access.
    cacheEnabled.mockReturnValue(true);
    incrWindow.mockResolvedValue(null);

    await expect(
      previewScheduleAi(auth, { kind: "division", id: divisionId }, { instruction: INSTRUCTION }),
    ).rejects.toMatchObject({ status: 429 });
    expect(parseCalls()).toBe(0);
    expect(await previewLedgerFor(auth.orgId)).toHaveLength(0);
  });

  it("refuses a joint preview the wallet cannot afford, before any model call", async () => {
    const auth = await seedPlusOrg();
    const walletId = await walletIdFor(auth.orgId);
    // THREE divisions at the default rung: minimumCredits([u,u,u]) === 2, so a
    // 1-credit wallet is short. Two divisions would bound at 1 and this wallet
    // would walk through — the bound has to be the joint discount's, not a count.
    await recordPackPurchase(walletId, 1, `fund-${randomUUID()}`);
    const { competitionId, divisionIds } = await seedJoint(auth, 3);
    compilerAnswers(COMPILED);

    await expect(
      previewScheduleAi(auth, { kind: "competition", id: competitionId }, {
        instruction: INSTRUCTION,
        division_ids: divisionIds,
      }),
    ).rejects.toMatchObject({ status: 402 });
    expect(parseCalls()).toBe(0);
    expect(architectCalls()).toBe(0);
    expect(await previewLedgerFor(auth.orgId)).toHaveLength(0);
  });

  it("bounds the joint preview on the competition bucket at 3 an hour", async () => {
    const auth = await seedPlusOrg();
    await recordPackPurchase(await walletIdFor(auth.orgId), 10, `fund-${randomUUID()}`);
    const { competitionId, divisionIds } = await seedJoint(auth, 3);
    compilerAnswers(COMPILED);
    const req = { instruction: INSTRUCTION, division_ids: divisionIds };

    await previewScheduleAi(auth, { kind: "competition", id: competitionId }, req);
    // The JOINT bucket, keyed by competition — not the division bucket, which
    // would let one competition's divisions each fund a separate joint quota.
    expect(rlCounts.get(`rl:ai-plan-competition:${competitionId}`)).toBe(1);

    await previewScheduleAi(auth, { kind: "competition", id: competitionId }, req);
    await previewScheduleAi(auth, { kind: "competition", id: competitionId }, req);
    expect(parseCalls()).toBe(3);

    await expect(
      previewScheduleAi(auth, { kind: "competition", id: competitionId }, req),
    ).rejects.toMatchObject({ status: 429 });
    // A joint compile is the expensive one; its max is 3, not the division's 5.
    expect(parseCalls()).toBe(3);
  });

  it("refuses a joint preview naming fewer than two divisions", async () => {
    const auth = await seedPlusOrg();
    await recordPackPurchase(await walletIdFor(auth.orgId), 10, `fund-${randomUUID()}`);
    const { competitionId, divisionIds } = await seedJoint(auth, 2);
    compilerAnswers(COMPILED);

    await expect(
      previewScheduleAi(auth, { kind: "competition", id: competitionId }, {
        instruction: INSTRUCTION,
        division_ids: [divisionIds[0]!],
      }),
    ).rejects.toMatchObject({ status: 400, code: "AI_PLAN_SINGLE_DIVISION" });
    expect(parseCalls()).toBe(0);
  });

  it("drops a division with nothing movable before it compiles (R6)", async () => {
    const auth = await seedPlusOrg();
    await recordPackPurchase(await walletIdFor(auth.orgId), 10, `fund-${randomUUID()}`);
    const { competitionId, divisionIds } = await seedJoint(auth, 3, { emptyLast: true });
    compilerAnswers(COMPILED);

    const res = await previewScheduleAi(auth, { kind: "competition", id: competitionId }, {
      instruction: INSTRUCTION,
      division_ids: divisionIds,
    });

    expect(res.failed).toBe(false);
    // The ledger names the divisions this preview was actually compiled for. The
    // empty one is dropped before the price, so it must be dropped here too —
    // otherwise the preview authorises a run over a division the run will skip.
    const [line] = await previewLedgerFor(auth.orgId);
    expect(line!.payload.division_ids).toEqual([divisionIds[0], divisionIds[1]]);
  });
});

// The single shared key between this wave's two tasks: the preview writes it,
// Task 2's run gate (`consumePreview`) matches on it. Both sides call THIS
// function, so these tests are written against the property the hash exists to
// guarantee rather than against its current output — two agreeing
// implementations of a wrong rule would still be wrong.
//
// The guarantee is asymmetric, and the asymmetry decides every judgement call
// below. A hash that is too STRICT refuses a confirm and costs the organiser one
// recompile. A hash that is too LOOSE runs — and charges — the architect under
// rules the organiser never saw, which is the failure the whole wave exists to
// close. So where the answer is genuinely arguable, err strict.
describe("hashInstruction", () => {
  it("ignores leading and trailing whitespace", () => {
    expect(hashInstruction("  a  b ")).toBe(hashInstruction("a  b"));
  });

  it("collapses runs of whitespace, including newlines", () => {
    // The same sentence wrapped across two lines is the same sentence.
    expect(hashInstruction("a  b")).toBe(hashInstruction("a b"));
    expect(hashInstruction("a\n\tb")).toBe(hashInstruction("a b"));
  });

  it("separates a different sentence", () => {
    expect(hashInstruction("a b")).not.toBe(hashInstruction("a c"));
  });

  it("treats case as significant", () => {
    // DELIBERATE. Case-folding would buy a retyped capital at the cost of making
    // the key answer "close enough" rather than "this exact sentence"; a
    // capitalisation change is an EDIT, and an edited instruction should be
    // recompiled and re-shown, not silently matched to the old card.
    expect(hashInstruction("Friday")).not.toBe(hashInstruction("friday"));
  });

  it("does not fold characters that merely look alike", () => {
    // DELIBERATE, and the reason no folding table exists here: a curly
    // apostrophe is not canonically equivalent to a straight one, so no standard
    // normalisation merges them and a bespoke table would be us guessing which
    // distinct characters "mean" the same. Refusing costs one recompile.
    expect(hashInstruction("don't")).not.toBe(hashInstruction("don’t"));
  });
});
