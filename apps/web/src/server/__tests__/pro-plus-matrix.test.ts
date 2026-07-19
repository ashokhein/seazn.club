import { describe, it, expect } from "vitest";
import { sql } from "@/lib/db";

// V290 (spec §1): the pro_plus column must be COMPLETE — a key present for
// any plan but missing for pro_plus would silently DENY on Pro Plus.
describe.skipIf(!process.env.DATABASE_URL)("V290 pro_plus matrix", () => {
  it("has a pro_plus row for every feature key any plan defines", async () => {
    const rows = await sql<{ feature_key: string; plan_key: string }[]>`
      select distinct feature_key, plan_key from plan_entitlements`;
    const all = new Set(rows.map((r) => r.feature_key));
    const plus = new Set(rows.filter((r) => r.plan_key === "pro_plus").map((r) => r.feature_key));
    // event_pass is deliberately sparse; pro_plus must not be.
    const missing = [...all].filter((k) => !plus.has(k));
    expect(missing).toEqual([]);
  });

  it("keeps officials.auto / api.write Pro Plus only", async () => {
    const rows = await sql<{ feature_key: string; plan_key: string; bool_value: boolean | null }[]>`
      select feature_key, plan_key, bool_value from plan_entitlements
      where feature_key in ('officials.auto','api.write')
        and plan_key in ('pro','pro_plus')`;
    for (const k of ["officials.auto", "api.write"]) {
      expect(rows.find((r) => r.plan_key === "pro" && r.feature_key === k)?.bool_value).toBe(false);
      expect(rows.find((r) => r.plan_key === "pro_plus" && r.feature_key === k)?.bool_value).toBe(true);
    }
  });

  // Owner 2026-07-19 (V302, supersedes the V291 amendment): AI scheduling is
  // granted on every plan with a graded per-division run cap — community 5 /
  // event pass 10 / pro 20 / pro plus 50.
  it("grants scheduling.ai on every plan with the V302 graded run caps", async () => {
    const rows = await sql<{ feature_key: string; plan_key: string; bool_value: boolean | null; int_value: number | null }[]>`
      select feature_key, plan_key, bool_value, int_value from plan_entitlements
      where feature_key in ('scheduling.ai','scheduling.ai.runs_per_division.max')`;
    const get = (k: string, p: string) => rows.find((r) => r.feature_key === k && r.plan_key === p);
    expect(get("scheduling.ai", "pro")?.bool_value).toBe(true);
    expect(get("scheduling.ai", "pro_plus")?.bool_value).toBe(true);
    expect(get("scheduling.ai", "community")?.bool_value).toBe(true);
    expect(get("scheduling.ai", "event_pass")?.bool_value).toBe(true);
    expect(get("scheduling.ai.runs_per_division.max", "community")?.int_value).toBe(5);
    expect(get("scheduling.ai.runs_per_division.max", "event_pass")?.int_value).toBe(10);
    expect(get("scheduling.ai.runs_per_division.max", "pro")?.int_value).toBe(20);
    expect(get("scheduling.ai.runs_per_division.max", "pro_plus")?.int_value).toBe(50);
  });

  it("seeds the new quota keys with the approved ladder", async () => {
    const rows = await sql<{ feature_key: string; plan_key: string; int_value: number | null; bool_value: boolean | null }[]>`
      select feature_key, plan_key, int_value, bool_value from plan_entitlements
      where feature_key in ('officials.per_fixture.max','schedule.checkpoints.max','domains.custom','support.priority','registration.fee_percent')`;
    const get = (k: string, p: string) => rows.find((r) => r.feature_key === k && r.plan_key === p);
    expect(get("officials.per_fixture.max", "community")?.int_value).toBe(1);
    expect(get("officials.per_fixture.max", "pro")?.int_value).toBeNull();
    expect(get("schedule.checkpoints.max", "community")?.int_value).toBe(1);
    expect(get("schedule.checkpoints.max", "pro")?.int_value).toBe(5);
    expect(get("schedule.checkpoints.max", "pro_plus")?.int_value).toBeNull();
    expect(get("domains.custom", "pro")?.bool_value).toBe(false);
    expect(get("domains.custom", "pro_plus")?.bool_value).toBe(true);
    expect(get("support.priority", "pro_plus")?.bool_value).toBe(true);
    expect(get("registration.fee_percent", "pro_plus")?.int_value).toBe(1);
    expect(rows.some((r) => r.feature_key === "officials.per_fixture.max" && r.plan_key === "event_pass")).toBe(false);
  });

  it("retired business and officials.assignment", async () => {
    const [biz] = await sql<{ n: number }[]>`
      select count(*)::int as n from plan_entitlements where plan_key = 'business'`;
    const [plan] = await sql<{ n: number }[]>`select count(*)::int as n from plans where key = 'business'`;
    const [oa] = await sql<{ n: number }[]>`
      select count(*)::int as n from plan_entitlements where feature_key = 'officials.assignment'`;
    expect(biz!.n).toBe(0);
    expect(plan!.n).toBe(0);
    expect(oa!.n).toBe(0);
  });

  it("did not touch dashboard.branding (PLG badge trigger, D7)", async () => {
    const rows = await sql<{ plan_key: string; bool_value: boolean | null }[]>`
      select plan_key, bool_value from plan_entitlements where feature_key = 'dashboard.branding'`;
    expect(rows.find((r) => r.plan_key === "community")?.bool_value).toBe(false);
    expect(rows.find((r) => r.plan_key === "pro")?.bool_value).toBe(true);
    expect(rows.find((r) => r.plan_key === "pro_plus")?.bool_value).toBe(true);
  });
});
