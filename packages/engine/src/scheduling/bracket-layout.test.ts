// twoSidedBracket (PROMPT-62 §1) — pure two-sided geometry over knockout
// fixtures: first-round matches split top-half → left, bottom-half → right,
// halving inward to a centre Final; a 3rd-place fixture hangs under it.
// Sport-neutral by construction: input is (id, round_no, seq_in_round) only.
import { describe, expect, it } from "vitest";
import { generateSingleElim } from "./bracket.ts";
import {
  rowCenter,
  twoSidedBracket,
  type BracketFixtureRef,
  type BracketLayout,
} from "./bracket-layout.ts";

const field = (n: number): string[] => Array.from({ length: n }, (_, i) => `s${i + 1}`);

// Map a generated bracket to layout refs the way the DB layer persists them:
// round_no = gen round, seq_in_round = 1-based order within the round.
function refsFor(n: number, thirdPlace = false): BracketFixtureRef[] {
  const { fixtures } = generateSingleElim({ entrants: field(n), thirdPlace });
  const perRound = new Map<number, number>();
  return fixtures.map((f) => {
    const seq = (perRound.get(f.round) ?? 0) + 1;
    perRound.set(f.round, seq);
    return { id: f.id, round_no: f.round, seq_in_round: seq };
  });
}

function layoutOf(refs: BracketFixtureRef[]): BracketLayout {
  const res = twoSidedBracket(refs);
  if (!res.ok) throw new Error(`expected ok layout, got: ${res.reason}`);
  return res.layout;
}

describe("twoSidedBracket", () => {
  it("8-team golden: halves split L/R, final centred, connectors = nodes − 1", () => {
    const layout = layoutOf(refsFor(8));
    expect(layout.rounds).toBe(3);
    expect(layout.colsPerSide).toBe(2);
    const bySide = (side: string) => layout.nodes.filter((n) => n.side === side);
    expect(bySide("L").map((n) => [n.col, n.row])).toEqual([[0, 0], [0, 1], [1, 0]]);
    expect(bySide("R").map((n) => [n.col, n.row])).toEqual([[0, 0], [0, 1], [1, 0]]);
    expect(bySide("center")).toHaveLength(1);
    expect(layout.connectors).toHaveLength(layout.nodes.length - 1);
    expect(layout.thirdPlaceId).toBeUndefined();
  });

  it("4-team: one column per side; 2-team: a single centred final", () => {
    const four = layoutOf(refsFor(4));
    expect(four.colsPerSide).toBe(1);
    expect(four.nodes.filter((n) => n.side === "center")).toHaveLength(1);

    const two = layoutOf(refsFor(2));
    expect(two.rounds).toBe(1);
    expect(two.colsPerSide).toBe(0);
    expect(two.nodes).toHaveLength(1);
    expect(two.nodes[0]!.side).toBe("center");
    expect(two.connectors).toHaveLength(0);
  });

  it("16 and 32 fields balance: half of round 0 on each side, structure sound", () => {
    for (const n of [16, 32]) {
      const layout = layoutOf(refsFor(n));
      const r0 = layout.nodes.filter((node) => node.col === 0 && node.side !== "center");
      expect(r0.filter((node) => node.side === "L")).toHaveLength(n / 4);
      expect(r0.filter((node) => node.side === "R")).toHaveLength(n / 4);
      expect(layout.connectors).toHaveLength(layout.nodes.length - 1);
    }
  });

  it("a bye field (6 into bracket of 8) lays out like the 8 bracket", () => {
    const layout = layoutOf(refsFor(6));
    expect(layout.rounds).toBe(3);
    expect(layout.nodes).toHaveLength(7);
  });

  it("the 3rd-place fixture hangs under the final, with no connectors of its own", () => {
    const layout = layoutOf(refsFor(4, true));
    expect(layout.thirdPlaceId).toBeDefined();
    const third = layout.nodes.find((n) => n.fixtureId === layout.thirdPlaceId);
    expect(third).toMatchObject({ side: "center", row: 1 });
    // final still centre row 0; connector count unchanged by the 3p node
    expect(layout.connectors).toHaveLength(layout.nodes.length - 2);
  });

  it("normalises 1-based round_no (DB rows) identically to 0-based", () => {
    const zero = refsFor(8);
    const one = zero.map((r) => ({ ...r, round_no: r.round_no + 1 }));
    expect(layoutOf(one)).toEqual(layoutOf(zero));
  });

  it("rejects non-single-elim shapes with a fallback signal", () => {
    // stepladder-shaped: one match per round, 3 rounds
    const ladder = [
      { id: "a", round_no: 0, seq_in_round: 1 },
      { id: "b", round_no: 1, seq_in_round: 1 },
      { id: "c", round_no: 2, seq_in_round: 1 },
    ];
    const res = twoSidedBracket(ladder);
    expect(res.ok).toBe(false);
    expect(twoSidedBracket([]).ok).toBe(false);
  });

  it("rowCenter positions rows in round-0 slot units", () => {
    expect(rowCenter(0, 0)).toBe(0.5);
    expect(rowCenter(0, 1)).toBe(1.5);
    expect(rowCenter(1, 0)).toBe(1);
    expect(rowCenter(2, 1)).toBe(6);
  });

  it("is deterministic", () => {
    expect(layoutOf(refsFor(16))).toEqual(layoutOf(refsFor(16)));
  });
});
