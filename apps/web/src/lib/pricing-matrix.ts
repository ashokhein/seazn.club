// Pricing comparison rows rendered FROM plan_entitlements (spec 2026-07-18
// pro-plus-tier §5) — the marketing table can't drift from what the resolver
// actually enforces. Pure: the page queries the four plan columns and pivots
// them through here, grouped by ENTITLEMENT_DOMAINS so /pricing and
// /admin/entitlements tell the same story.
import { ENTITLEMENT_DOMAINS } from "@/lib/entitlement-domains";

export interface MatrixCell {
  bool_value: boolean | null;
  int_value: number | null;
}

/** feature_key → plan_key → cell, straight from plan_entitlements. */
export type MatrixData = Record<string, Record<string, MatrixCell>>;

export interface PricingRow {
  labelKey: string;
  /** Optional second line under the label, always a dict KEY. Used where a
   *  bare number would mislead — the orgs row is a price, not an allowance
   *  (billing-groups spec 2026-07-21 §Surfaces to update). */
  noteKey?: string;
  free: string;
  pass: string;
  pro: string;
  plus: string;
}

export interface PricingSection {
  labelKey: string;
  rows: PricingRow[];
}

const CHECK = "✓";
const DASH = "—";
// Locale-free: rendered as-is, never translated to the English word
// "Unlimited" (approved UI-copy decision 2026-07-18).
const INF = "∞";

function intCell(cell: MatrixCell | undefined): string {
  if (!cell) return DASH;
  return cell.int_value === null ? INF : String(cell.int_value);
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

// Quota-style features render a count (∞ for unlimited); every other feature
// in the domains below is a plain on/off flag.
const INT_FEATURES = new Set([
  "orgs.max_owned",
  "divisions.per_competition.max",
  "entrants.per_division.max",
  "members.max",
  "scorers.max",
  "clubs.max",
  "teams.max",
  "teams.squad_max",
  "stages.per_division.max",
  "dashboard.public.max",
  "import.bulk",
  "schedule.checkpoints.max",
  "officials.per_fixture.max",
]);

function cellFormatter(feature: string): (cell: MatrixCell | undefined) => string {
  return INT_FEATURES.has(feature) ? intCell : boolCell;
}

/** Entry fees fold two keys into one honest cell: enabled + platform cut. */
function feeCell(data: MatrixData, plan: "community" | "event_pass" | "pro" | "pro_plus"): string {
  const paid = data["registration.paid"];
  const pct = data["registration.fee_percent"];
  const enabled =
    plan === "event_pass"
      ? (paid?.event_pass ?? paid?.community)?.bool_value === true
      : paid?.[plan]?.bool_value === true;
  if (!enabled) return DASH;
  const cut = plan === "event_pass" ? (pct?.event_pass ?? pct?.community) : pct?.[plan];
  return cut?.int_value != null ? `${CHECK} ${cut.int_value}%` : CHECK;
}

/**
 * Quota semantics differ per offer: free counts active comps, a pass IS one
 * competition, Pro/Pro Plus have no cap — prose beats a bare number here.
 * The `pass` cell holds a `pricing.matrix.`-prefixed dict KEY (translated
 * prose) — every other cell in this module is a locale-free literal (a
 * number, ∞, ✓ or —). The page distinguishes the two by that prefix before
 * calling `t()`.
 */
function competitionsRow(data: MatrixData): PricingRow {
  const cell = data["competitions.max_active"];
  return {
    labelKey: "pricing.matrix.competitions.max_active",
    free: intCell(cell?.community),
    pass: "pricing.matrix.passedEvent",
    pro: intCell(cell?.pro),
    plus: intCell(cell?.pro_plus),
  };
}

function feesRow(data: MatrixData): PricingRow {
  return {
    labelKey: "pricing.matrix.fees",
    free: feeCell(data, "community"),
    pass: feeCell(data, "event_pass"),
    pro: feeCell(data, "pro"),
    plus: feeCell(data, "pro_plus"),
  };
}

/**
 * Since billing groups (spec 2026-07-21) one subscription covers several
 * organisations, so this row is a PRICE, not an allowance: the count is what
 * the plan's bill may stretch to, and each organisation past the first costs
 * half the plan's rate. The number still comes from `orgs.max_owned` in
 * plan_entitlements — only the framing is added, as a translated note key, so
 * nothing about the ladder is hardcoded here.
 */
function orgsRow(data: MatrixData): PricingRow {
  const cell = data["orgs.max_owned"];
  return {
    labelKey: "pricing.matrix.orgs.max_owned",
    noteKey: "pricing.matrix.orgs.max_owned.note",
    free: intCell(cell?.community),
    pass: passCell(data, "orgs.max_owned", intCell),
    pro: intCell(cell?.pro),
    plus: intCell(cell?.pro_plus),
  };
}

function buildRow(data: MatrixData, feature: string): PricingRow {
  if (feature === "competitions.max_active") return competitionsRow(data);
  if (feature === "orgs.max_owned") return orgsRow(data);
  // registration.paid is never rendered bare — it's folded with
  // registration.fee_percent into the honest "fees" row instead.
  if (feature === "registration.paid") return feesRow(data);
  const fmt = cellFormatter(feature);
  return {
    labelKey: `pricing.matrix.${feature}`,
    free: fmt(data[feature]?.community),
    pass: passCell(data, feature, fmt),
    pro: fmt(data[feature]?.pro),
    plus: fmt(data[feature]?.pro_plus),
  };
}

/** One section per ENTITLEMENT_DOMAINS entry, in domain order. Keys not
 *  listed there (vestigial D9 keys + domains.custom) are never rendered. */
export function buildPricingSections(data: MatrixData): PricingSection[] {
  return ENTITLEMENT_DOMAINS.map((domain) => ({
    labelKey: `pricing.matrix.section.${domain.slug}`,
    rows: domain.features.map((feature) => buildRow(data, feature)),
  }));
}
