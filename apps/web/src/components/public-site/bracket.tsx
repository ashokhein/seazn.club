// Server component: bracket view for knockout/double-elim stages and ladder
// view for stepladder (doc 09 §2). Pure layout from round numbers — no
// per-sport code; scorelines come from ScoreSummary.headline.
import Link from "next/link";
import type { PublicFixture } from "@/server/public-site/data";

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

export function Bracket({ kind, fixtures, entrantNames, fixtureHref }: Props) {
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
