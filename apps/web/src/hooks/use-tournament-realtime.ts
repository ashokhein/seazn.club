"use client";

import { useEffect } from "react";
import { api } from "@/lib/client";

interface RealtimeToken {
  token: string;
  channel: string;
  expires_at: string;
}

/**
 * Subscribe to Supabase Realtime broadcast for a tournament.
 * Calls onUpdate (debounced 250ms) on each state_changed event.
 * Falls back silently if realtime is not available (Community plan, env not set, error).
 * The caller remains responsible for its own polling fallback when enabled=false.
 */
export function useTournamentRealtime(
  tournamentId: string,
  onUpdate: () => void,
  enabled: boolean,
) {
  useEffect(() => {
    if (!enabled) return;
    if (!process.env.NEXT_PUBLIC_SUPABASE_URL) return; // env not configured

    let cancelled = false;
    let debounce: ReturnType<typeof setTimeout> | null = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let channel: any = null;

    (async () => {
      let tokenData: RealtimeToken;
      try {
        tokenData = await api<RealtimeToken>(
          `/api/tournaments/${tournamentId}/realtime-token`,
        );
      } catch {
        return; // 403 (Community) or server error → fall back to polling
      }
      if (cancelled) return;

      const { supabaseBrowser } = await import("@/lib/supabase-browser");
      const sb = supabaseBrowser();
      await sb.realtime.setAuth(tokenData.token);

      channel = sb
        .channel(tokenData.channel, { config: { private: true } })
        .on("broadcast", { event: "state_changed" }, () => {
          if (debounce) clearTimeout(debounce);
          debounce = setTimeout(onUpdate, 250);
        })
        .subscribe();
    })();

    return () => {
      cancelled = true;
      if (debounce) clearTimeout(debounce);
      channel?.unsubscribe();
    };
  }, [tournamentId, onUpdate, enabled]);
}
