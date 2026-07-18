"use client";
// Live scoreboard for the public match page (doc 09 §2). Entitlement split
// (doc 09 §4): Pro orgs get Supabase Realtime push on `fixture:{id}`; everyone
// falls back to 15 s polling of the public fixture endpoint. Reuses the
// use-tournament-realtime pattern (renamed per PROMPT-12 item 3), inlined here
// because the public page authenticates with a public token endpoint instead
// of the org-member one.
import { useCallback, useEffect, useState } from "react";
import {
  disciplineLabel,
  disciplineList,
  matchStrength,
  periodBreakdown,
  servingSide,
  setBreakdown,
  stripLiveSetPoints,
} from "@/lib/public-site";
import {
  fetchLiveFixture,
  fetchPublicRealtimeToken,
  type LiveFixtureData,
} from "./live-score-data";

const POLL_MS = 15_000;

export type { LiveFixtureData };

interface Props {
  fixtureId: string;
  initial: LiveFixtureData;
  realtime: boolean; // org entitlement, resolved server-side
  entrantNames: Record<string, string>;
  sportKey: string;
}

export function LiveScore({ fixtureId, initial, realtime, entrantNames, sportKey }: Props) {
  const [data, setData] = useState<LiveFixtureData>(initial);

  const refresh = useCallback(async () => {
    try {
      setData(await fetchLiveFixture(fixtureId));
    } catch {
      // transient — keep the last known score
    }
  }, [fixtureId]);

  const live = data.status === "in_play" || data.status === "scheduled";

  // Realtime push (Pro orgs). Any failure — no entitlement (403), env missing,
  // websocket refused — leaves `subscribed` false and polling takes over.
  const [subscribed, setSubscribed] = useState(false);
  useEffect(() => {
    if (!realtime || !live) return;
    if (!process.env.NEXT_PUBLIC_SUPABASE_URL) return;
    let cancelled = false;
    let debounce: ReturnType<typeof setTimeout> | null = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let channel: any = null;

    (async () => {
      let token: { token: string; channel: string };
      try {
        token = await fetchPublicRealtimeToken(fixtureId);
      } catch {
        return; // not entitled or server error → polling
      }
      if (cancelled) return;
      const { supabaseBrowser } = await import("@/lib/supabase-browser");
      const sb = supabaseBrowser();
      await sb.realtime.setAuth(token.token);
      channel = sb
        .channel(token.channel, { config: { private: true } })
        .on("broadcast", { event: "state_changed" }, () => {
          if (debounce) clearTimeout(debounce);
          debounce = setTimeout(refresh, 250);
        })
        .subscribe((status: string) => {
          if (!cancelled) setSubscribed(status === "SUBSCRIBED");
        });
    })();

    return () => {
      cancelled = true;
      if (debounce) clearTimeout(debounce);
      channel?.unsubscribe();
      setSubscribed(false);
    };
  }, [fixtureId, realtime, live, refresh]);

  // 15 s polling fallback (Community, or realtime not connected).
  useEffect(() => {
    if (!live || subscribed) return;
    const id = setInterval(refresh, POLL_MS);
    return () => clearInterval(id);
  }, [live, subscribed, refresh]);

  const inPlay = data.status === "in_play";
  const decided = data.status === "decided" || data.status === "finalized";
  const breakdown = setBreakdown(data.summary, sportKey);
  // Kernel perSide order is [home, away]; row labels come from it.
  const sideIds = data.summary?.perSide?.map((s) => s.entrantId) ?? [];
  const showBreakdown = breakdown !== null && sideIds.length === 2;
  // Period-kernel surfaces (v6/00 §5): power-play strength while live,
  // goals-by-period once periods exist, the discipline list, tennis serve dot.
  const strength = inPlay ? matchStrength(data.summary) : null;
  const periods = periodBreakdown(data.summary);
  const discipline = disciplineList(data.summary);
  const serving = inPlay ? servingSide(data.summary) : null;
  return (
    <div className="space-y-4">
      {/* Court-slab scorebug — the broadcast moment of the page. */}
      <div className="overflow-hidden rounded-2xl bg-court text-court-ink shadow-lg">
        <div className="p-5 sm:p-6">
          {inPlay ? (
            <p className="mb-3 flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.22em] text-emerald-300">
              <span className="animate-live-pulse h-2 w-2 rounded-full bg-emerald-400" />
              Live{subscribed ? " · realtime" : ""}
              {strength ? (
                <span className="rounded-full bg-amber-400/20 px-2 py-0.5 font-mono text-[11px] font-bold tracking-normal text-amber-300">
                  {strength}
                </span>
              ) : null}
            </p>
          ) : (
            <p className="mb-3 text-[11px] font-semibold uppercase tracking-[0.22em] text-court-muted">
              {decided ? "Ended" : data.status.replace("_", " ")}
            </p>
          )}
          <p className="font-display text-5xl font-bold tabular-nums leading-none tracking-tight sm:text-6xl">
            {data.summary?.headline
              ? showBreakdown
                ? stripLiveSetPoints(data.summary.headline)
                : data.summary.headline
              : "Not started"}
          </p>
          {!showBreakdown && data.summary?.perSide ? (
            <ul className="mt-5 space-y-2">
              {data.summary.perSide.map((side, row) => {
                const isWinner = data.outcome?.winner === side.entrantId;
                const hasServe = serving !== null && (row === 0 ? "home" : "away") === serving;
                return (
                  <li
                    key={side.entrantId}
                    className={`flex items-baseline justify-between gap-3 tabular-nums ${
                      data.outcome?.winner && !isWinner ? "opacity-60" : ""
                    }`}
                  >
                    <span className="truncate font-display text-xl font-semibold uppercase tracking-wide sm:text-2xl">
                      {hasServe ? (
                        <span aria-label="serving" className="mr-1.5 text-amber-300">●</span>
                      ) : null}
                      {entrantNames[side.entrantId] ?? "—"}
                    </span>
                    <span className="shrink-0 font-display text-xl font-bold sm:text-2xl">
                      {side.line}
                    </span>
                  </li>
                );
              })}
            </ul>
          ) : null}
          {data.outcome?.winner ? (
            <p className="mt-4 flex items-center gap-1.5 text-sm text-court-muted">
              <span className="animate-trophy">🏆</span>
              Winner:{" "}
              <strong className="text-amber-300">
                {entrantNames[data.outcome.winner] ?? data.outcome.winner}
              </strong>
            </p>
          ) : null}
        </div>
        <div aria-hidden className={`h-1 ${inPlay ? "bg-emerald-400" : "bg-accent"}`} />
      </div>

      {showBreakdown ? (
        <SetScoreboard
          breakdown={breakdown}
          names={sideIds.map((id, row) => {
            const name = entrantNames[id] ?? "—";
            const hasServe = serving !== null && (row === 0 ? "home" : "away") === serving;
            return hasServe ? `● ${name}` : name;
          })}
        />
      ) : null}

      {periods && sideIds.length === 2 ? (
        <div className="rounded-2xl border border-zinc-200/80 bg-surface p-5 shadow-sm">
          <p className="mb-3 font-display text-sm font-semibold uppercase tracking-[0.18em] text-ink-muted">
            Goals by period
          </p>
          <div className="overflow-x-auto">
            <table className="w-full border-separate border-spacing-0 tabular-nums">
              <thead>
                <tr>
                  <th className="w-full" />
                  {periods.map((p) => (
                    <th
                      key={p.phase}
                      className="min-w-14 px-3 pb-2 text-center text-xs font-medium uppercase tracking-wide text-zinc-400"
                    >
                      {p.phase}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(["home", "away"] as const).map((side, row) => (
                  <tr key={side}>
                    <td
                      className={`max-w-40 truncate pr-4 text-sm font-medium text-zinc-800 ${row === 0 ? "border-b border-zinc-100" : ""} py-2`}
                    >
                      {entrantNames[sideIds[row]!] ?? "—"}
                    </td>
                    {periods.map((p) => (
                      <td
                        key={p.phase}
                        className={`px-3 py-2 text-center font-display text-xl font-medium text-zinc-700 ${row === 0 ? "border-b border-zinc-100" : ""}`}
                      >
                        {p[side]}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      {discipline && sideIds.length === 2 ? (
        <div className="rounded-2xl border border-zinc-200/80 bg-surface p-5 shadow-sm">
          <p className="mb-3 font-display text-sm font-semibold uppercase tracking-[0.18em] text-ink-muted">
            Discipline
          </p>
          <ul className="space-y-1.5">
            {discipline.map((entry, i) => (
              <li key={i} className="flex items-center gap-2 text-sm text-zinc-700">
                <span
                  aria-hidden
                  className={`h-3 w-2 rounded-[2px] ${
                    entry.classKey === "red" || entry.classKey === "match"
                      ? "bg-red-500"
                      : entry.classKey === "green"
                        ? "bg-emerald-500"
                        : "bg-amber-400"
                  }`}
                />
                <span className="font-medium">{disciplineLabel(entry.classKey)}</span>
                <span className="text-zinc-500">
                  — {entrantNames[sideIds[entry.side === "home" ? 0 : 1]!] ?? "—"}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

/** Per-set scoreboard card: one column per played set, live set tinted. */
function SetScoreboard({
  breakdown,
  names,
}: {
  breakdown: NonNullable<ReturnType<typeof setBreakdown>>;
  names: string[];
}) {
  const sides = ["home", "away"] as const;
  return (
    <div className="rounded-2xl border border-zinc-200/80 bg-surface p-5 shadow-sm">
      <p className="mb-3 font-display text-sm font-semibold uppercase tracking-[0.18em] text-ink-muted">
        Score by {breakdown.unit.toLowerCase()}
      </p>
      <div className="overflow-x-auto">
        <table className="w-full border-separate border-spacing-0 tabular-nums">
          <thead>
            <tr>
              <th className="w-full" />
              {breakdown.sets.map((s, i) => (
                <th
                  key={i}
                  className={`min-w-14 rounded-t-lg px-3 pb-2 text-center text-xs font-medium uppercase tracking-wide ${
                    s.closed ? "text-zinc-400" : "bg-emerald-50 text-emerald-700"
                  }`}
                >
                  <span className="inline-flex items-center gap-1.5">
                    {!s.closed && (
                      <span className="animate-live-pulse h-1.5 w-1.5 rounded-full bg-emerald-500" />
                    )}
                    {breakdown.unit} {i + 1}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sides.map((side, row) => (
              <tr key={side}>
                <td
                  className={`max-w-40 truncate pr-4 text-sm font-medium text-zinc-800 ${
                    row === 0 ? "border-b border-zinc-100" : ""
                  } py-2`}
                >
                  {names[row]}
                </td>
                {breakdown.sets.map((s, i) => {
                  const mine = s[side];
                  const theirs = s[side === "home" ? "away" : "home"];
                  const wonSet = s.closed && mine > theirs;
                  const liveCell = !s.closed;
                  return (
                    <td
                      key={i}
                      className={`px-3 py-2 text-center font-display text-2xl ${
                        row === 0 ? "border-b border-zinc-100" : ""
                      } ${row === 1 && liveCell ? "rounded-b-lg" : ""} ${
                        liveCell
                          ? "bg-emerald-50 font-bold text-emerald-700"
                          : wonSet
                            ? "font-bold text-ink"
                            : "font-medium text-zinc-400"
                      }`}
                    >
                      {mine}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
