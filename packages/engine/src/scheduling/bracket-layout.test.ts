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

// doubleElimBracket (G1) — two-lane geometry recovered from the persisted
// round_no blocks (WB 1..k, LB 2k+1..4k−2, GF 5k−1, reset 5k).
import { generateDoubleElim } from "./bracket.ts";
import { doubleElimBracket, lbRowUnit } from "./bracket-layout.ts";

/** Replicates usecases/stages.ts bracketToGen round numbering. */
function deRefs(n: number, bracketReset = false): BracketFixtureRef[] {
  const entrants = Array.from({ length: n }, (_, i) => `e${i + 1}`);
  const gen = generateDoubleElim({ entrants, bracketReset });
  const k = gen.rounds;
  const counters = new Map<string, number>();
  return gen.fixtures.map((f) => {
    const lane = f.bracket ?? "WB";
    const offset = lane === "LB" ? k : lane === "GF" ? 2 * k : 0;
    const roundNo = offset + f.round + 1;
    const seq = (counters.get(`${lane}:${roundNo}`) ?? 0) + 1;
    counters.set(`${lane}:${roundNo}`, seq);
    return { id: f.id, round_no: roundNo, seq_in_round: seq };
  });
}

describe("doubleElimBracket", () => {
  it("lays out an 8-entrant double elim: WB 3 cols, LB 4 cols, one GF", () => {
    const res = doubleElimBracket(deRefs(8));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const { layout } = res;
    expect(layout.k).toBe(3);
    expect(layout.wbRows).toBe(4);
    expect(layout.lbRows).toBe(2);
    expect(layout.lbCols).toBe(4);
    expect(layout.resetId).toBeUndefined();
    const lanes = (lane: string) => layout.nodes.filter((nd) => nd.lane === lane);
    expect(lanes("WB")).toHaveLength(7);
    expect(lanes("LB")).toHaveLength(6);
    expect(lanes("GF")).toHaveLength(1);
    // LB column counts follow the halving pairs 2,2,1,1.
    const lbCount = (col: number) => lanes("LB").filter((nd) => nd.col === col).length;
    expect([lbCount(0), lbCount(1), lbCount(2), lbCount(3)]).toEqual([2, 2, 1, 1]);
    // Major columns get straight in-lane feeds, minor columns get pairs.
    const major = layout.connectors.filter((c) => c.lane === "LB" && c.col === 1);
    expect(major).toEqual([
      { lane: "LB", col: 1, fromRow: 0, toRow: 0 },
      { lane: "LB", col: 1, fromRow: 1, toRow: 1 },
    ]);
  });

  it("keeps the bracket-reset fixture as GF col 1", () => {
    const res = doubleElimBracket(deRefs(4, true));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.layout.resetId).toBeDefined();
    expect(res.layout.nodes.filter((nd) => nd.lane === "GF")).toHaveLength(2);
  });

  it("rejects single-elim shapes and tampered counts", () => {
    const se = generateSingleElim({ entrants: ["a", "b", "c", "d"] });
    const counters = new Map<string, number>();
    const refs = se.fixtures.map((f) => {
      const seq = (counters.get(`${f.round}`) ?? 0) + 1;
      counters.set(`${f.round}`, seq);
      return { id: f.id, round_no: f.round + 1, seq_in_round: seq };
    });
    expect(doubleElimBracket(refs).ok).toBe(false);
    const de = deRefs(8);
    expect(doubleElimBracket(de.slice(1)).ok).toBe(false);
    expect(doubleElimBracket([]).ok).toBe(false);
  });

  it("lbRowUnit doubles spacing every two columns", () => {
    expect([0, 1, 2, 3].map(lbRowUnit)).toEqual([0, 0, 1, 1]);
  });
});

// pagePlayoffBracket (spec 2026-07-19) — the IPL Page-system shape.
import { generatePagePlayoff } from "./bracket.ts";
import { pagePlayoffBracket } from "./bracket-layout.ts";

describe("generatePagePlayoff + pagePlayoffBracket", () => {
  it("wires Q1/Eliminator/Q2/Final with the second-life feeds", () => {
    const gen = generatePagePlayoff({ entrants: ["s1", "s2", "s3", "s4"] });
    expect(gen.fixtures).toHaveLength(4);
    const byId = new Map(gen.fixtures.map((f) => [f.id, f]));
    expect(byId.get("pp-q1")).toMatchObject({ home: "s1", away: "s2", round: 0 });
    expect(byId.get("pp-elim")).toMatchObject({ home: "s3", away: "s4", round: 0 });
    expect(byId.get("pp-q2")).toMatchObject({
      homeFrom: { fixtureId: "pp-q1", side: "loser" },
      awayFrom: { fixtureId: "pp-elim", side: "winner" },
    });
    expect(byId.get("pp-final")).toMatchObject({
      isFinal: true,
      homeFrom: { fixtureId: "pp-q1", side: "winner" },
      awayFrom: { fixtureId: "pp-q2", side: "winner" },
    });
  });

  it("lays out the persisted rounds into the four named slots", () => {
    const refs = [
      { id: "a", round_no: 1, seq_in_round: 1 },
      { id: "b", round_no: 1, seq_in_round: 2 },
      { id: "c", round_no: 2, seq_in_round: 1 },
      { id: "d", round_no: 3, seq_in_round: 1 },
    ];
    const res = pagePlayoffBracket(refs);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.layout.nodes.map((n) => `${n.slot}:${n.fixtureId}`)).toEqual([
      "q1:a", "eliminator:b", "q2:c", "final:d",
    ]);
  });

  it("rejects non-Page shapes and wrong field sizes", () => {
    expect(pagePlayoffBracket([])).toMatchObject({ ok: false });
    const se = [
      { id: "a", round_no: 1, seq_in_round: 1 }, { id: "b", round_no: 1, seq_in_round: 2 },
      { id: "c", round_no: 1, seq_in_round: 3 }, { id: "d", round_no: 2, seq_in_round: 1 },
    ];
    expect(pagePlayoffBracket(se)).toMatchObject({ ok: false });
    expect(() => generatePagePlayoff({ entrants: ["a", "b", "c"] })).toThrow(/exactly 4/);
  });
});
