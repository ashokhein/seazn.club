"use client";
// Schedule tab (doc 09 §2): fixtures by round/date, entrant filter, decided
// scorelines from ScoreSummary.headline. Client-side filter keeps the page
// ISR-cacheable (searchParams would force dynamic rendering).
//
// Each fixture renders as a "scorebug" row — time/court rail, stacked sides,
// right-aligned per-side scores — the public site's signature element.
import Link from "next/link";
import { useState } from "react";
import { CalendarPlus } from "lucide-react";
import type { PublicFixture } from "@/server/public-site/data";
import { fmtTime, fmtDate, fmtZoneAbbrev } from "@/lib/format";

interface Props {
  fixtures: PublicFixture[];
  entrantNames: Record<string, string>;
  divisionPath: string; // /{org}/{comp}/{div}
  /** Venue zone (schedule_settings.tz) — times + day grouping are venue-local,
   *  the same for every viewer (spec 2026-07-14 two-lane, venue authoritative). */
  tz: string;
}

// Day bucket key as the venue-local calendar date (YYYY-MM-DD) so a 23:30 venue
// match doesn't slide onto the next/previous day for a viewer in another zone.
function dayKey(iso: string | null, tz: string): string | null {
  if (!iso) return null;
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date(iso)); // YYYY-MM-DD
  } catch {
    return new Intl.DateTimeFormat("en-CA").format(new Date(iso));
  }
}

const UNSCHEDULED = "unscheduled";

const timeOf = (iso: string, tz: string) => fmtTime(tz, iso);
const shortDate = (iso: string, tz: string) =>
  fmtDate(tz, iso, { weekday: "short", day: "numeric", month: "short" });

/** Per-side score lines fit the stacked layout only when short ("3", "21").
    Long lines (cricket innings, set strings) fall back to the headline chip. */
function sideLines(f: PublicFixture): [string, string] | null {
  const perSide = f.summary?.perSide;
  if (!perSide || perSide.length !== 2) return null;
  if (perSide.some((s) => s.line.length > 7)) return null;
  const byId = Object.fromEntries(perSide.map((s) => [s.entrantId, s.line]));
  const home = f.home_entrant_id ? byId[f.home_entrant_id] : undefined;
  const away = f.away_entrant_id ? byId[f.away_entrant_id] : undefined;
  return home != null && away != null ? [home, away] : null;
}

function ScorebugRow({
  fixture: f,
  entrantNames,
  href,
  railMode,
  tz,
}: {
  fixture: PublicFixture;
  entrantNames: Record<string, string>;
  href: string;
  railMode: "time" | "date";
  tz: string;
}) {
  const live = f.status === "in_play";
  const decided = f.status === "decided" || f.status === "finalized";
  const winner = f.outcome?.winner ?? null;
  const lines = decided || live ? sideLines(f) : null;
  const homeName = f.home_entrant_id ? (entrantNames[f.home_entrant_id] ?? "?") : "TBD";
  const awayName = f.away_entrant_id ? (entrantNames[f.away_entrant_id] ?? "?") : "TBD";

  const nameCls = (id: string | null) =>
    winner && id === winner
      ? "truncate text-[15px] font-semibold leading-6 text-ink"
      : winner
        ? "truncate text-[15px] font-medium leading-6 text-ink-muted"
        : "truncate text-[15px] font-medium leading-6 text-ink";
  const scoreCls = (id: string | null) => {
    const weight = winner && id === winner ? "font-bold" : "font-semibold";
    const color = live ? "text-emerald-600" : winner && id !== winner ? "text-ink-muted" : "text-ink";
    return `pl-2 text-right font-display text-lg tabular-nums leading-6 ${weight} ${color}`;
  };

  return (
    <Link
      href={href}
      className="relative grid grid-cols-[3.25rem_minmax(0,1fr)_auto] items-center gap-x-3 px-3.5 py-2.5 transition hover:bg-accent-soft/60"
    >
      {live ? <span aria-hidden className="absolute inset-y-0 left-0 w-0.5 bg-emerald-400" /> : null}

      <span className="row-span-2 flex flex-col items-start">
        {live ? (
          <span className="flex items-center gap-1 text-[11px] font-bold uppercase tracking-wide text-emerald-600">
            <span className="animate-live-pulse h-1.5 w-1.5 rounded-full bg-emerald-500" />
            Live
          </span>
        ) : (
          <span className="font-display text-sm font-semibold text-ink">
            {decided ? "Final" : f.scheduled_at ? timeOf(f.scheduled_at, tz) : "TBD"}
          </span>
        )}
        <span className="mt-0.5 max-w-[3.25rem] truncate text-[10px] uppercase tracking-wide text-ink-muted">
          {!decided && !live && railMode === "date" && f.scheduled_at
            ? shortDate(f.scheduled_at, tz)
            : (f.court_label ?? "")}
        </span>
      </span>

      <span className={nameCls(f.home_entrant_id)}>{homeName}</span>
      {lines ? (
        <span className={scoreCls(f.home_entrant_id)}>{lines[0]}</span>
      ) : (
        <span
          className={`row-span-2 self-center ${
            f.summary?.headline
              ? "rounded-full bg-accent-soft px-2.5 py-0.5 font-display text-sm font-semibold tabular-nums text-accent-strong"
              : "text-[11px] text-ink-muted"
          }`}
        >
          {f.summary?.headline ?? (f.venue && railMode === "time" ? f.venue : "")}
        </span>
      )}
      <span className={nameCls(f.away_entrant_id)}>{awayName}</span>
      {lines ? <span className={scoreCls(f.away_entrant_id)}>{lines[1]}</span> : null}
    </Link>
  );
}

export function Schedule({ fixtures, entrantNames, divisionPath, tz }: Props) {
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
    const key = mode === "day" ? (dayKey(f.scheduled_at, tz) ?? UNSCHEDULED) : String(f.round_no);
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
        <label className="sr-only" htmlFor="entrant-filter">
          Show matches for
        </label>
        <select
          id="entrant-filter"
          value={entrant}
          onChange={(e) => setEntrant(e.target.value)}
          className="rounded-lg border border-zinc-300 bg-surface px-2.5 py-1.5 text-sm text-ink outline-none transition focus:border-accent focus:ring-2 focus:ring-accent-line"
        >
          <option value="">All entrants</option>
          {options.map(([id, name]) => (
            <option key={id} value={id}>
              {name}
            </option>
          ))}
        </select>
        {anyScheduled && (
          <div
            role="group"
            aria-label="Group fixtures by"
            className="inline-flex overflow-hidden rounded-lg border border-zinc-300 text-sm"
          >
            {(["day", "round"] as const).map((v) => (
              <button
                key={v}
                type="button"
                aria-pressed={mode === v}
                onClick={() => setView(v)}
                className={`px-3 py-1.5 font-medium capitalize transition ${
                  mode === v
                    ? "bg-accent text-accent-ink"
                    : "bg-surface text-ink-muted hover:bg-accent-soft hover:text-accent-strong"
                }`}
              >
                {v}
              </button>
            ))}
          </div>
        )}
        <a
          href={`${divisionPath}/calendar.ics${entrant ? `?entrant=${entrant}` : ""}`}
          className="inline-flex items-center gap-1.5 text-sm font-medium text-accent-strong underline-offset-2 hover:underline"
        >
          <CalendarPlus aria-hidden className="h-4 w-4" />
          Add to calendar
        </a>
      </div>

      {orderedGroups.map(([key, list]) => (
        <section key={key} className="mb-6">
          <h3 className="mb-2 flex items-center gap-3 font-display text-sm font-semibold uppercase tracking-[0.18em] text-ink-muted">
            {groupLabel(key)}
            {(() => {
              const anchor = list.find((x) => x.scheduled_at)?.scheduled_at;
              return anchor ? (
                <span className="font-sans text-[10px] font-medium normal-case tracking-normal text-ink-muted/70">
                  times in {fmtZoneAbbrev(tz, anchor)}
                </span>
              ) : null;
            })()}
            <span aria-hidden className="h-px flex-1 bg-zinc-200" />
          </h3>
          <ul className="divide-y divide-zinc-100 overflow-hidden rounded-xl border border-zinc-200/80 bg-surface shadow-sm">
            {[...list]
              .sort((a, b) =>
                mode === "day"
                  ? (a.scheduled_at ?? "").localeCompare(b.scheduled_at ?? "") ||
                    a.round_no - b.round_no
                  : a.round_no - b.round_no,
              )
              .map((f) => (
                <li key={f.id}>
                  <ScorebugRow
                    fixture={f}
                    entrantNames={entrantNames}
                    href={`${divisionPath}/fixtures/${f.id}`}
                    railMode={mode === "day" ? "time" : "date"}
                    tz={tz}
                  />
                </li>
              ))}
          </ul>
        </section>
      ))}
      {shown.length === 0 ? (
        <p className="rounded-xl border border-dashed border-zinc-300 bg-surface p-6 text-center text-sm text-ink-muted">
          No fixtures yet — the schedule appears once the draw is made.
        </p>
      ) : null}
    </div>
  );
}
