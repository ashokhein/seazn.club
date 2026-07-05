// PROMPT-13 item 3: unit-test the freeze selector — which N resources stay
// active after a downgrade (doc 10 §2.4: most recently active first). Pure.
import { describe, expect, it } from "vitest";
import { selectFrozen, type FreezeCandidate } from "../entitlement-freeze";

const c = (id: string, lastActiveAt: string): FreezeCandidate => ({ id, lastActiveAt });

describe("selectFrozen (doc 10 §2.4)", () => {
  const candidates = [
    c("oldest", "2026-01-01T00:00:00Z"),
    c("middle", "2026-03-01T00:00:00Z"),
    c("newest", "2026-06-01T00:00:00Z"),
  ];

  it("keeps the N most recently active; the rest freeze", () => {
    expect(selectFrozen(candidates, 2)).toEqual(new Set(["oldest"]));
    expect(selectFrozen(candidates, 1)).toEqual(new Set(["oldest", "middle"]));
  });

  it("freezes nothing when within quota or unlimited", () => {
    expect(selectFrozen(candidates, 3)).toEqual(new Set());
    expect(selectFrozen(candidates, 99)).toEqual(new Set());
    expect(selectFrozen(candidates, null)).toEqual(new Set());
    expect(selectFrozen([], 0)).toEqual(new Set());
  });

  it("limit 0 freezes everything (feature absent from the plan)", () => {
    expect(selectFrozen(candidates, 0)).toEqual(
      new Set(["oldest", "middle", "newest"]),
    );
  });

  it("input order never matters", () => {
    const shuffled = [candidates[2], candidates[0], candidates[1]];
    expect(selectFrozen(shuffled, 2)).toEqual(selectFrozen(candidates, 2));
  });

  it("ties break deterministically on id", () => {
    const tied = [c("b", "2026-01-01T00:00:00Z"), c("a", "2026-01-01T00:00:00Z")];
    // Same instant: 'a' sorts first (stays active), 'b' freezes — every run.
    expect(selectFrozen(tied, 1)).toEqual(new Set(["b"]));
    expect(selectFrozen([...tied].reverse(), 1)).toEqual(new Set(["b"]));
  });

  it("accepts Date objects as lastActiveAt", () => {
    const dates = [
      { id: "x", lastActiveAt: new Date("2026-01-01") },
      { id: "y", lastActiveAt: new Date("2026-02-01") },
    ];
    expect(selectFrozen(dates, 1)).toEqual(new Set(["x"]));
  });
});
