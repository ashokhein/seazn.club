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

// ── Double-elim + stepladder editions (G-audit follow-up) ────────────────────
import { buildBracketDe, buildLadderPoster, type DocBracketDe, type DocLadder } from "@seazn/engine/exports";
import { generateDoubleElim } from "@seazn/engine/scheduling";
import { bracketDePageGeometry, ladderPageGeometry } from "../doc-bracket-geometry";

const LANES = { winners: "Winners bracket", losers: "Losers bracket", grandFinal: "Grand final", reset: "Reset" };

function deFieldOf(n: number, reset = false): DocBracketDe {
  const entrants = Array.from({ length: n }, (_, i) => `T${i + 1}`);
  const gen = generateDoubleElim({ entrants, bracketReset: reset });
  const k = gen.rounds;
  const counters = new Map<string, number>();
  const fixtures = gen.fixtures.map((f) => {
    const lane = f.bracket ?? "WB";
    const offset = lane === "LB" ? k : lane === "GF" ? 2 * k : 0;
    const round_no = offset + f.round + 1;
    const seq = (counters.get(`${lane}:${round_no}`) ?? 0) + 1;
    counters.set(`${lane}:${round_no}`, seq);
    return {
      id: f.id, round_no, seq_in_round: seq,
      home: f.home ?? null, away: f.away ?? null,
      headline: null, decided: false,
    };
  });
  return buildBracketDe("DE Cup", fixtures, LANES, { printedAt: "2026-07-19T00:00:00Z" }).bracketDe!;
}

function inBox(x: number, y: number) {
  expect(x).toBeGreaterThanOrEqual(BOX.x - 0.01);
  expect(x).toBeLessThanOrEqual(BOX.x + BOX.w + 0.01);
  expect(y).toBeGreaterThanOrEqual(BOX.y - 0.01);
  expect(y).toBeLessThanOrEqual(BOX.y + BOX.h + 0.01);
}

describe("bracketDePageGeometry — one-sheet bounds", () => {
  for (const [n, reset] of [[8, false], [8, true], [16, false]] as const) {
    it(`${n}-team double elim${reset ? " + reset" : ""} stays inside the box`, () => {
      const g = bracketDePageGeometry(deFieldOf(n, reset), BOX);
      expect(g.rects.length).toBeGreaterThan(0);
      for (const r of g.rects) {
        inBox(r.x, r.y);
        inBox(r.x + r.w, r.y + r.h);
      }
      for (const line of g.lines) for (const [x, y] of line.points) inBox(x, y);
      for (const l of g.labels) inBox(l.x, l.y);
    });
  }

  it("lane labels present (winners, losers, grand final; reset only when configured)", () => {
    const withReset = bracketDePageGeometry(deFieldOf(8, true), BOX);
    const texts = withReset.labels.map((l) => l.text);
    expect(texts).toContain("Winners bracket");
    expect(texts).toContain("Losers bracket");
    expect(texts).toContain("Grand final");
    expect(texts).toContain("Reset");
    const without = bracketDePageGeometry(deFieldOf(8, false), BOX);
    expect(without.labels.map((l) => l.text)).not.toContain("Reset");
  });
});

describe("ladderPageGeometry — one-sheet bounds", () => {
  function ladderOf(n: number): DocLadder {
    const fixtures = Array.from({ length: n }, (_, i) => ({
      id: `r${i + 1}`, round_no: i + 1, seq_in_round: 1,
      home: i === 0 ? "Challenger A" : null, away: `Seed ${n + 1 - i}`,
      headline: i === 0 ? "2–1" : null, decided: i === 0,
    }));
    return buildLadderPoster("Ladder", fixtures, (i) => `Rung ${i + 1}`, { printedAt: "2026-07-19T00:00:00Z" }).ladder!;
  }

  it("7 rungs stay inside the box, summit drawn first (top)", () => {
    const g = ladderPageGeometry(ladderOf(7), BOX);
    expect(g.rects).toHaveLength(7);
    for (const r of g.rects) {
      inBox(r.x, r.y);
      inBox(r.x + r.w, r.y + r.h);
    }
    for (const line of g.lines) for (const [x, y] of line.points) inBox(x, y);
    // Top rect is the last rung (the summit), bottom rect is rung 1.
    expect(g.labels[0]!.text).toBe("Rung 7");
    expect(g.labels[g.labels.length - 1]!.text).toBe("Rung 1");
  });
});
