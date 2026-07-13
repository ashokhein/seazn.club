"use client";

// Period pad (v6/00 §5) — shared by icehockey and hockey (and future
// football migration), driven entirely by the division's module config: no
// sport-key branching inside. Goals (quick tap or a detail sheet with
// scorer/assists/kind), penalties/cards from the SuspensionCfg class table
// with an active list + release action, period advances from the kernel's
// own `nextAdvance`, and the shootout recorder. The strength chip stays
// visible while any team-short suspension runs. Countdown hints are wall-
// clock sugar — the fold trusts only start/release events (v6/00 §6.1).
import { useEffect, useRef, useState } from "react";
import type { SendEvent, SideInfo, SportInfo, LiveState } from "@/components/v2/fixture-console";

interface SuspensionView {
  side: "home" | "away";
  person?: string;
  classKey: string;
  teamShort: boolean;
  permanent: boolean;
}

interface PeriodStateView {
  phase?: string;
  goals?: { home: number; away: number };
  suspensions?: SuspensionView[];
  shootout?: { kicks: { side: string; scored: boolean }[] } | null;
}

interface PeriodDetailView {
  nextAdvance?: string | null;
  shootoutNext?: "home" | "away" | null;
  strength?: string | null;
  escalate?: string[];
}

interface SuspensionClassCfg {
  minutes: number | null;
  teamShort: boolean;
  permanent?: boolean;
}

interface PeriodCfgView {
  suspensions?: { classes: Record<string, SuspensionClassCfg> } | null;
  goalKinds?: string[];
  assists?: boolean;
  shootout?: { attempts: number } | null;
}

const KIND_LABELS: Record<string, string> = {
  pp: "Power play",
  sh: "Short-handed",
  ps: "Penalty shot",
  pc: "Penalty corner",
  stroke: "Penalty stroke",
};

function classLabel(key: string, cls: SuspensionClassCfg): string {
  const name = key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  return cls.minutes === null ? name : `${name} (${cls.minutes}′)`;
}

export function PeriodPad({
  sport,
  home,
  away,
  live,
  send,
  busy,
}: {
  sport: SportInfo;
  home: SideInfo;
  away: SideInfo;
  live: LiveState;
  send: SendEvent;
  busy: boolean;
}) {
  const state = (live.state ?? {}) as PeriodStateView;
  const detail = ((live.summary as { detail?: unknown } | null)?.detail ?? {}) as PeriodDetailView;
  const cfg = (sport.config ?? {}) as PeriodCfgView;

  // Event type names come from the module's own tier declarations.
  const tier3 = sport.fidelityTiers.find((t) => t.tier === 3)?.eventTypes ?? [];
  const typeEnding = (suffix: string) => tier3.find((t) => t.endsWith(suffix));
  const goalType = typeEnding(".goal");
  const advanceType = typeEnding(".period.advance");
  const suspStartType = typeEnding(".suspension.start");
  const suspEndType = typeEnding(".suspension.end");
  const attemptType = typeEnding(".shootout.attempt");

  const phase = state.phase ?? "pre";
  const pre = phase === "pre" || live.status === "scheduled";
  const inShootout = phase === "SHOOTOUT";
  const playing = !pre && !inShootout && phase !== "done" && phase !== "final" && phase !== "abandoned";
  const suspensions = state.suspensions ?? [];
  const classes = cfg.suspensions?.classes ?? null;

  // Wall-clock countdown hints: stamp suspensions we see appear. Display
  // only — release is always the scorer's explicit action.
  const stampsRef = useRef<Map<number, number>>(new Map());
  const [, forceTick] = useState(0);
  useEffect(() => {
    const stamps = stampsRef.current;
    suspensions.forEach((_, i) => {
      if (!stamps.has(i)) stamps.set(i, Date.now());
    });
    for (const key of [...stamps.keys()]) {
      if (key >= suspensions.length) stamps.delete(key);
    }
  }, [suspensions]);
  useEffect(() => {
    if (suspensions.length === 0) return;
    const id = setInterval(() => forceTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [suspensions.length]);

  function countdown(index: number, susp: SuspensionView): string | null {
    if (classes === null) return null;
    const cls = classes[susp.classKey];
    if (!cls || cls.minutes === null) return susp.permanent ? "match" : null;
    const started = stampsRef.current.get(index);
    if (started === undefined) return `${cls.minutes}:00`;
    const left = Math.max(0, cls.minutes * 60 - Math.floor((Date.now() - started) / 1000));
    const mm = Math.floor(left / 60);
    const ss = String(left % 60).padStart(2, "0");
    return `${mm}:${ss}`;
  }

  const nameOf = (side: SideInfo, personId?: string): string | null => {
    if (!personId) return null;
    const roster = side.lineup.length > 0 ? side.lineup : side.members;
    return roster.find((m) => m.person_id === personId)?.full_name ?? personId;
  };
  const sideInfo = (key: "home" | "away") => (key === "home" ? home : away);

  return (
    <div className="space-y-4">
      {pre && <p className="text-xs text-amber-600">Start the match to open the first period.</p>}

      {(playing || inShootout) && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-full bg-slate-100 px-3 py-1 font-mono text-xs font-semibold text-slate-700">
            {inShootout ? "Shoot-out" : phase}
          </span>
          {detail.strength ? (
            <span className="rounded-full bg-amber-100 px-3 py-1 font-mono text-xs font-bold text-amber-800">
              {detail.strength}
            </span>
          ) : null}
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        {(["home", "away"] as const).map((key) => (
          <PeriodSidePad
            key={key}
            side={sideInfo(key)}
            score={state.goals?.[key] ?? 0}
            disabled={busy || !playing}
            goalType={goalType}
            suspStartType={suspStartType}
            classes={classes}
            goalKinds={(cfg.goalKinds ?? []).filter((k) => k !== "fg" && k !== "og")}
            assists={cfg.assists === true}
            escalate={detail.escalate ?? []}
            send={send}
          />
        ))}
      </div>

      {suspensions.length > 0 && suspEndType && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3">
          <p className="mb-2 text-xs font-medium text-amber-800">Running penalties</p>
          <ul className="space-y-1.5">
            {suspensions.map((susp, i) => {
              const side = sideInfo(susp.side);
              const hint = countdown(i, susp);
              return (
                <li key={i} className="flex flex-wrap items-center gap-2 text-xs text-slate-700">
                  <span className="font-medium">{side.name}</span>
                  <span>
                    {classes ? classLabel(susp.classKey, classes[susp.classKey] ?? { minutes: null, teamShort: false }) : susp.classKey}
                  </span>
                  {susp.person ? <span className="text-slate-500">{nameOf(side, susp.person)}</span> : null}
                  {hint ? <span className="font-mono text-amber-700">{hint}</span> : null}
                  {!susp.permanent && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        send(suspEndType, {
                          by: side.id,
                          class: susp.classKey,
                          ...(susp.person ? { person: susp.person } : {}),
                        })
                      }
                      className="btn btn-ghost px-2 py-0.5 text-[11px]"
                    >
                      Release
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
          <p className="mt-1.5 text-[10px] text-amber-700/80">
            Timers are a hint — release when the clock says so (a minor ends on a
            power-play goal).
          </p>
        </div>
      )}

      {inShootout && attemptType && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3">
          <p className="mb-2 text-xs font-medium text-amber-800">
            Shoot-out — record each attempt in order.
            {state.shootout && cfg.shootout && state.shootout.kicks.length >= cfg.shootout.attempts * 2
              ? " Sudden death."
              : ""}
          </p>
          <div className="flex flex-wrap gap-2">
            {(["home", "away"] as const).map((key) => {
              const side = sideInfo(key);
              const up = detail.shootoutNext === key || detail.shootoutNext == null;
              return (
                <span
                  key={side.id}
                  className={`flex items-center gap-1.5 rounded-lg px-1.5 py-1 ${up ? "" : "opacity-40"}`}
                >
                  <span className="text-xs text-slate-600">{side.name}:</span>
                  <button
                    type="button"
                    disabled={busy || !up}
                    onClick={() => send(attemptType, { by: side.id, scored: true })}
                    className="btn btn-primary px-3 py-1 text-xs"
                  >
                    ✓ scored
                  </button>
                  <button
                    type="button"
                    disabled={busy || !up}
                    onClick={() => send(attemptType, { by: side.id, scored: false })}
                    className="btn btn-danger px-3 py-1 text-xs"
                  >
                    ✕ missed
                  </button>
                </span>
              );
            })}
          </div>
        </div>
      )}

      {playing && detail.nextAdvance && advanceType && (
        <button
          type="button"
          disabled={busy}
          onClick={() => send(advanceType, { to: detail.nextAdvance })}
          className="btn btn-ghost"
        >
          ⏱ End {phase}
          {detail.nextAdvance !== "FT" ? ` → ${detail.nextAdvance}` : ""}
        </button>
      )}
    </div>
  );
}

function PeriodSidePad({
  side,
  score,
  disabled,
  goalType,
  suspStartType,
  classes,
  goalKinds,
  assists,
  escalate,
  send,
}: {
  side: SideInfo;
  score: number;
  disabled: boolean;
  goalType?: string;
  suspStartType?: string;
  classes: Record<string, SuspensionClassCfg> | null;
  goalKinds: string[];
  assists: boolean;
  escalate: string[];
  send: SendEvent;
}) {
  const [sheet, setSheet] = useState<"goal" | "penalty" | null>(null);
  const [person, setPerson] = useState("");
  const [assist1, setAssist1] = useState("");
  const [assist2, setAssist2] = useState("");
  const [kind, setKind] = useState("");
  const [classKey, setClassKey] = useState("");

  const roster = side.lineup.length > 0 ? side.lineup : side.members;
  const people = roster.map((m) => ({ person_id: m.person_id, full_name: m.full_name }));

  async function fireGoal() {
    if (!goalType) return;
    const chosenAssists = [assist1, assist2].filter(Boolean);
    const ok = await send(goalType, {
      by: side.id,
      ...(person ? { person } : {}),
      ...(kind ? { kind } : {}),
      ...(assists && chosenAssists.length > 0 && kind !== "og" ? { assists: chosenAssists } : {}),
    });
    if (ok) {
      setSheet(null);
      setPerson("");
      setAssist1("");
      setAssist2("");
      setKind("");
    }
  }

  async function firePenalty() {
    if (!suspStartType || !classKey) return;
    const ok = await send(suspStartType, {
      by: side.id,
      class: classKey,
      ...(person ? { person } : {}),
    });
    if (ok) {
      setSheet(null);
      setPerson("");
      setClassKey("");
    }
  }

  const escalating = sheet === "penalty" && person !== "" && escalate.includes(person);

  return (
    <div className="rounded-xl border border-slate-200 p-3">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <p className="truncate text-sm font-medium text-slate-700">{side.name}</p>
        <p className="font-mono text-3xl font-bold tabular-nums text-slate-900">{score}</p>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {goalType && (
          <button
            type="button"
            disabled={disabled}
            onClick={() => send(goalType, { by: side.id })}
            className="btn btn-primary px-3 py-1.5 text-xs"
          >
            + Goal
          </button>
        )}
        {goalType && (
          <button
            type="button"
            disabled={disabled}
            onClick={() => setSheet(sheet === "goal" ? null : "goal")}
            className={`btn px-3 py-1.5 text-xs ${sheet === "goal" ? "btn-primary" : "btn-ghost"}`}
          >
            Goal details…
          </button>
        )}
        {suspStartType && classes && (
          <button
            type="button"
            disabled={disabled}
            onClick={() => setSheet(sheet === "penalty" ? null : "penalty")}
            className={`btn px-3 py-1.5 text-xs ${sheet === "penalty" ? "btn-primary" : "btn-ghost"}`}
          >
            ▮ Penalty / card
          </button>
        )}
      </div>

      {sheet === "goal" && (
        <div className="mt-2 flex flex-wrap items-end gap-2">
          <label className="block">
            <span className="label">Scorer (optional)</span>
            <select value={person} onChange={(e) => setPerson(e.target.value)} className="select w-36 px-2 py-1 text-xs">
              <option value="">—</option>
              {people.map((p) => (
                <option key={p.person_id} value={p.person_id}>{p.full_name}</option>
              ))}
            </select>
          </label>
          {assists && (
            <>
              <label className="block">
                <span className="label">Assist 1</span>
                <select value={assist1} onChange={(e) => setAssist1(e.target.value)} className="select w-32 px-2 py-1 text-xs">
                  <option value="">—</option>
                  {people.filter((p) => p.person_id !== person).map((p) => (
                    <option key={p.person_id} value={p.person_id}>{p.full_name}</option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="label">Assist 2</span>
                <select value={assist2} onChange={(e) => setAssist2(e.target.value)} className="select w-32 px-2 py-1 text-xs">
                  <option value="">—</option>
                  {people.filter((p) => p.person_id !== person && p.person_id !== assist1).map((p) => (
                    <option key={p.person_id} value={p.person_id}>{p.full_name}</option>
                  ))}
                </select>
              </label>
            </>
          )}
          <label className="block">
            <span className="label">Type</span>
            <select value={kind} onChange={(e) => setKind(e.target.value)} className="select w-32 px-2 py-1 text-xs">
              <option value="">Open play</option>
              {goalKinds.map((k) => (
                <option key={k} value={k}>{KIND_LABELS[k] ?? k.toUpperCase()}</option>
              ))}
              <option value="og">Own goal</option>
            </select>
          </label>
          <button type="button" disabled={disabled} onClick={fireGoal} className="btn btn-primary px-3 py-1.5 text-xs">
            Record goal
          </button>
        </div>
      )}

      {sheet === "penalty" && classes && (
        <div className="mt-2 space-y-2">
          <div className="flex flex-wrap items-end gap-2">
            <label className="block">
              <span className="label">Class</span>
              <select value={classKey} onChange={(e) => setClassKey(e.target.value)} className="select w-40 px-2 py-1 text-xs">
                <option value="">—</option>
                {Object.entries(classes).map(([key, cls]) => (
                  <option key={key} value={key}>{classLabel(key, cls)}</option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="label">Player (optional)</span>
              <select value={person} onChange={(e) => setPerson(e.target.value)} className="select w-36 px-2 py-1 text-xs">
                <option value="">—</option>
                {people.map((p) => (
                  <option key={p.person_id} value={p.person_id}>{p.full_name}</option>
                ))}
              </select>
            </label>
            <button
              type="button"
              disabled={disabled || classKey === ""}
              onClick={firePenalty}
              className="btn btn-primary px-3 py-1.5 text-xs"
            >
              Record
            </button>
          </div>
          {escalating && (
            <p className="text-[11px] font-medium text-amber-700">
              Prior green card this match — a yellow is the usual escalation.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
