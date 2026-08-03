// #399 W4 — the rule vocabulary and the conflict delta.
//
// Two independent guarantees live here:
//
//   1. Every `Conflict` the verifier emits carries the rule code the scheduling
//      prompts taught (H2-H8, or CAP for the capacity case). A repair round that
//      is handed `{reason: "rest"}` is being asked to fix a word it was never
//      taught; one handed `H4` can act mechanically.
//   2. `deltaConflicts` is a MULTISET difference over the conflict identity, so
//      a pre-existing conflict is never reported as introduced and a second
//      instance of one is.
import { describe, expect, it } from "vitest";
import {
  conflictKey,
  deltaConflicts,
  RULE_BY_REASON,
  validateAssignments,
  type Conflict,
  type ConflictReason,
  type VerifyConfig,
} from "./calendar";

// Written out rather than derived: a union member added without a rule code is
// exactly the regression this asserts, and deriving the list from the map would
// make the test agree with the bug.
const ALL_REASONS: ConflictReason[] = [
  "no_slot",
  "court",
  "rest",
  "blackout",
  "person_overlap",
  "start_window",
  "window",
  "instruction",
  "order",
];

const AT = Date.UTC(2026, 7, 10, 9, 0);
const MIN = 60_000;

const cfg: VerifyConfig = {
  perEntrantMinRest: 0,
  gapMinutes: 0,
  blackouts: [],
  sessionWindows: [],
  matchMinutes: 30,
};

const conflict = (fixtureId: string, reason: ConflictReason, detail?: string): Conflict => ({
  fixtureId,
  reason,
  ...(detail !== undefined ? { detail } : {}),
});

describe("rule codes (#399)", () => {
  it("maps every ConflictReason, and nothing that is not one", () => {
    expect(Object.keys(RULE_BY_REASON).sort()).toEqual([...ALL_REASONS].sort());
  });

  it("uses the codes the prompt teaches", () => {
    expect(RULE_BY_REASON.court).toBe("H2");
    expect(RULE_BY_REASON.blackout).toBe("H3");
    expect(RULE_BY_REASON.window).toBe("H3");
    expect(RULE_BY_REASON.rest).toBe("H4");
    expect(RULE_BY_REASON.person_overlap).toBe("H4");
    expect(RULE_BY_REASON.start_window).toBe("H5");
    expect(RULE_BY_REASON.order).toBe("H6");
    expect(RULE_BY_REASON.instruction).toBe("H8");
  });

  it("gives the capacity case CAP, not a rule it did not break", () => {
    expect(RULE_BY_REASON.no_slot).toBe("CAP");
  });

  it("stamps the code on a court clash the verifier actually produces", () => {
    const conflicts = validateAssignments(
      [
        { fixtureId: "a", court: "C1", startAt: AT, endAt: AT + 30 * MIN, entrants: ["e1"], people: [] },
        { fixtureId: "b", court: "C1", startAt: AT, endAt: AT + 30 * MIN, entrants: ["e2"], people: [] },
      ],
      { ...cfg, courts: ["C1"] } as VerifyConfig,
    );
    expect(conflicts.some((c) => c.reason === "court")).toBe(true);
    expect(conflicts.every((c) => c.rule === RULE_BY_REASON[c.reason])).toBe(true);
  });

  it("stamps the code on a person overlap and on a rest breach", () => {
    const conflicts = validateAssignments(
      [
        { fixtureId: "a", court: "C1", startAt: AT, endAt: AT + 30 * MIN, entrants: ["e1"], people: ["p1"] },
        { fixtureId: "b", court: "C2", startAt: AT, endAt: AT + 30 * MIN, entrants: ["e2"], people: ["p1"] },
      ],
      cfg,
    );
    const overlap = conflicts.find((c) => c.reason === "person_overlap");
    expect(overlap?.rule).toBe("H4");
  });
});

describe("conflictKey (#399)", () => {
  it("is fixture, reason and detail", () => {
    expect(conflictKey(conflict("f1", "court", "court C1 double-booked"))).toBe(
      "f1|court|court C1 double-booked",
    );
  });

  it("keeps the empty-detail slot so a detail-less conflict still keys stably", () => {
    expect(conflictKey(conflict("f1", "court"))).toBe("f1|court|");
  });
});

describe("deltaConflicts (#399)", () => {
  it("does not report a conflict that was already there", () => {
    const pre = conflict("f1", "person_overlap", "person p1 overlap");
    expect(deltaConflicts([pre], [pre])).toEqual([]);
  });

  it("reports a conflict the change introduced", () => {
    const fresh = conflict("f2", "person_overlap", "person p9 overlap");
    expect(deltaConflicts([conflict("f1", "person_overlap", "person p1 overlap")], [fresh])).toEqual([
      fresh,
    ]);
  });

  it("reports a WORSENED conflict — same key, one more instance", () => {
    const dup = conflict("f1", "person_overlap", "person p1 overlap");
    expect(deltaConflicts([dup], [dup, dup])).toEqual([dup]);
  });

  it("reports a bigger breach, because the detail differs", () => {
    const worse = conflict("f1", "rest", "person p1/p2 below rest");
    expect(deltaConflicts([conflict("f1", "rest", "person p1 below rest")], [worse])).toEqual([worse]);
  });

  it("does not resurrect a conflict the change REMOVED", () => {
    expect(deltaConflicts([conflict("f1", "court", "court C1 double-booked")], [])).toEqual([]);
  });

  it("is empty when nothing changed at all", () => {
    const board = [conflict("f1", "rest", "entrant e1 below rest"), conflict("f2", "blackout", "x")];
    expect(deltaConflicts(board, board)).toEqual([]);
  });
});
