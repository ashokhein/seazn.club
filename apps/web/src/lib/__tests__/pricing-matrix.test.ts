// The pricing table renders from plan_entitlements (spec 2026-07-18
// pro-plus-tier §5) — these pin the pivot: ints/∞, bool ticks, pass-column
// fallback to community (the resolver's fall-through), and the folded
// entry-fee cell, across all four plans + eight ENTITLEMENT_DOMAINS.
import { describe, expect, it } from "vitest";
import { buildPricingSections, type MatrixData } from "@/lib/pricing-matrix";
import { ENTITLEMENT_DOMAINS } from "@/lib/entitlement-domains";

const cell = (int: number | null = null, bool: boolean | null = null) => ({
  int_value: int,
  bool_value: bool,
});

// Mirrors the real V286 local-DB values for the rows under test.
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
    // resolver does (db/migration/deltas/V286 comment).
    community: cell(1),
    pro: cell(5),
    pro_plus: cell(null),
  },
  "officials.per_fixture.max": {
    community: cell(1),
    pro: cell(null),
    pro_plus: cell(null),
  },
  "registration.paid": {
    community: cell(null, false),
    event_pass: cell(null, true),
    pro: cell(null, true),
    pro_plus: cell(null, true),
  },
  "registration.fee_percent": {
    event_pass: cell(5),
    pro: cell(2),
    pro_plus: cell(1),
  },
  "stats.player": {
    community: cell(null, false),
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
    expect(row("pricing.matrix.fees")).toMatchObject({
      free: "—",
      pass: "✓ 5%",
      pro: "✓ 2%",
      plus: "✓ 1%",
    });
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
