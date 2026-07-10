"use client";

// The stripped courtside pad behind /score/{token} (doc 13 §7, PROMPT-21).
// Reuses the sport pads; capabilities are the device-link subset — append +
// undo OWN events, nothing else. Every call presents the dl_ token as a
// Bearer header; the token stays in this tab (component prop), never storage.
// Offline-tolerant: sends retry with the SAME idempotency key (doc 08 §4).
import { useCallback, useState } from "react";
import { apiV1, ApiV1Error } from "@/lib/client-v1";
import { ScoringErrorBoundary } from "@/components/v2/scoring-error-boundary";
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
  /** Org logo URL (Pro branding), resolved server-side. */
  logo?: string | null;
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
  logo = null,
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
        <h1 className="mt-3 text-lg font-semibold text-slate-100">{dead}</h1>
        <p className="mt-2 text-sm text-slate-400">Ask the organiser for a fresh link.</p>
      </div>
    );
  }

  const summary = live.summary as { headline?: string } | null;
  const decided = live.outcome !== null;
  const started = live.status !== "scheduled";
  const scoring = live.status !== "finalized" && live.status !== "cancelled";
  const inPlay = live.status === "in_play";

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
      {/* LED-scoreboard header: the one glowing thing on the dark court.
          Accent keel + org logo carry the club branding (--ps-* chain). */}
      <header className="overflow-hidden rounded-2xl border border-slate-800 bg-slate-900 shadow-[0_0_40px_-12px_rgba(16,185,129,0.25)]">
        <div aria-hidden className="h-0.5 bg-accent" />
        <div className="flex items-center justify-between gap-2 border-b border-slate-800 px-4 py-2">
          <p className="flex min-w-0 items-center gap-2 truncate text-[11px] uppercase tracking-widest text-slate-500">
            {logo && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={logo} alt="" className="h-5 w-5 shrink-0 rounded bg-white/10 object-cover" />
            )}
            <span className="truncate">
              {fixture.division_name} · Round {fixture.round_no}
              {fixture.court_label ? ` · ${fixture.court_label}` : ""}
            </span>
          </p>
          {inPlay ? (
            <span className="flex shrink-0 items-center gap-1.5 text-[11px] font-semibold uppercase tracking-widest text-emerald-400">
              <span className="animate-live-pulse h-1.5 w-1.5 rounded-full bg-emerald-400" />
              Live
            </span>
          ) : (
            <span className="shrink-0 text-[11px] uppercase tracking-widest text-slate-500">
              {live.status.replace("_", " ")}
            </span>
          )}
        </div>
        <div className="px-4 py-5 text-center">
          <p className="flex items-baseline justify-center gap-3 text-sm font-medium text-slate-200">
            <span className="max-w-[40%] truncate">{home?.name ?? "TBD"}</span>
            <span className="text-[10px] uppercase tracking-widest text-slate-600">vs</span>
            <span className="max-w-[40%] truncate">{away?.name ?? "TBD"}</span>
          </p>
          <p className="mt-2 font-mono text-5xl font-bold tabular-nums tracking-tight text-emerald-300 [text-shadow:0_0_24px_rgba(52,211,153,0.35)]">
            {summary?.headline ?? "0 — 0"}
          </p>
        </div>
        <p className="border-t border-slate-800 px-4 py-2 text-center text-[10px] uppercase tracking-widest text-slate-600">
          Courtside {sport.scorerLabel.toLowerCase()} pad · link active today only
        </p>
      </header>

      {error && (
        <p className="rounded-md border border-red-900/50 bg-red-950/60 px-3 py-2 text-sm text-red-300">
          {error}
        </p>
      )}

      {scoring && home && away && (!started || lastOwnVoidable) && (
        <div className="flex flex-wrap gap-2">
          {!started && (
            <button
              type="button"
              disabled={busy}
              onClick={() => send("core.start", {})}
              className="btn btn-primary h-12 flex-1 text-base"
            >
              Start match
            </button>
          )}
          {lastOwnVoidable && (
            <button
              type="button"
              disabled={busy}
              onClick={() => send("core.void", { event_id: lastOwnVoidable.id })}
              className="flex h-12 items-center justify-center gap-2 rounded-full border border-amber-500/30 bg-amber-500/10 px-6 text-sm font-semibold text-amber-300 transition hover:border-amber-400/60 hover:bg-amber-500/20 active:scale-[0.98] disabled:opacity-50"
              title={`Undo ${lastOwnVoidable.type} (seq ${lastOwnVoidable.seq})`}
            >
              <span aria-hidden className="text-base leading-none">⟲</span>
              Undo my last entry
            </button>
          )}
        </div>
      )}

      {scoring && !decided && home && away && (
        <section className="card p-4">
          <ScoringErrorBoundary>
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
          </ScoringErrorBoundary>
        </section>
      )}

      {decided && scoring && (
        <p className="rounded-md border border-emerald-900/50 bg-emerald-950/60 px-3 py-2 text-sm text-emerald-300">
          Result recorded — the organiser finalizes it. Spot a mistake in your own entries?
          Use “Undo my last”.
        </p>
      )}
    </div>
  );
}
