// Standings display helpers — doc 09 §2 (PROMPT-12).
import { describe, expect, it } from "vitest";
import type { StandingsRow } from "./standings.ts";
import { derivedMetricText, tieBreakLabel, DERIVED_METRICS } from "./display.ts";

function row(metrics: Record<string, number>): StandingsRow {
  return { entrantId: "X", played: 0, won: 0, drawn: 0, lost: 0, points: 0, metrics };
}

describe("derivedMetricText (doc 09 §2)", () => {
  it("NRR from the integer ledger, signed, 3 decimals", () => {
    // 250 runs off 300 balls (5.0/over) vs 200 off 300 (4.0/over) ⇒ +1.000
    const r = row({
      runs_for: 250,
      balls_faced_eff: 300,
      runs_against: 200,
      balls_bowled_eff: 300,
    });
    expect(derivedMetricText(r, "nrr")).toBe("+1.000");
  });

  it("NRR before any play is a dash, negative NRR unsigned-minus", () => {
    expect(derivedMetricText(row({}), "nrr")).toBe("—");
    const losing = row({
      runs_for: 200,
      balls_faced_eff: 300,
      runs_against: 250,
      balls_bowled_eff: 300,
    });
    expect(derivedMetricText(losing, "nrr")).toBe("-1.000");
  });

  it("set ratio: finite, unbeaten (∞) and no-data (—)", () => {
    expect(derivedMetricText(row({ sets_won: 6, sets_lost: 4 }), "set_ratio")).toBe("1.50");
    expect(derivedMetricText(row({ sets_won: 6, sets_lost: 0 }), "set_ratio")).toBe("∞");
    expect(derivedMetricText(row({}), "set_ratio")).toBe("—");
  });

  it("buchholz columns render half-steps from materialised metrics", () => {
    expect(derivedMetricText(row({ buchholz_cut1: 7.5 }), "buchholz_cut1")).toBe("7½");
    expect(derivedMetricText(row({ buchholz_cut1: 7 }), "buchholz_cut1")).toBe("7");
    expect(derivedMetricText(row({}), "buchholz_cut1")).toBeNull();
  });

  it("sberger trims trailing zeros", () => {
    expect(derivedMetricText(row({ sberger: 12.25 }), "sberger")).toBe("12.25");
    expect(derivedMetricText(row({ sberger: 12 }), "sberger")).toBe("12");
  });
});

describe("tieBreakLabel", () => {
  it("maps known keys to human phrasing and falls back to the raw key", () => {
    expect(tieBreakLabel("h2h_points")).toBe("head-to-head");
    expect(tieBreakLabel("lots")).toBe("drawing of lots");
    expect(tieBreakLabel("mystery")).toBe("mystery");
  });
});

describe("DERIVED_METRICS", () => {
  it("covers every cascade key the dashboard can render as a column", () => {
    expect(DERIVED_METRICS.map((m) => m.key)).toEqual([
      "nrr",
      "set_ratio",
      "board_ratio",
      "point_ratio",
      "buchholz_cut1",
      "buchholz",
      "sberger",
    ]);
  });
});
