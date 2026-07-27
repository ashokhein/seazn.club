// The pricing table renders from plan_entitlements (spec 2026-07-18
// pro-plus-tier §5) — these pin the pivot: ints/∞, bool ticks, pass-column
// fallback to community (the resolver's fall-through), and the folded
// entry-fee cell, across all FIVE plan columns + eight ENTITLEMENT_DOMAINS.
// v17 #294 added the fifth: `event_pass_l`, the L rung, which falls through to
// community exactly like M does when it has no row of its own.
import { afterAll, describe, expect, it } from "vitest";
import {
  buildPricingSections,
  PRICING_PLAN_KEYS,
  PRICING_COLUMN_LABEL_KEY,
  type MatrixData,
} from "@/lib/pricing-matrix";
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
    // V341: L lifts the division headroom to 20 — one of only TWO keys where
    // L differs from M.
    event_pass_l: cell(20),
    pro: cell(null),
    pro_plus: cell(null),
  },
  "entrants.per_division.max": {
    // V319: 64 / 128 / 256 / ∞.
    community: cell(64),
    event_pass: cell(128),
    // V341: L's int_value is NULL — unlimited, the second and last key where
    // the rungs differ. This ∞ is the whole reason the table needed a fifth
    // column: an L buyer reading M's "128" is told the cap they paid to remove.
    event_pass_l: cell(null),
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
    event_pass_l: cell(null, true),
    pro: cell(null, true),
    pro_plus: cell(null, true),
  },
  "officials.auto": {
    community: cell(null, false),
    event_pass: cell(null, false),
    event_pass_l: cell(null, false),
    pro: cell(null, true),
    pro_plus: cell(null, true),
  },
  "officials.marks": {
    community: cell(null, true),
    event_pass: cell(null, true),
    event_pass_l: cell(null, true),
    pro: cell(null, true),
    pro_plus: cell(null, true),
  },
  // V310 (D18/D19/D20): charging entry fees is free for everyone; the pass and
  // the paid plans buy a CHEAPER cut, not the ability itself.
  "registration.paid": {
    community: cell(null, true),
    event_pass: cell(null, true),
    event_pass_l: cell(null, true),
    pro: cell(null, true),
    pro_plus: cell(null, true),
  },
  "registration.fee_percent": {
    community: cell(8),
    event_pass: cell(5),
    // Flat across rungs by decision (#294): L buys size, not a cheaper cut.
    event_pass_l: cell(5),
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
    event_pass_l: cell(null, true),
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
    event_pass_l: cell(20, true),
    pro: cell(null, true),
    pro_plus: cell(null, true),
  },
};

// Keys with NO event_pass_l row in the fixture above — schedule.checkpoints.max,
// clubs.max, teams.max, competitions.max_active, stats.player — are deliberate:
// they exercise L's fall-through to community, the same resolver behaviour the
// M column has always had. A fifth column that silently rendered "—" for every
// key L has no row of its own would make L look WORSE than M.

describe("buildPricingSections (spec 2026-07-18 pro-plus-tier §5)", () => {
  const sections = buildPricingSections(DATA);
  const allRows = sections.flatMap((s) => s.rows);
  const row = (labelKey: string) => allRows.find((r) => r.labelKey === labelKey)!;
  const cells = (labelKey: string) => row(labelKey).cells;

  it("returns one section per ENTITLEMENT_DOMAINS entry, in domain order", () => {
    expect(sections).toHaveLength(8);
    expect(sections.map((s) => s.labelKey)).toEqual(
      ENTITLEMENT_DOMAINS.map((d) => `pricing.matrix.section.${d.slug}`),
    );
  });

  // The anti-gap guard. The bug this whole task exists to close was a table
  // whose shape allowed exactly ONE pass column, so a second rung had nowhere
  // to render and quietly inherited the first one's numbers. `cells` is keyed
  // by PRICING_PLAN_KEYS, so a plan added to that tuple without a value here
  // fails LOUDLY — naming the row and the plan — instead of vanishing.
  it("gives every row a non-empty cell for every PRICING_PLAN_KEYS column", () => {
    for (const r of allRows) {
      for (const plan of PRICING_PLAN_KEYS) {
        expect(r.cells[plan], `${r.labelKey} / ${plan}`).toBeTruthy();
      }
      expect(Object.keys(r.cells).sort().join(","), r.labelKey).toBe(
        [...PRICING_PLAN_KEYS].sort().join(","),
      );
    }
  });

  // Every column needs a heading, and each must be its own — two plans sharing
  // a label is how a reader ends up comparing "Event Pass" against
  // "Event Pass" and concluding the rungs are the same product.
  it("names a distinct heading key for every column", () => {
    const labels = PRICING_PLAN_KEYS.map((p) => PRICING_COLUMN_LABEL_KEY[p]);
    expect(labels.filter(Boolean)).toHaveLength(PRICING_PLAN_KEYS.length);
    expect(new Set(labels).size).toBe(PRICING_PLAN_KEYS.length);
  });

  it("renders the prose quota row for competitions.max_active", () => {
    // V319: community free tier now runs big — 10 active competitions. BOTH
    // rungs read the prose cell: a pass IS one competition, at either size.
    expect(cells("pricing.matrix.competitions.max_active")).toMatchObject({
      community: "10",
      event_pass: "pricing.matrix.passedEvent",
      event_pass_l: "pricing.matrix.passedEvent",
      pro: "∞",
      pro_plus: "∞",
    });
  });

  it("renders ∞ for unlimited ints, never the word Unlimited", () => {
    // V319 community caps: 4 divisions, 64 entrants. V341: L is the only pass
    // column that reaches 20 / ∞ — the two figures the $59 actually buys.
    expect(cells("pricing.matrix.divisions.per_competition.max")).toMatchObject({
      community: "4",
      event_pass: "10",
      event_pass_l: "20",
      pro: "∞",
      pro_plus: "∞",
    });
    expect(cells("pricing.matrix.entrants.per_division.max")).toMatchObject({
      community: "64",
      event_pass: "128",
      event_pass_l: "∞",
      pro: "256",
      pro_plus: "∞",
    });
  });

  it("renders the W1 clubs/teams caps as numbers, ∞ for unlimited (V319 caps)", () => {
    // V319: community clubs 2 → 5, teams 2 → 8; no event_pass row, so BOTH
    // pass columns fall through to community.
    expect(cells("pricing.matrix.clubs.max")).toMatchObject({
      community: "5",
      event_pass: "5",
      event_pass_l: "5",
      pro: "20",
      pro_plus: "∞",
    });
    expect(cells("pricing.matrix.teams.max")).toMatchObject({
      community: "8",
      event_pass: "8",
      event_pass_l: "8",
      pro: "40",
      pro_plus: "∞",
    });
    expect(cells("pricing.matrix.teams.squad_max")).toMatchObject({
      community: "20",
      event_pass: "20",
      event_pass_l: "20",
      pro: "∞",
      pro_plus: "∞",
    });
  });

  it("falls BOTH pass columns through to community when neither rung has a row", () => {
    expect(cells("pricing.matrix.schedule.checkpoints.max")).toMatchObject({
      community: "2",
      event_pass: "2",
      event_pass_l: "2",
      pro: "5",
      pro_plus: "∞",
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
    const tick = { community: "✓", event_pass: "✓", event_pass_l: "✓", pro: "✓", pro_plus: "✓" };
    expect(cells("pricing.matrix.officials.roles_multi")).toMatchObject(tick);
    expect(cells("pricing.matrix.officials.marks")).toMatchObject(tick);
    // The AI-officials path is still gated — the honest differentiator. Neither
    // rung buys it: L is a bigger event, not a cheaper Pro.
    expect(cells("pricing.matrix.officials.auto")).toMatchObject({
      community: "—",
      event_pass: "—",
      event_pass_l: "—",
      pro: "✓",
      pro_plus: "✓",
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
    // #294: the fee is FLAT across rungs — L buys size, not a cheaper cut.
    // A 5% cell on the L column is the assertion that keeps the ladder honest.
    expect(cells("pricing.matrix.fees")).toMatchObject({
      community: "✓ 8%",
      event_pass: "✓ 5%",
      event_pass_l: "✓ 5%",
      pro: "✓ 2%",
      pro_plus: "✓ 1%",
    });
  });

  it("charges every column — no plan is barred from taking entry fees", () => {
    for (const plan of PRICING_PLAN_KEYS) {
      expect(cells("pricing.matrix.fees")[plan], plan).not.toBe("—");
    }
  });

  // dashboard.player_profiles is a row the Event Pass lifts that /pricing used
  // to omit entirely (classed as vestigial — see the banned-list test below);
  // it is a live gate, so the matrix has to price it. The AI run cap row that
  // used to sit alongside it was retired in v17 Phase 2 Task 5 (V322): the
  // credit wallet meters spend now, not a plan-graded per-division count.
  it("renders public player profiles with the pass lifting them (V307/V308)", () => {
    expect(cells("pricing.matrix.dashboard.player_profiles")).toMatchObject({
      community: "—",
      event_pass: "✓",
      event_pass_l: "✓",
      pro: "✓",
      pro_plus: "✓",
    });
    // …while the stats behind them stay Pro: the pass columns differ between
    // the two adjacent scoring rows, and that is the honest story. stats.player
    // has no row for EITHER rung, so both fall through to community's false.
    expect(cells("pricing.matrix.stats.player")).toMatchObject({
      community: "—",
      event_pass: "—",
      event_pass_l: "—",
    });
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

// V341 (v17 #294) — the L rung, rendered. The fixture above proves the pivot
// handles a fifth column; this proves /pricing's actual query and the LIVE
// matrix produce the column a buyer sees. Built by replaying the exact read
// `pricing/page.tsx` performs, so a plan key dropped from PRICING_PLAN_KEYS
// takes this test down with the page.
//
// Real Postgres required; skipped without DATABASE_URL (CI sets it).
describe.skipIf(!HAS_DB)("V341 L rung: /pricing renders a fifth column from live rows", () => {
  const liveRows = async () => {
    const rows = await sql<
      { plan_key: string; feature_key: string; bool_value: boolean | null; int_value: number | null }[]
    >`
      select plan_key, feature_key, bool_value, int_value
      from plan_entitlements where plan_key = any(${[...PRICING_PLAN_KEYS]})`;
    const data: MatrixData = {};
    for (const r of rows) {
      (data[r.feature_key] ??= {})[r.plan_key] = {
        bool_value: r.bool_value,
        int_value: r.int_value,
      };
    }
    return buildPricingSections(data).flatMap((s) => s.rows);
  };

  it("selects the L rung at all — the column cannot render without the row", () => {
    expect([...PRICING_PLAN_KEYS]).toContain("event_pass_l");
  });

  it("quotes L's own caps: 20 divisions and unlimited entrants", async () => {
    const rows = await liveRows();
    const cells = (k: string) => rows.find((r) => r.labelKey === k)!.cells;
    expect(cells("pricing.matrix.divisions.per_competition.max").event_pass_l).toBe("20");
    expect(cells("pricing.matrix.entrants.per_division.max").event_pass_l).toBe("∞");
    // …and M keeps its own, so the two columns are genuinely different offers.
    expect(cells("pricing.matrix.divisions.per_competition.max").event_pass).toBe("10");
    expect(cells("pricing.matrix.entrants.per_division.max").event_pass).toBe("128");
  });

  // The two failure modes this table can have, caught by one comparison:
  //   • L column falls back to M (the pre-#294 shape) -> the list comes back
  //     EMPTY and the assertion prints the two keys it expected;
  //   • L column falls through to COMMUNITY on keys M lifts -> extra rows join
  //     the list and it prints exactly which ones.
  // Compared as a joined STRING because the JSON reporter elides array
  // elements and would name neither side.
  it("differs from M on exactly the two keys V341 overrides, and nowhere else", async () => {
    const rows = await liveRows();
    const differing = rows
      .filter((r) => r.cells.event_pass !== r.cells.event_pass_l)
      .map((r) => r.labelKey)
      .sort()
      .join(", ");
    expect(differing).toBe(
      "pricing.matrix.divisions.per_competition.max, pricing.matrix.entrants.per_division.max",
    );
  });
});
