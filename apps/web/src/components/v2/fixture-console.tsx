"use client";

// THE organiser scoring surface (PROMPT-15 task 1). Sport-shaped pads feed
// POST /api/v1/fixtures/{id}/events with optimistic concurrency: every event
// carries expected_seq + an idempotency key (doc 08 §4); a 409 resyncs from
// the ledger and replays the UI.
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { apiV1, ApiV1Error } from "@/lib/client-v1";
import { describeEvent, EVENT_TONE_STYLE } from "@/lib/event-copy";
import { UpgradeGate } from "@/components/upgrade-gate";
import { LineupEditor } from "@/components/v2/lineup-editor";
import { GenericPad } from "@/components/v2/pads/generic-pad";
import { BoardgamePad } from "@/components/v2/pads/boardgame-pad";
import { SetbasedPad } from "@/components/v2/pads/setbased-pad";
import { FootballPad } from "@/components/v2/pads/football-pad";
import { CricketPad } from "@/components/v2/pads/cricket-pad";

export interface MemberIn {
  person_id: string;
  full_name: string;
  squad_number: number | null;
  default_position_key: string | null;
  is_captain: boolean;
  roles: string[];
}
export interface LineupSlotIn {
  person_id: string;
  full_name: string;
  squad_number?: number | null;
  slot: "starting" | "bench";
  position_key: string | null;
  order_no: number | null;
  roles: string[];
}
export interface SideInfo {
  id: string;
  name: string;
  members: MemberIn[];
  lineup: LineupSlotIn[];
}

export interface FidelityTierIn {
  tier: number;
  eventTypes: string[];
  entitlement?: string;
}

export interface SportInfo {
  key: string;
  config: Record<string, unknown>;
  scorerLabel: string;
  positionGroups: { key: string; name: string }[];
  roles: { key: string; name?: string }[];
  lineupSize: number;
  fidelityTiers: FidelityTierIn[];
}

export interface LiveState {
  status: string;
  last_seq: number;
  summary: unknown;
  state: unknown;
  outcome: unknown;
}

export interface EventIn {
  id: string;
  seq: number;
  type: string;
  payload: unknown;
  recorded_at: string;
  recorded_by?: string | null;
  voids_event_id: string | null;
  device_link_id?: string | null;
}

interface Props {
  fixture: {
    id: string;
    status: string;
    scheduled_at: string | null;
    venue: string | null;
    court_label: string | null;
    round_no: number;
  };
  sport: SportInfo;
  home: SideInfo | null;
  away: SideInfo | null;
  initialState: LiveState;
  initialEvents: EventIn[];
  canEdit: boolean;
  /** recorded_by → display name for Activity attribution. */
  recorderNames?: Record<string, string>;
}

export type SendEvent = (type: string, payload: unknown) => Promise<boolean>;

const STATUS_STYLE: Record<string, string> = {
  scheduled: "bg-slate-100 text-slate-600",
  in_play: "bg-amber-100 text-amber-700",
  decided: "bg-sky-100 text-sky-700",
  finalized: "bg-emerald-100 text-emerald-700",
  abandoned: "bg-slate-100 text-slate-400",
  forfeited: "bg-red-50 text-red-500",
  cancelled: "bg-slate-100 text-slate-400",
};

const SETBASED = new Set(["volleyball", "badminton", "tabletennis"]);

export function FixtureConsole({
  fixture,
  sport,
  home,
  away,
  initialState,
  initialEvents,
  canEdit,
  recorderNames = {},
}: Props) {
  const router = useRouter();
  const [live, setLive] = useState<LiveState>(initialState);
  const [events, setEvents] = useState<EventIn[]>(initialEvents);
  const [error, setError] = useState<string | null>(null);
  const [paywallFeature, setPaywallFeature] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const resync = useCallback(async () => {
    const [state, all] = await Promise.all([
      apiV1<LiveState>(`/api/v1/fixtures/${fixture.id}/state`),
      apiV1<EventIn[]>(`/api/v1/fixtures/${fixture.id}/events?since_seq=0`),
    ]);
    setLive(state);
    setEvents(all);
  }, [fixture.id]);

  const send: SendEvent = useCallback(
    async (type, payload) => {
      setError(null);
      setPaywallFeature(null);
      setBusy(true);
      try {
        await apiV1(`/api/v1/fixtures/${fixture.id}/events`, {
          method: "POST",
          json: {
            expected_seq: live.last_seq,
            type,
            payload,
            idempotency_key: crypto.randomUUID(),
          },
        });
        await resync();
        router.refresh();
        return true;
      } catch (err) {
        if (err instanceof ApiV1Error && err.code === "SEQ_CONFLICT") {
          // Another scorer got there first — resync and let them retry.
          await resync().catch(() => undefined);
          setError("Score moved on another device — the view has been refreshed, please re-check.");
        } else if (err instanceof ApiV1Error && err.code === "PAYMENT_REQUIRED") {
          setPaywallFeature(String(err.extra.feature_key ?? ""));
        } else {
          setError(err instanceof Error ? err.message : "Failed");
        }
        return false;
      } finally {
        setBusy(false);
      }
    },
    [fixture.id, live.last_seq, resync, router],
  );

  const summary = live.summary as { headline?: string } | null;
  const scoring = canEdit && live.status !== "finalized" && live.status !== "cancelled";
  const decided = live.outcome !== null;
  const started = live.status !== "scheduled";

  const sides = { home, away };
  const entrantNames: Record<string, string> = {};
  if (home) entrantNames[home.id] = home.name;
  if (away) entrantNames[away.id] = away.name;
  const lastVoidable = [...events]
    .reverse()
    .find((e) => e.type !== "core.void" && !events.some((v) => v.voids_event_id === e.id));

  return (
    <div className="space-y-6">
      {/* Scoreline header */}
      <header className="card p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-lg font-semibold tracking-tight text-slate-900">
            {home?.name ?? "TBD"} <span className="text-slate-400">vs</span>{" "}
            {away?.name ?? "TBD"}
          </h1>
          <span className={`badge ${STATUS_STYLE[live.status] ?? ""}`}>
            {live.status.replace("_", " ")}
          </span>
        </div>
        <p className="mt-2 font-mono text-2xl text-slate-800">
          {summary?.headline ?? "—"}
        </p>
        <p className="mt-1 text-xs text-slate-400">
          Round {fixture.round_no}
          {fixture.scheduled_at
            ? ` · ${new Date(fixture.scheduled_at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}`
            : ""}
          {fixture.venue ? ` · ${fixture.venue}` : ""}
          {fixture.court_label ? ` · ${fixture.court_label}` : ""}
          {` · recorded by the ${sport.scorerLabel.toLowerCase()}`}
        </p>
      </header>

      {paywallFeature && <UpgradeGate feature={paywallFeature} />}
      {error && (
        <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>
      )}

      {/* Match controls */}
      {scoring && home && away && (
        <div className="flex flex-wrap items-center gap-2">
          {!started && (
            <button
              type="button"
              disabled={busy}
              onClick={() => send("core.start", {})}
              className="btn btn-primary"
            >
              Start match
            </button>
          )}
          {decided && (
            <button
              type="button"
              disabled={busy}
              onClick={() => send("core.finalize", {})}
              className="btn btn-primary"
            >
              Finalize (lock ledger)
            </button>
          )}
          {!decided && (
            <>
              <ForfeitButton busy={busy} home={home} away={away} send={send} />
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  const reason = window.prompt("Abandon reason (e.g. rain):");
                  if (reason) void send("core.abandon", { reason });
                }}
                className="btn btn-danger"
              >
                Abandon
              </button>
            </>
          )}
          {lastVoidable && (
            <button
              type="button"
              disabled={busy}
              onClick={() => send("core.void", { event_id: lastVoidable.id })}
              className="btn btn-ghost"
              title={`Undo ${lastVoidable.type} (seq ${lastVoidable.seq})`}
            >
              ⟲ Undo last
            </button>
          )}
        </div>
      )}

      {/* Sport pad */}
      {scoring && !decided && home && away && (
        <section className="card p-5">
          <h2 className="mb-3 text-sm font-semibold text-slate-700">Scoring</h2>
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

      {/* Lineups (locked once the fixture starts) */}
      {home && away && (
        <div className="grid gap-4 lg:grid-cols-2">
          {(["home", "away"] as const).map((sideKey) => {
            const s = sides[sideKey]!;
            return (
              <LineupEditor
                key={s.id}
                fixtureId={fixture.id}
                side={s}
                positionGroups={sport.positionGroups}
                roles={sport.roles}
                lineupSize={sport.lineupSize}
                canEdit={canEdit && live.status === "scheduled"}
                onSaved={() => router.refresh()}
              />
            );
          })}
        </div>
      )}

      {/* Event ledger */}
      <section className="card overflow-hidden">
        <header className="border-b border-slate-100 px-4 py-3">
          <h2 className="text-sm font-semibold text-slate-700">
            Activity <span className="font-normal text-slate-400">({events.length})</span>
          </h2>
        </header>
        {events.length === 0 ? (
          <p className="px-4 py-4 text-sm text-slate-400">No events recorded.</p>
        ) : (
          <ul className="max-h-96 divide-y divide-slate-50 overflow-y-auto">
            {[...events].reverse().map((e) => {
              const voided = events.some((v) => v.voids_event_id === e.id);
              const desc = describeEvent(e.type, e.payload, entrantNames);
              // Attribution: device-link events come from the handed device;
              // signed-in recorders show by name.
              const recorder = e.device_link_id
                ? `Courtside ${sport.scorerLabel.toLowerCase()} pad`
                : e.recorded_by
                  ? (recorderNames[e.recorded_by] ?? sport.scorerLabel)
                  : null;
              return (
                <li
                  key={e.id}
                  title={`${e.type} ${JSON.stringify(e.payload)}`}
                  className={`flex items-center gap-3 px-4 py-2 text-xs ${voided ? "line-through opacity-40" : ""}`}
                >
                  <span className="w-8 shrink-0 font-mono text-slate-300">#{e.seq}</span>
                  <span
                    className={`badge w-24 shrink-0 justify-center capitalize ${EVENT_TONE_STYLE[desc.tone]}`}
                  >
                    {desc.label}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-slate-700">
                    {desc.text}
                    {recorder ? <span className="text-slate-400"> ({recorder})</span> : null}
                  </span>
                  <span className="shrink-0 text-slate-400">
                    {new Date(e.recorded_at).toLocaleTimeString()}
                  </span>
                  {scoring && !voided && e.type !== "core.void" && !decidedLock(live.status) && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => send("core.void", { event_id: e.id })}
                      className="shrink-0 text-red-500 hover:underline"
                    >
                      void
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}

function decidedLock(status: string): boolean {
  return status === "finalized" || status === "cancelled";
}

function ForfeitButton({
  busy,
  home,
  away,
  send,
}: {
  busy: boolean;
  home: SideInfo;
  away: SideInfo;
  send: SendEvent;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        disabled={busy}
        onClick={() => setOpen(!open)}
        className="btn btn-ghost"
      >
        Forfeit…
      </button>
      {open && (
        <div className="card absolute z-10 mt-1 w-56 space-y-1 p-2 shadow-lg">
          {[home, away].map((s) => (
            <button
              key={s.id}
              type="button"
              className="block w-full rounded px-2 py-1.5 text-left text-sm hover:bg-purple-50"
              onClick={() => {
                setOpen(false);
                const reason = window.prompt(`Reason ${s.name} forfeits:`, "walkover");
                if (reason) void send("core.forfeit", { by: s.id, reason });
              }}
            >
              {s.name} forfeits
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
