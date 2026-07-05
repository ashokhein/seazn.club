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

  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-4">
      {data.status === "in_play" ? (
        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-red-600">
          Live{subscribed ? " · realtime" : ""}
        </p>
      ) : (
        <p className="mb-2 text-xs font-medium uppercase tracking-wide text-zinc-500">
          {data.status.replace("_", " ")}
        </p>
      )}
      <p className="text-2xl font-semibold tabular-nums">
        {data.summary?.headline ?? "Not started"}
      </p>
      {data.summary?.perSide ? (
        <ul className="mt-2 space-y-1 text-sm text-zinc-700">
          {data.summary.perSide.map((side) => (
            <li key={side.entrantId} className="tabular-nums">
              <span className="font-medium">{entrantNames[side.entrantId] ?? "—"}</span>{" "}
              {side.line}
            </li>
          ))}
        </ul>
      ) : null}
      {data.outcome?.winner ? (
        <p className="mt-2 text-sm text-zinc-600">
          Winner: <strong>{entrantNames[data.outcome.winner] ?? data.outcome.winner}</strong>
        </p>
      ) : null}
    </div>
  );
}
