"use client";
// Live scoreboard for the public match page (doc 09 §2). Entitlement split
// (doc 09 §4): Pro orgs get Supabase Realtime push on `fixture:{id}`; everyone
// falls back to 15 s polling of the public fixture endpoint. Reuses the
// use-tournament-realtime pattern (renamed per PROMPT-12 item 3), inlined here
// because the public page authenticates with a public token endpoint instead
// of the org-member one.
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/client";

const POLL_MS = 15_000;

export interface LiveFixtureData {
  status: string;
  summary: { headline?: string; perSide?: { entrantId: string; line: string }[] } | null;
  outcome: { kind?: string; winner?: string } | null;
}

interface Props {
  fixtureId: string;
  initial: LiveFixtureData;
  realtime: boolean; // org entitlement, resolved server-side
  entrantNames: Record<string, string>;
}

export function LiveScore({ fixtureId, initial, realtime, entrantNames }: Props) {
  const [data, setData] = useState<LiveFixtureData>(initial);

  const refresh = useCallback(async () => {
    try {
      const res = await api<{ data: LiveFixtureData }>(`/api/v1/public/fixtures/${fixtureId}`);
      setData(res.data);
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
        token = (
          await api<{ data: { token: string; channel: string } }>(
            `/api/v1/public/fixtures/${fixtureId}/realtime-token`,
          )
        ).data;
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
  return (
    <div
      className={`rounded-2xl border p-5 shadow-sm ${
        inPlay
          ? "border-emerald-200 bg-gradient-to-br from-emerald-50 via-white to-white"
          : "border-purple-100 bg-white"
      }`}
    >
      {inPlay ? (
        <p className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-emerald-700">
          <span className="animate-live-pulse h-2 w-2 rounded-full bg-emerald-500" />
          Live{subscribed ? " · realtime" : ""}
        </p>
      ) : (
        <p className="mb-2 text-xs font-medium uppercase tracking-wide text-zinc-500">
          {data.status.replace("_", " ")}
        </p>
      )}
      <p className="text-4xl font-black tabular-nums tracking-tight text-zinc-900">
        {data.summary?.headline ?? "Not started"}
      </p>
      {data.summary?.perSide ? (
        <ul className="mt-3 space-y-1.5 text-sm text-zinc-700">
          {data.summary.perSide.map((side) => (
            <li key={side.entrantId} className="flex items-center gap-2 tabular-nums">
              <span className="font-medium">{entrantNames[side.entrantId] ?? "—"}</span>
              <span className="rounded-full bg-purple-50 px-2 py-0.5 text-xs font-semibold text-purple-700">
                {side.line}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {data.outcome?.winner ? (
        <p className="mt-3 flex items-center gap-1.5 text-sm text-zinc-600">
          <span className="animate-trophy">🏆</span>
          Winner:{" "}
          <strong className="text-zinc-900">
            {entrantNames[data.outcome.winner] ?? data.outcome.winner}
          </strong>
        </p>
      ) : null}
    </div>
  );
}
