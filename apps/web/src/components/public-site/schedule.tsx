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

function dayKey(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const UNSCHEDULED = "unscheduled";

export function Schedule({ fixtures, entrantNames, divisionPath }: Props) {
  const [entrant, setEntrant] = useState<string>("");
  // Day view first (fixtures by date) — matches how a spectator reads a
  // timetable on the day. Round view stays a click away for bracket-style flow.
  const [view, setView] = useState<"day" | "round">("day");
  const shown = entrant
    ? fixtures.filter((f) => f.home_entrant_id === entrant || f.away_entrant_id === entrant)
    : fixtures;

  // Only offer the day view when at least one fixture actually has a date.
  const anyScheduled = fixtures.some((f) => f.scheduled_at);
  const mode = anyScheduled ? view : "round";

  const groups = new Map<string, PublicFixture[]>();
  for (const f of shown) {
    const key =
      mode === "day" ? (dayKey(f.scheduled_at) ?? UNSCHEDULED) : String(f.round_no);
    const list = groups.get(key) ?? [];
    list.push(f);
    groups.set(key, list);
  }

  const orderedGroups = [...groups.entries()].sort(([a], [b]) => {
    if (mode === "day") {
      if (a === UNSCHEDULED) return 1;
      if (b === UNSCHEDULED) return -1;
      return a.localeCompare(b);
    }
    return Number(a) - Number(b);
  });

  const groupLabel = (key: string): string => {
    if (mode === "round") return `Round ${key}`;
    if (key === UNSCHEDULED) return "Time TBD";
    return new Date(`${key}T12:00`).toLocaleDateString("en-GB", {
      weekday: "long",
      day: "numeric",
      month: "long",
    });
  };

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
          className="rounded-lg border border-purple-200 bg-white px-2.5 py-1.5 text-sm outline-none focus:border-purple-500 focus:ring-2 focus:ring-purple-200"
        >
          <option value="">All entrants</option>
          {options.map(([id, name]) => (
            <option key={id} value={id}>
              {name}
            </option>
          ))}
        </select>
        {anyScheduled && (
          <div className="inline-flex overflow-hidden rounded-lg border border-purple-200 text-sm">
            {(["day", "round"] as const).map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => setView(v)}
                className={`px-3 py-1.5 font-medium capitalize transition ${
                  mode === v
                    ? "bg-purple-600 text-white"
                    : "bg-white text-purple-700 hover:bg-purple-50"
                }`}
              >
                {v}
              </button>
            ))}
          </div>
        )}
        <a
          href={`${divisionPath}/calendar.ics${entrant ? `?entrant=${entrant}` : ""}`}
          className="text-sm font-medium text-purple-700 underline underline-offset-2 hover:text-purple-900"
        >
          Subscribe (.ics)
        </a>
      </div>

      {orderedGroups.map(([key, list]) => (
          <section key={key} className="mb-6">
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-purple-700/70">
              {groupLabel(key)}
            </h3>
            <ul className="divide-y divide-purple-50 overflow-hidden rounded-xl border border-purple-100 bg-white shadow-sm">
              {[...list]
                .sort((a, b) =>
                  mode === "day"
                    ? (a.scheduled_at ?? "").localeCompare(b.scheduled_at ?? "") ||
                      a.round_no - b.round_no
                    : a.round_no - b.round_no,
                )
                .map((f) => (
                <li key={f.id}>
                  <Link
                    href={`${divisionPath}/fixtures/${f.id}`}
                    className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-sm transition hover:bg-purple-50/60"
                  >
                    <span className="font-medium">
                      {f.home_entrant_id ? (entrantNames[f.home_entrant_id] ?? "?") : "TBD"}
                      <span className="font-normal text-zinc-400"> vs </span>
                      {f.away_entrant_id ? (entrantNames[f.away_entrant_id] ?? "?") : "TBD"}
                    </span>
                    <span className="text-xs text-zinc-500">
                      {f.status === "in_play" ? (
                        <span className="flex items-center gap-1.5 rounded-full bg-emerald-50 px-2 py-0.5 font-semibold text-emerald-700">
                          <span className="animate-live-pulse h-1.5 w-1.5 rounded-full bg-emerald-500" />
                          LIVE
                        </span>
                      ) : f.summary?.headline ? (
                        <span className="rounded-full bg-purple-50 px-2 py-0.5 font-semibold tabular-nums text-purple-700">
                          {f.summary.headline}
                        </span>
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
