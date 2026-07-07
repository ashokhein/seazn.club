"use client";

// Football timeline pad (spec 04 §1): goals, cards, subs, period boundaries,
// shootout kicks. The event log below the console is the match timeline.
import { useState } from "react";
import type { SendEvent, SideInfo, SportInfo, LiveState } from "@/components/v2/fixture-console";

interface FootballStateView {
  phase?: string;
  goals?: { home: number; away: number };
  shootout?: { kicks: { side: string; scored: boolean }[] } | null;
}

// Which period boundary ends the current play phase (spec 04 §1.3).
const PERIOD_END: Record<string, { phase: string; label: string }> = {
  H1: { phase: "HT", label: "End 1st half (HT)" },
  H2: { phase: "FT", label: "End 2nd half (FT)" },
  ET_H1: { phase: "ET_HT", label: "End ET 1st half" },
  ET_H2: { phase: "ET_FT", label: "End extra time" },
};

export function FootballPad({
  home,
  away,
  live,
  send,
  busy,
}: {
  sport?: SportInfo;
  home: SideInfo;
  away: SideInfo;
  live: LiveState;
  send: SendEvent;
  busy: boolean;
}) {
  const state = (live.state ?? {}) as FootballStateView;
  const phase = state.phase ?? "pre";
  const periodEnd = PERIOD_END[phase];
  const inShootout = phase === "SHOOTOUT";
  const playing = periodEnd !== undefined || inShootout;

  return (
    <div className="space-y-4">
      {phase === "pre" && (
        <p className="text-xs text-amber-600">Start the match to open the first half.</p>
      )}
      {playing && (
        <p className="text-xs text-slate-400">
          Phase: <span className="font-mono">{phase}</span>
        </p>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        {[home, away].map((side) => (
          <SidePad
            key={side.id}
            side={side}
            disabled={busy || !playing || inShootout}
            send={send}
          />
        ))}
      </div>

      {inShootout && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3">
          <p className="mb-2 text-xs font-medium text-amber-800">
            Penalty shootout — record each kick in order.
          </p>
          <div className="flex flex-wrap gap-2">
            {[home, away].map((side) => (
              <span key={side.id} className="flex items-center gap-1.5">
                <span className="text-xs text-slate-600">{side.name}:</span>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => send("football.shootout.kick", { by: side.id, scored: true })}
                  className="btn btn-primary px-3 py-1 text-xs"
                >
                  ⚽ scored
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => send("football.shootout.kick", { by: side.id, scored: false })}
                  className="btn btn-danger px-3 py-1 text-xs"
                >
                  ✕ missed
                </button>
              </span>
            ))}
          </div>
        </div>
      )}

      {periodEnd && (
        <button
          type="button"
          disabled={busy}
          onClick={() => send("football.period", { phase: periodEnd.phase })}
          className="btn btn-ghost"
        >
          ⏱ {periodEnd.label}
        </button>
      )}
    </div>
  );
}

function SidePad({
  side,
  disabled,
  send,
}: {
  side: SideInfo;
  disabled: boolean;
  send: SendEvent;
}) {
  const [minute, setMinute] = useState("");
  const [person, setPerson] = useState("");
  const [assist, setAssist] = useState("");
  const [byNumber, setByNumber] = useState(false);
  const [action, setAction] = useState<"goal" | "yellow" | "red" | "sub" | "motm" | null>(null);
  const [subOn, setSubOn] = useState("");

  // Jul3/07 §5: pickers show "#7 — Name"; number-order sort is a toggle
  // (19 May).
  const roster = side.lineup.length > 0 ? side.lineup : side.members;
  const people = roster.map((m) => ({
    person_id: m.person_id,
    full_name: m.full_name,
    squad_number: "squad_number" in m ? (m.squad_number ?? null) : null,
  }));
  if (byNumber) {
    people.sort((a, b) => (a.squad_number ?? 999) - (b.squad_number ?? 999));
  }
  const label = (p: { full_name: string; squad_number: number | null }) =>
    p.squad_number !== null ? `#${p.squad_number} — ${p.full_name}` : p.full_name;

  const min = minute ? { minute: Number(minute) } : {};

  async function fire() {
    if (!action) return;
    let ok = false;
    if (action === "goal") {
      ok = await send("football.goal", {
        by: side.id,
        ...(person ? { scorer: person } : {}),
        ...(assist ? { assist } : {}),
        ...min,
      });
    } else if (action === "yellow" || action === "red") {
      ok = await send("football.card", {
        by: side.id,
        color: action,
        ...(person ? { person } : {}),
        ...min,
      });
    } else if (action === "sub") {
      if (!person || !subOn) return;
      ok = await send("football.sub", { by: side.id, off: person, on: subOn, ...min });
    } else if (action === "motm") {
      // Jul3/07 §4: MOTM rides the ordinary scoring endpoint (core.award)
      if (!person) return;
      ok = await send("core.award", { person, key: "motm" });
    }
    if (ok) {
      setAction(null);
      setPerson("");
      setSubOn("");
      setMinute("");
    }
  }

  return (
    <div className="rounded-xl border border-slate-200 p-3">
      <p className="mb-2 truncate text-sm font-medium text-slate-700">{side.name}</p>
      <div className="flex flex-wrap gap-1.5">
        <button
          type="button"
          disabled={disabled}
          onClick={() => setAction(action === "goal" ? null : "goal")}
          className={`btn px-3 py-1.5 text-xs ${action === "goal" ? "btn-primary" : "btn-ghost"}`}
        >
          ⚽ Goal
        </button>
        <button
          type="button"
          disabled={disabled}
          onClick={() => setAction(action === "yellow" ? null : "yellow")}
          className={`btn px-3 py-1.5 text-xs ${action === "yellow" ? "btn-primary" : "btn-ghost"}`}
        >
          🟨 Yellow
        </button>
        <button
          type="button"
          disabled={disabled}
          onClick={() => setAction(action === "red" ? null : "red")}
          className={`btn px-3 py-1.5 text-xs ${action === "red" ? "btn-primary" : "btn-ghost"}`}
        >
          🟥 Red
        </button>
        <button
          type="button"
          disabled={disabled}
          onClick={() => setAction(action === "sub" ? null : "sub")}
          className={`btn px-3 py-1.5 text-xs ${action === "sub" ? "btn-primary" : "btn-ghost"}`}
        >
          ⇄ Sub
        </button>
        <button
          type="button"
          disabled={disabled}
          onClick={() => setAction(action === "motm" ? null : "motm")}
          className={`btn px-3 py-1.5 text-xs ${action === "motm" ? "btn-primary" : "btn-ghost"}`}
        >
          ⭐ MVP
        </button>
      </div>

      {action && (
        <div className="mt-2 flex flex-wrap items-end gap-2">
          <label className="block">
            <span className="label">
              {action === "sub" ? "Off" : action === "motm" ? "Man of the match" : "Player (optional)"}{" "}
              <button
                type="button"
                className="text-[10px] text-purple-600 hover:underline"
                onClick={() => setByNumber((v) => !v)}
              >
                {byNumber ? "sort by name" : "sort by number"}
              </button>
            </span>
            <select
              value={person}
              onChange={(e) => setPerson(e.target.value)}
              className="select w-36 px-2 py-1 text-xs"
            >
              <option value="">—</option>
              {people.map((p) => (
                <option key={p.person_id} value={p.person_id}>
                  {label(p)}
                </option>
              ))}
            </select>
          </label>
          {action === "goal" && (
            <label className="block">
              <span className="label">Assist (optional)</span>
              <select
                value={assist}
                onChange={(e) => setAssist(e.target.value)}
                className="select w-36 px-2 py-1 text-xs"
              >
                <option value="">—</option>
                {people
                  .filter((p) => p.person_id !== person)
                  .map((p) => (
                    <option key={p.person_id} value={p.person_id}>
                      {label(p)}
                    </option>
                  ))}
              </select>
            </label>
          )}
          {action === "sub" && (
            <label className="block">
              <span className="label">On</span>
              <select
                value={subOn}
                onChange={(e) => setSubOn(e.target.value)}
                className="select w-36 px-2 py-1 text-xs"
              >
                <option value="">—</option>
                {people.map((p) => (
                  <option key={p.person_id} value={p.person_id}>
                    {label(p)}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="block">
            <span className="label">Minute</span>
            <input
              type="number"
              min={0}
              max={150}
              value={minute}
              onChange={(e) => setMinute(e.target.value)}
              className="input w-20 px-2 py-1 text-xs"
            />
          </label>
          <button
            type="button"
            disabled={disabled || (action === "sub" && (!person || !subOn))}
            onClick={fire}
            className="btn btn-primary px-3 py-1.5 text-xs"
          >
            Record
          </button>
        </div>
      )}
    </div>
  );
}
