// The scale-to-fit proof for the bracket poster (PROMPT-62 §4): pdfkit
// silently suppresses content at/below the bottom margin and the draw-call
// spy can't see position, so the one-landscape-sheet guarantee is pinned here.
import { describe, expect, it } from "vitest";
import { buildBracket, type DocBracket } from "@seazn/engine/exports";
import { bracketPageGeometry } from "../doc-bracket-geometry";

// A4 landscape: 841.89 × 595.28, margin 40, masthead+title ≈ 120pt used.
const BOX = { x: 40, y: 130, w: 841.89 - 80, h: 595.28 - 130 - 50 };

function fieldOf(n: number): DocBracket {
  const rounds = Math.log2(n);
  const fixtures: { id: string; round_no: number; seq_in_round: number; home: string | null; away: string | null; headline: string | null; decided: boolean }[] = [];
  for (let r = 0; r < rounds; r++) {
    const games = n / 2 ** (r + 1);
    for (let i = 0; i < games; i++) {
      fixtures.push({
        id: `r${r}-i${i}`, round_no: r, seq_in_round: i + 1,
        home: r === 0 ? `Team ${2 * i + 1}` : null, away: r === 0 ? `Team ${2 * i + 2}` : null,
        headline: r === 0 ? "2–1" : null, decided: r === 0,
      });
    }
  }
  return buildBracket("Cup", fixtures, { printedAt: "2026-07-18T00:00:00Z" }).bracket!;
}

describe("bracketPageGeometry — one-sheet bounds", () => {
  for (const n of [4, 8, 16, 32]) {
    it(`${n}-team field: every rect, line point and label inside the content box`, () => {
      const g = bracketPageGeometry(fieldOf(n), BOX);
      for (const r of g.rects) {
        expect(r.x).toBeGreaterThanOrEqual(BOX.x);
        expect(r.y).toBeGreaterThanOrEqual(BOX.y);
        expect(r.x + r.w).toBeLessThanOrEqual(BOX.x + BOX.w + 0.01);
        expect(r.y + r.h).toBeLessThanOrEqual(BOX.y + BOX.h + 0.01);
        expect(r.h).toBeGreaterThan(10); // still readable
      }
      for (const l of g.lines) {
        for (const [x, y] of l.points) {
          expect(x).toBeGreaterThanOrEqual(BOX.x - 0.01);
          expect(x).toBeLessThanOrEqual(BOX.x + BOX.w + 0.01);
          expect(y).toBeGreaterThanOrEqual(BOX.y - 0.01);
          expect(y).toBeLessThanOrEqual(BOX.y + BOX.h + 0.01);
        }
      }
      for (const label of g.labels) {
        expect(label.x).toBeGreaterThanOrEqual(BOX.x);
        expect(label.x + label.w).toBeLessThanOrEqual(BOX.x + BOX.w + 0.01);
      }
    });
  }

  it("keeps the 3rd-place node inside the box too", () => {
    const b = fieldOf(4);
    const withThird: DocBracket = {
      ...b,
      thirdPlaceId: "tp",
      nodes: [...b.nodes, { fixtureId: "tp", side: "center", col: b.colsPerSide, row: 1, home: "X", away: "Y", headline: null, decided: false }],
    };
    const g = bracketPageGeometry(withThird, BOX);
    const tp = g.rects.find((r) => r.fixtureId === "tp")!;
    expect(tp.y + tp.h).toBeLessThanOrEqual(BOX.y + BOX.h + 0.01);
  });
});
