// Two-sided bracket geometry (PROMPT-62 §1) — ONE pure layout driving the
// console BracketPanel, the public bracket and the PDF poster, so the three
// surfaces can never diverge. Input is structural only (id, round_no,
// seq_in_round): no sport code, no DB. Single elimination only — double-elim
// and stepladder shapes return { ok: false } and keep their existing views.

export interface BracketFixtureRef {
  id: string;
  round_no: number; // 0- or 1-based — normalised internally
  seq_in_round: number; // 1-based order within the round
}

export interface BracketNode {
  fixtureId: string;
  side: "L" | "R" | "center"; // centre = the Final (+ 3rd place under it)
  col: number; // 0 = outermost round on each side; centre col = colsPerSide
  row: number; // vertical slot within the column (0-based)
}

export interface BracketConnector {
  side: "L" | "R";
  /** Column of the TARGET node's round; feeders sit in col − 1 (the final's
   *  two feeders use col = colsPerSide, one per side, from that side's
   *  innermost column row). */
  col: number;
  fromRow: number;
  toRow: number;
}

export interface BracketLayout {
  nodes: BracketNode[];
  connectors: BracketConnector[];
  rounds: number;
  colsPerSide: number;
  thirdPlaceId?: string;
}

export type BracketLayoutResult =
  | { ok: true; layout: BracketLayout }
  | { ok: false; reason: string };

/** Vertical centre of a node in round-0 slot units: renderers multiply by a
 *  slot height. (row + 0.5) · 2^col — each column doubles the spacing. */
export function rowCenter(col: number, row: number): number {
  return (row + 0.5) * 2 ** col;
}

// ---------------------------------------------------------------------------
// Double-elimination two-lane geometry (G1). Structural-only like
// twoSidedBracket: lanes are recovered from the round_no blocks the
// persistence mapping emits (bracketToGen): with WB depth k and N = 2^k
// entrants — WB rounds 1..k, LB rounds 2k+1..4k−2 (2k−2 rounds, counts
// halving in equal pairs), grand final 5k−1, optional reset 5k. Anything
// else returns { ok: false } and keeps the existing column view.

export interface DoubleElimNode {
  fixtureId: string;
  lane: "WB" | "LB" | "GF";
  col: number; // 0-based within the lane; GF col 0 = grand final, 1 = reset
  row: number;
}

export interface DoubleElimConnector {
  lane: "WB" | "LB";
  /** Column of the TARGET node; feeders sit in col − 1 of the same lane. */
  col: number;
  fromRow: number;
  toRow: number;
}

export interface DoubleElimLayout {
  nodes: DoubleElimNode[];
  /** In-lane feeds only — WB drops into LB and the two GF joins are drawn by
   *  the renderer from the known lane-final positions. */
  connectors: DoubleElimConnector[];
  k: number; // WB depth (rounds in the winners lane)
  wbRows: number; // 2^(k−1) row slots in WB col 0
  lbRows: number; // 2^(k−2) row slots in LB col 0 (0 when k === 1)
  lbCols: number; // 2k − 2
  resetId?: string;
}

export type DoubleElimLayoutResult =
  | { ok: true; layout: DoubleElimLayout }
  | { ok: false; reason: string };

/** LB columns advance in equal-count pairs — vertical spacing doubles every
 *  TWO columns, so renderers use rowCenter(lbRowUnit(col), row). */
export function lbRowUnit(col: number): number {
  return Math.floor(col / 2);
}

export function doubleElimBracket(
  fixtures: readonly BracketFixtureRef[],
): DoubleElimLayoutResult {
  if (fixtures.length === 0) return { ok: false, reason: "no fixtures" };

  const minRound = Math.min(...fixtures.map((f) => f.round_no));
  const byRound = new Map<number, BracketFixtureRef[]>();
  for (const f of fixtures) {
    const r = f.round_no - minRound;
    const list = byRound.get(r) ?? [];
    list.push(f);
    byRound.set(r, list);
  }
  for (const list of byRound.values()) list.sort((a, b) => a.seq_in_round - b.seq_in_round);
  const count = (r: number) => (byRound.get(r) ?? []).length;

  const c0 = count(0);
  if (c0 < 1 || (c0 & (c0 - 1)) !== 0) {
    return { ok: false, reason: `round 0 has ${c0} matches — not a power-of-two field` };
  }
  const k = Math.log2(c0) + 1;
  const lbCols = 2 * k - 2;

  // Expected occupancy, normalised: WB 0..k−1, LB 2k..2k+lbCols−1,
  // GF 5k−2 (+ reset 5k−1). Everything else must be empty.
  const expected = new Map<number, number>();
  for (let r = 0; r < k; r++) expected.set(r, 2 ** (k - 1 - r));
  for (let L = 0; L < lbCols; L++) expected.set(2 * k + L, 2 ** (k - 2 - Math.floor(L / 2)));
  expected.set(5 * k - 2, 1);
  const resetRound = 5 * k - 1;

  for (const [r, want] of expected) {
    if (count(r) !== want) {
      return { ok: false, reason: `round ${r + minRound} has ${count(r)} matches, expected ${want}` };
    }
  }
  for (const r of byRound.keys()) {
    if (!expected.has(r) && r !== resetRound) {
      return { ok: false, reason: `unexpected round ${r + minRound}` };
    }
  }
  const resetList = byRound.get(resetRound) ?? [];
  if (resetList.length > 1) {
    return { ok: false, reason: `reset round has ${resetList.length} matches` };
  }

  const nodes: DoubleElimNode[] = [];
  const connectors: DoubleElimConnector[] = [];

  for (let r = 0; r < k; r++) {
    byRound.get(r)!.forEach((f, i) => {
      nodes.push({ fixtureId: f.id, lane: "WB", col: r, row: i });
      if (r > 0) {
        connectors.push({ lane: "WB", col: r, fromRow: 2 * i, toRow: i });
        connectors.push({ lane: "WB", col: r, fromRow: 2 * i + 1, toRow: i });
      }
    });
  }
  for (let L = 0; L < lbCols; L++) {
    byRound.get(2 * k + L)!.forEach((f, i) => {
      nodes.push({ fixtureId: f.id, lane: "LB", col: L, row: i });
      if (L === 0) return; // fed by WB drops only
      if (L % 2 === 1) {
        // Major: LB winner comes straight across (the other side is a WB drop).
        connectors.push({ lane: "LB", col: L, fromRow: i, toRow: i });
      } else {
        connectors.push({ lane: "LB", col: L, fromRow: 2 * i, toRow: i });
        connectors.push({ lane: "LB", col: L, fromRow: 2 * i + 1, toRow: i });
      }
    });
  }
  nodes.push({ fixtureId: byRound.get(5 * k - 2)![0]!.id, lane: "GF", col: 0, row: 0 });
  let resetId: string | undefined;
  if (resetList.length === 1) {
    resetId = resetList[0]!.id;
    nodes.push({ fixtureId: resetId, lane: "GF", col: 1, row: 0 });
  }

  return {
    ok: true,
    layout: {
      nodes,
      connectors,
      k,
      wbRows: 2 ** (k - 1),
      lbRows: k >= 2 ? 2 ** (k - 2) : 0,
      lbCols,
      ...(resetId !== undefined ? { resetId } : {}),
    },
  };
}

export function twoSidedBracket(fixtures: readonly BracketFixtureRef[]): BracketLayoutResult {
  if (fixtures.length === 0) return { ok: false, reason: "no fixtures" };

  const minRound = Math.min(...fixtures.map((f) => f.round_no));
  const byRound = new Map<number, BracketFixtureRef[]>();
  for (const f of fixtures) {
    const r = f.round_no - minRound;
    const list = byRound.get(r) ?? [];
    list.push(f);
    byRound.set(r, list);
  }
  const rounds = Math.max(...byRound.keys()) + 1;
  for (const list of byRound.values()) {
    list.sort((a, b) => a.seq_in_round - b.seq_in_round);
  }

  const r0 = byRound.get(0) ?? [];
  const size = r0.length * 2; // entrant slots
  // Single-elim shape: round-0 count is a power of two ≥ 2, every later round
  // halves it, the last round holds the final (+ optionally one 3rd-place).
  if (r0.length < 1 || (r0.length & (r0.length - 1)) !== 0) {
    return { ok: false, reason: `round 0 has ${r0.length} matches — not a power-of-two field` };
  }
  if (rounds !== Math.log2(size)) {
    return { ok: false, reason: `expected ${Math.log2(size)} rounds for ${size} slots, got ${rounds}` };
  }
  for (let r = 0; r < rounds - 1; r++) {
    const expected = r0.length / 2 ** r;
    if ((byRound.get(r) ?? []).length !== expected) {
      return { ok: false, reason: `round ${r} has ${(byRound.get(r) ?? []).length} matches, expected ${expected}` };
    }
  }
  const last = byRound.get(rounds - 1) ?? [];
  if (last.length < 1 || last.length > 2) {
    return { ok: false, reason: `final round has ${last.length} matches` };
  }

  const colsPerSide = rounds - 1;
  const nodes: BracketNode[] = [];
  const connectors: BracketConnector[] = [];

  // Rounds before the final: first half of each round → L, second half → R.
  for (let r = 0; r < rounds - 1; r++) {
    const list = byRound.get(r)!;
    const half = list.length / 2;
    list.forEach((f, i) => {
      const side: "L" | "R" = i < half ? "L" : "R";
      const row = i < half ? i : i - half;
      nodes.push({ fixtureId: f.id, side, col: r, row });
      if (r > 0) {
        connectors.push({ side, col: r, fromRow: 2 * row, toRow: row });
        connectors.push({ side, col: r, fromRow: 2 * row + 1, toRow: row });
      }
    });
  }

  // Final (lowest seq in the last round) at centre; a second fixture there is
  // the 3rd-place playoff, hung underneath with no connectors of its own.
  const final = last[0]!;
  nodes.push({ fixtureId: final.id, side: "center", col: colsPerSide, row: 0 });
  let thirdPlaceId: string | undefined;
  if (last.length === 2) {
    thirdPlaceId = last[1]!.id;
    nodes.push({ fixtureId: thirdPlaceId, side: "center", col: colsPerSide, row: 1 });
  }
  if (rounds > 1) {
    connectors.push({ side: "L", col: colsPerSide, fromRow: 0, toRow: 0 });
    connectors.push({ side: "R", col: colsPerSide, fromRow: 0, toRow: 0 });
  }

  return {
    ok: true,
    layout: {
      nodes,
      connectors,
      rounds,
      colsPerSide,
      ...(thirdPlaceId !== undefined ? { thirdPlaceId } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// Page-system playoffs (IPL style, spec 2026-07-19): fixed 4-match shape —
// Qualifier 1 + Eliminator (round 0), Qualifier 2 (round 1), Final (round 2).
// Structural like the others: anything else returns { ok: false }.
// ---------------------------------------------------------------------------

export type PagePlayoffSlot = "q1" | "eliminator" | "q2" | "final";

export interface PagePlayoffNode {
  fixtureId: string;
  slot: PagePlayoffSlot;
}

export interface PagePlayoffLayout {
  nodes: PagePlayoffNode[]; // exactly four, in q1/eliminator/q2/final order
}

export type PagePlayoffLayoutResult =
  | { ok: true; layout: PagePlayoffLayout }
  | { ok: false; reason: string };

export function pagePlayoffBracket(
  fixtures: readonly BracketFixtureRef[],
): PagePlayoffLayoutResult {
  if (fixtures.length !== 4) return { ok: false, reason: `expected 4 fixtures, got ${fixtures.length}` };
  const minRound = Math.min(...fixtures.map((f) => f.round_no));
  const byRound = new Map<number, BracketFixtureRef[]>();
  for (const f of fixtures) {
    const r = f.round_no - minRound;
    const list = byRound.get(r) ?? [];
    list.push(f);
    byRound.set(r, list);
  }
  for (const list of byRound.values()) list.sort((a, b) => a.seq_in_round - b.seq_in_round);
  const r0 = byRound.get(0) ?? [];
  const r1 = byRound.get(1) ?? [];
  const r2 = byRound.get(2) ?? [];
  if (r0.length !== 2 || r1.length !== 1 || r2.length !== 1 || byRound.size !== 3) {
    return { ok: false, reason: `not the Q1/Eliminator → Q2 → Final shape (rounds ${[...byRound.keys()].sort().join(",")})` };
  }
  return {
    ok: true,
    layout: {
      nodes: [
        { fixtureId: r0[0]!.id, slot: "q1" },
        { fixtureId: r0[1]!.id, slot: "eliminator" },
        { fixtureId: r1[0]!.id, slot: "q2" },
        { fixtureId: r2[0]!.id, slot: "final" },
      ],
    },
  };
}
