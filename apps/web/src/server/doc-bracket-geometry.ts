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
