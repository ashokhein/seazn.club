"use client";

// Players panel — list / switch / delete profiles, add a new one, and set the
// active player's name and copy register. Port of js/app.js renderProfilePanel.
import { useState } from "react";
import { Mode, useProgress } from "../../lib/progress";
import { Modal } from "./Modal";

export function ProfilePanel({ onClose }: { onClose(): void }) {
  const progress = useProgress();
  const [armedDelete, setArmedDelete] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [newMode, setNewMode] = useState<Mode>("classic");

  const profiles = progress.profiles();
  const activeId = progress.activeId();

  return (
    <Modal title="Players" onClose={onClose}>
      <p className="text-xs text-slate-500">
        Each player keeps their own progress, stars and streak.
      </p>

      <ul className="mt-3 flex flex-col gap-2">
        {profiles.map((prof, i) => {
          const active = prof.id === activeId;
          return (
            <li
              key={prof.id}
              className={`flex items-center gap-2 rounded-xl border p-2 ${
                active ? "border-purple-400 bg-purple-50" : "border-slate-200"
              }`}
            >
              <span className="flex-1 text-sm font-medium text-purple-950">
                {prof.name || `Player ${i + 1}`}
                <span className="ml-2 rounded-full bg-slate-100 px-1.5 py-0.5 text-xs text-slate-500">
                  {prof.mode === "story" ? "Story" : "Classic"}
                </span>
                {active ? <span className="ml-2 text-xs text-purple-600">· active</span> : null}
              </span>
              {!active ? (
                <button
                  type="button"
                  className="rounded-lg border border-purple-300 px-2 py-1 text-xs font-medium text-purple-700 hover:bg-purple-50"
                  onClick={() => progress.switchProfile(prof.id)}
                >
                  Switch
                </button>
              ) : null}
              {profiles.length > 1 ? (
                <button
                  type="button"
                  className={`rounded-lg border px-2 py-1 text-xs font-medium ${
                    armedDelete === prof.id
                      ? "border-rose-500 bg-rose-500 text-white"
                      : "border-rose-300 text-rose-600 hover:bg-rose-50"
                  }`}
                  onClick={() => {
                    if (armedDelete === prof.id) {
                      progress.removeProfile(prof.id);
                      setArmedDelete(null);
                    } else {
                      setArmedDelete(prof.id);
                    }
                  }}
                >
                  {armedDelete === prof.id ? "Really delete?" : "Delete"}
                </button>
              ) : null}
            </li>
          );
        })}
      </ul>

      {/* Active player's settings */}
      <div className="mt-5 border-t border-slate-100 pt-4">
        <label className="text-xs font-semibold text-slate-600">This player’s name</label>
        <input
          type="text"
          maxLength={16}
          value={progress.getName()}
          onChange={(e) => progress.setName(e.target.value)}
          placeholder="Add a name"
          className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
        />
        <div className="mt-3 flex gap-2">
          {(["story", "classic"] as Mode[]).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => progress.setMode(m)}
              className={`rounded-full border px-3 py-1 text-sm font-medium ${
                progress.getMode() === m
                  ? "border-purple-600 bg-purple-600 text-white"
                  : "border-purple-300 bg-white text-purple-800 hover:bg-purple-50"
              }`}
            >
              {m === "story" ? "Story (kids)" : "Classic (adult)"}
            </button>
          ))}
        </div>
      </div>

      {/* Add a new player */}
      <div className="mt-5 border-t border-slate-100 pt-4">
        <label className="text-xs font-semibold text-slate-600">Add a player</label>
        <div className="mt-1 flex flex-wrap gap-2">
          <input
            type="text"
            maxLength={16}
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="Name"
            className="min-w-32 flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm"
          />
          <select
            value={newMode}
            onChange={(e) => setNewMode(e.target.value as Mode)}
            className="rounded-lg border border-slate-300 px-2 py-2 text-sm"
          >
            <option value="classic">Classic</option>
            <option value="story">Story</option>
          </select>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => {
              progress.addProfile(newName, newMode);
              setNewName("");
            }}
          >
            Add
          </button>
        </div>
      </div>
    </Modal>
  );
}
