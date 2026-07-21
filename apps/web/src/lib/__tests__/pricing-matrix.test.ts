// The pricing table renders from plan_entitlements (spec 2026-07-18
// pro-plus-tier §5) — these pin the pivot: ints/∞, bool ticks, pass-column
// fallback to community (the resolver's fall-through), and the folded
// entry-fee cell, across all four plans + eight ENTITLEMENT_DOMAINS.
import { afterAll, describe, expect, it } from "vitest";
import { buildPricingSections, type MatrixData } from "@/lib/pricing-matrix";
import { ENTITLEMENT_DOMAINS } from "@/lib/entitlement-domains";
import { sql } from "@/lib/db";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

const cell = (int: number | null = null, bool: boolean | null = null) => ({
  int_value: int,
  bool_value: bool,
});

// Mirrors the real V290 local-DB values for the rows under test.
const DATA: MatrixData = {
  "competitions.max_active": {
    community: cell(1),
    pro: cell(null),
    pro_plus: cell(null),
  },
  "divisions.per_competition.max": {
    community: cell(2),
    event_pass: cell(10),
    pro: cell(null),
    pro_plus: cell(null),
  },
  "entrants.per_division.max": {
    community: cell(16),
    event_pass: cell(32),
    pro: cell(256),
    pro_plus: cell(null),
  },
  "schedule.checkpoints.max": {
    // No event_pass row — pass falls through to community, exactly like the
    // resolver does (db/migration/deltas/V290 comment).
    community: cell(1),
    pro: cell(5),
    pro_plus: cell(null),
  },
  "officials.per_fixture.max": {
    community: cell(1),
    pro: cell(null),
    pro_plus: cell(null),
  },
  // V310 (D18/D19/D20): charging entry fees is free for everyone; the pass and
  // the paid plans buy a CHEAPER cut, not the ability itself.
  "registration.paid": {
    community: cell(null, true),
    event_pass: cell(null, true),
    pro: cell(null, true),
    pro_plus: cell(null, true),
  },
  "registration.fee_percent": {
    community: cell(8),
    event_pass: cell(5),
    pro: cell(2),
    pro_plus: cell(1),
  },
  "stats.player": {
    community: cell(null, false),
    pro: cell(null, true),
    pro_plus: cell(null, true),
  },
  // W1 Task 11: clubs & teams register caps (real V291 values) render as
  // numbers, ∞ for unlimited — never a bare ✓/— tick.
  "clubs.max": {
    community: cell(2, true),
    event_pass: cell(2, true),
    pro: cell(20, true),
    pro_plus: cell(null, true),
  },
  "teams.max": {
    community: cell(2, true),
    event_pass: cell(2, true),
    pro: cell(40, true),
    pro_plus: cell(null, true),
  },
  "teams.squad_max": {
    community: cell(20, true),
    event_pass: cell(20, true),
    pro: cell(null, true),
    pro_plus: cell(null, true),
  },
};

describe("buildPricingSections (spec 2026-07-18 pro-plus-tier §5)", () => {
  const sections = buildPricingSections(DATA);
  const allRows = sections.flatMap((s) => s.rows);
  const row = (labelKey: string) => allRows.find((r) => r.labelKey === labelKey)!;

  it("returns one section per ENTITLEMENT_DOMAINS entry, in domain order", () => {
    expect(sections).toHaveLength(8);
    expect(sections.map((s) => s.labelKey)).toEqual(
      ENTITLEMENT_DOMAINS.map((d) => `pricing.matrix.section.${d.slug}`),
    );
  });

  it("every row has non-empty free/pass/pro/plus cells", () => {
    for (const r of allRows) {
      expect(r.free).toBeTruthy();
      expect(r.pass).toBeTruthy();
      expect(r.pro).toBeTruthy();
      expect(r.plus).toBeTruthy();
    }
  });

  it("renders the prose quota row for competitions.max_active", () => {
    expect(row("pricing.matrix.competitions.max_active")).toMatchObject({
      free: "1",
      pass: "pricing.matrix.passedEvent",
      pro: "∞",
      plus: "∞",
    });
  });

  it("renders ∞ for unlimited ints, never the word Unlimited", () => {
    expect(row("pricing.matrix.divisions.per_competition.max")).toMatchObject({
      free: "2",
      pass: "10",
      pro: "∞",
      plus: "∞",
    });
    expect(row("pricing.matrix.entrants.per_division.max")).toMatchObject({
      free: "16",
      pass: "32",
      pro: "256",
      plus: "∞",
    });
  });

  it("renders the W1 clubs/teams caps as numbers, ∞ for unlimited (spec V291)", () => {
    expect(row("pricing.matrix.clubs.max")).toMatchObject({
      free: "2",
      pass: "2",
      pro: "20",
      plus: "∞",
    });
    expect(row("pricing.matrix.teams.max")).toMatchObject({
      free: "2",
      pass: "2",
      pro: "40",
      plus: "∞",
    });
    expect(row("pricing.matrix.teams.squad_max")).toMatchObject({
      free: "20",
      pass: "20",
      pro: "∞",
      plus: "∞",
    });
  });

  it("falls the pass column through to community when no event_pass row exists", () => {
    expect(row("pricing.matrix.schedule.checkpoints.max")).toMatchObject({
      free: "1",
      pass: "1",
      pro: "5",
      plus: "∞",
    });
    expect(row("pricing.matrix.officials.per_fixture.max")).toMatchObject({
      free: "1",
      pass: "1",
      pro: "∞",
      plus: "∞",
    });
  });

  it("folds registration.paid + fee_percent into one entry-fee cell, keyed pricing.matrix.fees", () => {
    // V310: every column charges; the ladder is what differs (8/5/2/1).
    expect(row("pricing.matrix.fees")).toMatchObject({
      free: "✓ 8%",
      pass: "✓ 5%",
      pro: "✓ 2%",
      plus: "✓ 1%",
    });
  });

  it("charges every column — no plan is barred from taking entry fees", () => {
    expect(row("pricing.matrix.fees").free).not.toBe("—");
  });

  it("never renders domains.custom or any D9 vestigial key", () => {
    const banned = [
      "domains.custom",
      "public_pages",
      "dashboard.player_profiles",
      "eligibility.enforced",
      "stats.club_championship",
    ];
    const labelKeys = allRows.map((r) => r.labelKey);
    for (const key of banned) {
      expect(labelKeys.some((lk) => lk.includes(key))).toBe(false);
    }
  });
});

// V310 (D18/D19/D20) — the packaging decision itself, asserted against the live
// matrix rather than the fixture above. A fixture can be edited to say anything;
// this is the row that has to exist for /pricing and the resolver to agree.
//
// Real Postgres required; skipped without DATABASE_URL (CI sets it).
describe.skipIf(!HAS_DB)("V310 packaging: logos + paid entry for everyone", () => {
  const load = async (key: string) => {
    const rows = await sql<{ plan_key: string; bool_value: boolean | null; int_value: number | null }[]>`
      select plan_key, bool_value, int_value from plan_entitlements where feature_key = ${key}`;
    return (plan: string) => rows.find((r) => r.plan_key === plan);
  };

  it("grants org logos (branding) on every plan, community included", async () => {
    const get = await load("branding");
    for (const plan of ["community", "event_pass", "pro", "pro_plus"]) {
      expect(get(plan)?.bool_value, plan).toBe(true);
    }
  });

  it("grants registration.paid on every plan, community included", async () => {
    const get = await load("registration.paid");
    for (const plan of ["community", "event_pass", "pro", "pro_plus"]) {
      expect(get(plan)?.bool_value, plan).toBe(true);
    }
  });

  // The community row must EXIST and be > 0. feePercentFor
  // (server/usecases/registrations.ts) falls back to platformFeeDefault() when
  // getLimit returns null OR <= 0, and that default is 5 — the same cut the
  // pass charges. Without a real row the pass would discount nothing.
  it("ladders registration.fee_percent 8/5/2/1 with an EXPLICIT community row", async () => {
    const get = await load("registration.fee_percent");
    expect(get("community"), "community needs a real row, not the 5% env fallback").toBeDefined();
    expect(get("community")?.int_value).toBe(8);
    expect(get("event_pass")?.int_value).toBe(5);
    expect(get("pro")?.int_value).toBe(2);
    expect(get("pro_plus")?.int_value).toBe(1);
    expect(get("community")!.int_value!).toBeGreaterThan(0);
  });

  // Deliberate: logos are table stakes, the org THEME COLOUR is not. This is
  // the visible Pro differentiator and the PLG badge trigger (D7).
  it("leaves dashboard.branding denied to community AND to the Event Pass", async () => {
    const get = await load("dashboard.branding");
    expect(get("community")?.bool_value).toBe(false);
    expect(get("event_pass")?.bool_value).toBe(false);
    expect(get("pro")?.bool_value).toBe(true);
    expect(get("pro_plus")?.bool_value).toBe(true);
  });

  // Consequence the guard depends on: branding and registration.paid must stop
  // being "lifted by the pass" (community now equals event_pass), while
  // fee_percent stays lifted at 8 vs 5.
  it("drops branding + registration.paid from the pass-lifted set, keeps fee_percent", async () => {
    const lifted = await sql<{ feature_key: string }[]>`
      select ep.feature_key
      from plan_entitlements ep
      left join plan_entitlements c
        on c.plan_key = 'community' and c.feature_key = ep.feature_key
      where ep.plan_key = 'event_pass'
        and (ep.bool_value is distinct from c.bool_value
             or ep.int_value is distinct from c.int_value)`;
    const keys = lifted.map((r) => r.feature_key);
    expect(keys).not.toContain("branding");
    expect(keys).not.toContain("registration.paid");
    expect(keys).toContain("registration.fee_percent");
  });
});
