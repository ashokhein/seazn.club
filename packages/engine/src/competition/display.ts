// Standings display helpers — doc 09 §2 (PROMPT-12). The public dashboard
// renders sport-correct tables with ZERO per-sport UI code: columns come from
// the module's MetricSpec[] plus the cascade-derived metrics below, and the
// formulas for derived values live HERE (engine-owned), never in the web app.
//
// Derived metrics are ranking concepts, not ledger fields: NRR and the ratio
// metrics are recomputed for display from the integer ledger in a row (the
// cascade compares them by cross-multiplication and never stores a float);
// the Swiss metrics (buchholz/buchholz_cut1/sberger) are materialised into
// row.metrics by rankStandings because they need the assembled ledger.
import type { TiebreakerKey } from "../sport/module.ts";
import type { StandingsRow } from "./standings.ts";

export interface DerivedMetricSpec {
  key: TiebreakerKey;
  label: string;
  decimals: number;
}

// Cascade keys that earn a standings column when the division's cascade uses
// them (doc 09 §2: cricket → NRR; volleyball → set/point ratio; chess →
// Buchholz Cut-1, SB). Declaration order = column order.
export const DERIVED_METRICS: readonly DerivedMetricSpec[] = [
  { key: "nrr", label: "NRR", decimals: 3 },
  { key: "set_ratio", label: "Ratio", decimals: 2 },
  { key: "point_ratio", label: "Pts ratio", decimals: 2 },
  { key: "buchholz_cut1", label: "Buchholz Cut-1", decimals: 1 },
  { key: "buchholz", label: "Buchholz", decimals: 1 },
  { key: "sberger", label: "SB", decimals: 2 },
];

function metric(row: StandingsRow, key: string): number {
  return row.metrics[key] ?? 0;
}

function ratioText(won: number, lost: number, decimals: number): string {
  if (lost === 0) return won > 0 ? "∞" : "—";
  return (won / lost).toFixed(decimals);
}

/**
 * Display text for a derived metric on one row, or null when the row cannot
 * produce it (no ledger yet). NRR is signed per convention (+0.412).
 */
export function derivedMetricText(row: StandingsRow, key: TiebreakerKey): string | null {
  switch (key) {
    case "nrr": {
      const bf = metric(row, "balls_faced_eff");
      const bb = metric(row, "balls_bowled_eff");
      if (bf === 0 || bb === 0) return "—";
      const nrr = (6 * metric(row, "runs_for")) / bf - (6 * metric(row, "runs_against")) / bb;
      const text = nrr.toFixed(3);
      return nrr > 0 ? `+${text}` : text;
    }
    case "set_ratio":
      return ratioText(metric(row, "sets_won"), metric(row, "sets_lost"), 2);
    case "point_ratio":
      return ratioText(metric(row, "points_won"), metric(row, "points_lost"), 2);
    case "buchholz":
    case "buchholz_cut1": {
      const value = row.metrics[key];
      return value === undefined ? null : formatHalfSteps(value);
    }
    case "sberger": {
      const value = row.metrics[key];
      return value === undefined ? null : value.toFixed(2).replace(/\.?0+$/, "") || "0";
    }
    default:
      return null;
  }
}

// Chess-style points render in halves ("3½") — reuse for buchholz columns.
function formatHalfSteps(points: number): string {
  const whole = Math.trunc(points);
  const hasHalf = Math.abs(points - whole) >= 0.25;
  if (whole === 0) return hasHalf ? "½" : "0";
  return hasHalf ? `${whole}½` : `${whole}`;
}

// Human phrasing for the tie-break trace keys (doc 09 §2 popover: "ahead on
// head-to-head"). Keys not listed fall back to the raw key.
const TIE_BREAK_LABELS: Record<string, string> = {
  points: "points",
  wins: "wins",
  diff: "goal/run difference",
  for: "goals/runs scored",
  fair_play: "fair play",
  nrr: "net run rate",
  set_ratio: "set ratio",
  point_ratio: "point ratio",
  h2h_points: "head-to-head",
  h2h_diff: "head-to-head difference",
  h2h_for: "head-to-head scoring",
  direct: "direct encounter",
  buchholz: "Buchholz",
  buchholz_cut1: "Buchholz Cut-1",
  sberger: "Sonneborn–Berger",
  seed: "seeding",
  lots: "drawing of lots",
};

export function tieBreakLabel(key: string): string {
  return TIE_BREAK_LABELS[key] ?? key;
}
