import type { PreviewPhase } from "@/server/usecases/stages";

/** Layout engine for the home-page Draw mind-map (design/v3/12 §4.4, revised
 *  per founder feedback 12 Jul: diagram, not a vs-list). Pure math over the
 *  engine's PreviewPhase output so the SVG renderer stays dumb and the
 *  geometry is unit-testable. Canvas width is fixed; height grows. */

export interface MapNode {
  id: string;
  kind: "match" | "pool" | "hub" | "entrant" | "trophy" | "label";
  x: number;
  y: number;
  w: number;
  h: number;
  lines: string[];
}
export interface MapEdge {
  id: string;
  d: string; // SVG path
}
export interface DrawGraph {
  width: number;
  height: number;
  nodes: MapNode[];
  edges: MapEdge[];
}

const W = 800;
const MW = 148; // match node
const MH = 40;
const GX = 72;
const GY = 14;
const PAD = 18;

const trunc = (s: string, n = 17) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function nameFor(token: string, names: string[]): string {
  if (/^[A-Z]$/.test(token)) return names[token.charCodeAt(0) - 65] ?? token;
  return token;
}

/** Cubic connector between bracket columns. */
function edgePath(x1: number, y1: number, x2: number, y2: number): string {
  const mx = (x1 + x2) / 2;
  return `M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`;
}

/** Bracket columns for knockout-style phases (also the double-elim fallback). */
function bracketLayout(
  phase: PreviewPhase,
  names: string[],
  yOff: number,
  idp: string,
): { nodes: MapNode[]; edges: MapEdge[]; height: number } {
  const rounds = phase.sections;
  const nodes: MapNode[] = [];
  const edges: MapEdge[] = [];
  const m0 = rounds[0]?.matches.length ?? 0;
  if (m0 === 0) return { nodes, edges, height: 0 };

  const innerH = Math.max(m0 * (MH + GY), MH + GY);
  const cols = rounds.length;
  const totalW = cols * MW + (cols - 1) * GX + MW * 0.6; // room for trophy
  const x0 = Math.max(PAD, (W - totalW) / 2);

  const pos: Array<Array<{ cx: number; cy: number }>> = [];
  rounds.forEach((round, r) => {
    const x = x0 + r * (MW + GX);
    pos[r] = [];
    round.matches.forEach((m, i) => {
      const cy = yOff + PAD + ((i + 0.5) * innerH) / round.matches.length;
      pos[r]![i] = { cx: x + MW / 2, cy };
      nodes.push({
        id: `${idp}-m${r}-${i}`,
        kind: "match",
        x,
        y: cy - MH / 2,
        w: MW,
        h: MH,
        lines: [trunc(nameFor(m.home, names)), trunc(nameFor(m.away, names))],
      });
    });
    // round label above the column
    nodes.push({
      id: `${idp}-l${r}`,
      kind: "label",
      x,
      y: yOff + PAD - 16,
      w: MW,
      h: 12,
      lines: [round.title],
    });
    if (r > 0 && round.matches.length === Math.ceil(rounds[r - 1]!.matches.length / 2)) {
      rounds[r - 1]!.matches.forEach((_, j) => {
        const child = pos[r - 1]![j]!;
        const parent = pos[r]![Math.floor(j / 2)]!;
        edges.push({
          id: `${idp}-e${r}-${j}`,
          d: edgePath(child.cx + MW / 2, child.cy, parent.cx - MW / 2, parent.cy),
        });
      });
    }
  });

  // trophy to the right of the last single-match round
  const last = rounds[rounds.length - 1]!;
  if (last.matches.length === 1) {
    const p = pos[rounds.length - 1]![0]!;
    nodes.push({
      id: `${idp}-t`,
      kind: "trophy",
      x: p.cx + MW / 2 + 26,
      y: p.cy - 16,
      w: 32,
      h: 32,
      lines: ["🏆"],
    });
    edges.push({
      id: `${idp}-et`,
      d: edgePath(p.cx + MW / 2, p.cy, p.cx + MW / 2 + 26, p.cy),
    });
  }
  return { nodes, edges, height: PAD * 2 + innerH };
}

/** Pool boxes with member names, side by side. */
function poolsLayout(
  phase: PreviewPhase,
  names: string[],
  yOff: number,
  idp: string,
): { nodes: MapNode[]; edges: MapEdge[]; height: number } {
  const nodes: MapNode[] = [];
  const pools = phase.sections;
  const boxW = 168;
  const gap = 36;
  const rowW = pools.length * boxW + (pools.length - 1) * gap;
  const x0 = Math.max(PAD, (W - rowW) / 2);
  let maxH = 0;
  pools.forEach((pool, i) => {
    const members: string[] = [];
    for (const m of pool.matches) {
      for (const t of [m.home, m.away]) {
        const nm = nameFor(t, names);
        if (!members.includes(nm)) members.push(nm);
      }
    }
    const h = 30 + members.length * 17 + 8;
    maxH = Math.max(maxH, h);
    nodes.push({
      id: `${idp}-p${i}`,
      kind: "pool",
      x: x0 + i * (boxW + gap),
      y: yOff + PAD,
      w: boxW,
      h,
      lines: [pool.title, ...members.map((m) => trunc(m, 19))],
    });
  });
  return { nodes, edges: [], height: PAD * 2 + maxH };
}

/** Radial mind-map for league phases: hub + one pill per entrant. */
function radialLayout(
  phase: PreviewPhase,
  names: string[],
  yOff: number,
  idp: string,
): { nodes: MapNode[]; edges: MapEdge[]; height: number } {
  const entrants: string[] = [];
  for (const s of phase.sections) {
    for (const m of s.matches) {
      for (const t of [m.home, m.away]) {
        const nm = nameFor(t, names);
        if (!entrants.includes(nm)) entrants.push(nm);
      }
    }
  }
  const rounds = phase.sections.length;
  const matches = phase.sections.reduce((a, s) => a + s.matches.length, 0);
  const n = entrants.length;
  const R = 118 + n * 5;
  const cx = W / 2;
  const cy = yOff + PAD + R + 30;

  const nodes: MapNode[] = [];
  const edges: MapEdge[] = [];
  const pillW = 130;
  const pillH = 22;

  entrants.forEach((name, i) => {
    const a = (i / n) * Math.PI * 2 - Math.PI / 2;
    const px = cx + Math.cos(a) * R;
    const py = cy + Math.sin(a) * R * 0.72; // gentle ellipse
    edges.push({ id: `${idp}-s${i}`, d: `M ${cx} ${cy} L ${px} ${py}` });
    nodes.push({
      id: `${idp}-n${i}`,
      kind: "entrant",
      x: px - pillW / 2,
      y: py - pillH / 2,
      w: pillW,
      h: pillH,
      lines: [trunc(name, 18)],
    });
  });
  nodes.push({
    id: `${idp}-hub`,
    kind: "hub",
    x: cx - 105,
    y: cy - 26,
    w: 210,
    h: 52,
    lines: ["Everyone plays everyone", `${rounds} rounds · ${matches} matches`],
  });
  return { nodes, edges, height: PAD * 2 + R * 1.72 + 60 + pillH };
}

export function buildDrawGraph(phases: PreviewPhase[], names: string[]): DrawGraph {
  const nodes: MapNode[] = [];
  const edges: MapEdge[] = [];
  let y = 0;

  phases.forEach((phase, pi) => {
    const idp = `p${pi}`;
    // phase title banner
    nodes.push({
      id: `${idp}-title`,
      kind: "label",
      x: W / 2 - 150,
      y: y + 6,
      w: 300,
      h: 16,
      lines: [phase.title.toUpperCase()],
    });
    y += 30;

    const isPools = phase.sections.some((s) => /^(pool|group)\s/i.test(s.title));
    const isLeague = /league/i.test(phase.title) && !isPools;
    const block = isPools
      ? poolsLayout(phase, names, y, idp)
      : isLeague
        ? radialLayout(phase, names, y, idp)
        : bracketLayout(phase, names, y, idp);
    nodes.push(...block.nodes);
    edges.push(...block.edges);
    y += block.height;

    if (phase.note && block.nodes.length === 0) {
      nodes.push({
        id: `${idp}-note`,
        kind: "label",
        x: W / 2 - 260,
        y,
        w: 520,
        h: 16,
        lines: [phase.note],
      });
      y += 34;
    }

    if (pi < phases.length - 1) {
      nodes.push({
        id: `${idp}-adv`,
        kind: "label",
        x: W / 2 - 120,
        y: y + 2,
        w: 240,
        h: 14,
        lines: ["QUALIFIERS ADVANCE ↓"],
      });
      y += 30;
    }
  });

  return { width: W, height: Math.max(y + PAD, 120), nodes, edges };
}
