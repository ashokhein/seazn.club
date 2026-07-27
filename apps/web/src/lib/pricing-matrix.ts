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

/**
 * Every column of the comparison table, in render order — and the exact plan
 * list `/pricing` reads from `plan_entitlements`.
 *
 * ONE list, because the table used to have three: a hardcoded `where plan_key
 * in (…)` in the page's query, a fixed set of named fields on `PricingRow`,
 * and a hand-written `<th>` row. Adding the L rung (v17 #294) meant a plan
 * could be in the query and still have nowhere to render — and a plan with
 * nowhere to render inherits the neighbouring column's numbers, which on this
 * page means quoting M's 128-entrant ceiling to someone paying to remove it.
 * Deriving the query, the row shape and the headings from this tuple makes
 * that class of gap a type error instead.
 */
export const PRICING_PLAN_KEYS = [
  "community",
  "event_pass",
  "event_pass_l",
  "pro",
  "pro_plus",
] as const;

export type PricingPlanKey = (typeof PRICING_PLAN_KEYS)[number];

/** Column heading, per plan. A `Record` so a plan added above without a
 *  heading is a compile error rather than a blank column. */
export const PRICING_COLUMN_LABEL_KEY: Record<PricingPlanKey, string> = {
  community: "pricing.table.community",
  event_pass: "pricing.table.pass",
  event_pass_l: "pricing.table.passL",
  pro: "pricing.table.pro",
  pro_plus: "pricing.table.proPlus",
};

/** The rungs of the Event Pass ladder — the columns that fall through to
 *  community, because a pass grants only what it explicitly lifts. */
const PASS_PLANS: ReadonlySet<string> = new Set<PricingPlanKey>(["event_pass", "event_pass_l"]);

export interface PricingRow {
  labelKey: string;
  /** Optional second line under the label, always a dict KEY. Used where a
   *  bare number would mislead — the orgs row is a price, not an allowance
   *  (billing-groups spec 2026-07-21 §Surfaces to update). */
  noteKey?: string;
  /** One rendered value per column, keyed by plan. */
  cells: Record<PricingPlanKey, string>;
}

/** Build a row's cells by asking `value` for each column in turn. */
function cellsFor(value: (plan: PricingPlanKey) => string): Record<PricingPlanKey, string> {
  return Object.fromEntries(PRICING_PLAN_KEYS.map((p) => [p, value(p)])) as Record<
    PricingPlanKey,
    string
  >;
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
 * The raw cell a column should render, with the resolver's own fall-through.
 *
 * A feature key missing from a PASS rung's matrix falls through to the
 * community plan at resolution time — mirror that here so the table tells the
 * truth about what a passed competition actually gets. It applies to BOTH
 * rungs: V341 derives L from M, so the keys L has no row for are exactly the
 * keys M has no row for, and rendering "—" there would make the more expensive
 * rung look like it grants less.
 */
function cellAt(data: MatrixData, feature: string, plan: PricingPlanKey): MatrixCell | undefined {
  const direct = data[feature]?.[plan];
  if (direct) return direct;
  return PASS_PLANS.has(plan) ? data[feature]?.community : undefined;
}

// Quota-style features render a count (∞ for unlimited); every other feature
// in the domains below is a plain on/off flag.
const INT_FEATURES = new Set([
  "orgs.max_owned",
  "divisions.per_competition.max",
  "entrants.per_division.max",
  "members.max",
  // scorers.max retired from the comparison (#244); officials.per_fixture.max
  // dropped because V319 makes it ∞ on every plan — an all-∞ row tells no story.
  "clubs.max",
  "teams.max",
  "teams.squad_max",
  "stages.per_division.max",
  "dashboard.public.max",
  "import.bulk",
  "schedule.checkpoints.max",
  // scheduling.ai.runs_per_division.max retired (v17 Phase 2 Task 5, V322):
  // the graded per-division run cap is gone, replaced by the AI credit
  // wallet, which meters spend rather than a plan-graded count — there is no
  // longer a number to render here.
]);

function cellFormatter(feature: string): (cell: MatrixCell | undefined) => string {
  return INT_FEATURES.has(feature) ? intCell : boolCell;
}

/** Entry fees fold two keys into one honest cell: enabled + platform cut. */
function feeCell(data: MatrixData, plan: PricingPlanKey): string {
  if (cellAt(data, "registration.paid", plan)?.bool_value !== true) return DASH;
  const cut = cellAt(data, "registration.fee_percent", plan);
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
    // Both rungs read the prose cell: a pass IS one competition, at either
    // size. What L buys is a bigger event, never more of them.
    cells: cellsFor((plan) =>
      PASS_PLANS.has(plan) ? "pricing.matrix.passedEvent" : intCell(cell?.[plan]),
    ),
  };
}

function feesRow(data: MatrixData): PricingRow {
  return {
    labelKey: "pricing.matrix.fees",
    cells: cellsFor((plan) => feeCell(data, plan)),
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
  return {
    labelKey: "pricing.matrix.orgs.max_owned",
    noteKey: "pricing.matrix.orgs.max_owned.note",
    cells: cellsFor((plan) => intCell(cellAt(data, "orgs.max_owned", plan))),
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
    cells: cellsFor((plan) => fmt(cellAt(data, feature, plan))),
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
