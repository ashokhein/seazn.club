// W5 (#400, #388). ONE definition of a reviewable row, and ONE definition of
// the count. #388's complaint is that "N warnings to review" sat above amber
// rows that were not warnings, so the number disagreed with the screen; this
// wave adds two more row categories on top of that. Deriving the count from the
// same array the panel renders is what makes the two structurally incapable of
// drifting — a count read off `plan.warnings.length` is the same bug with a
// bigger number.
import { describe, expect, it } from "vitest";
import {
  buildReviewRows,
  reviewRowCount,
  reviewRowPulseIds,
  type ReviewSource,
} from "../ai-review";

const plan: ReviewSource = {
  warnings: [{ fixtureId: "f1", reason: "rest", detail: "18 min short of 45" }],
  unschedulable: [{ fixture_id: "f2", reason: "no court free in the window", rule: "CAP" }],
  assumptions: ["Read 'the weekend' as Sat + Sun."],
};

describe("buildReviewRows", () => {
  it("builds one row per reviewable item, in warning → unschedulable → assumption order", () => {
    const rows = buildReviewRows(plan);
    expect(rows.map((r) => r.kind)).toEqual(["warning", "unschedulable", "assumption"]);
  });

  it("carries each row's own payload through untouched", () => {
    const [w, u, a] = buildReviewRows(plan);
    expect(w).toEqual({
      kind: "warning",
      fixtureId: "f1",
      reason: "rest",
      detail: "18 min short of 45",
      rule: undefined,
    });
    expect(u).toEqual({
      kind: "unschedulable",
      fixtureId: "f2",
      reason: "no court free in the window",
      rule: "CAP",
    });
    expect(a).toEqual({ kind: "assumption", text: "Read 'the weekend' as Sat + Sun." });
  });

  it("is empty for a clean plan", () => {
    expect(buildReviewRows({ warnings: [], unschedulable: [], assumptions: [] })).toEqual([]);
  });

  it("does not drop a row category when another is empty", () => {
    const rows = buildReviewRows({
      warnings: [],
      unschedulable: plan.unschedulable,
      assumptions: [],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe("unschedulable");
  });

  // Task 3 widens both plan responses to `assumptions: []`, but the joint
  // response and any older cached plan can still arrive without the key. An
  // absent array is zero rows, never a crash.
  it("treats an absent assumptions array as no assumption rows", () => {
    const rows = buildReviewRows({ warnings: plan.warnings, unschedulable: [] });
    expect(rows.map((r) => r.kind)).toEqual(["warning"]);
  });
});

describe("reviewRowCount", () => {
  it("counts every row it renders", () => {
    expect(reviewRowCount(buildReviewRows(plan))).toBe(3);
  });

  it("is the length of the rendered array, not the warning count", () => {
    const rows = buildReviewRows(plan);
    expect(reviewRowCount(rows)).toBe(rows.length);
    expect(reviewRowCount(rows)).not.toBe(plan.warnings.length);
  });

  it("is zero for no rows", () => {
    expect(reviewRowCount([])).toBe(0);
  });
});

describe("reviewRowPulseIds", () => {
  // W5 Task 5 must-fix 3. The pulse highlights blocks on the GRID. A warning is
  // about a fixture the plan placed, so it has a block to light up; an
  // unschedulable fixture is by definition not placed and sits in the tray, and
  // an assumption is about no fixture at all. Feeding either to "Show these on
  // the board" is a button that points at nothing.
  it("offers only the fixtures the plan actually placed", () => {
    expect(reviewRowPulseIds(buildReviewRows(plan))).toEqual(["f1"]);
  });

  it("is empty when nothing on the card is on the grid", () => {
    const rows = buildReviewRows({
      warnings: [],
      unschedulable: plan.unschedulable,
      assumptions: ["Read 'the weekend' as Sat + Sun."],
    });
    expect(rows).toHaveLength(2);
    expect(reviewRowPulseIds(rows)).toEqual([]);
  });
});
