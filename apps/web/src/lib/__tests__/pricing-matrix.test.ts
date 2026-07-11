// The pricing table renders from plan_entitlements (v3/07 §5) — these pin the
// pivot: ints/unlimited, bool ticks, pass-column fallback to community (the
// resolver's fall-through), and the folded entry-fee cell.
import { describe, expect, it } from "vitest";
import { buildPricingRows, type MatrixData } from "@/lib/pricing-matrix";

const cell = (int: number | null = null, bool: boolean | null = null) => ({
  int_value: int,
  bool_value: bool,
});

const DATA: MatrixData = {
  "competitions.max_active": { community: cell(1), pro: cell(null) },
  "divisions.per_competition.max": {
    community: cell(2),
    event_pass: cell(10),
    pro: cell(null),
  },
  "entrants.per_division.max": {
    community: cell(16),
    event_pass: cell(32),
    pro: cell(256),
  },
  "registration.paid": {
    community: cell(null, false),
    event_pass: cell(null, true),
    pro: cell(null, true),
  },
  "registration.fee_percent": { event_pass: cell(5), pro: cell(2) },
  // stats.player has NO event_pass row — the pass column must fall back to
  // community's deny, exactly like the resolver does.
  "stats.player": { community: cell(null, false), pro: cell(null, true) },
};

describe("buildPricingRows (v3/07 §5)", () => {
  const rows = buildPricingRows(DATA);
  const row = (label: string) => rows.find((r) => r.label.includes(label))!;

  it("renders ints, Unlimited for null, and the pass quota story", () => {
    expect(row("Active competitions")).toMatchObject({
      free: "1",
      pass: "The passed event",
      pro: "Unlimited",
    });
    expect(row("Divisions per competition")).toMatchObject({
      free: "2",
      pass: "10",
      pro: "Unlimited",
    });
    expect(row("Entrants per division")).toMatchObject({ free: "16", pass: "32", pro: "256" });
  });

  it("pass column falls back to community when the pass matrix has no row", () => {
    expect(row("Player stats").pass).toBe("—");
    expect(row("Player stats").pro).toBe("✓");
  });

  it("folds registration.paid + fee_percent into one entry-fee cell", () => {
    expect(row("Entry fees")).toMatchObject({
      free: "—",
      pass: "✓ 5% fee",
      pro: "✓ 2% fee",
    });
  });
});
