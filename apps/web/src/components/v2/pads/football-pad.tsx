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
  const [action, setAction] = useState<"goal" | "yellow" | "red" | "sub" | null>(null);
  const [subOn, setSubOn] = useState("");

  const people = side.lineup.length > 0 ? side.lineup : side.members.map((m) => ({
    person_id: m.person_id,
    full_name: m.full_name,
  }));

  const min = minute ? { minute: Number(minute) } : {};

  async function fire() {
    if (!action) return;
    let ok = false;
    if (action === "goal") {
      ok = await send("football.goal", {
        by: side.id,
        ...(person ? { scorer: person } : {}),
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
      </div>

      {action && (
        <div className="mt-2 flex flex-wrap items-end gap-2">
          <label className="block">
            <span className="label">{action === "sub" ? "Off" : "Player (optional)"}</span>
            <select
              value={person}
              onChange={(e) => setPerson(e.target.value)}
              className="select w-36 px-2 py-1 text-xs"
            >
              <option value="">—</option>
              {people.map((p) => (
                <option key={p.person_id} value={p.person_id}>
                  {p.full_name}
                </option>
              ))}
            </select>
          </label>
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
                    {p.full_name}
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
