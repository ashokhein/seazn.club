"use client";

// Drag-and-drop schedule board (doc 12 §2, PROMPT-17): grid of courts × time
// (day/week views), fixture cards with TBD feed labels and division colours,
// optimistic drag + debounced re-validation, violation badges, pin/lock,
// re-flow remaining, bulk shift/swap, realtime refresh on division:{id}, and
// a keyboard-accessible move menu (select a card → move via controls).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { apiV1, ApiV1Error } from "@/lib/client-v1";
import { UpgradeGate } from "@/components/upgrade-gate";
import { dayKey, daySlots, toLocalInput, type FeedLabelPair } from "@/lib/schedule-board";

const MIN = 60_000;

export interface BoardDivision {
  id: string;
  name: string;
  status: string;
  color: string;
}

export interface BoardStage {
  id: string;
  division_id: string;
  seq: number;
  kind: string;
  name: string;
  status: string;
}

export interface BoardFixture {
  id: string;
  stage_id: string;
  division_id: string;
  round_no: number;
  seq_in_round: number;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  /** ISO string over the wire, Date when it crosses straight from an RSC. */
  scheduled_at: string | Date | null;
  venue: string | null;
  court_label: string | null;
  status: string;
  schedule_source: string;
  schedule_locked: boolean;
  outcome: unknown;
}

export interface BoardConfig {
  startAt?: string | null;
  matchMinutes: number;
  gapMinutes: number;
  courts: string[];
  perEntrantMinRest: number;
  blackouts: { court?: string; from: string; to: string }[];
  sessionWindows: { from: string; to: string }[];
  roundMinutes?: number | null;
}

export interface BoardConflict {
  fixture_id: string;
  code: string;
  blocking: boolean;
  detail?: string;
}

interface Props {
  divisions: BoardDivision[];
  stages: BoardStage[];
  fixtures: BoardFixture[];
  entrantNames: Record<string, string>;
  feedLabels: Record<string, FeedLabelPair>;
  settings: { division_id: string; config: BoardConfig; tz: string };
  canEdit: boolean;
  constraintsAllowed: boolean;
}

const CONFLICT_LABEL: Record<string, string> = {
  "conflict.court": "court clash",
  "warn.rest": "rest",
  "warn.person_overlap": "person overlap",
  "warn.order": "plays before feeder",
  "warn.blackout": "blackout",
  "warn.no_slot": "no slot",
};

type Override = { scheduled_at: string | null; court_label: string | null; schedule_locked: boolean };

export function ScheduleBoard({
  divisions,
  stages,
  fixtures,
  entrantNames,
  feedLabels,
  settings,
  canEdit,
  constraintsAllowed,
}: Props) {
  const router = useRouter();
  const single = divisions.length === 1 ? divisions[0] : null;
  const cfg = settings.config;
  const [overrides, setOverrides] = useState<Record<string, Override>>({});
  const [conflicts, setConflicts] = useState<BoardConflict[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [paywall, setPaywall] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<string | null>(null); // keyboard move target
  const [view, setView] = useState<"day" | "week">("day");
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Server props are the source of truth; optimistic overrides melt away on
  // each refresh (last-write-wins per fixture, doc 12 §6). Render-time state
  // adjustment (the React "derive from props" pattern) — no effect cascade.
  const [seenFixtures, setSeenFixtures] = useState(fixtures);
  if (seenFixtures !== fixtures) {
    setSeenFixtures(fixtures);
    setOverrides({});
  }

  const board: BoardFixture[] = useMemo(
    () =>
      fixtures.map((f) => {
        const o = overrides[f.id];
        return o ? { ...f, ...o } : f;
      }),
    [fixtures, overrides],
  );

  const colorOf = useMemo(
    () => Object.fromEntries(divisions.map((d) => [d.id, d.color])),
    [divisions],
  );
  const conflictsByFixture = useMemo(() => {
    const map: Record<string, BoardConflict[]> = {};
    for (const c of conflicts) (map[c.fixture_id] ??= []).push(c);
    return map;
  }, [conflicts]);

  const scheduled = board.filter((f) => f.scheduled_at !== null && f.court_label !== null);
  const unscheduled = board.filter(
    (f) => (f.scheduled_at === null || f.court_label === null) && f.status === "scheduled",
  );

  const days = useMemo(() => {
    const set = new Set(scheduled.map((f) => dayKey(f.scheduled_at as string)));
    if (set.size === 0 && cfg.startAt) set.add(dayKey(cfg.startAt));
    if (set.size === 0) set.add(dayKey(new Date()));
    return [...set].sort();
  }, [scheduled, cfg.startAt]);
  const [day, setDay] = useState<string>(days[0] as string);
  if (!days.includes(day)) setDay(days[0] as string); // render-time adjust

  // Courts: configured list plus anything already used on the board.
  const courts = useMemo(() => {
    const list = [...cfg.courts];
    for (const f of scheduled) {
      if (f.court_label && !list.includes(f.court_label)) list.push(f.court_label);
    }
    return list;
  }, [cfg.courts, scheduled]);

  // ------------------------------------------------------------------ actions

  const runValidate = useCallback(async () => {
    try {
      const results = await Promise.all(
        divisions.map((d) =>
          apiV1<{ conflicts: BoardConflict[] }>(`/api/v1/divisions/${d.id}/schedule/validate`, {
            method: "POST",
          }),
        ),
      );
      setConflicts(results.flatMap((r) => r.conflicts));
    } catch {
      /* validation is advisory — never break the board */
    }
  }, [divisions]);

  const queueValidate = useCallback(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => void runValidate(), 400);
  }, [runValidate]);

  // Full report on load and after every server refresh (doc 12 §4 — board
  // load + after external edits). Debounced: state lands in a timer callback.
  useEffect(() => {
    queueValidate();
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [queueValidate, fixtures]);

  function fail(err: unknown) {
    if (err instanceof ApiV1Error && err.code === "PAYMENT_REQUIRED") {
      setPaywall(String(err.extra.feature_key ?? ""));
    } else if (err instanceof ApiV1Error && err.code === "SCHEDULE_CONFLICT") {
      const list = (err.extra.conflicts as BoardConflict[] | undefined) ?? [];
      setError(
        `Blocked: ${list.map((c) => `${CONFLICT_LABEL[c.code] ?? c.code}${c.detail ? ` (${c.detail})` : ""}`).join("; ") || err.message}`,
      );
    } else {
      setError(err instanceof Error ? err.message : "Failed");
    }
  }

  async function moveCard(fixtureId: string, atIso: string | null, court: string | null) {
    if (!canEdit) return;
    setError(null);
    const prev = board.find((f) => f.id === fixtureId);
    if (!prev || prev.status !== "scheduled") return;
    setOverrides((o) => ({
      ...o,
      [fixtureId]: {
        scheduled_at: atIso,
        court_label: court,
        schedule_locked: prev.schedule_locked,
      },
    }));
    try {
      await apiV1(`/api/v1/fixtures/${fixtureId}`, {
        method: "PATCH",
        json: { scheduled_at: atIso, court_label: court },
      });
      queueValidate();
      router.refresh();
    } catch (err) {
      setOverrides((o) => {
        const rest = { ...o };
        delete rest[fixtureId];
        return rest;
      });
      fail(err);
    }
  }

  async function togglePin(f: BoardFixture) {
    if (!canEdit) return;
    setError(null);
    try {
      await apiV1(`/api/v1/fixtures/${f.id}`, {
        method: "PATCH",
        json: { schedule_locked: !f.schedule_locked },
      });
      router.refresh();
    } catch (err) {
      fail(err);
    }
  }

  async function autoRun(stageId: string, onlyUnlocked: boolean) {
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      const out = await apiV1<{
        assignments: { fixture_id: string; scheduled_at: string; court_label: string }[];
        conflicts: BoardConflict[];
      }>(`/api/v1/stages/${stageId}/schedule/auto`, {
        method: "POST",
        json: { only_unlocked: onlyUnlocked },
      });
      if (out.assignments.length === 0) {
        setNotice("Nothing to schedule for this stage.");
        return;
      }
      const applied = await apiV1<{ applied: number; conflicts: BoardConflict[] }>(
        `/api/v1/stages/${stageId}/schedule/apply`,
        {
          method: "POST",
          json: {
            assignments: out.assignments.map((a) => ({
              fixture_id: a.fixture_id,
              scheduled_at: a.scheduled_at,
              court_label: a.court_label,
            })),
            source: "auto",
          },
        },
      );
      setConflicts(applied.conflicts);
      setNotice(
        `Placed ${applied.applied} fixture(s)` +
          (applied.conflicts.length > 0 ? ` — ${applied.conflicts.length} warning(s).` : "."),
      );
      router.refresh();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  }

  async function act(path: string, done: string) {
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      await apiV1(path, { method: "POST" });
      setNotice(done);
      router.refresh();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  }

  // Bulk tools (doc 12 §2): shift the selected day ±N minutes / swap two courts.
  async function shiftDay(minutes: number) {
    setBusy(true);
    setError(null);
    try {
      for (const f of scheduled) {
        if (dayKey(f.scheduled_at as string) !== day || f.status !== "scheduled") continue;
        await apiV1(`/api/v1/fixtures/${f.id}`, {
          method: "PATCH",
          json: {
            scheduled_at: new Date(new Date(f.scheduled_at as string).getTime() + minutes * MIN).toISOString(),
          },
        });
      }
      router.refresh();
      queueValidate();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  }

  async function swapCourts(a: string, b: string) {
    setBusy(true);
    setError(null);
    try {
      for (const f of scheduled) {
        if (dayKey(f.scheduled_at as string) !== day || f.status !== "scheduled") continue;
        if (f.court_label === a) {
          await apiV1(`/api/v1/fixtures/${f.id}`, { method: "PATCH", json: { court_label: b } });
        } else if (f.court_label === b) {
          await apiV1(`/api/v1/fixtures/${f.id}`, { method: "PATCH", json: { court_label: a } });
        }
      }
      router.refresh();
      queueValidate();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  }

  // Realtime board refresh on division:{id} (doc 12 §6 — two organisers).
  useEffect(() => {
    if (!process.env.NEXT_PUBLIC_SUPABASE_URL) return;
    let cancelled = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const channels: any[] = [];
    (async () => {
      try {
        const { supabaseBrowser } = await import("@/lib/supabase-browser");
        const sb = supabaseBrowser();
        for (const d of divisions) {
          if (cancelled) return;
          channels.push(
            sb
              .channel(`division:${d.id}`)
              .on("broadcast", { event: "schedule_changed" }, () => router.refresh())
              .subscribe(),
          );
        }
      } catch {
        /* realtime is best-effort; the board still works without it */
      }
    })();
    return () => {
      cancelled = true;
      for (const ch of channels) ch?.unsubscribe();
    };
  }, [divisions, router]);

  // ------------------------------------------------------------------ grid math

  const slotMinutes = cfg.matchMinutes + cfg.gapMinutes;
  const dayFixtures = scheduled.filter((f) => dayKey(f.scheduled_at as string) === day);
  const dayStartDefault = new Date(`${day}T08:00`).getTime();
  const dayEndDefault = new Date(`${day}T22:00`).getTime();
  const times = dayFixtures.map((f) => new Date(f.scheduled_at as string).getTime());
  const gridFrom = times.length > 0 ? Math.min(...times, dayStartDefault) : dayStartDefault;
  const gridTo =
    times.length > 0
      ? Math.max(...times.map((t) => t + cfg.matchMinutes * MIN), Math.min(dayEndDefault, gridFrom + 8 * 60 * MIN))
      : dayEndDefault;
  const slots = daySlots(gridFrom, gridTo, slotMinutes);

  const selectedFixture = selected !== null ? (board.find((f) => f.id === selected) ?? null) : null;

  // ------------------------------------------------------------------ render

  return (
    <div className="space-y-4">
      {paywall && <UpgradeGate feature={paywall} />}
      {notice && <p className="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{notice}</p>}
      {error && <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>}

      {/* Action bar */}
      <div className="flex flex-wrap items-center gap-2">
        {canEdit &&
          stages
            .filter((s) => s.status !== "complete")
            .map((s) => (
              <span key={s.id} className="inline-flex items-center gap-1">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => autoRun(s.id, false)}
                  className="btn btn-primary px-3 py-1.5 text-xs"
                >
                  Auto-schedule {stages.length > 1 ? s.name : ""}
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => autoRun(s.id, true)}
                  className="btn btn-ghost px-3 py-1.5 text-xs"
                  title="Re-run the auto pass over unlocked fixtures only; pinned cards stay"
                >
                  Re-flow remaining
                </button>
              </span>
            ))}
        <div className="flex-1" />
        {canEdit && single && single.status !== "active" && single.status !== "completed" && (
          <>
            <button
              type="button"
              disabled={busy}
              onClick={() => act(`/api/v1/divisions/${single.id}/publish-schedule`, "Schedule published — it is now on the public dashboard and .ics feeds.")}
              className="btn btn-ghost px-3 py-1.5 text-xs"
            >
              Publish schedule
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => act(`/api/v1/divisions/${single.id}/start`, "Tournament started — scoring is open.")}
              className="btn btn-primary px-3 py-1.5 text-xs"
            >
              Start tournament
            </button>
          </>
        )}
      </div>

      {/* Division colour legend (competition-wide view, doc 06 §4.3) */}
      {divisions.length > 1 && (
        <div className="flex flex-wrap items-center gap-3 text-xs text-slate-500">
          {divisions.map((d) => (
            <span key={d.id} className="inline-flex items-center gap-1">
              <span className="h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: d.color }} />
              {d.name}
            </span>
          ))}
        </div>
      )}

      {/* Day picker, view toggle, bulk tools */}
      <div className="flex flex-wrap items-center gap-2">
        {days.map((d) => (
          <button
            key={d}
            type="button"
            onClick={() => setDay(d)}
            className={`rounded-full px-3 py-1 text-xs font-medium ${
              d === day ? "bg-purple-600 text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"
            }`}
          >
            {new Date(`${d}T12:00`).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}
          </button>
        ))}
        <button
          type="button"
          onClick={() => setView(view === "day" ? "week" : "day")}
          className="btn btn-ghost px-3 py-1 text-xs"
        >
          {view === "day" ? "Week view" : "Day view"}
        </button>
        {canEdit && view === "day" && (
          <span className="ml-auto flex items-center gap-1 text-xs text-slate-500">
            Shift day
            <button type="button" disabled={busy} onClick={() => shiftDay(-15)} className="btn btn-ghost px-2 py-1 text-xs">−15m</button>
            <button type="button" disabled={busy} onClick={() => shiftDay(15)} className="btn btn-ghost px-2 py-1 text-xs">+15m</button>
            {courts.length >= 2 && (
              <button
                type="button"
                disabled={busy}
                onClick={() => swapCourts(courts[0] as string, courts[1] as string)}
                className="btn btn-ghost px-2 py-1 text-xs"
                title={`Swap ${courts[0]} ↔ ${courts[1]} for this day`}
              >
                Swap {courts[0]}↔{courts[1]}
              </button>
            )}
          </span>
        )}
      </div>

      {/* Keyboard-accessible move panel (a11y — doc 12 / PROMPT-17 item 5) */}
      {canEdit && selectedFixture && (
        <MovePanel
          fixture={selectedFixture}
          courts={courts}
          entrantNames={entrantNames}
          feedLabels={feedLabels}
          onMove={(atIso, court) => {
            void moveCard(selectedFixture.id, atIso, court);
            setSelected(null);
          }}
          onClose={() => setSelected(null)}
        />
      )}

      {/* The grid */}
      {view === "day" ? (
        <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
          <table className="w-full border-collapse text-xs" aria-label="Schedule board">
            <thead>
              <tr>
                <th className="w-16 border-b border-slate-200 bg-slate-50 px-2 py-2 text-left font-medium text-slate-500">Time</th>
                {courts.map((c) => (
                  <th key={c} className="border-b border-l border-slate-200 bg-slate-50 px-2 py-2 text-left font-medium text-slate-600">
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {slots.map((t) => (
                <tr key={t}>
                  <td className="border-b border-slate-100 px-2 py-1 align-top text-slate-400">
                    {new Date(t).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
                  </td>
                  {courts.map((court) => {
                    const cell = dayFixtures.filter((f) => {
                      const at = new Date(f.scheduled_at as string).getTime();
                      return f.court_label === court && at >= t && at < t + slotMinutes * MIN;
                    });
                    return (
                      <td
                        key={court}
                        className="h-10 border-b border-l border-slate-100 px-1 py-0.5 align-top"
                        onDragOver={canEdit ? (e) => e.preventDefault() : undefined}
                        onDrop={
                          canEdit
                            ? (e) => {
                                e.preventDefault();
                                const fid = e.dataTransfer.getData("text/fixture");
                                if (fid) void moveCard(fid, new Date(t).toISOString(), court);
                              }
                            : undefined
                        }
                      >
                        {cell.map((f) => (
                          <FixtureCard
                            key={f.id}
                            fixture={f}
                            entrantNames={entrantNames}
                            feedLabels={feedLabels}
                            conflicts={conflictsByFixture[f.id] ?? []}
                            color={divisions.length > 1 ? colorOf[f.division_id] : undefined}
                            canEdit={canEdit}
                            selected={selected === f.id}
                            onSelect={() => setSelected(selected === f.id ? null : f.id)}
                            onTogglePin={() => void togglePin(f)}
                          />
                        ))}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="grid gap-3 md:grid-cols-3 lg:grid-cols-4">
          {days.map((d) => (
            <section key={d} className="card p-3">
              <h4 className="mb-2 text-xs font-semibold text-slate-600">
                {new Date(`${d}T12:00`).toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" })}
              </h4>
              <ul className="space-y-1">
                {scheduled
                  .filter((f) => dayKey(f.scheduled_at as string) === d)
                  .sort(
                    (a, b) =>
                      new Date(a.scheduled_at as string).getTime() -
                      new Date(b.scheduled_at as string).getTime(),
                  )
                  .map((f) => (
                    <li key={f.id} className="flex items-center gap-2 text-xs text-slate-600">
                      <span className="w-10 text-slate-400">
                        {new Date(f.scheduled_at as string).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
                      </span>
                      <span className="truncate">{cardTitle(f, entrantNames, feedLabels)}</span>
                      <span className="ml-auto text-slate-400">{f.court_label}</span>
                    </li>
                  ))}
              </ul>
            </section>
          ))}
        </div>
      )}

      {/* Unscheduled tray */}
      {unscheduled.length > 0 && (
        <section className="card p-3">
          <h4 className="mb-2 text-xs font-semibold text-slate-600">
            Unscheduled ({unscheduled.length}) — drag onto the board{canEdit ? "" : " (view-only)"}
          </h4>
          <div className="flex flex-wrap gap-1.5">
            {unscheduled.map((f) => (
              <FixtureCard
                key={f.id}
                fixture={f}
                entrantNames={entrantNames}
                feedLabels={feedLabels}
                conflicts={conflictsByFixture[f.id] ?? []}
                color={divisions.length > 1 ? colorOf[f.division_id] : undefined}
                canEdit={canEdit}
                selected={selected === f.id}
                onSelect={() => setSelected(selected === f.id ? null : f.id)}
                onTogglePin={() => void togglePin(f)}
              />
            ))}
          </div>
        </section>
      )}

      {/* Settings */}
      <SettingsPanel
        divisionId={settings.division_id}
        config={cfg}
        tz={settings.tz}
        canEdit={canEdit}
        constraintsAllowed={constraintsAllowed}
        onSaved={() => {
          setNotice("Scheduling settings saved.");
          router.refresh();
        }}
        onError={fail}
      />
    </div>
  );
}

function cardTitle(
  f: BoardFixture,
  names: Record<string, string>,
  feeds: Record<string, FeedLabelPair>,
): string {
  const home = f.home_entrant_id
    ? (names[f.home_entrant_id] ?? "?")
    : (feeds[f.id]?.home ?? "TBD");
  const away = f.away_entrant_id
    ? (names[f.away_entrant_id] ?? "?")
    : (feeds[f.id]?.away ?? "TBD");
  return `${home} vs ${away}`;
}

function FixtureCard({
  fixture,
  entrantNames,
  feedLabels,
  conflicts,
  color,
  canEdit,
  selected,
  onSelect,
  onTogglePin,
}: {
  fixture: BoardFixture;
  entrantNames: Record<string, string>;
  feedLabels: Record<string, FeedLabelPair>;
  conflicts: BoardConflict[];
  color?: string;
  canEdit: boolean;
  selected: boolean;
  onSelect: () => void;
  onTogglePin: () => void;
}) {
  const movable = canEdit && fixture.status === "scheduled";
  const blocking = conflicts.some((c) => c.blocking);
  return (
    <div
      draggable={movable}
      onDragStart={(e) => e.dataTransfer.setData("text/fixture", fixture.id)}
      className={`group mb-0.5 rounded border px-1.5 py-1 text-[11px] leading-tight ${
        blocking
          ? "border-red-300 bg-red-50"
          : conflicts.length > 0
            ? "border-amber-300 bg-amber-50"
            : "border-slate-200 bg-white"
      } ${selected ? "ring-2 ring-purple-400" : ""} ${movable ? "cursor-grab" : "opacity-80"}`}
      style={color ? { borderLeftWidth: 3, borderLeftColor: color } : undefined}
    >
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={onSelect}
          aria-pressed={selected}
          aria-label={`${cardTitle(fixture, entrantNames, feedLabels)} — round ${fixture.round_no}${canEdit ? ". Select to move via menu" : ""}`}
          className="min-w-0 flex-1 truncate text-left font-medium text-slate-700 hover:text-purple-700"
        >
          {cardTitle(fixture, entrantNames, feedLabels)}
        </button>
        {canEdit && fixture.status === "scheduled" && (
          <button
            type="button"
            onClick={onTogglePin}
            aria-label={fixture.schedule_locked ? "Unlock (allow re-flow)" : "Pin/lock this slot"}
            title={fixture.schedule_locked ? "Locked — survives re-flow" : "Pin this slot"}
            className={fixture.schedule_locked ? "" : "opacity-30 group-hover:opacity-100"}
          >
            {fixture.schedule_locked ? "🔒" : "📌"}
          </button>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-1 text-[10px] text-slate-400">
        <span>R{fixture.round_no}</span>
        {fixture.status !== "scheduled" && <span className="text-sky-600">{fixture.status}</span>}
        {conflicts.map((c, i) => (
          <span
            key={i}
            title={c.detail}
            className={`rounded px-1 ${c.blocking ? "bg-red-100 text-red-700" : "bg-amber-100 text-amber-700"}`}
          >
            {CONFLICT_LABEL[c.code] ?? c.code}
          </span>
        ))}
      </div>
    </div>
  );
}

// Keyboard-accessible alternative to dragging: pick court + time, hit Move.
function MovePanel({
  fixture,
  courts,
  entrantNames,
  feedLabels,
  onMove,
  onClose,
}: {
  fixture: BoardFixture;
  courts: string[];
  entrantNames: Record<string, string>;
  feedLabels: Record<string, FeedLabelPair>;
  onMove: (atIso: string | null, court: string | null) => void;
  onClose: () => void;
}) {
  const [when, setWhen] = useState(
    fixture.scheduled_at ? toLocalInput(fixture.scheduled_at) : "",
  );
  const [court, setCourt] = useState(fixture.court_label ?? courts[0] ?? "");
  return (
    <div
      role="dialog"
      aria-label={`Move ${cardTitle(fixture, entrantNames, feedLabels)}`}
      className="flex flex-wrap items-end gap-2 rounded-lg border border-purple-200 bg-purple-50 p-3"
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
    >
      <p className="w-full text-xs font-medium text-purple-800">
        Move: {cardTitle(fixture, entrantNames, feedLabels)}
      </p>
      <label className="block">
        <span className="label">When</span>
        <input
          type="datetime-local"
          value={when}
          onChange={(e) => setWhen(e.target.value)}
          className="input px-2 py-1 text-xs"
          autoFocus
        />
      </label>
      <label className="block">
        <span className="label">Court</span>
        <select value={court} onChange={(e) => setCourt(e.target.value)} className="input px-2 py-1 text-xs">
          {courts.map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>
      </label>
      <button
        type="button"
        onClick={() => onMove(when ? new Date(when).toISOString() : null, court || null)}
        className="btn btn-primary px-3 py-1.5 text-xs"
      >
        Move
      </button>
      <button type="button" onClick={onClose} className="btn btn-ghost px-3 py-1.5 text-xs">
        Cancel
      </button>
    </div>
  );
}

function SettingsPanel({
  divisionId,
  config,
  tz,
  canEdit,
  constraintsAllowed,
  onSaved,
  onError,
}: {
  divisionId: string;
  config: BoardConfig;
  tz: string;
  canEdit: boolean;
  constraintsAllowed: boolean;
  onSaved: () => void;
  onError: (err: unknown) => void;
}) {
  const [open, setOpen] = useState(false);
  const [startAt, setStartAt] = useState(config.startAt ? toLocalInput(config.startAt) : "");
  const [matchMinutes, setMatchMinutes] = useState(config.matchMinutes);
  const [gapMinutes, setGapMinutes] = useState(config.gapMinutes);
  const [rest, setRest] = useState(config.perEntrantMinRest);
  const [courtsText, setCourtsText] = useState(config.courts.join(", "));
  const [zone, setZone] = useState(tz);
  const [saving, setSaving] = useState(false);

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="text-xs text-purple-600 hover:underline">
        Scheduling settings ({config.courts.length} court{config.courts.length === 1 ? "" : "s"}, {config.matchMinutes}
        min matches{config.perEntrantMinRest > 0 ? `, ${config.perEntrantMinRest}min rest` : ""})
      </button>
    );
  }

  async function save() {
    setSaving(true);
    try {
      const courts = courtsText.split(",").map((c) => c.trim()).filter(Boolean);
      await apiV1(`/api/v1/divisions/${divisionId}/schedule-settings`, {
        method: "PUT",
        json: {
          config: {
            ...config,
            startAt: startAt ? new Date(startAt).toISOString() : null,
            matchMinutes,
            gapMinutes,
            perEntrantMinRest: rest,
            courts: courts.length > 0 ? courts : ["Court 1"],
          },
          tz: zone,
        },
      });
      setOpen(false);
      onSaved();
    } catch (err) {
      onError(err);
    } finally {
      setSaving(false);
    }
  }

  const constrained = !constraintsAllowed;
  return (
    <section className="card space-y-2 p-4">
      <h4 className="text-sm font-semibold text-slate-700">Scheduling settings</h4>
      {constrained && <UpgradeGate feature="scheduling.constraints" compact />}
      <div className="flex flex-wrap items-end gap-3">
        <label className="block">
          <span className="label">First match</span>
          <input type="datetime-local" value={startAt} onChange={(e) => setStartAt(e.target.value)} className="input px-2 py-1 text-xs" disabled={!canEdit} />
        </label>
        <label className="block">
          <span className="label">Match (min)</span>
          <input type="number" min={1} value={matchMinutes} onChange={(e) => setMatchMinutes(Number(e.target.value))} className="input w-20 px-2 py-1 text-xs" disabled={!canEdit} />
        </label>
        <label className="block">
          <span className="label">Gap (min)</span>
          <input type="number" min={0} value={gapMinutes} onChange={(e) => setGapMinutes(Number(e.target.value))} className="input w-20 px-2 py-1 text-xs" disabled={!canEdit} />
        </label>
        <label className="block">
          <span className="label">Min rest (min)</span>
          <input type="number" min={0} value={rest} onChange={(e) => setRest(Number(e.target.value))} className="input w-20 px-2 py-1 text-xs" disabled={!canEdit || constrained} />
        </label>
        <label className="block">
          <span className="label">Courts (comma-separated)</span>
          <input value={courtsText} onChange={(e) => setCourtsText(e.target.value)} className="input w-56 px-2 py-1 text-xs" disabled={!canEdit} />
        </label>
        <label className="block">
          <span className="label">Timezone</span>
          <input value={zone} onChange={(e) => setZone(e.target.value)} className="input w-36 px-2 py-1 text-xs" disabled={!canEdit} />
        </label>
        {canEdit && (
          <button type="button" disabled={saving} onClick={save} className="btn btn-primary px-3 py-1.5 text-xs">
            {saving ? "Saving…" : "Save"}
          </button>
        )}
        <button type="button" onClick={() => setOpen(false)} className="btn btn-ghost px-3 py-1.5 text-xs">
          Close
        </button>
      </div>
      <p className="text-[11px] text-slate-400">
        Blackouts and session windows are honoured by the auto pass and validator; multi-court,
        rest, blackout and session constraints need the Pro constraint solver.
      </p>
    </section>
  );
}
