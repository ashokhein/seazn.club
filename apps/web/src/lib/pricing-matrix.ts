// Pricing comparison rows rendered FROM plan_entitlements (v3/07 §5) — the
// marketing table can't drift from what the resolver actually enforces.
// Pure: the page queries the three plan columns and pivots them through here.

export interface MatrixCell {
  bool_value: boolean | null;
  int_value: number | null;
}

/** feature_key → plan_key → cell, straight from plan_entitlements. */
export type MatrixData = Record<string, Record<string, MatrixCell>>;

export interface PricingRow {
  label: string;
  free: string;
  pass: string;
  pro: string;
}

const CHECK = "✓";
const DASH = "—";

function intCell(cell: MatrixCell | undefined): string {
  if (!cell) return DASH;
  return cell.int_value === null ? "Unlimited" : String(cell.int_value);
}

function boolCell(cell: MatrixCell | undefined): string {
  return cell?.bool_value === true ? CHECK : DASH;
}

/**
 * A pass column key missing from the event_pass matrix falls through to the
 * community plan at resolution time — mirror that here so the table tells
 * the truth about what a passed competition actually gets.
 */
function passCell(
  data: MatrixData,
  feature: string,
  fmt: (cell: MatrixCell | undefined) => string,
): string {
  const cell = data[feature]?.event_pass ?? data[feature]?.community;
  return fmt(cell);
}

interface RowSpec {
  feature: string;
  label: string;
  fmt: (cell: MatrixCell | undefined) => string;
}

// Order = the story: scale first, money features, brand, Pro-only depth.
const ROWS: RowSpec[] = [
  { feature: "divisions.per_competition.max", label: "Divisions per competition", fmt: intCell },
  { feature: "entrants.per_division.max", label: "Entrants per division", fmt: intCell },
  { feature: "members.max", label: "Team members", fmt: intCell },
  { feature: "registration.enabled", label: "Online registration", fmt: boolCell },
  { feature: "formats.advanced", label: "Advanced formats — double elim, ladders, americano", fmt: boolCell },
  { feature: "branding", label: "Custom branding", fmt: boolCell },
  { feature: "exports", label: "PDF / XLSX exports & print packs", fmt: boolCell },
  { feature: "realtime", label: "Realtime scoreboard & slideshow", fmt: boolCell },
  { feature: "dashboard.branding", label: "Remove the “Powered by Seazn” badge", fmt: boolCell },
  { feature: "stats.player", label: "Player stats & MOTM", fmt: boolCell },
  { feature: "officials.assignment", label: "Officials & referee assignment", fmt: boolCell },
  { feature: "scheduling.constraints", label: "Scheduling constraints", fmt: boolCell },
  { feature: "api.access", label: "API keys & integrations", fmt: boolCell },
];

export function buildPricingRows(data: MatrixData): PricingRow[] {
  const rows: PricingRow[] = [
    // Quota semantics differ per offer: free counts active comps, a pass IS
    // one competition, Pro has no cap — prose beats a bare number here.
    {
      label: "Active competitions",
      free: intCell(data["competitions.max_active"]?.community),
      pass: "The passed event",
      pro:
        data["competitions.max_active"]?.pro?.int_value === null
          ? "Unlimited"
          : intCell(data["competitions.max_active"]?.pro),
    },
    ...ROWS.map((spec) => ({
      label: spec.label,
      free: spec.fmt(data[spec.feature]?.community),
      pass: passCell(data, spec.feature, spec.fmt),
      pro: spec.fmt(data[spec.feature]?.pro),
    })),
  ];

  // Entry fees fold two keys into one honest cell: enabled + platform cut.
  const paid = data["registration.paid"];
  const pct = data["registration.fee_percent"];
  const feeCell = (plan: "community" | "event_pass" | "pro"): string => {
    const enabled =
      plan === "event_pass"
        ? (paid?.event_pass ?? paid?.community)?.bool_value === true
        : paid?.[plan]?.bool_value === true;
    if (!enabled) return DASH;
    const cut =
      plan === "event_pass" ? (pct?.event_pass ?? pct?.community) : pct?.[plan];
    return cut?.int_value != null ? `${CHECK} ${cut.int_value}% fee` : CHECK;
  };
  rows.splice(4, 0, {
    label: "Entry fees paid out to your club",
    free: feeCell("community"),
    pass: feeCell("event_pass"),
    pro: feeCell("pro"),
  });

  return rows;
}
