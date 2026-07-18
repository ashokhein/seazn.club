// Server component: bracket view for knockout/double-elim stages and ladder
// view for stepladder (doc 09 §2). Pure layout from round numbers — no
// per-sport code; scorelines come from ScoreSummary.headline.
// PROMPT-62: single-elim knockouts render as the classic two-sided tree
// (shared engine geometry, same as the console panel and the PDF poster);
// double-elim / stepladder / irregular shapes keep the column fallback.
import Link from "next/link";
import type { PublicFixture } from "@/server/public-site/data";
import {
  rowCenter,
  twoSidedBracket,
  type BracketLayout,
  type BracketNode,
} from "@seazn/engine/scheduling";

interface Props {
  kind: "knockout" | "double_elim" | "stepladder";
  fixtures: PublicFixture[];
  entrantNames: Record<string, string>;
  fixtureHref: (fixtureId: string) => string;
}

function sideLabel(entrantId: string | null, names: Record<string, string>): string {
  return entrantId ? (names[entrantId] ?? "?") : "TBD";
}

function FixtureCard({
  fixture,
  entrantNames,
  href,
}: {
  fixture: PublicFixture;
  entrantNames: Record<string, string>;
  href: string;
}) {
  const winner = fixture.outcome?.winner;
  const side = (id: string | null) => (
    <span
      className={
        id && id === winner
          ? "truncate font-semibold text-ink"
          : winner
            ? "truncate text-ink-muted"
            : "truncate text-ink"
      }
    >
      {sideLabel(id, entrantNames)}
    </span>
  );
  const live = fixture.status === "in_play";
  return (
    <Link
      href={href}
      className={`relative block overflow-hidden rounded-lg border bg-surface p-2.5 text-sm shadow-sm transition hover:-translate-y-0.5 hover:shadow ${
        live ? "border-emerald-300 hover:border-emerald-400" : "border-zinc-200/80 hover:border-accent-line"
      }`}
    >
      {winner ? <span aria-hidden className="absolute inset-y-0 left-0 w-0.5 bg-accent" /> : null}
      {live ? <span aria-hidden className="absolute inset-y-0 left-0 w-0.5 bg-emerald-400" /> : null}
      <div className="flex flex-col gap-0.5">
        {side(fixture.home_entrant_id)}
        {side(fixture.away_entrant_id)}
      </div>
      <div className="mt-1.5 text-xs text-ink-muted">
        {live ? (
          <span className="flex items-center gap-1.5 font-bold uppercase tracking-wide text-emerald-600">
            <span className="animate-live-pulse h-1.5 w-1.5 rounded-full bg-emerald-500" />
            Live
          </span>
        ) : fixture.summary?.headline ? (
          <span className="font-display text-sm font-semibold tabular-nums text-accent-strong">
            {fixture.summary.headline}
          </span>
        ) : fixture.scheduled_at ? (
          new Date(fixture.scheduled_at).toLocaleString("en-GB", {
            day: "numeric",
            month: "short",
            hour: "2-digit",
            minute: "2-digit",
          })
        ) : (
          "TBD"
        )}
      </div>
    </Link>
  );
}

const COL_W = 208;
const NODE_W = COL_W - 20;
const SLOT_H = 104;
const NODE_H = 92;

function TwoSided({
  layout,
  fixtures,
  entrantNames,
  fixtureHref,
}: {
  layout: BracketLayout;
  fixtures: PublicFixture[];
  entrantNames: Record<string, string>;
  fixtureHref: (fixtureId: string) => string;
}) {
  const byId = new Map(fixtures.map((f) => [f.id, f]));
  const rowsPerSide = Math.max(
    1,
    layout.nodes.filter((n) => n.col === 0 && n.side === "L").length,
  );
  const totalW = (2 * layout.colsPerSide + 1) * COL_W;
  const totalH =
    Math.max(rowsPerSide * SLOT_H, SLOT_H * 2) +
    (layout.thirdPlaceId !== undefined ? NODE_H + 20 : 0);
  const colX = (node: Pick<BracketNode, "side" | "col">): number => {
    if (node.side === "L") return node.col * COL_W;
    if (node.side === "R") return (2 * layout.colsPerSide - node.col) * COL_W + (COL_W - NODE_W);
    return layout.colsPerSide * COL_W + (COL_W - NODE_W) / 2;
  };
  const nodeTop = (node: BracketNode): number => {
    if (node.side === "center") {
      const centre = (rowsPerSide * SLOT_H) / 2 - NODE_H / 2;
      return node.row === 0 ? centre : centre + NODE_H + 20;
    }
    return rowCenter(node.col, node.row) * SLOT_H - NODE_H / 2;
  };

  return (
    <div className="overflow-x-auto" data-bracket="two-sided">
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
            const fromCol = c.col - 1;
            const fx =
              c.side === "L"
                ? fromCol * COL_W + NODE_W
                : (2 * layout.colsPerSide - fromCol) * COL_W + (COL_W - NODE_W);
            const fy = rowCenter(fromCol, c.fromRow) * SLOT_H;
            const tx = isFinal
              ? layout.colsPerSide * COL_W + (c.side === "L" ? (COL_W - NODE_W) / 2 : COL_W - (COL_W - NODE_W) / 2)
              : c.side === "L"
                ? c.col * COL_W
                : (2 * layout.colsPerSide - c.col) * COL_W + COL_W;
            const ty = isFinal ? (rowsPerSide * SLOT_H) / 2 : rowCenter(c.col, c.toRow) * SLOT_H;
            const midX = (fx + tx) / 2;
            return (
              <path
                key={i}
                d={`M ${fx} ${fy} H ${midX} V ${ty} H ${tx}`}
                fill="none"
                className="stroke-zinc-300"
                strokeWidth="1.5"
              />
            );
          })}
        </svg>
        {layout.nodes.map((node) => {
          const f = byId.get(node.fixtureId);
          if (!f) return null;
          return (
            <div
              key={node.fixtureId}
              data-side={node.side}
              className="absolute"
              style={{ left: colX(node), top: nodeTop(node), width: NODE_W }}
            >
              <FixtureCard fixture={f} entrantNames={entrantNames} href={fixtureHref(f.id)} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function Bracket({ kind, fixtures, entrantNames, fixtureHref }: Props) {
  // PROMPT-62: the connected two-sided tree, when the shape allows it.
  if (kind === "knockout") {
    const result = twoSidedBracket(fixtures);
    if (result.ok) {
      return (
        <TwoSided
          layout={result.layout}
          fixtures={fixtures}
          entrantNames={entrantNames}
          fixtureHref={fixtureHref}
        />
      );
    }
  }
  const rounds = new Map<number, PublicFixture[]>();
  for (const f of fixtures) {
    const list = rounds.get(f.round_no) ?? [];
    list.push(f);
    rounds.set(f.round_no, list);
  }
  const ordered = [...rounds.entries()].sort(([a], [b]) => a - b);
  // Distance from the last round — stable even when byes thin out a round.
  // Double-elim round numbers encode WB/LB/GF lanes, so keep plain numbers.
  const maxRound = ordered.length > 0 ? ordered[ordered.length - 1][0] : 0;
  const roundName = (roundNo: number): string => {
    if (kind === "stepladder") return `Rung ${roundNo}`;
    if (kind === "knockout") {
      const fromEnd = maxRound - roundNo;
      if (fromEnd === 0) return "Final";
      if (fromEnd === 1) return "Semi-finals";
      if (fromEnd === 2) return "Quarter-finals";
    }
    return `Round ${roundNo}`;
  };

  return (
    <div className="overflow-x-auto">
      <div className={kind === "stepladder" ? "flex flex-col gap-4" : "flex gap-6"}>
        {ordered.map(([roundNo, list]) => (
          <div key={roundNo} className="min-w-48">
            <h3 className="mb-2 font-display text-sm font-semibold uppercase tracking-[0.18em] text-ink-muted">
              {roundName(roundNo)}
            </h3>
            <div className="flex flex-col justify-around gap-3">
              {list
                .sort((a, b) => a.seq_in_round - b.seq_in_round)
                .map((f) => (
                  <FixtureCard
                    key={f.id}
                    fixture={f}
                    entrantNames={entrantNames}
                    href={fixtureHref(f.id)}
                  />
                ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
