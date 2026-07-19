import { describe, expect, it } from "vitest";
import type { AiOfficialsPlanResponse } from "@/server/api-v1/schemas";
import { buildOfficialsGrid, officialsConflictKey } from "../ai-officials-grid";
import type { AiConsoleFixture } from "../ai-diff";

// A three-fixture proposal that exercises every chip tone at once: f1 clean,
// f2 blocking, f3 unfilled with a solver candidate (lazy_unfilled).
const roster = [
  { id: "o1", name: "Alice Ref" },
  { id: "o2", name: "Bob Ump" },
  { id: "o3", name: "Cara Line" },
];
const fixtures: Pick<AiConsoleFixture, "id" | "code" | "matchup" | "isFinal" | "isJunior">[] = [
  { id: "f1", code: "R1·1", matchup: "A vs B", isFinal: false, isJunior: false },
  { id: "f2", code: "R1·2", matchup: "C vs D", isFinal: false, isJunior: false },
  { id: "f3", code: "R2·1", matchup: "E vs F", isFinal: true, isJunior: false },
];
const placements = [
  { fixture_id: "f1", scheduled_at: "2026-08-01T09:00:00+01:00", court_label: "Court 1" },
  { fixture_id: "f2", scheduled_at: "2026-08-01T10:00:00+01:00", court_label: "Court 2" },
  { fixture_id: "f3", scheduled_at: "2026-08-01T11:00:00+01:00", court_label: "Court 1" },
];

function plan(over: Partial<AiOfficialsPlanResponse> = {}): AiOfficialsPlanResponse {
  return {
    assignments: [
      { fixtureId: "f1", officialId: "o1", roleKey: "referee" },
      { fixtureId: "f2", officialId: "o2", roleKey: "referee" },
    ],
    conflicts: [
      { kind: "official_overlap", severity: "block", fixtureId: "f2", officialId: "o2", detail: "clashes 10:00" },
    ],
    diff: {
      changed: ["f1", "f2"],
      unchanged: [],
      unfilled: [{ fixture_id: "f3", role_key: "referee", reason: "no eligible official available" }],
    },
    lazy_unfilled: [{ fixture_id: "f3", role_key: "referee", candidate_official_id: "o3" }],
    explanations: [],
    summary: "",
    usage: { input_tokens: 0, output_tokens: 0, repair_rounds: 0 },
    ...over,
  };
}

const base = { plan: plan(), placements, fixtures, roster, roles: ["referee"] };

describe("buildOfficialsGrid", () => {
  it("one row per fixture, one slot per required role, sorted by kickoff", () => {
    const m = buildOfficialsGrid({ ...base, hasPrior: false });
    expect(m.rows.map((r) => r.fixtureId)).toEqual(["f1", "f2", "f3"]);
    expect(m.rows.every((r) => r.slots.length === 1)).toBe(true);
    expect(m.total).toBe(3); // 3 fixtures × 1 role
    expect(m.filled).toBe(2); // f1, f2 assigned
    expect(m.blocking).toBe(1);
  });

  it("a filled, unflagged slot on a first draft (no prior) reads teal, not amber", () => {
    // f1 is in diff.changed, but hasPrior=false so 'changed vs prior' is moot.
    const slot = buildOfficialsGrid({ ...base, hasPrior: false }).rows[0]!.slots[0]!;
    expect(slot.tone).toBe("clean");
    expect(slot.officialName).toBe("Alice Ref");
  });

  it("the same slot ambers once a prior exists and its fixture changed", () => {
    const slot = buildOfficialsGrid({ ...base, hasPrior: true }).rows[0]!.slots[0]!;
    expect(slot.tone).toBe("changed");
  });

  it("a blocking conflict reddens the filled slot and carries kind + raw detail", () => {
    const slot = buildOfficialsGrid({ ...base, hasPrior: true }).rows[1]!.slots[0]!;
    expect(slot.tone).toBe("blocking");
    expect(slot.conflictKind).toBe("official_overlap");
    expect(slot.conflictDetail).toBe("clashes 10:00");
    expect(slot.officialName).toBe("Bob Ump"); // still shows who
  });

  it("an unfilled slot is hollow with the model reason and the solver candidate", () => {
    const slot = buildOfficialsGrid({ ...base, hasPrior: false }).rows[2]!.slots[0]!;
    expect(slot.tone).toBe("unfilled");
    expect(slot.officialId).toBeUndefined();
    expect(slot.reason).toBe("no eligible official available");
    expect(slot.lazyCandidateId).toBe("o3");
    expect(slot.lazyCandidateName).toBe("Cara Line");
  });

  it("a locked assignment padlocks (tone 'locked') below red, above amber", () => {
    const p = plan({
      assignments: [{ fixtureId: "f1", officialId: "o1", roleKey: "referee", locked: true }],
      conflicts: [],
      diff: { changed: ["f1"], unchanged: [], unfilled: [] },
      lazy_unfilled: [],
    });
    const slot = buildOfficialsGrid({ ...base, plan: p, hasPrior: true }).rows[0]!.slots[0]!;
    expect(slot.tone).toBe("locked"); // locked wins over 'changed'
    expect(slot.locked).toBe(true);
  });

  it("a blocking conflict still wins over a locked assignment (surface the problem)", () => {
    const p = plan({
      assignments: [{ fixtureId: "f2", officialId: "o2", roleKey: "referee", locked: true }],
      diff: { changed: [], unchanged: [], unfilled: [] },
      lazy_unfilled: [],
    });
    const row = buildOfficialsGrid({ ...base, plan: p, hasPrior: false }).rows.find((r) => r.fixtureId === "f2")!;
    expect(row.slots[0]!.tone).toBe("blocking");
    expect(row.slots[0]!.locked).toBe(true); // the padlock marker still renders
  });

  it("carries the fixture's persistent Final/JR marker independent of tone", () => {
    const m = buildOfficialsGrid({ ...base, hasPrior: false });
    expect(m.rows.find((r) => r.fixtureId === "f3")!.marker).toBe("FN");
    expect(m.rows.find((r) => r.fixtureId === "f1")!.marker).toBeNull();
  });

  it("falls back to a truncated id when a roster name is missing", () => {
    const p = plan({
      assignments: [{ fixtureId: "f1", officialId: "unknown-official-id", roleKey: "referee" }],
      conflicts: [],
      diff: { changed: [], unchanged: [], unfilled: [] },
      lazy_unfilled: [],
    });
    const slot = buildOfficialsGrid({ ...base, plan: p, hasPrior: false }).rows[0]!.slots[0]!;
    expect(slot.officialName).toBe("unknown-"); // first 8 chars
  });
});

describe("officialsConflictKey", () => {
  it("maps each engine kind to its dedicated dict key", () => {
    expect(officialsConflictKey("official_overlap")).toBe("board.ai.officials.conflict.official_overlap");
    expect(officialsConflictKey("team_ref_self")).toBe("board.ai.officials.conflict.team_ref_self");
    expect(officialsConflictKey("ineligible")).toBe("board.ai.officials.conflict.ineligible");
  });

  it("falls back to the generic key for an unmapped kind (never leaks raw tokens)", () => {
    expect(officialsConflictKey("some_new_kind")).toBe("board.ai.officials.conflict.unknown");
  });
});
