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
    <span className={id && id === winner ? "font-semibold" : undefined}>
      {sideLabel(id, entrantNames)}
    </span>
  );
  return (
    <Link
      href={href}
      className="block rounded border border-zinc-200 bg-white p-2 text-sm shadow-sm hover:border-zinc-400"
    >
      <div className="flex flex-col gap-0.5">
        {side(fixture.home_entrant_id)}
        {side(fixture.away_entrant_id)}
      </div>
      <div className="mt-1 text-xs text-zinc-500">
        {fixture.status === "in_play" ? (
          <span className="font-medium text-red-600">LIVE</span>
        ) : (
          (fixture.summary?.headline ??
            (fixture.scheduled_at
              ? new Date(fixture.scheduled_at).toLocaleString("en-GB", {
                  day: "numeric",
                  month: "short",
                  hour: "2-digit",
                  minute: "2-digit",
                })
              : "TBD"))
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
  const roundName = (roundNo: number, count: number): string => {
    if (kind === "stepladder") return `Rung ${roundNo}`;
    if (count === 1) return "Final";
    if (count === 2) return "Semi-finals";
    if (count === 4) return "Quarter-finals";
    return `Round ${roundNo}`;
  };

  return (
    <div className="overflow-x-auto">
      <div className={kind === "stepladder" ? "flex flex-col gap-4" : "flex gap-6"}>
        {ordered.map(([roundNo, list]) => (
          <div key={roundNo} className="min-w-48">
            <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-zinc-500">
              {roundName(roundNo, list.length)}
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
