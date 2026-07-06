"use client";

// The stripped courtside pad behind /score/{token} (doc 13 §7, PROMPT-21).
// Reuses the sport pads; capabilities are the device-link subset — append +
// undo OWN events, nothing else. Every call presents the dl_ token as a
// Bearer header; the token stays in this tab (component prop), never storage.
// Offline-tolerant: sends retry with the SAME idempotency key (doc 08 §4).
import { useCallback, useState } from "react";
import { apiV1, ApiV1Error } from "@/lib/client-v1";
import { GenericPad } from "@/components/v2/pads/generic-pad";
import { BoardgamePad } from "@/components/v2/pads/boardgame-pad";
import { SetbasedPad } from "@/components/v2/pads/setbased-pad";
import { FootballPad } from "@/components/v2/pads/football-pad";
import { CricketPad } from "@/components/v2/pads/cricket-pad";
import type {
  LiveState,
  SendEvent,
  SideInfo,
  SportInfo,
} from "@/components/v2/fixture-console";

export type PadSideInfo = SideInfo;

export interface PadEventIn {
  id: string;
  seq: number;
  type: string;
  payload: unknown;
  recorded_at: string;
  voids_event_id: string | null;
  device_link_id: string | null;
}

interface Props {
  token: string;
  deviceLinkId: string;
  fixture: {
    id: string;
    round_no: number;
    venue: string | null;
    court_label: string | null;
    competition_name: string;
    division_name: string;
  };
  sport: SportInfo;
  home: PadSideInfo | null;
  away: PadSideInfo | null;
  initialState: LiveState;
  initialEvents: PadEventIn[];
}

const SETBASED = new Set(["volleyball", "badminton", "tabletennis"]);
const DEAD_CODES = new Set(["LINK_EXPIRED", "LINK_REVOKED", "LINK_INVALID", "UNAUTHENTICATED"]);

export function DeviceScorePad({
  token,
  deviceLinkId,
  fixture,
  sport,
  home,
  away,
  initialState,
  initialEvents,
}: Props) {
  const [live, setLive] = useState<LiveState>(initialState);
  const [events, setEvents] = useState<PadEventIn[]>(initialEvents);
  const [error, setError] = useState<string | null>(null);
  const [dead, setDead] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const authed = useCallback(
    <T,>(url: string, options?: Parameters<typeof apiV1>[1]) =>
      apiV1<T>(url, {
        ...options,
        headers: { ...(options?.headers ?? {}), Authorization: `Bearer ${token}` },
      }),
    [token],
  );

  const resync = useCallback(async () => {
    const [state, all] = await Promise.all([
      authed<LiveState>(`/api/v1/fixtures/${fixture.id}/state`),
      authed<PadEventIn[]>(`/api/v1/fixtures/${fixture.id}/events?since_seq=0`),
    ]);
    setLive(state);
    setEvents(all);
  }, [authed, fixture.id]);

  const send: SendEvent = useCallback(
    async (type, payload) => {
      setError(null);
      setBusy(true);
      // One idempotency key per action: flaky venue Wi-Fi retries are safe —
      // the server replays the cached answer instead of double-writing.
      const idempotencyKey = crypto.randomUUID();
      try {
        for (let attempt = 0; ; attempt++) {
          try {
            await authed(`/api/v1/fixtures/${fixture.id}/events`, {
              method: "POST",
              json: {
                expected_seq: live.last_seq,
                type,
                payload,
                idempotency_key: idempotencyKey,
              },
            });
            break;
          } catch (err) {
            // Network failure (offline) → retry same key with backoff.
            if (!(err instanceof ApiV1Error) && attempt < 3) {
              await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
              continue;
            }
            throw err;
          }
        }
        await resync();
        return true;
      } catch (err) {
        if (err instanceof ApiV1Error && DEAD_CODES.has(err.code)) {
          setDead(err.message);
        } else if (err instanceof ApiV1Error && err.code === "SEQ_CONFLICT") {
          await resync().catch(() => undefined);
          setError("Score moved on another device — refreshed, please re-check.");
        } else {
          setError(err instanceof Error ? err.message : "Failed — try again");
        }
        return false;
      } finally {
        setBusy(false);
      }
    },
    [authed, fixture.id, live.last_seq, resync],
  );

  // Doc 13 §7: the pad's dead-end when the link dies mid-day.
  if (dead) {
    return (
      <div className="flex min-h-[60vh] flex-col items-center justify-center text-center">
        <p className="text-4xl">⏱️</p>
        <h1 className="mt-3 text-lg font-semibold text-slate-800">{dead}</h1>
        <p className="mt-2 text-sm text-slate-500">Ask the organiser for a fresh link.</p>
      </div>
    );
  }

  const summary = live.summary as { headline?: string } | null;
  const decided = live.outcome !== null;
  const started = live.status !== "scheduled";
  const scoring = live.status !== "finalized" && live.status !== "cancelled";

  // Undo-own (doc 13 §7): only un-voided events THIS link recorded.
  const lastOwnVoidable = [...events]
    .reverse()
    .find(
      (e) =>
        e.device_link_id === deviceLinkId &&
        e.type !== "core.void" &&
        !events.some((v) => v.voids_event_id === e.id),
    );

  return (
    <div className="space-y-4">
      <header className="card p-4">
        <p className="text-xs text-slate-400">
          {fixture.competition_name} · {fixture.division_name} · Round {fixture.round_no}
          {fixture.court_label ? ` · ${fixture.court_label}` : ""}
        </p>
        <h1 className="mt-1 text-lg font-semibold text-slate-900">
          {home?.name ?? "TBD"} <span className="text-slate-400">vs</span> {away?.name ?? "TBD"}
        </h1>
        <p className="mt-1 font-mono text-2xl text-slate-800">{summary?.headline ?? "—"}</p>
        <p className="mt-1 text-[11px] text-slate-400">
          Courtside {sport.scorerLabel.toLowerCase()} pad · link active today only
        </p>
      </header>

      {error && <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>}

      {scoring && home && away && (
        <div className="flex flex-wrap gap-2">
          {!started && (
            <button type="button" disabled={busy} onClick={() => send("core.start", {})} className="btn btn-primary">
              Start match
            </button>
          )}
          {lastOwnVoidable && (
            <button
              type="button"
              disabled={busy}
              onClick={() => send("core.void", { event_id: lastOwnVoidable.id })}
              className="btn btn-ghost"
              title={`Undo ${lastOwnVoidable.type} (seq ${lastOwnVoidable.seq})`}
            >
              ⟲ Undo my last
            </button>
          )}
        </div>
      )}

      {scoring && !decided && home && away && (
        <section className="card p-4">
          {sport.key === "cricket" ? (
            <CricketPad sport={sport} home={home} away={away} live={live} send={send} busy={busy} />
          ) : sport.key === "football" ? (
            <FootballPad sport={sport} home={home} away={away} live={live} send={send} busy={busy} />
          ) : SETBASED.has(sport.key) ? (
            <SetbasedPad sport={sport} home={home} away={away} live={live} send={send} busy={busy} />
          ) : sport.key === "boardgame" ? (
            <BoardgamePad home={home} away={away} send={send} busy={busy} started={started} />
          ) : (
            <GenericPad sport={sport} home={home} away={away} send={send} busy={busy} />
          )}
        </section>
      )}

      {decided && scoring && (
        <p className="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
          Result recorded — the organiser finalizes it. Spot a mistake in your own entries?
          Use “Undo my last”.
        </p>
      )}
    </div>
  );
}
