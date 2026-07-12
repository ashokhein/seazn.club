import type { PreviewPhase } from "@/server/usecases/stages";
import { buildDrawGraph, type MapNode } from "@/lib/marketing/draw-graph";
import { Reveal } from "./reveal";

/** SVG mind-map renderer for The Draw (design/v3/12 §4.4, revised 12 Jul):
 *  the division-wizard diagram language over live engine output. Nodes pop
 *  and edges draw themselves once on view; static under reduced motion. */

function NodeBox({ node, i }: { node: MapNode; i: number }) {
  const delay = { animationDelay: `${Math.min(i * 45, 900)}ms` };
  switch (node.kind) {
    case "label":
      return (
        <text
          className="mk-map-node mk-display"
          style={delay}
          x={node.x + node.w / 2}
          y={node.y + node.h}
          textAnchor="middle"
          fontSize="11"
          letterSpacing="0.14em"
          fill="#7e22ce"
          fontWeight="600"
        >
          {node.lines[0]}
        </text>
      );
    case "trophy":
      return (
        <text
          className="mk-map-node"
          style={delay}
          x={node.x + node.w / 2}
          y={node.y + node.h / 2 + 8}
          textAnchor="middle"
          fontSize="22"
        >
          🏆
        </text>
      );
    case "entrant":
      return (
        <g className="mk-map-node" style={delay}>
          <rect x={node.x} y={node.y} width={node.w} height={node.h} rx={node.h / 2} fill="var(--mk-light-violet)" stroke="#d8b4fe" />
          <text x={node.x + node.w / 2} y={node.y + node.h / 2 + 3.5} textAnchor="middle" fontSize="10.5" fill="#3b0764" fontWeight="600">
            {node.lines[0]}
          </text>
        </g>
      );
    case "hub":
      return (
        <g className="mk-map-node" style={delay}>
          <rect x={node.x} y={node.y} width={node.w} height={node.h} rx="12" fill="var(--mk-night)" stroke="var(--mk-lime)" strokeWidth="2" />
          <text x={node.x + node.w / 2} y={node.y + 20} textAnchor="middle" fontSize="11" fill="var(--mk-cream)" fontWeight="600">
            {node.lines[0]}
          </text>
          <text className="mk-display" x={node.x + node.w / 2} y={node.y + 38} textAnchor="middle" fontSize="12" fill="var(--mk-lime)" fontWeight="700" letterSpacing="0.06em">
            {node.lines[1]}
          </text>
        </g>
      );
    case "pool":
      return (
        <g className="mk-map-node" style={delay}>
          <rect x={node.x} y={node.y} width={node.w} height={node.h} rx="10" fill="white" stroke="#d8b4fe" strokeWidth="1.5" />
          <text className="mk-display" x={node.x + 12} y={node.y + 19} fontSize="11" fill="#7e22ce" fontWeight="700" letterSpacing="0.1em">
            {node.lines[0]?.toUpperCase()}
          </text>
          {node.lines.slice(1).map((m, j) => (
            <text key={j} x={node.x + 12} y={node.y + 36 + j * 17} fontSize="11" fill="#1e1b2e">
              {m}
            </text>
          ))}
        </g>
      );
    default: // match
      return (
        <g className="mk-map-node" style={delay}>
          <rect x={node.x} y={node.y} width={node.w} height={node.h} rx="8" fill="white" stroke="#c4b5fd" strokeWidth="1.5" />
          <line x1={node.x + 8} y1={node.y + node.h / 2} x2={node.x + node.w - 8} y2={node.y + node.h / 2} stroke="#f3e8ff" />
          <text x={node.x + 10} y={node.y + 15} fontSize="10.5" fill="#1e1b2e" fontWeight="600">
            {node.lines[0]}
          </text>
          <text x={node.x + 10} y={node.y + 32} fontSize="10.5" fill="#1e1b2e" fontWeight="600">
            {node.lines[1]}
          </text>
        </g>
      );
  }
}

export function DrawMindmap({ phases, names }: { phases: PreviewPhase[]; names: string[] }) {
  const graph = buildDrawGraph(phases, names);
  return (
    <Reveal className="overflow-x-auto">
      <svg
        viewBox={`0 0 ${graph.width} ${graph.height}`}
        className="mx-auto h-auto w-full max-w-4xl"
        style={{ minWidth: 560 }}
        role="img"
        aria-label="Generated tournament structure diagram"
      >
        {graph.edges.map((e, i) => (
          <path
            key={e.id}
            className="mk-map-edge"
            style={{ animationDelay: `${Math.min(i * 45, 900)}ms` }}
            d={e.d}
            pathLength={1}
            fill="none"
            stroke="#c4b5fd"
            strokeWidth="1.5"
          />
        ))}
        {graph.nodes.map((n, i) => (
          <NodeBox key={n.id} node={n} i={i} />
        ))}
      </svg>
    </Reveal>
  );
}
