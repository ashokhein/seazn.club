// v17 gap #295 — the alert SPEC-2 §5.1 named as the trigger for revisiting
// flat 1-credit-per-run pricing: a single run's cost_usd >= 2x the trailing
// median for its phase. `shouldAlertOnRunCost` carries every decision branch
// (null cost, no baseline, below/at/above the multiple) as a pure function so
// it is exhaustively testable with no DB and no flake risk from other suites
// concurrently writing competition_events. `medianRunCostUsd` and
// `maybeAlertExpensiveRun` are thin DB/email wiring on top of it; both are
// exercised against a REAL cost value ($50) that is orders above anything a
// mocked-LLM test pack can produce (SPEC-2 §6: worst observed real cost is
// ~$0.47), so the "fires" assertions stay robust even if other test files
// insert their own (tiny) competition_events rows into the same schema
// concurrently.
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

vi.mock("@/lib/email", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/email")>();
  return { ...actual, sendAiRunCostAlertEmail: vi.fn().mockResolvedValue(true) };
});

import { sql } from "@/lib/db";
import { sendAiRunCostAlertEmail } from "@/lib/email";
import {
  AI_RUN_COST_ALERT_MULTIPLE,
  maybeAlertExpensiveRun,
  medianRunCostUsd,
  shouldAlertOnRunCost,
} from "../ai-runs-admin";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

afterEach(() => {
  vi.mocked(sendAiRunCostAlertEmail).mockClear();
  delete process.env.STAFF_ALERT_EMAIL;
});

describe("shouldAlertOnRunCost (pure, v17 gap #295)", () => {
  it("false when cost is null (nothing to compare)", () => {
    expect(shouldAlertOnRunCost(null, 0.1)).toBe(false);
  });
  it("false when there is no median yet (null or non-positive baseline)", () => {
    expect(shouldAlertOnRunCost(5, null)).toBe(false);
    expect(shouldAlertOnRunCost(5, 0)).toBe(false);
    expect(shouldAlertOnRunCost(5, -1)).toBe(false);
  });
  it("false strictly below the multiple", () => {
    expect(shouldAlertOnRunCost(0.19, 0.1, 2)).toBe(false);
  });
  it("true at or above the multiple", () => {
    expect(shouldAlertOnRunCost(0.2, 0.1, 2)).toBe(true);
    expect(shouldAlertOnRunCost(0.25, 0.1, 2)).toBe(true);
  });
  it("defaults the multiple to AI_RUN_COST_ALERT_MULTIPLE (SPEC-2 §5.1's own named trigger)", () => {
    expect(AI_RUN_COST_ALERT_MULTIPLE).toBe(2);
    expect(shouldAlertOnRunCost(0.2, 0.1)).toBe(true);
    expect(shouldAlertOnRunCost(0.19999, 0.1)).toBe(false);
  });
});

describe.skipIf(!HAS_DB)("medianRunCostUsd (v17 gap #295)", () => {
  it("returns null for a window with provably zero rows (future bound)", async () => {
    // days:-1 -> now() - make_interval(days => -1) = now() + 1 day, a bound
    // no row's created_at can ever satisfy — deterministic null regardless of
    // what other suites have written into competition_events.
    expect(await medianRunCostUsd("schedule.ai_generated", -1)).toBeNull();
  });

  it("returns a positive number once at least one qualifying row exists", async () => {
    const [org] = await sql<{ id: string }[]>`
      insert into organizations (name, slug)
      values (${"Median " + randomUUID().slice(0, 8)}, ${"median-" + randomUUID().slice(0, 8)})
      returning id`;
    const [comp] = await sql<{ id: string }[]>`
      insert into competitions (org_id, name, slug, visibility, branding)
      values (${org!.id}, 'Median Comp', ${"median-comp-" + randomUUID().slice(0, 8)}, 'private', '{}')
      returning id`;
    await sql`
      insert into competition_events (competition_id, org_id, type, payload)
      values (${comp!.id}, ${org!.id}, 'schedule.ai_generated', ${sql.json({ cost_usd: 0.01 })})`;
    const median = await medianRunCostUsd("schedule.ai_generated", 1);
    expect(typeof median).toBe("number");
    expect(median).toBeGreaterThan(0);
  });
});

describe.skipIf(!HAS_DB)("maybeAlertExpensiveRun (v17 gap #295)", () => {
  it("never emails when STAFF_ALERT_EMAIL is unset, even for an extreme cost", async () => {
    delete process.env.STAFF_ALERT_EMAIL;
    await maybeAlertExpensiveRun({
      orgId: randomUUID(),
      phase: "schedule",
      model: "claude-sonnet-5",
      costUsd: 50,
    });
    expect(sendAiRunCostAlertEmail).not.toHaveBeenCalled();
  });

  it("alerts when a run's cost is astronomically above the trailing median", async () => {
    process.env.STAFF_ALERT_EMAIL = "ops@seazn.test";
    const orgId = randomUUID();
    await maybeAlertExpensiveRun({
      orgId,
      competitionId: "comp-1",
      phase: "schedule",
      model: "claude-sonnet-5",
      costUsd: 50, // no realistic AI run (SPEC-2 §6: worst ~$0.47) gets near this
    });
    expect(sendAiRunCostAlertEmail).toHaveBeenCalledTimes(1);
    const args = vi.mocked(sendAiRunCostAlertEmail).mock.calls[0]![0];
    expect(args.orgId).toBe(orgId);
    expect(args.competitionId).toBe("comp-1");
    expect(args.phase).toBe("schedule");
    expect(args.costUsd).toBe(50);
    expect(args.medianUsd).toBeGreaterThan(0);
  });

  it("never throws — a check failure is swallowed", async () => {
    process.env.STAFF_ALERT_EMAIL = "ops@seazn.test";
    vi.mocked(sendAiRunCostAlertEmail).mockRejectedValueOnce(new Error("boom"));
    await expect(
      maybeAlertExpensiveRun({ orgId: randomUUID(), phase: "officials", model: "x", costUsd: 50 }),
    ).resolves.toBeUndefined();
  });

  it("does nothing for a null cost (nothing to compare)", async () => {
    process.env.STAFF_ALERT_EMAIL = "ops@seazn.test";
    await maybeAlertExpensiveRun({ orgId: randomUUID(), phase: "schedule", model: "x", costUsd: null });
    expect(sendAiRunCostAlertEmail).not.toHaveBeenCalled();
  });
});
