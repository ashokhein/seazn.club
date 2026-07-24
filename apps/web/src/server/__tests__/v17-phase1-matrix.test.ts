import { describe, it, expect } from "vitest";
import { sql } from "@/lib/db";

// v17 Phase 1 — packaging re-org (design/v17-pricing-entitlements/SPEC-1).
// Verifies V319: free runs big + officials ungate (#253) + dead keys (#246),
// and the org-wide-vs-competition-scoped Event Pass rule.
describe.skipIf(!process.env.DATABASE_URL)("v17 phase 1 matrix (V319)", () => {
  const get = async (k: string, p: string) => {
    const [r] = await sql<{ bool_value: boolean | null; int_value: number | null }[]>`
      select bool_value, int_value from plan_entitlements
      where feature_key = ${k} and plan_key = ${p}`;
    return r ?? null;
  };
  const has = async (k: string, p: string) => {
    const [r] = await sql<{ n: number }[]>`
      select count(*)::int as n from plan_entitlements where feature_key = ${k} and plan_key = ${p}`;
    return (r?.n ?? 0) > 0;
  };

  it("free runs big — community scale caps raised", async () => {
    expect((await get("entrants.per_division.max", "community"))?.int_value).toBe(64);
    expect((await get("competitions.max_active", "community"))?.int_value).toBe(10);
    expect((await get("divisions.per_competition.max", "community"))?.int_value).toBe(4);
    expect((await get("members.max", "community"))?.int_value).toBe(5);
    expect((await get("clubs.max", "community"))?.int_value).toBe(5);
    expect((await get("teams.max", "community"))?.int_value).toBe(8);
    expect((await get("import.bulk", "community"))?.int_value).toBe(50);
    expect((await get("schedule.checkpoints.max", "community"))?.int_value).toBe(2);
  });

  it("Event Pass lifts comp-scoped caps above community, not org-wide ones", async () => {
    // entrants is competition-scoped + pass-lifted: stays strictly above community 64
    expect((await get("entrants.per_division.max", "event_pass"))?.int_value).toBe(128);
    // divisions is comp-scoped and already above the new community 4
    expect((await get("divisions.per_competition.max", "event_pass"))?.int_value).toBe(10);
    // org-wide caps must NOT be pass-lifted (else the pass caps them BELOW the raised
    // community value). Rows removed → fall through to the community plan value.
    expect(await has("clubs.max", "event_pass")).toBe(false);
    expect(await has("teams.max", "event_pass")).toBe(false);
    expect(await has("members.max", "event_pass")).toBe(false);
  });

  it("officials ungated on every plan (#253) — manual, not AI", async () => {
    for (const p of ["community", "pro", "pro_plus"]) {
      expect((await get("officials.per_fixture.max", p))?.int_value).toBeNull();
      expect((await get("officials.roles_multi", p))?.bool_value).toBe(true);
      expect((await get("officials.marks", p))?.bool_value).toBe(true);
    }
    expect((await get("officials.roles_multi", "event_pass"))?.bool_value).toBe(true);
    expect((await get("officials.marks", "event_pass"))?.bool_value).toBe(true);
    // AI officials auto stays gated this phase (becomes credit-metered in Phase 2)
    expect((await get("officials.auto", "community"))?.bool_value).not.toBe(true);
  });

  it("dead keys removed (#246); stats.club_championship kept", async () => {
    expect(await has("public_pages", "community")).toBe(false);
    expect(await has("eligibility.enforced", "community")).toBe(false);
    expect(await has("stats.club_championship", "pro_plus")).toBe(true);
  });
});
