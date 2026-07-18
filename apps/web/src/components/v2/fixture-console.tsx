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
import { ClientTime } from "@/components/client-time";
import { ShareButton } from "@/components/share-button";
import { LineupEditor } from "@/components/v2/lineup-editor";
import { ScoringErrorBoundary } from "@/components/v2/scoring-error-boundary";
import { GenericPad } from "@/components/v2/pads/generic-pad";
import { BoardgamePad } from "@/components/v2/pads/boardgame-pad";
import { CarromPad } from "@/components/v2/pads/carrom-pad";
import { SetbasedPad } from "@/components/v2/pads/setbased-pad";
import { TennisPad } from "@/components/v2/pads/tennis-pad";
import { PeriodPad } from "@/components/v2/pads/period-pad";
import { FootballPad } from "@/components/v2/pads/football-pad";
import { CricketPad } from "@/components/v2/pads/cricket-pad";
import { PadSuspensionBanner } from "@/components/discipline/pad-suspension-banner";
import { useMsg } from "@/components/i18n/dict-provider";
import type { MessageKey } from "@/lib/messages";

type Msg = (key: MessageKey, vars?: Record<string, string | number>) => string;

/** Focus-trapped, Esc-to-close single-field text prompt — replaces the native
 *  browser prompt dialog for the abandon/forfeit reason inputs below (same
 *  reasoning as prose-editor.tsx's EditorDialog: stylable, localizable,
 *  testable, consistent with the rest of the app's dialogs). */
function TextPromptDialog({
  title, initialValue, msg, onSubmit, onClose,
}: {
  title: string;
  initialValue: string;
  msg: Msg;
  onSubmit: (value: string) => void;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    dialogRef.current?.querySelector<HTMLElement>("input")?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-purple-950/30 p-4 backdrop-blur-sm"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="w-full max-w-sm rounded-2xl border border-purple-100 bg-white p-5 shadow-2xl"
      >
        <h2 className="text-sm font-semibold text-slate-900">{title}</h2>
        <form
          className="mt-3 space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            const value = (new FormData(e.currentTarget).get("reason") as string).trim();
            if (value) onSubmit(value);
            else onClose();
          }}
        >
          <input
            name="reason"
            type="text"
            autoComplete="off"
            defaultValue={initialValue}
            className="input w-full"
          />
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <button type="button" className="btn btn-ghost" onClick={onClose}>
              {msg("editor.cancel")}
            </button>
            <button type="submit" className="btn btn-primary">
              {msg("editor.apply")}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

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
    /** Venue zone (schedule_settings.tz) so the kick-off shows venue time. */
    scheduled_tz?: string;
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
  /** Public fixture path — enables the share action once decided (v3/10 #2).
   *  Null when the competition isn't shared. */
  publicPath?: string | null;
  /** Player RSVP/check-in per person (PROMPT-53) — chips in the lineup picker. */
  availability?: Record<string, PersonAvailability>;
  /** Active suspensions among this fixture's entrants (SPEC-1), joined server
   *  side into the bootstrap payload. Drives the soft pad warning banner. */
  activeSuspensions?: { personId: string; personName: string; served: number; total: number }[];
}

/** Payload keys that carry a person id across the sport modules (card, goal,
 *  sub, award). The pad warning fires when a recorded event names a suspended
 *  person via any of them. */
const ATTRIBUTION_KEYS = ["person", "scorer", "assist", "off", "on"] as const;

function personIdsInEvents(events: EventIn[]): Set<string> {
  const ids = new Set<string>();
  for (const e of events) {
    const p = e.payload as Record<string, unknown> | null;
    if (!p) continue;
    for (const k of ATTRIBUTION_KEYS) {
      const v = p[k];
      if (typeof v === "string") ids.add(v);
    }
  }
  return ids;
}

export interface PersonAvailability {
  status: "in" | "out" | "maybe";
  note: string | null;
  checked_in_at: string | null;
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
// Nested-kernel sports (points → games → sets) — TennisPad, not SetbasedPad.
const NESTED = new Set(["tennis"]);
// Period-kernel sports — PeriodPad (football stays on FootballPad this wave;
// migration noted as a follow-up in v6/README).
const PERIOD = new Set(["icehockey", "hockey"]);

export function FixtureConsole({
  fixture,
  sport,
  home,
  away,
  initialState,
  initialEvents,
  canEdit,
  recorderNames = {},
  publicPath = null,
  availability = {},
  activeSuspensions = [],
}: Props) {
  const msg = useMsg();
  const router = useRouter();
  const [live, setLive] = useState<LiveState>(initialState);
  const [events, setEvents] = useState<EventIn[]>(initialEvents);
  const [error, setError] = useState<string | null>(null);
  const [paywallFeature, setPaywallFeature] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [abandonPrompt, setAbandonPrompt] = useState(false);

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
          setError(msg("score.seqConflict"));
        } else if (err instanceof ApiV1Error && err.code === "PAYMENT_REQUIRED") {
          setPaywallFeature(String(err.extra.feature_key ?? ""));
        } else {
          setError(err instanceof Error ? err.message : msg("score.failed"));
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

  // Soft discipline warning (SPEC-1 / D8): a suspended player has been recorded
  // in this fixture's ledger. Never blocks — it just flags.
  const referencedPersons = personIdsInEvents(events);
  const flaggedSuspensions = activeSuspensions.filter((s) => referencedPersons.has(s.personId));

  return (
    <div className="space-y-6">
      {/* Scoreline header */}
      <header className="card p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-lg font-semibold tracking-tight text-slate-900">
            {home?.name ?? msg("schedule.tbd")} <span className="text-slate-400">{msg("schedule.vs")}</span>{" "}
            {away?.name ?? msg("schedule.tbd")}
          </h1>
          <span className={`badge ${STATUS_STYLE[live.status] ?? ""}`}>
            {scoreStatusLabel(msg, live.status)}
          </span>
        </div>
        <p className="mt-2 font-mono text-2xl text-slate-800">
          {summary?.headline ?? "—"}
        </p>
        <p className="mt-1 text-xs text-slate-400">
          {msg("schedule.round", { n: fixture.round_no })}
          {fixture.scheduled_at ? (
            <>
              {" · "}
              <ClientTime value={fixture.scheduled_at} mode="datetime" tz={fixture.scheduled_tz} showZone />
            </>
          ) : (
            ""
          )}
          {fixture.venue ? ` · ${fixture.venue}` : ""}
          {fixture.court_label ? ` · ${fixture.court_label}` : ""}
          {` · ${msg("score.recordedBy", { scorer: sport.scorerLabel.toLowerCase() })}`}
        </p>
      </header>

      {paywallFeature && <UpgradeGate feature={paywallFeature} />}
      {error && (
        <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>
      )}

      {/* Soft suspension warnings (SPEC-1) — one dismissible banner per flagged
          player recorded in this ledger. Never blocks scoring (D8). */}
      {flaggedSuspensions.length > 0 && (
        <div className="space-y-2">
          {flaggedSuspensions.map((s) => (
            <PadSuspensionBanner
              key={s.personId}
              name={s.personName}
              served={s.served}
              total={s.total}
            />
          ))}
        </div>
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
              {msg("score.startMatch")}
            </button>
          )}
          {decided && (
            <>
              <button
                type="button"
                disabled={busy}
                onClick={() => send("core.finalize", {})}
                className="btn btn-primary"
              >
                {msg("score.finalize")}
              </button>
              {publicPath && home && away && (
                // v3/10 #2: result decided → one tap to the club group chat.
                <ShareButton
                  title={`${home.name} ${msg("schedule.vs")} ${away.name}`}
                  text={msg("score.shareText", { home: home.name, away: away.name, headline: summary?.headline ?? msg("score.resultIn") })}
                  url={publicPath}
                  className="btn btn-ghost"
                />
              )}
            </>
          )}
          {!decided && (
            <>
              <ForfeitButton busy={busy} home={home} away={away} send={send} />
              <button
                type="button"
                disabled={busy}
                onClick={() => setAbandonPrompt(true)}
                className="btn btn-danger"
              >
                {msg("score.abandon")}
              </button>
            </>
          )}
          {abandonPrompt && (
            <TextPromptDialog
              title={msg("score.abandonPrompt")}
              initialValue=""
              msg={msg}
              onClose={() => setAbandonPrompt(false)}
              onSubmit={(reason) => {
                setAbandonPrompt(false);
                void send("core.abandon", { reason });
              }}
            />
          )}
          {lastVoidable && (
            <button
              type="button"
              disabled={busy}
              onClick={() => send("core.void", { event_id: lastVoidable.id })}
              className="btn btn-ghost"
              title={msg("score.undoTitle", { type: lastVoidable.type, seq: lastVoidable.seq })}
            >
              {msg("score.undoLast")}
            </button>
          )}
        </div>
      )}

      {/* Sport pad */}
      {scoring && !decided && home && away && (
        <section className="card p-5" data-testid="score-pad">
          <h2 className="mb-3 text-sm font-semibold text-slate-700">{msg("score.scoring")}</h2>
          <ScoringErrorBoundary fixtureId={fixture.id}>
            {sport.key === "cricket" ? (
              <CricketPad sport={sport} home={home} away={away} live={live} send={send} busy={busy} />
            ) : sport.key === "football" ? (
              <FootballPad sport={sport} home={home} away={away} live={live} send={send} busy={busy} />
            ) : SETBASED.has(sport.key) ? (
              <SetbasedPad sport={sport} home={home} away={away} live={live} send={send} busy={busy} />
            ) : NESTED.has(sport.key) ? (
              <TennisPad sport={sport} home={home} away={away} live={live} send={send} busy={busy} />
            ) : PERIOD.has(sport.key) ? (
              <PeriodPad sport={sport} home={home} away={away} live={live} send={send} busy={busy} />
            ) : sport.key === "boardgame" ? (
              <BoardgamePad home={home} away={away} send={send} busy={busy} started={started} />
            ) : sport.key === "carrom" ? (
              // Carrom scores board-by-board (carrom.board.summary) — the
              // generic 1-result pad would send generic.result, which the
              // module rejects as an unknown event type.
              <CarromPad home={home} away={away} live={live} send={send} busy={busy} started={started} />
            ) : (
              <GenericPad sport={sport} home={home} away={away} send={send} busy={busy} />
            )}
          </ScoringErrorBoundary>
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
                availability={availability}
              />
            );
          })}
        </div>
      )}

      {/* Event ledger */}
      <section className="card overflow-hidden">
        <header className="border-b border-slate-100 px-4 py-3">
          <h2 className="text-sm font-semibold text-slate-700">
            {msg("score.activity")} <span className="font-normal text-slate-400">({events.length})</span>
          </h2>
        </header>
        {events.length === 0 ? (
          <p className="px-4 py-4 text-sm text-slate-400">{msg("score.noEvents")}</p>
        ) : (
          <ul className="max-h-96 divide-y divide-slate-50 overflow-y-auto">
            {[...events].reverse().map((e) => {
              const voided = events.some((v) => v.voids_event_id === e.id);
              const desc = describeEvent(e.type, e.payload, entrantNames);
              // Attribution: device-link events come from the handed device;
              // signed-in recorders show by name.
              const recorder = e.device_link_id
                ? msg("score.courtsidePad", { scorer: sport.scorerLabel.toLowerCase() })
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
                  {/* ClientTime: locale time renders differently on server vs
                      browser (17:59 vs 5:59 PM) — the mismatch forced a full
                      client re-render that ate early clicks. SSR emits an
                      empty span; the viewer-local time fills in after mount. */}
                  <span className="shrink-0 text-slate-400">
                    <ClientTime value={e.recorded_at} mode="time" />
                  </span>
                  {scoring && !voided && e.type !== "core.void" && !decidedLock(live.status) && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => send("core.void", { event_id: e.id })}
                      className="shrink-0 text-red-500 hover:underline"
                    >
                      {msg("score.void")}
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

/** Localized fixture status; unknown values fall back to the raw token. */
function scoreStatusLabel(msg: Msg, status: string): string {
  const key = `score.status.${status}` as MessageKey;
  const label = msg(key);
  return label === key ? status.replace("_", " ") : label;
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
  const msg = useMsg();
  const [open, setOpen] = useState(false);
  const [forfeitPrompt, setForfeitPrompt] = useState<SideInfo | null>(null);
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
        {msg("score.forfeit")}
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
                setForfeitPrompt(s);
              }}
            >
              {msg("score.forfeits", { name: s.name })}
            </button>
          ))}
        </div>
      )}
      {forfeitPrompt && (
        <TextPromptDialog
          title={msg("score.forfeitPrompt", { name: forfeitPrompt.name })}
          initialValue="walkover"
          msg={msg}
          onClose={() => setForfeitPrompt(null)}
          onSubmit={(reason) => {
            const by = forfeitPrompt.id;
            setForfeitPrompt(null);
            void send("core.forfeit", { by, reason });
          }}
        />
      )}
    </div>
  );
}
