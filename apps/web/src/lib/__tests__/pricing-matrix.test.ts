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

// Mirrors the real local-DB values for the rows under test (V290 + V310 + V319).
const DATA: MatrixData = {
  "competitions.max_active": {
    // V319: community 5 → 10. Still no event_pass row — a passed competition
    // leaves the active count instead of raising the org-wide cap.
    community: cell(10),
    pro: cell(null),
    pro_plus: cell(null),
  },
  "divisions.per_competition.max": {
    // V319: community 2 → 4. event_pass 10 already > 4.
    community: cell(4),
    event_pass: cell(10),
    pro: cell(null),
    pro_plus: cell(null),
  },
  "entrants.per_division.max": {
    // V319: 64 / 128 / 256 / ∞.
    community: cell(64),
    event_pass: cell(128),
    pro: cell(256),
    pro_plus: cell(null),
  },
  "schedule.checkpoints.max": {
    // No event_pass row — pass falls through to community, exactly like the
    // resolver does (db/migration/deltas/V290 comment).
    community: cell(2),
    pro: cell(5),
    pro_plus: cell(null),
  },
  // V319 ungate (#253): officials are included on every plan — roles_multi and
  // marks are ticks across all four, so no officials row is a paywall. Only
  // officials.auto (AI officials) stays a Pro/Pro-Plus differentiator.
  // officials.per_fixture.max is deliberately NOT rendered (∞ everywhere).
  "officials.roles_multi": {
    community: cell(null, true),
    event_pass: cell(null, true),
    pro: cell(null, true),
    pro_plus: cell(null, true),
  },
  "officials.auto": {
    community: cell(null, false),
    event_pass: cell(null, false),
    pro: cell(null, true),
    pro_plus: cell(null, true),
  },
  "officials.marks": {
    community: cell(null, true),
    event_pass: cell(null, true),
    pro: cell(null, true),
    pro_plus: cell(null, true),
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
  // Real V307/V308 values. The pass lifts the public player card even though
  // it does NOT lift stats.player — the two sit side by side in the scoring
  // domain and the pass column deliberately reads ✓ / — across them.
  "dashboard.player_profiles": {
    community: cell(null, false),
    event_pass: cell(null, true),
    pro: cell(null, true),
    pro_plus: cell(null, true),
  },
  // scheduling.ai.runs_per_division.max retired (v17 Phase 2 Task 5, V322) —
  // no rows left, no fixture entry needed.
  // W1 Task 11: clubs & teams register caps render as numbers, ∞ for
  // unlimited — never a bare ✓/— tick. V319 raised the community caps
  // (clubs 2 → 5, teams 2 → 8) and dropped the event_pass rows, so the pass
  // column now falls through to community (5 / 8), exactly like the DB.
  "clubs.max": {
    community: cell(5),
    pro: cell(20, true),
    pro_plus: cell(null, true),
  },
  "teams.max": {
    community: cell(8),
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
    // V319: community free tier now runs big — 10 active competitions.
    expect(row("pricing.matrix.competitions.max_active")).toMatchObject({
      free: "10",
      pass: "pricing.matrix.passedEvent",
      pro: "∞",
      plus: "∞",
    });
  });

  it("renders ∞ for unlimited ints, never the word Unlimited", () => {
    // V319 community caps: 4 divisions, 64 entrants.
    expect(row("pricing.matrix.divisions.per_competition.max")).toMatchObject({
      free: "4",
      pass: "10",
      pro: "∞",
      plus: "∞",
    });
    expect(row("pricing.matrix.entrants.per_division.max")).toMatchObject({
      free: "64",
      pass: "128",
      pro: "256",
      plus: "∞",
    });
  });

  it("renders the W1 clubs/teams caps as numbers, ∞ for unlimited (V319 caps)", () => {
    // V319: community clubs 2 → 5, teams 2 → 8; no event_pass row, so the pass
    // column falls through to community.
    expect(row("pricing.matrix.clubs.max")).toMatchObject({
      free: "5",
      pass: "5",
      pro: "20",
      plus: "∞",
    });
    expect(row("pricing.matrix.teams.max")).toMatchObject({
      free: "8",
      pass: "8",
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
      free: "2",
      pass: "2",
      pro: "5",
      plus: "∞",
    });
  });

  // #244: scorers retired from ALL marketing/comparison copy. The DB key and
  // role code stay, but no scorer row may appear anywhere in the pricing table.
  it("renders no scorer row anywhere (retired from marketing, #244)", () => {
    const haystack = JSON.stringify(sections).toLowerCase();
    expect(haystack).not.toContain("scorer");
  });

  // V319 ungate (#253): officials are included on every plan. The comparison
  // must not read as a paywall — roles_multi and marks tick across all four
  // columns; only officials.auto (AI officials) is a Pro/Pro-Plus differentiator.
  it("shows officials as included on every plan, not a paywalled row", () => {
    expect(row("pricing.matrix.officials.roles_multi")).toMatchObject({
      free: "✓",
      pass: "✓",
      pro: "✓",
      plus: "✓",
    });
    expect(row("pricing.matrix.officials.marks")).toMatchObject({
      free: "✓",
      pass: "✓",
      pro: "✓",
      plus: "✓",
    });
    // The AI-officials path is still gated — the honest differentiator.
    expect(row("pricing.matrix.officials.auto")).toMatchObject({
      free: "—",
      pass: "—",
      pro: "✓",
      plus: "✓",
    });
  });

  // The all-∞ trap: officials.per_fixture.max is ∞ on every plan after V319, so
  // it must not be rendered — a mystery ∞/∞/∞/∞ row tells no story.
  it("does not render the undifferentiated officials.per_fixture.max row", () => {
    const labelKeys = allRows.map((r) => r.labelKey);
    expect(labelKeys).not.toContain("pricing.matrix.officials.per_fixture.max");
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

  // dashboard.player_profiles is a row the Event Pass lifts that /pricing used
  // to omit entirely (classed as vestigial — see the banned-list test below);
  // it is a live gate, so the matrix has to price it. The AI run cap row that
  // used to sit alongside it was retired in v17 Phase 2 Task 5 (V322): the
  // credit wallet meters spend now, not a plan-graded per-division count.
  it("renders public player profiles with the pass lifting them (V307/V308)", () => {
    expect(row("pricing.matrix.dashboard.player_profiles")).toMatchObject({
      free: "—",
      pass: "✓",
      pro: "✓",
      plus: "✓",
    });
    // …while the stats behind them stay Pro: the pass column differs between
    // the two adjacent scoring rows, and that is the honest story.
    expect(row("pricing.matrix.stats.player")).toMatchObject({ free: "—", pass: "—" });
  });

  it("never renders domains.custom or any D9 vestigial key", () => {
    // `dashboard.player_profiles` was on this list and is NOT any more. It is
    // not vestigial: server/public-site/data.ts gates the public player card on
    // it, and V308 grants it to the Event Pass — so hiding it from /pricing hid
    // a thing customers pay $29 for. The rest below really are dead keys.
    const banned = [
      "domains.custom",
      "public_pages",
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

// V319 (v17 Phase 1) — the free tier "runs big". Community rises to 64 entrants
// and 10 competitions (from V311's 32 / 5), and the pass rises above it to 128.
// These assert the intent against the live matrix, because a fixture can be
// edited to say anything and the resolver reads the table.
//
// Real Postgres required; skipped without DATABASE_URL (CI sets it).
describe.skipIf(!HAS_DB)("V319 scale caps: community 64 entrants, 10 competitions", () => {
  const load = async (key: string) => {
    const rows = await sql<{ plan_key: string; bool_value: boolean | null; int_value: number | null }[]>`
      select plan_key, bool_value, int_value from plan_entitlements where feature_key = ${key}`;
    return (plan: string) => rows.find((r) => r.plan_key === plan);
  };

  it("ladders entrants.per_division.max 64 / 128 / 256 / ∞", async () => {
    const get = await load("entrants.per_division.max");
    expect(get("community")?.int_value).toBe(64);
    // The pass MUST rise above community. With community at 64 a pass stuck on
    // 64 would lift nothing — the key would drop out of the pass-lifted set and
    // the $29 purchase would buy no extra entrants at all.
    expect(get("event_pass")?.int_value).toBe(128);
    expect(get("pro")?.int_value).toBe(256);
    expect(get("pro_plus"), "pro_plus must keep a row").toBeDefined();
    expect(get("pro_plus")?.int_value, "null int_value is unlimited").toBeNull();
  });

  it("keeps entrants.per_division.max in the pass-lifted set (64 vs 128)", async () => {
    const get = await load("entrants.per_division.max");
    expect(get("event_pass")?.int_value).not.toBe(get("community")?.int_value);
  });

  it("raises community competitions.max_active to 10, pro/pro_plus stay unlimited", async () => {
    const get = await load("competitions.max_active");
    expect(get("community")?.int_value).toBe(10);
    expect(get("pro"), "pro must keep a row").toBeDefined();
    expect(get("pro")?.int_value).toBeNull();
    expect(get("pro_plus"), "pro_plus must keep a row").toBeDefined();
    expect(get("pro_plus")?.int_value).toBeNull();
  });

  it("raises community divisions.per_competition.max to 4", async () => {
    const get = await load("divisions.per_competition.max");
    expect(get("community")?.int_value).toBe(4);
  });

  // Deliberate absence, not an oversight. A passed competition is already
  // excluded from the active count (server/usecases/competitions.ts) — that is
  // the mechanism. An event_pass row here would additionally raise the ORG-WIDE
  // cap for any org holding one pass, which is not what the pass sells.
  it("adds no event_pass row for competitions.max_active", async () => {
    const get = await load("competitions.max_active");
    expect(get("event_pass")).toBeUndefined();
  });
});
