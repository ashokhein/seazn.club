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
//
// Noise discipline for the DB blocks: other suites (schedule-ai-route,
// schedule-ai-ledger, officials-ai-route) DO write these same event types into
// the shared schema, but they can only ADD rows, never remove them. So every
// assertion here is written to survive extra rows: the min-sample test asserts
// its own precondition, the seeded medians sit orders of magnitude apart from
// anything a mocked run produces, and the phase -> event-type map is pinned by
// comparing the emailed median against a freshly-read median for BOTH types
// rather than against a hardcoded number.
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
  AI_RUN_MEDIAN_MIN_SAMPLE,
  MEDIAN_WINDOW_DAYS,
  aiRunTotals,
  listAiRuns,
  maybeAlertExpensiveRun,
  medianRunCostUsd,
  shouldAlertOnRunCost,
} from "../ai-runs-admin";

const HAS_DB = !!process.env.DATABASE_URL;

/** Comfortably over the min-sample floor so a stray concurrent row can never
 *  drag a seeded window back under it. */
const SEED_N = 25;
/** Officials baseline cost — orders of magnitude below anything a real or
 *  mocked schedule run records, so "the emailed median is the OFFICIALS one"
 *  is detectable by range alone. */
const OFFICIALS_COST = 0.000001;

type RunEventType = "schedule.ai_generated" | "schedule.ai_officials_generated";

/** A one-off event type nothing else in the schema can ever write, so a window
 *  filtered on it contains exactly the rows the calling test seeded. Used only
 *  where the assertion is about ROW COUNTS (the min-sample floor), which the
 *  real, shared event types cannot support deterministically. */
const probeType = (): RunEventType =>
  `schedule.ai_generated#probe-${randomUUID().slice(0, 8)}` as RunEventType;

/** Seed `n` qualifying run events of `type`, each with the same `cost_usd`,
 *  under a throwaway org/competition. One INSERT … SELECT over
 *  generate_series, so a 25-row baseline costs one round trip. */
async function seedRuns(type: RunEventType, costUsd: number, n: number): Promise<void> {
  const suffix = randomUUID().slice(0, 8);
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, slug)
    values (${"Median " + suffix}, ${"median-" + suffix})
    returning id`;
  const [comp] = await sql<{ id: string }[]>`
    insert into competitions (org_id, name, slug, visibility, branding)
    values (${org!.id}, 'Median Comp', ${"median-comp-" + suffix}, 'private', '{}')
    returning id`;
  await sql`
    insert into competition_events (competition_id, org_id, type, payload)
    select ${comp!.id}::uuid, ${org!.id}::uuid, ${type}::text, ${sql.json({ cost_usd: costUsd })}::jsonb
      from generate_series(1, ${n})`;
}

/** Seed ONE run event with an arbitrary (possibly malformed) payload, and hand
 *  back the competition id so the caller can delete it again. Malformed rows
 *  MUST be cleaned up: unlike `pack_units`, a bad `cost_usd` is read by
 *  medianRunCostUsd / aiRunTotals / listAiRuns, so leaving one behind poisons
 *  every later suite in the shared schema. */
async function seedRawRun(
  type: string,
  payload: Record<string, unknown>,
): Promise<{ compId: string; orgName: string }> {
  const suffix = randomUUID().slice(0, 8);
  const orgName = `Malformed ${suffix}`;
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, slug) values (${orgName}, ${"malformed-" + suffix})
    returning id`;
  const [comp] = await sql<{ id: string }[]>`
    insert into competitions (org_id, name, slug, visibility, branding)
    values (${org!.id}, 'Malformed Comp', ${"malformed-comp-" + suffix}, 'private', '{}')
    returning id`;
  await sql`
    insert into competition_events (competition_id, org_id, type, payload)
    values (${comp!.id}, ${org!.id}, ${type}, ${sql.json(payload as never)})`;
  return { compId: comp!.id, orgName };
}

/** How many rows the median query would actually see — used to assert the
 *  min-sample test's own precondition instead of assuming it. */
async function qualifyingRows(type: RunEventType, days: number): Promise<number> {
  const [row] = await sql<{ n: number }[]>`
    select count(*)::int as n
      from competition_events
     where type = ${type}
       and payload->>'cost_usd' is not null
       and created_at >= now() - make_interval(days => ${days})`;
  return row?.n ?? 0;
}

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
  it("pins the baseline window and the min-sample floor (controller ruling)", () => {
    // Both are load-bearing policy, not implementation detail: the window is
    // interpolated into the staff email, and the floor is what stops a
    // thin-data deployment emailing on every slightly-above-average run.
    expect(MEDIAN_WINDOW_DAYS).toBe(30);
    expect(AI_RUN_MEDIAN_MIN_SAMPLE).toBe(20);
  });
});

describe.skipIf(!HAS_DB)("medianRunCostUsd (v17 gap #295)", () => {
  it("returns null for a window with provably zero rows (future bound)", async () => {
    // days:-1 -> now() - make_interval(days => -1) = now() + 1 day, a bound
    // no row's created_at can ever satisfy — deterministic null regardless of
    // what other suites have written into competition_events.
    expect(await medianRunCostUsd("schedule.ai_generated", -1)).toBeNull();
  });

  it("returns null below the min-sample floor — one run is not a baseline", async () => {
    // Per-test synthetic event type: the window then provably contains ONLY
    // the rows this test seeds. Against the real types a "1 row -> null"
    // assertion is NOT deterministic — they accumulate rows from earlier runs
    // of this same file (the schema outlives the run), from concurrent suites,
    // and from production-shaped code paths. `type` is unconstrained text and
    // the SQL path exercised is identical; only the `type =` filter differs.
    const probe = probeType();
    await seedRuns(probe, 0.01, 1);
    expect(await qualifyingRows(probe, 1)).toBe(1);
    expect(await medianRunCostUsd(probe, 1)).toBeNull();
    // …and still null one row short of the floor.
    await seedRuns(probe, 0.01, AI_RUN_MEDIAN_MIN_SAMPLE - 2);
    expect(await qualifyingRows(probe, 1)).toBe(AI_RUN_MEDIAN_MIN_SAMPLE - 1);
    expect(await medianRunCostUsd(probe, 1)).toBeNull();
  });

  it("returns the median at exactly the min-sample floor (boundary)", async () => {
    const probe = probeType();
    await seedRuns(probe, 0.02, AI_RUN_MEDIAN_MIN_SAMPLE);
    expect(await qualifyingRows(probe, 1)).toBe(AI_RUN_MEDIAN_MIN_SAMPLE);
    expect(await medianRunCostUsd(probe, 1)).toBeCloseTo(0.02, 10);
  });

  it("returns a positive number once a REAL run type holds at least the min sample", async () => {
    await seedRuns("schedule.ai_generated", 0.01, SEED_N);
    expect(await qualifyingRows("schedule.ai_generated", 1)).toBeGreaterThanOrEqual(
      AI_RUN_MEDIAN_MIN_SAMPLE,
    );
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
    await seedRuns("schedule.ai_generated", 0.5, SEED_N);
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
    expect(args.to).toBe("ops@seazn.test");
    expect(args.orgId).toBe(orgId);
    expect(args.competitionId).toBe("comp-1");
    expect(args.phase).toBe("schedule");
    expect(args.model).toBe("claude-sonnet-5");
    expect(args.costUsd).toBe(50);
    expect(args.medianUsd).toBeGreaterThan(0);
    expect(args.windowDays).toBe(MEDIAN_WINDOW_DAYS);
  });

  it("forwards the run's mode and pack_units to the email (v17 gap #295 fold)", async () => {
    // The alert is the only place a human sees this run before /admin/ai-runs,
    // and "$0.90" alone cannot be triaged: mode says whether it is a full
    // regenerate or a nudge, pack_units says whether the cost is proportionate.
    // Both are pass-through only — the MEDIAN stays pooled across modes (see
    // the pooled-baseline note in the copy), so nothing here narrows it.
    await seedRuns("schedule.ai_generated", 0.5, SEED_N);
    process.env.STAFF_ALERT_EMAIL = "ops@seazn.test";
    await maybeAlertExpensiveRun({
      orgId: randomUUID(),
      phase: "schedule",
      mode: "regenerate",
      model: "claude-sonnet-5",
      costUsd: 50,
      packUnits: 40,
    });
    expect(sendAiRunCostAlertEmail).toHaveBeenCalledTimes(1);
    const args = vi.mocked(sendAiRunCostAlertEmail).mock.calls[0]![0];
    expect(args.mode).toBe("regenerate");
    expect(args.packUnits).toBe(40);
  });

  it("omits mode/pack_units rather than inventing them when the caller has none", async () => {
    // The officials path has no mode at all, and a pre-wave caller may carry no
    // size — the email must receive nothing rather than a zero it would render
    // as a real, empty pack.
    await seedRuns("schedule.ai_officials_generated", OFFICIALS_COST, SEED_N);
    process.env.STAFF_ALERT_EMAIL = "ops@seazn.test";
    await maybeAlertExpensiveRun({
      orgId: randomUUID(),
      phase: "officials",
      model: "claude-sonnet-5",
      costUsd: 50,
    });
    expect(sendAiRunCostAlertEmail).toHaveBeenCalledTimes(1);
    const args = vi.mocked(sendAiRunCostAlertEmail).mock.calls[0]![0];
    expect(args.mode).toBeUndefined();
    expect(args.packUnits).toBeUndefined();
  });

  it("compares an officials run against the OFFICIALS baseline, not the schedule one", async () => {
    // Pins the phase -> event-type map: the two baselines are seeded orders of
    // magnitude apart, so an inverted ternary would email a visibly different
    // median. Asserted three ways — exact equality with a fresh officials
    // read, a range only the officials seed can satisfy, and a proof that the
    // schedule baseline really is somewhere else entirely.
    await seedRuns("schedule.ai_officials_generated", OFFICIALS_COST, SEED_N);
    process.env.STAFF_ALERT_EMAIL = "ops@seazn.test";
    await maybeAlertExpensiveRun({
      orgId: randomUUID(),
      phase: "officials",
      model: "claude-sonnet-5",
      costUsd: 50,
    });
    expect(sendAiRunCostAlertEmail).toHaveBeenCalledTimes(1);
    const args = vi.mocked(sendAiRunCostAlertEmail).mock.calls[0]![0];
    const officialsMedian = await medianRunCostUsd(
      "schedule.ai_officials_generated",
      MEDIAN_WINDOW_DAYS,
    );
    const scheduleMedian = await medianRunCostUsd("schedule.ai_generated", MEDIAN_WINDOW_DAYS);
    expect(args.phase).toBe("officials");
    expect(args.medianUsd).toBe(officialsMedian);
    expect(args.medianUsd).toBeLessThan(0.0001); // only the officials seed lives down here
    expect(scheduleMedian).toBeGreaterThan(0.001); // …and the schedule baseline does not
  });

  it("never throws — a check failure is swallowed", async () => {
    await seedRuns("schedule.ai_officials_generated", OFFICIALS_COST, SEED_N);
    process.env.STAFF_ALERT_EMAIL = "ops@seazn.test";
    vi.mocked(sendAiRunCostAlertEmail).mockRejectedValueOnce(new Error("boom"));
    await expect(
      maybeAlertExpensiveRun({ orgId: randomUUID(), phase: "officials", model: "x", costUsd: 50 }),
    ).resolves.toBeUndefined();
    // The send really was attempted — otherwise this would pass vacuously
    // without ever entering the catch.
    expect(sendAiRunCostAlertEmail).toHaveBeenCalledTimes(1);
  });

  it("does nothing for a null cost (nothing to compare)", async () => {
    process.env.STAFF_ALERT_EMAIL = "ops@seazn.test";
    await maybeAlertExpensiveRun({
      orgId: randomUUID(),
      phase: "schedule",
      model: "x",
      costUsd: null,
    });
    expect(sendAiRunCostAlertEmail).not.toHaveBeenCalled();
  });
});

// v17 gap #295, fix round 2 (controller ruling). `cost_usd` is a free-form
// JSONB key, not a typed column, and every reader in ai-runs-admin.ts cast it
// with a bare `::numeric`. ONE unreadable value therefore aborts the whole
// query — and because maybeAlertExpensiveRun wraps everything in a try/catch
// that only logs, the expensive-run alert this wave exists to ship would then
// go SILENT, permanently, with nothing surfacing it. /admin/ai-runs (which
// renders listAiRuns + aiRunTotals server-side) 500s for the same reason.
//
// Every test here plants a malformed row and removes it in a `finally` — the
// schema is shared and long-lived, so a poison row left behind breaks every
// later suite (which is exactly how this defect was discovered).
describe.skipIf(!HAS_DB)("malformed cost_usd must not disable the readers (v17 gap #295)", () => {
  it("does not silently kill the expensive-run alert", async () => {
    await seedRuns("schedule.ai_generated", 0.5, SEED_N);
    const { compId } = await seedRawRun("schedule.ai_generated", { cost_usd: "expensive" });
    try {
      process.env.STAFF_ALERT_EMAIL = "ops@seazn.test";
      // Before the guard this threw PostgresError: invalid input syntax for
      // type numeric: "expensive".
      const median = await medianRunCostUsd("schedule.ai_generated", MEDIAN_WINDOW_DAYS);
      expect(median).toBeGreaterThan(0);

      // …and this is the real damage: the throw was swallowed, so the alert
      // simply never fired again.
      await maybeAlertExpensiveRun({
        orgId: randomUUID(),
        phase: "schedule",
        model: "claude-sonnet-5",
        costUsd: 50,
      });
      expect(sendAiRunCostAlertEmail).toHaveBeenCalledTimes(1);
    } finally {
      await sql`delete from competition_events where competition_id = ${compId}`;
    }
  });

  it("excludes an unreadable row from the MIN-SAMPLE count, not just from the percentile", async () => {
    // A row carrying no usable cost carries no signal either, so it must not
    // help a thin window reach the >= 20 floor — otherwise 19 real runs plus
    // one corrupt one would start emailing staff off a baseline of 19.
    // Per-test synthetic type, so the window provably holds only these rows.
    const probe = probeType();
    await seedRuns(probe, 0.01, AI_RUN_MEDIAN_MIN_SAMPLE - 1); // 19 usable
    const { compId } = await seedRawRun(probe, { cost_usd: "expensive" }); // 20th row, unusable
    try {
      expect(await medianRunCostUsd(probe, 1)).toBeNull();
      // One more REAL row tips it over — proving the null above was the
      // sample floor talking, not the malformed row breaking the query.
      await seedRuns(probe, 0.01, 1);
      expect(await medianRunCostUsd(probe, 1)).toBeCloseTo(0.01, 10);
    } finally {
      await sql`delete from competition_events where competition_id = ${compId}`;
    }
  });

  it("keeps /admin/ai-runs rendering — listAiRuns and aiRunTotals degrade to nulls", async () => {
    // Same page, same hazard, three more casts: usage counters and the
    // division_id used in a LEFT JOIN, all read straight out of the payload.
    const { compId, orgName } = await seedRawRun("schedule.ai_generated", {
      cost_usd: "expensive",
      usage: { input_tokens: "many", output_tokens: 12, repair_rounds: null },
      division_id: "not-a-uuid",
    });
    try {
      const rows = await listAiRuns(200);
      const row = rows.find((r) => r.org_name === orgName);
      expect(row, "the malformed run should still be listed, not omitted").toBeDefined();
      expect(row!.cost_usd).toBeNull();
      expect(row!.input_tokens).toBeNull();
      expect(row!.division_name).toBeNull();
      // A readable neighbour on the same row is still read.
      expect(row!.output_tokens).toBe(12);

      const totals = await aiRunTotals(MEDIAN_WINDOW_DAYS);
      expect(totals.runs).toBeGreaterThan(0);
      // The run is counted; its unreadable numbers simply are not summed.
      expect(Number.isFinite(totals.input_tokens)).toBe(true);
    } finally {
      await sql`delete from competition_events where competition_id = ${compId}`;
    }
  });
});

// The module-level vi.mock above swaps sendAiRunCostAlertEmail out for everyone
// importing @/lib/email, which is what the wiring tests need — but it also
// means the real renderer would otherwise ship with zero coverage. Pull the
// unmocked implementation straight out of vi.importActual for this block
// (cheaper and less surprising than a second test file that would need its own
// DB/mocking setup). `send()` returns false without RESEND_API_KEY, so these
// exercise the full render path with no network.
describe("sendAiRunCostAlertEmail (real render, v17 gap #295)", () => {
  const realSend = async (opts: Parameters<typeof sendAiRunCostAlertEmail>[0]) => {
    const actual = await vi.importActual<typeof import("@/lib/email")>("@/lib/email");
    return actual.sendAiRunCostAlertEmail(opts);
  };
  const base = {
    to: "ops@seazn.test",
    orgId: "org-1",
    competitionId: "comp-1",
    phase: "schedule" as const,
    model: "claude-sonnet-5",
    costUsd: 50,
    windowDays: MEDIAN_WINDOW_DAYS,
  };

  it("renders and returns false with no provider configured (no network, no throw)", async () => {
    const key = process.env.RESEND_API_KEY;
    delete process.env.RESEND_API_KEY;
    try {
      await expect(realSend({ ...base, medianUsd: 0.25 })).resolves.toBe(false);
    } finally {
      if (key !== undefined) process.env.RESEND_API_KEY = key;
    }
  });

  it("renders the no-multiple branch (medianUsd <= 0) without dividing by zero", async () => {
    const key = process.env.RESEND_API_KEY;
    delete process.env.RESEND_API_KEY;
    try {
      await expect(
        realSend({ ...base, competitionId: undefined, phase: "officials", medianUsd: 0 }),
      ).resolves.toBe(false);
    } finally {
      if (key !== undefined) process.env.RESEND_API_KEY = key;
    }
  });
});
