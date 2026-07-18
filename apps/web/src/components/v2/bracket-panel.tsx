"use client";

// Console two-sided bracket (PROMPT-62 §2) — the knockout counterpart of the
// flat StagesPanel list (which stays for scheduling/Documents). Geometry comes
// from the shared engine `twoSidedBracket`, so console, public and PDF can
// never diverge. Renders nothing for non-single-elim shapes (double-elim /
// stepladder keep their existing views).
import Link from "@/components/ui/console-link";
import { routes } from "@/lib/routes";
import { useMsg } from "@/components/i18n/dict-provider";
import {
  rowCenter,
  twoSidedBracket,
  type BracketLayout,
  type BracketNode,
} from "@seazn/engine/scheduling";

interface FixtureLike {
  id: string;
  round_no: number;
  seq_in_round: number;
  fixture_no: number;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  status: string;
  outcome: unknown;
}

interface Props {
  fixtures: FixtureLike[];
  entrantNames: Record<string, string>;
  /** entrant_id → resolved badge URL (PROMPT-60 resolver); null/absent = none. */
  entrantBadges?: Record<string, string | null>;
  /** fixture_id → ScoreSummary.headline (from match_states). */
  headlines?: Record<string, string>;
  orgSlug: string;
  compSlug: string;
  divSlug: string;
}

const COL_W = 190; // px per bracket column
const SLOT_H = 76; // px per round-0 slot
const NODE_H = 60;
const NODE_W = COL_W - 24;

/** Horizontal px of a node's column: L columns grow rightwards, R columns
 *  mirror from the right edge, the centre Final sits in the middle. */
function colX(node: Pick<BracketNode, "side" | "col">, colsPerSide: number): number {
  if (node.side === "L") return node.col * COL_W;
  if (node.side === "R") return (2 * colsPerSide - node.col) * COL_W;
  return colsPerSide * COL_W; // center
}

export function BracketPanel({
  fixtures,
  entrantNames,
  entrantBadges,
  headlines,
  orgSlug,
  compSlug,
  divSlug,
}: Props) {
  const msg = useMsg();
  const result = twoSidedBracket(fixtures);
  if (!result.ok) return null;
  const layout: BracketLayout = result.layout;
  const byId = new Map(fixtures.map((f) => [f.id, f]));

  const totalW = (2 * layout.colsPerSide + 1) * COL_W;
  const rowsPerSide = Math.max(
    1,
    layout.nodes.filter((n) => n.col === 0 && n.side === "L").length,
  );
  const totalH = Math.max(rowsPerSide * SLOT_H, SLOT_H * 2) + (layout.thirdPlaceId ? NODE_H + 16 : 0);

  const nodeTop = (node: BracketNode): number => {
    if (node.side === "center") {
      const centre = (rowsPerSide * SLOT_H) / 2 - NODE_H / 2;
      return node.row === 0 ? centre : centre + NODE_H + 16; // 3rd place hangs under
    }
    return rowCenter(node.col, node.row) * SLOT_H - NODE_H / 2;
  };
  const nodeCenterY = (side: "L" | "R", col: number, row: number): number =>
    rowCenter(col, row) * SLOT_H;

  const side = (entrantId: string | null, winner: string | null, live: boolean) => {
    const name = entrantId ? (entrantNames[entrantId] ?? entrantId) : null;
    const badge = entrantId ? entrantBadges?.[entrantId] : null;
    const isWinner = winner !== null && winner === entrantId;
    const muted = winner !== null && winner !== entrantId;
    return (
      <span className="flex min-w-0 items-center gap-1.5">
        {badge ? (
          // eslint-disable-next-line @next/next/no-img-element -- tenant crest
          <img src={badge} alt="" className="h-3.5 w-3.5 shrink-0 rounded-[3px] object-cover" />
        ) : null}
        <span
          className={`truncate text-xs ${
            name === null
              ? "italic text-[color:var(--app-fg-muted,#94a3b8)]"
              : isWinner
                ? "font-semibold text-[color:var(--app-fg,#e2e8f0)]"
                : muted
                  ? "text-[color:var(--app-fg-muted,#94a3b8)]"
                  : "text-[color:var(--app-fg,#e2e8f0)]"
          }`}
        >
          {name ?? msg("bracket.tbd")}
        </span>
        {live && <span className="animate-live-pulse h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-400" />}
      </span>
    );
  };

  return (
    <section className="card overflow-hidden" data-testid="bracket-panel">
      <header className="border-b border-slate-100 px-4 py-3">
        <h3 className="text-sm font-semibold text-slate-800">{msg("bracket.title")}</h3>
      </header>
      <div className="overflow-x-auto bg-[color:var(--app-surface,#0f172a)] p-4">
        <div className="relative" style={{ width: totalW, height: totalH }}>
          <svg
            aria-hidden
            className="absolute inset-0"
            width={totalW}
            height={totalH}
            viewBox={`0 0 ${totalW} ${totalH}`}
          >
            {layout.connectors.map((c, i) => {
              const isFinal = c.col === layout.colsPerSide;
              // Feeder centre (col-1 for normal targets; innermost side column
              // feeds the Final).
              const fromCol = c.col - 1;
              const fx =
                c.side === "L"
                  ? fromCol * COL_W + NODE_W
                  : (2 * layout.colsPerSide - fromCol) * COL_W + (COL_W - NODE_W);
              const fy = nodeCenterY(c.side, fromCol, c.fromRow);
              const tx = isFinal
                ? layout.colsPerSide * COL_W + (c.side === "L" ? 0 : NODE_W)
                : c.side === "L"
                  ? c.col * COL_W
                  : (2 * layout.colsPerSide - c.col) * COL_W + NODE_W;
              const ty = isFinal
                ? (rowsPerSide * SLOT_H) / 2
                : nodeCenterY(c.side, c.col, c.toRow);
              const midX = (fx + tx) / 2;
              return (
                <path
                  key={i}
                  d={`M ${fx} ${fy} H ${midX} V ${ty} H ${tx}`}
                  fill="none"
                  stroke="var(--app-hairline, #334155)"
                  strokeWidth="1.5"
                />
              );
            })}
          </svg>
          {layout.nodes.map((node) => {
            const f = byId.get(node.fixtureId);
            if (!f) return null;
            const winner = (f.outcome as { winner?: string } | null)?.winner ?? null;
            const live = f.status === "in_play";
            const headline = headlines?.[f.id];
            return (
              <Link
                key={node.fixtureId}
                href={routes.fixture(orgSlug, compSlug, divSlug, f.fixture_no)}
                data-side={node.side}
                className="absolute block rounded-lg border border-[color:var(--app-hairline,#334155)] bg-[color:var(--app-card,#1e293b)] px-2.5 py-1.5 shadow-sm transition hover:-translate-y-0.5 hover:shadow"
                style={{
                  left: colX(node, layout.colsPerSide) + (node.side === "R" ? COL_W - NODE_W : 0),
                  top: nodeTop(node),
                  width: NODE_W,
                  height: NODE_H,
                }}
              >
                <span className="flex h-full flex-col justify-center gap-0.5">
                  {side(f.home_entrant_id, winner, live)}
                  {side(f.away_entrant_id, winner, live)}
                </span>
                {headline !== undefined && (
                  <span className="absolute right-2 top-1.5 font-display text-[11px] tabular-nums text-[color:var(--app-fg-muted,#94a3b8)]">
                    {headline}
                  </span>
                )}
              </Link>
            );
          })}
        </div>
      </div>
    </section>
  );
}
