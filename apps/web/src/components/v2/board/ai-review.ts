// W5 (#400, #388) — the ONE definition of a reviewable row, and the ONE
// definition of how many there are.
//
// #388: "N warnings to review" sat above a column of amber rows that were not
// all warnings, so the number disagreed with the screen. This wave makes that
// worse by adding two more categories — fixtures the solver gave up on, and the
// architect's own assumptions. The fix is structural rather than arithmetic:
// both consoles build the SAME array here, the panel renders that array, and
// the count is that array's length. A second count derived from
// `plan.warnings.length` anywhere is the original defect with a bigger number.
//
// Pure: no JSX, no hooks, no dict. The panel does the localizing.
import type { RuleCode } from "@/server/api-v1/schemas";

/**
 * What a review row can be about.
 *
 * `warning`      — the engine verifier flagged the placement but the apply is
 *                  still allowed. `reason` is the engine's raw camelCase token;
 *                  the panel routes it through `board.conflict.*`.
 * `unschedulable`— the solver could not place the fixture at all. `reason` is
 *                  the solver's own sentence, `rule` the rule it ran out of.
 * `assumption`   — the ARCHITECT's note about what it assumed while placing
 *                  (stage 2). NOT the resolver's assumptions, which are shown
 *                  at the preview before a credit is spent.
 */
export type ReviewRow =
  | { kind: "warning"; fixtureId: string; reason: string; detail?: string; rule?: RuleCode }
  | { kind: "unschedulable"; fixtureId: string; reason: string; rule: RuleCode }
  | { kind: "assumption"; text: string };

/**
 * The slice of a plan response the builder reads.
 *
 * Declared structurally rather than as `Pick<AiPlanResponse, …>` so this module
 * serves the single-division and joint responses from one definition — their
 * `unschedulable.fixture_id` types differ (`Uuid` vs `string`) and the joint
 * response need not carry `assumptions` for a cached plan to still render.
 */
export type ReviewSource = {
  /** Engine `Conflict`s — camelCase, as the verifier emits them. */
  warnings: { fixtureId: string; reason: string; detail?: string; rule?: RuleCode }[];
  /** Solver give-ups — snake_case, as the API returns them. */
  unschedulable: { fixture_id: string; reason: string; rule: RuleCode }[];
  /** Absent on a plan taken before W5 widened the response. */
  assumptions?: string[];
};

/**
 * Every amber row a finished run produced, in one array.
 *
 * Order is fixed and meaningful: what went wrong with a placement, then what
 * could not be placed, then how the sentence was read. Findings before
 * interpretation — an organiser scanning the card should hit the consequences
 * first.
 */
export function buildReviewRows(plan: ReviewSource): ReviewRow[] {
  return [
    ...plan.warnings.map(
      (w): ReviewRow => ({
        kind: "warning",
        fixtureId: w.fixtureId,
        reason: w.reason,
        detail: w.detail,
        rule: w.rule,
      }),
    ),
    ...plan.unschedulable.map(
      (u): ReviewRow => ({
        kind: "unschedulable",
        fixtureId: u.fixture_id,
        reason: u.reason,
        rule: u.rule,
      }),
    ),
    ...(plan.assumptions ?? []).map((text): ReviewRow => ({ kind: "assumption", text })),
  ];
}

/**
 * How many things there are to review.
 *
 * Yes, this is `rows.length`. The value is not the arithmetic — it is that
 * there is exactly one vocabulary for the count, taken from the array the panel
 * renders, so the header and the list cannot disagree.
 */
export function reviewRowCount(rows: ReviewRow[]): number {
  return rows.length;
}

/**
 * The fixtures the grid pulse can actually light up.
 *
 * Warnings only, and that is the whole point. The pulse highlights BLOCKS on
 * the grid, which exist for fixtures the plan placed: a warning is the verifier
 * flagging a placement, so it has one. An unschedulable fixture is by
 * definition not in the proposal (the server dedupes the two against each
 * other) and stays in the tray — the review card says so in as many words — and
 * an assumption is about no fixture at all. Feeding either to a button labelled
 * "Show these on the board" is a control that points at nothing.
 */
export function reviewRowPulseIds(rows: ReviewRow[]): string[] {
  return rows.flatMap((r) => (r.kind === "warning" ? [r.fixtureId] : []));
}
