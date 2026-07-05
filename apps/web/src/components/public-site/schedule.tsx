"use client";
// Schedule tab (doc 09 §2): fixtures by round/date, entrant filter, decided
// scorelines from ScoreSummary.headline. Client-side filter keeps the page
// ISR-cacheable (searchParams would force dynamic rendering).
import Link from "next/link";
import { useState } from "react";
import type { PublicFixture } from "@/server/public-site/data";

interface Props {
  fixtures: PublicFixture[];
  entrantNames: Record<string, string>;
  divisionPath: string; // /{org}/{comp}/{div}
}

export function Schedule({ fixtures, entrantNames, divisionPath }: Props) {
  const [entrant, setEntrant] = useState<string>("");
  const shown = entrant
    ? fixtures.filter((f) => f.home_entrant_id === entrant || f.away_entrant_id === entrant)
    : fixtures;

  const rounds = new Map<number, PublicFixture[]>();
  for (const f of shown) {
    const list = rounds.get(f.round_no) ?? [];
    list.push(f);
    rounds.set(f.round_no, list);
  }

  const options = Object.entries(entrantNames).sort(([, a], [, b]) => a.localeCompare(b));

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <label className="text-sm text-zinc-600" htmlFor="entrant-filter">
          Filter
        </label>
        <select
          id="entrant-filter"
          value={entrant}
          onChange={(e) => setEntrant(e.target.value)}
          className="rounded border border-zinc-300 bg-white px-2 py-1 text-sm"
        >
          <option value="">All entrants</option>
          {options.map(([id, name]) => (
            <option key={id} value={id}>
              {name}
            </option>
          ))}
        </select>
        <a
          href={`${divisionPath}/calendar.ics${entrant ? `?entrant=${entrant}` : ""}`}
          className="text-sm text-blue-700 underline underline-offset-2"
        >
          Subscribe (.ics)
        </a>
      </div>

      {[...rounds.entries()]
        .sort(([a], [b]) => a - b)
        .map(([roundNo, list]) => (
          <section key={roundNo} className="mb-6">
            <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-zinc-500">
              Round {roundNo}
            </h3>
            <ul className="divide-y divide-zinc-100 rounded border border-zinc-200 bg-white">
              {list.map((f) => (
                <li key={f.id}>
                  <Link
                    href={`${divisionPath}/fixtures/${f.id}`}
                    className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm hover:bg-zinc-50"
                  >
                    <span>
                      {f.home_entrant_id ? (entrantNames[f.home_entrant_id] ?? "?") : "TBD"}
                      <span className="text-zinc-400"> vs </span>
                      {f.away_entrant_id ? (entrantNames[f.away_entrant_id] ?? "?") : "TBD"}
                    </span>
                    <span className="text-xs text-zinc-500">
                      {f.status === "in_play" ? (
                        <span className="font-medium text-red-600">LIVE</span>
                      ) : f.summary?.headline ? (
                        <span className="tabular-nums">{f.summary.headline}</span>
                      ) : (
                        <>
                          {f.scheduled_at
                            ? new Date(f.scheduled_at).toLocaleString("en-GB", {
                                weekday: "short",
                                day: "numeric",
                                month: "short",
                                hour: "2-digit",
                                minute: "2-digit",
                              })
                            : "Time TBD"}
                          {f.venue ? ` · ${f.venue}` : ""}
                          {f.court_label ? ` · ${f.court_label}` : ""}
                        </>
                      )}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ))}
      {shown.length === 0 ? (
        <p className="text-sm text-zinc-500">No fixtures yet.</p>
      ) : null}
    </div>
  );
}
