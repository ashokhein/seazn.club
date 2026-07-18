// Server component: round-robin results matrix (G2) — the classic crosstable
// for league/group stages. Rows = home side, columns = away side; a cell
// holds the scoreline of home-vs-away (linked), a live dot while in play, or
// a dot placeholder for an unplayed pairing. Zero per-sport code: scorelines
// come from ScoreSummary.headline, order comes from the standings.
import Link from "next/link";
import type { PublicFixture } from "@/server/public-site/data";
import { EntityLogo } from "@/components/ui/entity-logo";

interface Props {
  /** Row/column order — pass the standings rank order. */
  entrantIds: string[];
  entrantNames: Record<string, string>;
  entrantLogos?: Record<string, string | null>;
  /** Fixtures of ONE pool/stage scope; pairings outside entrantIds are ignored. */
  fixtures: PublicFixture[];
  fixtureHref: (fixtureId: string) => string;
  caption?: string;
}

const DONE = new Set(["decided", "finalized", "forfeited", "abandoned"]);

export function ResultsMatrix({
  entrantIds,
  entrantNames,
  entrantLogos,
  fixtures,
  fixtureHref,
  caption,
}: Props) {
  if (entrantIds.length < 2) return null;
  // home → away → fixtures (double round-robins stack two lines in a cell).
  const byPair = new Map<string, PublicFixture[]>();
  for (const f of fixtures) {
    if (!f.home_entrant_id || !f.away_entrant_id) continue;
    const key = `${f.home_entrant_id}:${f.away_entrant_id}`;
    const list = byPair.get(key) ?? [];
    list.push(f);
    byPair.set(key, list);
  }
  const initials = (id: string) =>
    (entrantNames[id] ?? "?")
      .split(/\s+/)
      .map((w) => w[0])
      .join("")
      .slice(0, 2)
      .toUpperCase();

  return (
    <div
      className="overflow-x-auto rounded-xl border border-zinc-200/80 bg-surface shadow-sm"
      data-results-matrix
    >
      <table className="w-full text-sm">
        {caption ? (
          <caption className="px-4 py-2.5 text-left font-display text-sm font-semibold text-ink">
            {caption}
          </caption>
        ) : null}
        <thead>
          <tr className="border-b border-zinc-200/80 text-xs text-ink-muted">
            <th scope="col" className="px-3 py-2 text-left font-medium">
              Home \ Away
            </th>
            {entrantIds.map((id) => (
              <th
                key={id}
                scope="col"
                title={entrantNames[id] ?? "?"}
                className="px-2 py-2 text-center font-medium"
              >
                {entrantLogos ? (
                  <span className="inline-flex items-center justify-center">
                    <EntityLogo src={entrantLogos[id] ?? null} name={entrantNames[id] ?? "?"} size={20} />
                  </span>
                ) : (
                  initials(id)
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {entrantIds.map((rowId) => (
            <tr key={rowId} className="border-b border-zinc-100 last:border-0">
              <th
                scope="row"
                className="max-w-44 truncate px-3 py-2 text-left font-medium text-ink"
              >
                <span className="flex items-center gap-2">
                  {entrantLogos ? (
                    <EntityLogo src={entrantLogos[rowId] ?? null} name={entrantNames[rowId] ?? "?"} size={20} />
                  ) : null}
                  <span className="truncate">{entrantNames[rowId] ?? "?"}</span>
                </span>
              </th>
              {entrantIds.map((colId) => {
                if (rowId === colId) {
                  return (
                    <td key={colId} aria-hidden className="bg-zinc-100/70 px-2 py-2 text-center">
                      <span className="text-zinc-300">—</span>
                    </td>
                  );
                }
                const cell = byPair.get(`${rowId}:${colId}`) ?? [];
                return (
                  <td key={colId} className="px-2 py-2 text-center tabular-nums">
                    {cell.length === 0 ? (
                      <span className="text-zinc-300">·</span>
                    ) : (
                      <span className="flex flex-col items-center gap-0.5">
                        {cell.map((f) =>
                          f.status === "in_play" ? (
                            <Link key={f.id} href={fixtureHref(f.id)} aria-label="Live">
                              <span className="animate-live-pulse inline-block h-2 w-2 rounded-full bg-emerald-500" />
                            </Link>
                          ) : DONE.has(f.status) && f.summary?.headline ? (
                            <Link
                              key={f.id}
                              href={fixtureHref(f.id)}
                              className="font-display text-[13px] font-semibold text-accent-strong hover:underline"
                            >
                              {f.summary.headline}
                            </Link>
                          ) : (
                            <span key={f.id} className="text-zinc-300">
                              ·
                            </span>
                          ),
                        )}
                      </span>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
