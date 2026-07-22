/**
 * The pass-vs-plan comparison the upgrade page renders (spec D10: "a
 * pass-vs-Pro comparison naming real limits").
 *
 * ── Why the numbers are not written down here ───────────────────────────────
 * The page this replaced hardcoded its claims in the dictionary, and one of
 * them was simply false: `upgrade.includes.entrants` promised "32 entrants per
 * division (Free: 16)" while the live matrix says the pass grants 64 and
 * Community already allows 32 — the offer undersold itself by half and libelled
 * the free plan, in four languages. Copy that quotes a limit rots the moment
 * `plan_entitlements` moves, and nothing fails when it does.
 *
 * So this module owns only the SHAPE of the table — which rows, in what order,
 * read from which entitlement keys — and every figure in it is read from
 * `plan_entitlements` at render time, by the same keys the resolver enforces.
 * The page cannot claim a limit the product does not grant.
 *
 * Pure: no DB, no React, no i18n. The page supplies the rows' values and turns
 * `CompareCell` into words in the viewer's language.
 */

export type CompareKind = "number" | "percent" | "flag";

export interface CompareRow {
  /** `ui` dictionary key for the row label. */
  labelKey: string;
  /**
   * Entitlement keys this row reports. The FIRST drives the figures; the rest
   * exist so a ceiling arriving as `?feature=` can be matched to the row that
   * describes it (`formats.advanced` and `formats.double_elim` are one line to
   * a reader, two keys to the resolver).
   */
  features: string[];
  kind: CompareKind;
}

/**
 * Ordered so the four rows a buyer can put a number on come first — those are
 * what a pass is bought for — and the yes/no rows follow. Not a sequence, so
 * the table carries no step numbering.
 */
export const PASS_COMPARE_ROWS: readonly CompareRow[] = [
  { labelKey: "upgrade.limit.divisions", features: ["divisions.per_competition.max"], kind: "number" },
  { labelKey: "upgrade.limit.entrants", features: ["entrants.per_division.max"], kind: "number" },
  {
    labelKey: "upgrade.limit.aiRuns",
    features: ["scheduling.ai.runs_per_division.max"],
    kind: "number",
  },
  { labelKey: "upgrade.limit.fee", features: ["registration.fee_percent"], kind: "percent" },
  {
    labelKey: "upgrade.limit.formats",
    features: ["formats.advanced", "formats.double_elim"],
    kind: "flag",
  },
  { labelKey: "upgrade.limit.realtime", features: ["realtime"], kind: "flag" },
  { labelKey: "upgrade.limit.exports", features: ["exports.branded"], kind: "flag" },
  { labelKey: "upgrade.limit.profiles", features: ["dashboard.player_profiles"], kind: "flag" },
  {
    labelKey: "upgrade.limit.sponsors",
    features: ["sponsors.tiers", "sponsors.monetize"],
    kind: "flag",
  },
];

/** Every entitlement key the table needs, for one `in (…)` read. */
export const PASS_COMPARE_FEATURES: string[] = [
  ...new Set(PASS_COMPARE_ROWS.flatMap((r) => r.features)),
];

/** One `plan_entitlements` row, or `undefined` when the plan has no row at all. */
export type MatrixCell = { bool: boolean | null; int: number | null } | undefined;

export type CompareCell =
  /** A figure to print as-is ("10", "8%"). */
  | { type: "value"; text: string }
  /** No ceiling — Pro's `divisions.per_competition.max` row has a NULL cap. */
  | { type: "unlimited" }
  | { type: "yes" }
  | { type: "no" };

/**
 * What one cell of the table says.
 *
 * The load-bearing case is a numeric key with NO CAP — a row whose `int_value`
 * is null, or no row at all. In the resolver that means "no ceiling was
 * configured", which `getLimit` reads as unlimited, and it is exactly how Pro
 * grants unlimited divisions (the row exists; the cap is null). Rendering it as
 * a blank would tell a buyer Pro offers nothing in the row where it offers most.
 *
 * The same absence on a FLAG is the opposite claim: off, because a feature
 * nobody granted is not granted. The kinds are split for exactly this reason,
 * and `__tests__/pass-comparison.test.ts` pins today's matrix shape so a key
 * that quietly loses its row cannot slip through as "Unlimited".
 */
export function compareCell(kind: CompareKind, cell: MatrixCell): CompareCell {
  if (kind === "flag") return cell?.bool === true ? { type: "yes" } : { type: "no" };
  if (cell === undefined || cell.int === null) {
    // A percentage with no row is not "unlimited", it is unknown — and an
    // unknown fee must never render as a promise.
    return kind === "percent" ? { type: "no" } : { type: "unlimited" };
  }
  return { type: "value", text: kind === "percent" ? `${cell.int}%` : String(cell.int) };
}

/** Does this row describe the feature key a ceiling arrived with? */
export function rowCovers(row: CompareRow, feature: string | null): boolean {
  return !!feature && row.features.includes(feature);
}
