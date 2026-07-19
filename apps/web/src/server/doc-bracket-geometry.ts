// Pure page geometry for the bracket poster (PROMPT-62 §4). Separated from
// the pdfkit renderer because the draw-call spy cannot detect on-page
// position/clipping (v12 gotcha) — the scale-to-fit guarantee is proven HERE,
// by unit test: every rect, line point and label stays inside the content box
// for any field up to 32 teams on one landscape sheet.
import type { DocBracket } from "@seazn/engine/exports";

export interface PageBox {
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface BracketRect {
  fixtureId: string;
  x: number;
  y: number;
  w: number;
  h: number;
  home: string;
  away: string;
  headline: string | null;
  decided: boolean;
  isCenter: boolean;
}
export interface BracketLine {
  points: [number, number][]; // H-V-H elbow, 4 points
}
export interface BracketLabel {
  text: string;
  x: number;
  y: number;
  w: number;
}
export interface BracketPageGeometry {
  rects: BracketRect[];
  lines: BracketLine[];
  labels: BracketLabel[];
}

const LABEL_H = 18;
const GAP = 7;

export function bracketPageGeometry(b: DocBracket, box: PageBox): BracketPageGeometry {
  const cols = 2 * b.colsPerSide + 1;
  const colW = box.w / cols;
  const bodyY = box.y + LABEL_H;
  const bodyH = box.h - LABEL_H - (b.thirdPlaceId !== undefined ? 0 : 0);
  const rowsPerSide = Math.max(1, b.rowsPerSide);
  // 3rd-place hangs under the final inside the same vertical budget.
  const slotH = bodyH / Math.max(rowsPerSide, 2);
  const nodeH = Math.min(slotH - GAP, 46);
  const nodeW = colW - GAP * 2;

  const rowCenter = (col: number, row: number): number => (row + 0.5) * 2 ** col * slotH;

  const colXLeft = (side: "L" | "R" | "center", col: number): number => {
    if (side === "L") return box.x + col * colW + GAP;
    if (side === "R") return box.x + (2 * b.colsPerSide - col) * colW + GAP;
    return box.x + b.colsPerSide * colW + GAP;
  };

  const rects: BracketRect[] = b.nodes.map((n) => {
    let y: number;
    if (n.side === "center") {
      const centre = bodyY + (rowsPerSide * slotH) / 2 - nodeH / 2;
      y = n.row === 0 ? centre : Math.min(centre + nodeH + GAP, box.y + box.h - nodeH);
    } else {
      y = bodyY + rowCenter(n.col, n.row) - nodeH / 2;
    }
    return {
      fixtureId: n.fixtureId,
      x: colXLeft(n.side, n.col),
      y,
      w: nodeW,
      h: nodeH,
      home: n.home,
      away: n.away,
      headline: n.headline,
      decided: n.decided,
      isCenter: n.side === "center",
    };
  });

  const lines: BracketLine[] = b.connectors.map((c) => {
    const isFinal = c.col === b.colsPerSide;
    const fromCol = c.col - 1;
    const fromRight = c.side === "L";
    const fx = colXLeft(c.side, fromCol) + (fromRight ? nodeW : 0);
    const fy = bodyY + rowCenter(fromCol, c.fromRow);
    const tx = isFinal
      ? colXLeft("center", b.colsPerSide) + (c.side === "L" ? 0 : nodeW)
      : colXLeft(c.side, c.col) + (fromRight ? 0 : nodeW);
    const ty = isFinal ? bodyY + (rowsPerSide * slotH) / 2 : bodyY + rowCenter(c.col, c.toRow);
    const midX = (fx + tx) / 2;
    return { points: [[fx, fy], [midX, fy], [midX, ty], [tx, ty]] };
  });

  const labels: BracketLabel[] = [];
  for (let col = 0; col < b.colsPerSide; col++) {
    const text = b.roundLabels[col] ?? "";
    labels.push({ text, x: box.x + col * colW + GAP, y: box.y, w: colW - GAP * 2 });
    labels.push({
      text,
      x: box.x + (2 * b.colsPerSide - col) * colW + GAP,
      y: box.y,
      w: colW - GAP * 2,
    });
  }
  labels.push({
    text: b.roundLabels[b.rounds - 1] ?? "Final",
    x: box.x + b.colsPerSide * colW + GAP,
    y: box.y,
    w: colW - GAP * 2,
  });

  return { rects, lines, labels };
}

// ---------------------------------------------------------------------------
// Double-elim edition (G-audit follow-up): winners lane above losers lane,
// grand final (+ reset) joining the lane finals. Same contract as the
// two-sided geometry — every rect/line/label proven inside the box by test.
// ---------------------------------------------------------------------------
import type { DocBracketDe, DocLadder } from "@seazn/engine/exports";

export function bracketDePageGeometry(b: DocBracketDe, box: PageBox): BracketPageGeometry {
  const cols = Math.max(b.k, b.lbCols) + (b.resetId !== undefined ? 2 : 1);
  const colW = box.w / cols;
  const laneGap = 16;
  const wbRows = Math.max(1, b.wbRows);
  const lbRows = Math.max(0, b.lbRows);
  const bodyY = box.y + LABEL_H;
  const bodyH = box.h - LABEL_H * (lbRows > 0 ? 2 : 1) - (lbRows > 0 ? laneGap : 0);
  const slotH = bodyH / Math.max(wbRows + lbRows, 2);
  const nodeH = Math.min(slotH - GAP, 46);
  const nodeW = colW - GAP * 2;
  const wbTop = bodyY;
  const lbTop = wbTop + wbRows * slotH + laneGap + LABEL_H;
  const gfX = box.x + Math.max(b.k, b.lbCols) * colW + GAP;
  const lbUnit = (col: number) => 2 ** Math.floor(col / 2);
  const wbY = (col: number, row: number) => wbTop + (row + 0.5) * 2 ** col * slotH;
  const lbY = (col: number, row: number) => lbTop + (row + 0.5) * lbUnit(col) * slotH;
  const gfY = lbRows > 0 ? (wbTop + lbTop + lbRows * slotH) / 2 : wbTop + (wbRows * slotH) / 2;

  const rects: BracketRect[] = b.nodes.map((n) => {
    const centerY = n.lane === "WB" ? wbY(n.col, n.row) : n.lane === "LB" ? lbY(n.col, n.row) : gfY;
    const x = n.lane === "GF" ? gfX + n.col * colW : box.x + n.col * colW + GAP;
    // Clamp inside the box — the reset column may sit at the right edge.
    const y = Math.min(Math.max(centerY - nodeH / 2, box.y), box.y + box.h - nodeH);
    return {
      fixtureId: n.fixtureId,
      x: Math.min(x, box.x + box.w - nodeW),
      y, w: nodeW, h: nodeH,
      home: n.home, away: n.away, headline: n.headline, decided: n.decided,
      isCenter: n.lane === "GF",
    };
  });

  const lines: BracketLine[] = b.connectors.map((c) => {
    const y = c.lane === "WB" ? wbY : lbY;
    const fx = box.x + (c.col - 1) * colW + GAP + nodeW;
    const tx = box.x + c.col * colW + GAP;
    const fy = y(c.col - 1, c.fromRow);
    const ty = y(c.col, c.toRow);
    const midX = (fx + tx) / 2;
    return { points: [[fx, fy], [midX, fy], [midX, ty], [tx, ty]] };
  });
  // Grand-final joins from both lane finals.
  const wbFx = box.x + (b.k - 1) * colW + GAP + nodeW;
  lines.push({ points: [[wbFx, wbY(b.k - 1, 0)], [gfX - GAP, wbY(b.k - 1, 0)], [gfX - GAP, gfY], [gfX, gfY]] });
  if (b.lbCols > 0) {
    const lbFx = box.x + (b.lbCols - 1) * colW + GAP + nodeW;
    lines.push({ points: [[lbFx, lbY(b.lbCols - 1, 0)], [gfX - GAP, lbY(b.lbCols - 1, 0)], [gfX - GAP, gfY], [gfX, gfY]] });
  }

  const labels: BracketLabel[] = [
    { text: b.laneLabels.winners, x: box.x + GAP, y: box.y, w: colW * 2 },
    { text: b.laneLabels.grandFinal, x: gfX, y: box.y, w: nodeW },
  ];
  if (lbRows > 0) {
    labels.push({ text: b.laneLabels.losers, x: box.x + GAP, y: lbTop - LABEL_H, w: colW * 2 });
  }
  if (b.resetId !== undefined) {
    labels.push({ text: b.laneLabels.reset, x: gfX + colW, y: box.y, w: nodeW });
  }
  return { rects, lines, labels };
}

// Stepladder edition: rungs stacked top (summit) to bottom, connectors up.
export function ladderPageGeometry(l: DocLadder, box: PageBox): BracketPageGeometry {
  const n = Math.max(1, l.rungs.length);
  const slotH = (box.h - LABEL_H) / n;
  const nodeH = Math.min(slotH - GAP, 52);
  const nodeW = Math.min(box.w * 0.6, 360);
  // Summit last in play order → drawn at the top.
  const ordered = [...l.rungs].reverse();
  const rects: BracketRect[] = ordered.map((r, i) => ({
    fixtureId: r.fixtureId,
    x: box.x + GAP,
    y: box.y + LABEL_H + i * slotH + (slotH - nodeH) / 2,
    w: nodeW, h: nodeH,
    home: r.home, away: r.away, headline: r.headline, decided: r.decided,
    isCenter: false,
  }));
  const lines: BracketLine[] = rects.slice(0, -1).map((r, i) => {
    const below = rects[i + 1]!;
    const x = r.x + nodeW + GAP * 2;
    return { points: [[below.x + nodeW, below.y + nodeH / 2], [x, below.y + nodeH / 2], [x, r.y + nodeH / 2], [r.x + nodeW, r.y + nodeH / 2]] };
  });
  const labels: BracketLabel[] = ordered.map((r, i) => ({
    text: r.label,
    x: box.x + GAP,
    y: box.y + LABEL_H + i * slotH - 2,
    w: nodeW,
  }));
  return { rects, lines, labels };
}

// Page playoffs (IPL): Q1 + Eliminator left, Q2 centre, Final right — the
// classic playoff card on one landscape sheet.
import type { DocPagePlayoff } from "@seazn/engine/exports";

export function pagePlayoffPageGeometry(pp: DocPagePlayoff, box: PageBox): BracketPageGeometry {
  const colW = box.w / 3;
  const nodeW = colW - GAP * 2;
  const nodeH = 46;
  const y0 = box.y + LABEL_H;
  const pos: Record<string, { x: number; y: number }> = {
    q1: { x: box.x + GAP, y: y0 },
    eliminator: { x: box.x + GAP, y: y0 + Math.min(box.h * 0.45, 180) },
    q2: { x: box.x + colW + GAP, y: y0 + Math.min(box.h * 0.28, 112) },
    final: { x: box.x + 2 * colW + GAP, y: y0 + Math.min(box.h * 0.12, 50) },
  };
  const rects: BracketRect[] = pp.nodes.map((n) => ({
    fixtureId: n.fixtureId,
    x: pos[n.slot]!.x,
    y: Math.min(pos[n.slot]!.y, box.y + box.h - nodeH),
    w: nodeW, h: nodeH,
    home: n.home, away: n.away, headline: n.headline, decided: n.decided,
    isCenter: n.slot === "final",
  }));
  const c = (slot: string) => ({ x: pos[slot]!.x, y: Math.min(pos[slot]!.y, box.y + box.h - nodeH) + nodeH / 2 });
  const rx2 = (slot: string) => pos[slot]!.x + nodeW;
  const lines: BracketLine[] = [
    { points: [[rx2("q1"), c("q1").y], [(rx2("q1") + pos.q2!.x) / 2, c("q1").y], [(rx2("q1") + pos.q2!.x) / 2, c("q2").y], [pos.q2!.x, c("q2").y]] },
    { points: [[rx2("eliminator"), c("eliminator").y], [(rx2("eliminator") + pos.q2!.x) / 2, c("eliminator").y], [(rx2("eliminator") + pos.q2!.x) / 2, c("q2").y], [pos.q2!.x, c("q2").y]] },
    { points: [[rx2("q1"), c("q1").y], [(rx2("q1") + pos.final!.x) / 2 + 30, c("q1").y], [(rx2("q1") + pos.final!.x) / 2 + 30, c("final").y], [pos.final!.x, c("final").y]] },
    { points: [[rx2("q2"), c("q2").y], [(rx2("q2") + pos.final!.x) / 2, c("q2").y], [(rx2("q2") + pos.final!.x) / 2, c("final").y], [pos.final!.x, c("final").y]] },
  ];
  const labels: BracketLabel[] = pp.nodes.map((n) => ({
    text: pp.slotLabels[n.slot],
    x: pos[n.slot]!.x,
    y: Math.min(pos[n.slot]!.y, box.y + box.h - nodeH) - LABEL_H + 2,
    w: nodeW,
  }));
  return { rects, lines, labels };
}
