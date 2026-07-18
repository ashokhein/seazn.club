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
