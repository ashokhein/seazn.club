// v17 gap #295 — SPEC-2 §5.3's "live margin monitor" / SPEC-3 §6's
// "/admin/revenue — add credits sold vs COGS". credits_spent (and its
// $0.25/credit revenue-equivalent) comes from ai_credit_ledger; cogs_usd
// comes from the AI run audit trail (competition_events) — see the plan's
// Migration note for why these are two independent aggregates, not a
// per-run join. Real Postgres required; skipped without DATABASE_URL.
//
// NOISE DISCIPLINE. The per-ORG assertions are deterministic: every row is
// scoped to a throwaway org id nothing else can write to. The per-PHASE
// assertions cannot be — `byPhase` is a platform-wide rollup and the sibling
// AI suites (schedule-ai-route, officials-ai-route, ai-run-cost-alert) write
// real run events into the same schema concurrently. They can only ADD rows,
// never remove them, so those assertions are written as BEFORE/AFTER deltas
// with seed magnitudes ($100s, millions of units) orders above anything a
// mocked run produces (SPEC-2 §6: worst observed real run ~$0.47, packs in the
// tens of fixtures). A delta landing in the seeded band is reachable only if
// the seed was attributed to that phase and nothing else was.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { AI_RUN_UNIT_NOUN } from "@/lib/ai-pricing";
import {
  aiMarginReport,
  costPerUnitUsd,
  type AiMarginRow,
  type AiPhaseUnitRow,
} from "../ai-runs-admin";

const HAS_DB = !!process.env.DATABASE_URL;
const uniq = () => randomUUID().slice(0, 8);

/** Widest window the report offers, and the one the panel renders. */
const DAYS = 30;

async function seedOrg(name: string): Promise<string> {
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, slug) values (${name}, ${`margin-${uniq()}`})
    returning id`;
  return org!.id;
}

async function seedCompetition(orgId: string): Promise<string> {
  const [comp] = await sql<{ id: string }[]>`
    insert into competitions (org_id, name, slug, visibility, branding)
    values (${orgId}, 'Margin Comp', ${`margin-comp-${uniq()}`}, 'private', '{}')
    returning id`;
  return comp!.id;
}

/** One AI run event with an arbitrary payload — used by the phase tests to
 *  plant runs whose cost/size are orders above real traffic. */
async function seedRunEvent(
  compId: string,
  orgId: string,
  type: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await sql`
    insert into competition_events (competition_id, org_id, type, payload)
    values (${compId}, ${orgId}, ${type}, ${sql.json(payload as never)})`;
}

const phaseRow = (report: { byPhase: AiPhaseUnitRow[] }, phase: string): AiPhaseUnitRow => {
  const row = report.byPhase.find((r) => r.phase === phase);
  expect(row, `expected a ${phase} row in byPhase`).toBeDefined();
  return row!;
};

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

describe("costPerUnitUsd (pure, v17 gap #295)", () => {
  it("is null with no units — a phase that recorded no size has no $/unit, not a zero", () => {
    // Split out of the rollup precisely so this branch is testable without a
    // database: every pre-wave run event carries no pack_units at all, so a
    // production window can genuinely hold cost and no units.
    expect(costPerUnitUsd(12.5, 0)).toBeNull();
    expect(costPerUnitUsd(0, 0)).toBeNull();
  });
  it("divides sized COGS by units", () => {
    expect(costPerUnitUsd(1, 1000)).toBeCloseTo(0.001, 9);
    expect(costPerUnitUsd(0.6, 1500)).toBeCloseTo(0.0004, 9);
  });
  it("is zero, not null, when sized runs really did cost nothing (solver-draft)", () => {
    // officials-ai records solver-draft runs at cost_usd = 0. That is a real
    // $0.00/unit, and collapsing it to null would hide free runs from the panel.
    expect(costPerUnitUsd(0, 10)).toBe(0);
  });
});

describe.skipIf(!HAS_DB)("aiMarginReport (v17 gap #295)", () => {
  it("nets refunds into credits_spent, prices at $0.25/credit, and rolls up per-org + aggregate", async () => {
    const orgId = await seedOrg(`Margin A ${uniq()}`);
    const compId = await seedCompetition(orgId);
    const walletId = randomUUID(); // wallet mechanics are irrelevant here — the report groups by spent_by_org_id/org_id, not wallet_id

    // 10 credits spent, 2 refunded back -> net 8 -> revenue = 8 * $0.25 = $2.00
    const holdId = randomUUID();
    await sql`
      insert into ai_credit_ledger (id, wallet_id, delta, source, bucket, spent_by_org_id, balance_after, idempotency_key)
      values (${holdId}, ${walletId}, -10, 'run_spend', 'grant', ${orgId}, 0, ${`h-${uniq()}`})`;
    await sql`
      insert into ai_credit_ledger (wallet_id, delta, source, bucket, ref, balance_after, idempotency_key)
      values (${walletId}, 2, 'refund', 'grant', ${holdId}, 2, ${`r-${uniq()}`})`;

    // $0.30 real COGS across two events (one success, one failure — both count).
    await sql`
      insert into competition_events (competition_id, org_id, type, payload)
      values (${compId}, ${orgId}, 'schedule.ai_generated', ${sql.json({ cost_usd: 0.2 })})`;
    await sql`
      insert into competition_events (competition_id, org_id, type, payload)
      values (${compId}, ${orgId}, 'schedule.ai_failed', ${sql.json({ cost_usd: 0.1 })})`;

    const report = await aiMarginReport(DAYS);
    const row = report.byOrg.find((r) => r.org_id === orgId);
    expect(row).toBeDefined();
    expect(row!.credits_spent).toBe(8);
    expect(row!.revenue_usd).toBeCloseTo(2.0, 2);
    expect(row!.cogs_usd).toBeCloseTo(0.3, 2);
    expect(row!.margin_pct).toBeCloseTo(85, 0); // (2.00 - 0.30) / 2.00 = 85%

    // Aggregate includes at least this org's numbers (other concurrent test
    // data may also be present — assert a floor, not an exact total).
    expect(report.aggregate.credits_spent).toBeGreaterThanOrEqual(8);
    expect(report.aggregate.cogs_usd).toBeGreaterThanOrEqual(0.3 - 0.001);
  });

  it("an org with COGS but no net credit spend shows margin_pct null, not a divide-by-zero", async () => {
    const orgId = await seedOrg(`Margin B ${uniq()}`);
    const compId = await seedCompetition(orgId);
    // Every run failed and was fully refunded -> net credits_spent = 0.
    const holdId = randomUUID();
    await sql`
      insert into ai_credit_ledger (id, wallet_id, delta, source, bucket, spent_by_org_id, balance_after, idempotency_key)
      values (${holdId}, ${randomUUID()}, -1, 'run_spend', 'grant', ${orgId}, 0, ${`h-${uniq()}`})`;
    await sql`
      insert into ai_credit_ledger (wallet_id, delta, source, bucket, ref, balance_after, idempotency_key)
      values ((select wallet_id from ai_credit_ledger where id = ${holdId}), 1, 'refund', 'grant', ${holdId}, 1, ${`r-${uniq()}`})`;
    await sql`
      insert into competition_events (competition_id, org_id, type, payload)
      values (${compId}, ${orgId}, 'schedule.ai_failed', ${sql.json({ cost_usd: 0.05 })})`;

    const report = await aiMarginReport(DAYS);
    const row = report.byOrg.find((r) => r.org_id === orgId);
    expect(row).toBeDefined();
    expect(row!.credits_spent).toBe(0);
    expect(row!.revenue_usd).toBe(0);
    expect(row!.cogs_usd).toBeCloseTo(0.05, 2);
    expect(row!.margin_pct).toBeNull();
  });
});

describe.skipIf(!HAS_DB)("aiMarginReport — byOrg ordering (v17 gap #295)", () => {
  it("breaks COGS ties deterministically, so the 25-row view cap cannot shuffle between loads", async () => {
    // The panel shows only the top 25 of (today) 300+ orgs. Sorting on COGS
    // alone leaves every tie — and $0.00 COGS is the common case — resolved by
    // Set insertion order, which comes from two GROUP BY queries that carry no
    // ORDER BY. Postgres is free to return those rows differently on any run,
    // so an org could appear and disappear from the panel with no data change.
    const cogs = 550;
    const orgs = await Promise.all([
      seedOrg(`Margin tie ${uniq()}`),
      seedOrg(`Margin tie ${uniq()}`),
      seedOrg(`Margin tie ${uniq()}`),
    ]);
    // Two fully tied (same COGS, same credits); one tied on COGS but richer.
    const credits = [4, 4, 9];
    for (const [i, orgId] of orgs.entries()) {
      const compId = await seedCompetition(orgId);
      await seedRunEvent(compId, orgId, "schedule.ai_generated", { cost_usd: cogs });
      await sql`
        insert into ai_credit_ledger (wallet_id, delta, source, bucket, spent_by_org_id, balance_after, idempotency_key)
        values (${randomUUID()}, ${-credits[i]!}, 'run_spend', 'grant', ${orgId}, 0, ${`t-${uniq()}`})`;
    }

    const report = await aiMarginReport(DAYS);

    // THE assertion: every adjacent pair obeys the full 3-key order. Checking
    // only the seeded trio is not enough — V8's sort is stable, so with no
    // tiebreaker those three keep whatever order the Set happened to give
    // them, which is right about as often as it is wrong. (Verified: removing
    // the tiebreakers left a trio-only test passing.) Across the schema's
    // hundreds of tied $0.00 orgs, insertion order cannot satisfy this.
    const cmp = (a: AiMarginRow, b: AiMarginRow) =>
      b.cogs_usd - a.cogs_usd ||
      b.revenue_usd - a.revenue_usd ||
      (a.org_id ?? "").localeCompare(b.org_id ?? "");
    expect(report.byOrg.length).toBeGreaterThan(3); // else the check is thin
    for (let i = 1; i < report.byOrg.length; i++) {
      const prev = report.byOrg[i - 1]!;
      const curr = report.byOrg[i]!;
      expect(
        cmp(prev, curr),
        `byOrg[${i - 1}] (${prev.org_id}, cogs ${prev.cogs_usd}, rev ${prev.revenue_usd}) ` +
          `must not sort after byOrg[${i}] (${curr.org_id}, cogs ${curr.cogs_usd}, rev ${curr.revenue_usd})`,
      ).toBeLessThanOrEqual(0);
    }

    // Readable spot-checks on the seeded trio, on top of the invariant above.
    const at = (orgId: string) => report.byOrg.findIndex((r) => r.org_id === orgId);
    const richer = orgs[2]!;
    const [tiedA, tiedB] = [orgs[0]!, orgs[1]!];
    expect(at(richer)).toBeLessThan(at(tiedA)); // more revenue wins the COGS tie
    expect(at(richer)).toBeLessThan(at(tiedB));
    const [firstTied, secondTied] = tiedA < tiedB ? [tiedA, tiedB] : [tiedB, tiedA];
    expect(at(firstTied)).toBeLessThan(at(secondTied)); // total tie -> org id asc

    // And the whole ordering is reproducible across reads.
    const again = await aiMarginReport(DAYS);
    expect(again.byOrg.map((r) => r.org_id)).toEqual(report.byOrg.map((r) => r.org_id));
  });
});

describe.skipIf(!HAS_DB)("aiMarginReport — per-phase unit economics (v17 gap #295)", () => {
  it("segments $/unit BY PHASE and labels the unit — the two phases count different things", async () => {
    // schedule stamps movableIds.size (the movable SUBSET it was asked to
    // place); officials stamps pack.fixtures.length (EVERY fixture in the
    // pack). A single blended $/unit across the two would be arithmetic over
    // two different denominators, so the report must never produce one.
    const orgId = await seedOrg(`Margin phase ${uniq()}`);
    const compId = await seedCompetition(orgId);
    const before = await aiMarginReport(DAYS);

    // Seed magnitudes far above anything real traffic or a mocked run makes.
    await seedRunEvent(compId, orgId, "schedule.ai_generated", {
      cost_usd: 600,
      pack_units: 1_500_000,
    });
    await seedRunEvent(compId, orgId, "schedule.ai_officials_generated", {
      cost_usd: 900,
      pack_units: 3_000_000,
    });

    const after = await aiMarginReport(DAYS);
    const sched = phaseRow(after, "schedule");
    const offs = phaseRow(after, "officials");

    // The unit is part of the number.
    expect(sched.unit_noun).toBe(`${AI_RUN_UNIT_NOUN.schedule}s`);
    expect(offs.unit_noun).toBe(`${AI_RUN_UNIT_NOUN.officials}s`);
    expect(sched.unit_noun).not.toBe(offs.unit_noun);

    // Attribution: each seed landed in its own bucket and nowhere else. The
    // bands are only reachable if the schedule seed did NOT leak into
    // officials (and vice versa) — the two seeds differ by 1.5M units / $300.
    const dSchedUnits = sched.units - phaseRow(before, "schedule").units;
    const dOffsUnits = offs.units - phaseRow(before, "officials").units;
    expect(dSchedUnits).toBeGreaterThanOrEqual(1_500_000);
    expect(dSchedUnits).toBeLessThan(1_600_000);
    expect(dOffsUnits).toBeGreaterThanOrEqual(3_000_000);
    expect(dOffsUnits).toBeLessThan(3_100_000);

    // The ratio is each row's own sized COGS over its own units — never the
    // platform total over the platform units.
    for (const row of after.byPhase) {
      expect(row.cost_per_unit_usd).toBe(costPerUnitUsd(row.sized_cogs_usd, row.units));
    }

    // And no blended cross-phase per-unit number is exposed anywhere.
    expect(after.aggregate).not.toHaveProperty("cost_per_unit_usd");
    expect(after).not.toHaveProperty("cost_per_unit_usd");
  });

  it("counts runs that carry NO pack_units instead of dropping or zeroing them", async () => {
    // Every run event written before this wave lacks the key. Such a run's
    // COGS is real and must stay in cogs_usd; only the $/unit denominator
    // excludes it — otherwise a window full of legacy rows silently reads as
    // a very cheap $/unit.
    const orgId = await seedOrg(`Margin nounits ${uniq()}`);
    const compId = await seedCompetition(orgId);
    const before = phaseRow(await aiMarginReport(DAYS), "schedule");

    await seedRunEvent(compId, orgId, "schedule.ai_generated", { cost_usd: 700 });

    const after = phaseRow(await aiMarginReport(DAYS), "schedule");
    expect(after.runs - before.runs).toBeGreaterThanOrEqual(1);
    expect(after.runs_missing_units - before.runs_missing_units).toBeGreaterThanOrEqual(1);
    // Its cost IS in the phase total. (Floor is a hair under 700 because the
    // delta of two rounded dollar totals carries float noise — the assertion
    // is "the $700 arrived", not "to the cent".)
    expect(after.cogs_usd - before.cogs_usd).toBeGreaterThan(699.9);
    // …and is NOT in the $/unit numerator (a $700 leak would be unmissable).
    expect(after.sized_cogs_usd - before.sized_cogs_usd).toBeLessThan(1);
    // …and contributed no phantom units.
    expect(after.units - before.units).toBeLessThan(1000);
  });

  it("survives a malformed pack_units instead of 500-ing the whole page", async () => {
    // `pack_units` is a free-form JSONB key, not a typed column — nothing in
    // the database stops a future writer (or a hand-patched row) putting a
    // string there. An unguarded ::numeric cast would throw, and /admin/revenue
    // renders this report server-side, so one bad row would take down the
    // entire page rather than one number. Treat it as "no size recorded".
    const orgId = await seedOrg(`Margin bad ${uniq()}`);
    const compId = await seedCompetition(orgId);
    const before = phaseRow(await aiMarginReport(DAYS), "schedule");

    await seedRunEvent(compId, orgId, "schedule.ai_generated", {
      cost_usd: 900,
      pack_units: "lots",
    });

    const after = phaseRow(await aiMarginReport(DAYS), "schedule");
    // Counted as a run, counted in COGS, counted as size-less…
    expect(after.runs - before.runs).toBeGreaterThanOrEqual(1);
    expect(after.cogs_usd - before.cogs_usd).toBeGreaterThan(899.9);
    expect(after.runs_missing_units - before.runs_missing_units).toBeGreaterThanOrEqual(1);
    // …and contributes neither phantom units nor a $900 leak into the ratio.
    expect(after.units - before.units).toBeLessThan(1000);
    expect(after.sized_cogs_usd - before.sized_cogs_usd).toBeLessThan(1);
  });

  it("survives a malformed cost_usd instead of 500-ing the whole page", async () => {
    // Exactly the pack_units hazard one column over: cost_usd is a free-form
    // JSONB key too, and this report is the page-load path. A run whose cost
    // cannot be read is counted as a run, surfaced in runs_missing_cost, and
    // contributes nothing to COGS — we do not invent a number, and we do not
    // let one row take the page down.
    const orgId = await seedOrg(`Margin badcost ${uniq()}`);
    const compId = await seedCompetition(orgId);
    const before = phaseRow(await aiMarginReport(DAYS), "schedule");

    await seedRunEvent(compId, orgId, "schedule.ai_generated", {
      cost_usd: "expensive",
      pack_units: 4_000_000,
    });

    try {
      const after = phaseRow(await aiMarginReport(DAYS), "schedule");
      expect(after.runs - before.runs).toBeGreaterThanOrEqual(1);
      expect(after.runs_missing_cost - before.runs_missing_cost).toBeGreaterThanOrEqual(1);
      // No invented cost anywhere.
      expect(after.cogs_usd - before.cogs_usd).toBeLessThan(1);
      expect(after.sized_cogs_usd - before.sized_cogs_usd).toBeLessThan(1);
      // Its size is not counted either: units and sized COGS must stay a MATCHED
      // pair, or the ratio divides one set's cost by another set's units.
      expect(after.units - before.units).toBeLessThan(1000);
    } finally {
      // MUST clean up, unlike the malformed-pack_units row above. `pack_units`
      // is read by nothing outside this report, but `cost_usd` is read by
      // `medianRunCostUsd` and `aiRunTotals`, whose casts are UNGUARDED. Left
      // behind, this single row permanently breaks the expensive-run alert and
      // /admin/ai-runs for every later suite in the shared schema — observed:
      // 4 failures in ai-run-cost-alert.test.ts, including the alert silently
      // never firing again. Filed as a finding; not fixed here (out of scope),
      // so the test must not be the thing that plants it.
      await sql`delete from competition_events where competition_id = ${compId}`;
    }
  });

  it("accepts a cost in exponent form — a real, very small cost is not silently dropped", async () => {
    // JSON.stringify switches to exponential below 1e-6, so a genuinely tiny
    // per-run cost reaches the payload as "1e-7". A guard that only accepted
    // plain decimals would quietly treat those as unrecorded and understate
    // COGS — a worse failure than the crash it replaced, because it is silent.
    const orgId = await seedOrg(`Margin expcost ${uniq()}`);
    const compId = await seedCompetition(orgId);
    const before = phaseRow(await aiMarginReport(DAYS), "officials");

    await sql`
      insert into competition_events (competition_id, org_id, type, payload)
      values (${compId}, ${orgId}, 'schedule.ai_officials_generated',
              ${sql.json({ cost_usd: 1e-7, pack_units: 1 } as never)})`;

    const after = phaseRow(await aiMarginReport(DAYS), "officials");
    expect(after.runs - before.runs).toBeGreaterThanOrEqual(1);
    // Counted as costed, not as missing.
    expect(after.runs_missing_cost - before.runs_missing_cost).toBe(0);
  });

  it("counts an escalated run's size ONCE — `movable` and `pack_units` are the same number, not two signals", async () => {
    // schedule-ai stamps ladder telemetry on an escalated run, and that block
    // carries `movable: movableIds.size` — the identical number already
    // stamped as `pack_units`. Summing both would silently double every
    // escalated run's size and halve the phase's cost per unit.
    const orgId = await seedOrg(`Margin escalated ${uniq()}`);
    const compId = await seedCompetition(orgId);
    const before = phaseRow(await aiMarginReport(DAYS), "schedule");

    await seedRunEvent(compId, orgId, "schedule.ai_generated", {
      cost_usd: 400,
      pack_units: 6_000_000,
      // Exactly the shape schedule-ai.ts writes when the ladder falls through.
      escalated_from: "gemini",
      rungs_tried: ["gemini", "claude-sonnet-5"],
      warnings: 2,
      movable: 6_000_000,
    });

    const after = phaseRow(await aiMarginReport(DAYS), "schedule");
    const dUnits = after.units - before.units;
    expect(dUnits).toBeGreaterThanOrEqual(6_000_000);
    // 12,000,000 would mean `movable` was counted as well.
    expect(dUnits).toBeLessThan(6_100_000);
    // One run, not two.
    expect(after.runs - before.runs).toBeGreaterThanOrEqual(1);
    expect(after.runs - before.runs).toBeLessThan(5);
  });

  it("reads a failed run's phase off its payload, not off the event type", async () => {
    // Both phases record failures under the SAME type (schedule.ai_failed) and
    // stamp `phase` in the payload. Keying off the type alone would file every
    // officials failure under schedule and skew both $/unit figures.
    const orgId = await seedOrg(`Margin failed ${uniq()}`);
    const compId = await seedCompetition(orgId);
    const before = await aiMarginReport(DAYS);

    // Both directions, so neither "always officials" nor "always schedule"
    // can satisfy this: the two failures differ only in their stamped phase,
    // and their costs are far enough apart to tell the buckets apart.
    await seedRunEvent(compId, orgId, "schedule.ai_failed", {
      phase: "officials",
      cost_usd: 800,
      pack_units: 5_000_000,
    });
    await seedRunEvent(compId, orgId, "schedule.ai_failed", {
      phase: "schedule",
      cost_usd: 300,
      pack_units: 2_000_000,
    });

    const after = await aiMarginReport(DAYS);
    const dOffs = phaseRow(after, "officials").cogs_usd - phaseRow(before, "officials").cogs_usd;
    const dSched = phaseRow(after, "schedule").cogs_usd - phaseRow(before, "schedule").cogs_usd;
    // Bands, not floors: 800 must land in officials and ONLY 800 (not 1100),
    // 300 in schedule and only 300 — float noise in a delta of rounded totals
    // is far below the 1-dollar slack.
    expect(dOffs).toBeGreaterThan(799.9);
    expect(dOffs).toBeLessThan(801);
    expect(dSched).toBeGreaterThan(299.9);
    expect(dSched).toBeLessThan(301);
  });

  it("reports a provably empty window as all-zero, which is what the panel's idle state reads", async () => {
    // days: -1 -> now() + 1 day, a lower bound no row's created_at can satisfy.
    // Deterministic regardless of what any other suite has written, and it is
    // the exact shape /admin/revenue keys its "no AI runs yet" state off.
    const report = await aiMarginReport(-1);
    expect(report.days).toBe(-1);
    expect(report.byOrg).toEqual([]);
    expect(report.aggregate.credits_spent).toBe(0);
    expect(report.aggregate.revenue_usd).toBe(0);
    expect(report.aggregate.cogs_usd).toBe(0);
    expect(report.aggregate.margin_pct).toBeNull();
    // Both phase rows still present, all zero, with no invented $/unit.
    expect(report.byPhase).toHaveLength(2);
    for (const row of report.byPhase) {
      expect(row.runs).toBe(0);
      expect(row.runs_missing_units).toBe(0);
      expect(row.runs_missing_cost).toBe(0);
      expect(row.units).toBe(0);
      expect(row.cogs_usd).toBe(0);
      expect(row.cost_per_unit_usd).toBeNull();
    }
  });

  it("always reports both phases, so an empty phase reads as 'no runs' and not as a missing row", async () => {
    // Stable shape for the panel, and it makes the zero-units branch reachable
    // on a fresh deployment: a phase with no runs yet has units 0 and therefore
    // no $/unit at all.
    const report = await aiMarginReport(DAYS);
    expect(report.byPhase.map((r) => r.phase)).toEqual(["schedule", "officials"]);
    for (const row of report.byPhase) {
      if (row.units === 0) expect(row.cost_per_unit_usd).toBeNull();
    }
  });

  it("partitions the platform COGS — the phase rows add up to the aggregate", async () => {
    // A single report is one consistent read, so the COGS identity holds
    // exactly regardless of what other suites are writing: if a bucket were
    // dropped (an unknown phase string, a null payload phase on a legacy
    // failure) the totals would diverge.
    //
    // The run-count check is one-sided on purpose: the raw count is taken
    // BEFORE the report, and concurrent suites can only ADD rows, so
    // `runs >= n` can never be satisfied by a rollup that dropped a bucket.
    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from competition_events
       where type in ('schedule.ai_generated', 'schedule.ai_officials_generated', 'schedule.ai_failed')
         and created_at >= now() - make_interval(days => ${DAYS})`;
    const report = await aiMarginReport(DAYS);
    // EXACT, not "close to": the panel prints the headline COGS in a tile and
    // the phase rows in a table directly under it, and a staff member adding
    // those two rows must land on the headline. Rounding the grand total
    // independently of the rows lets them disagree by a cent — observed at
    // ~2,000 rows before the totals were single-sourced. The remaining slack
    // is float addition noise only.
    const summed = report.byPhase.reduce((s, r) => s + r.cogs_usd, 0);
    expect(Math.abs(summed - report.aggregate.cogs_usd)).toBeLessThan(0.0000001);
    const runs = report.byPhase.reduce((s, r) => s + r.runs, 0);
    expect(n).toBeGreaterThan(0); // otherwise the check below passes vacuously
    expect(runs).toBeGreaterThanOrEqual(n);
  });
});
