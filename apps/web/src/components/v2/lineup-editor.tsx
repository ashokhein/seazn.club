"use client";

// Per-fixture lineup editor: pick starters/bench from the entrant's roster,
// assign positions/order from the module catalog. PUT replaces the lineup
// (doc 08 §3); the engine validates size/roles at the scoring door.
import { useState } from "react";
import { apiV1 } from "@/lib/client-v1";
import type { SideInfo, LineupSlotIn } from "@/components/v2/fixture-console";

interface Props {
  fixtureId: string;
  side: SideInfo;
  positionGroups: { key: string; name: string }[];
  roles: { key: string; name?: string }[];
  lineupSize: number;
  canEdit: boolean;
  onSaved: () => void;
}

interface SlotDraft {
  person_id: string;
  full_name: string;
  slot: "starting" | "bench";
  position_key: string | null;
  order_no: number;
  roles: string[];
}

export function LineupEditor({
  fixtureId,
  side,
  positionGroups,
  roles,
  lineupSize,
  canEdit,
  onSaved,
}: Props) {
  const [slots, setSlots] = useState<SlotDraft[]>(() =>
    side.lineup.map((s: LineupSlotIn, i) => ({
      person_id: s.person_id,
      full_name: s.full_name,
      slot: s.slot,
      position_key: s.position_key,
      order_no: s.order_no ?? i + 1,
      roles: s.roles ?? [],
    })),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const inLineup = new Set(slots.map((s) => s.person_id));
  const startingCount = slots.filter((s) => s.slot === "starting").length;

  function add(member: SideInfo["members"][number], slot: "starting" | "bench") {
    setSlots((prev) => [
      ...prev,
      {
        person_id: member.person_id,
        full_name: member.full_name,
        slot,
        position_key: member.default_position_key,
        order_no: prev.length + 1,
        roles: member.roles ?? [],
      },
    ]);
    setSaved(false);
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await apiV1(`/api/v1/fixtures/${fixtureId}/lineups/${side.id}`, {
        method: "PUT",
        json: {
          slots: slots.map((s, i) => ({
            person_id: s.person_id,
            slot: s.slot,
            position_key: s.position_key,
            order_no: i + 1,
            roles: s.roles,
          })),
        },
      });
      setSaved(true);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card p-4">
      <header className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-700">{side.name} lineup</h3>
        <span
          className={`text-xs ${startingCount === lineupSize ? "text-emerald-600" : "text-slate-400"}`}
        >
          {startingCount}/{lineupSize} starting
        </span>
      </header>

      {slots.length === 0 && (
        <p className="mb-2 text-xs text-slate-400">
          {canEdit ? "No lineup submitted — add players below." : "No lineup submitted."}
        </p>
      )}

      <ul className="space-y-1.5">
        {slots.map((s, i) => (
          <li key={s.person_id} className="flex flex-wrap items-center gap-2 text-xs">
            <span className="w-7 font-mono text-slate-400">{i + 1}.</span>
            <span className="w-36 truncate font-medium text-slate-700">{s.full_name}</span>
            <select
              disabled={!canEdit}
              value={s.slot}
              onChange={(e) => {
                const v = e.target.value as "starting" | "bench";
                setSlots((prev) => prev.map((x, j) => (j === i ? { ...x, slot: v } : x)));
                setSaved(false);
              }}
              className="select w-24 px-2 py-1 text-xs"
              aria-label={`Slot for ${s.full_name}`}
            >
              <option value="starting">starting</option>
              <option value="bench">bench</option>
            </select>
            {positionGroups.length > 0 && (
              <select
                disabled={!canEdit}
                value={s.position_key ?? ""}
                onChange={(e) => {
                  const v = e.target.value || null;
                  setSlots((prev) =>
                    prev.map((x, j) => (j === i ? { ...x, position_key: v } : x)),
                  );
                  setSaved(false);
                }}
                className="select w-32 px-2 py-1 text-xs"
                aria-label={`Position for ${s.full_name}`}
              >
                <option value="">position…</option>
                {positionGroups.map((g) => (
                  <option key={g.key} value={g.key}>
                    {g.name}
                  </option>
                ))}
              </select>
            )}
            {roles.map((r) => (
              <label key={r.key} className="flex items-center gap-1 text-slate-500">
                <input
                  type="checkbox"
                  disabled={!canEdit}
                  checked={s.roles.includes(r.key)}
                  onChange={(e) => {
                    setSlots((prev) =>
                      prev.map((x, j) =>
                        j === i
                          ? {
                              ...x,
                              roles: e.target.checked
                                ? [...x.roles, r.key]
                                : x.roles.filter((k) => k !== r.key),
                            }
                          : x,
                      ),
                    );
                    setSaved(false);
                  }}
                />
                {r.name ?? r.key}
              </label>
            ))}
            {canEdit && (
              <span className="flex gap-1">
                <button
                  type="button"
                  disabled={i === 0}
                  onClick={() => {
                    setSlots((prev) => {
                      const next = [...prev];
                      [next[i - 1], next[i]] = [next[i], next[i - 1]];
                      return next;
                    });
                    setSaved(false);
                  }}
                  className="text-slate-400 hover:text-slate-700"
                  aria-label={`Move ${s.full_name} up`}
                >
                  ↑
                </button>
                <button
                  type="button"
                  disabled={i === slots.length - 1}
                  onClick={() => {
                    setSlots((prev) => {
                      const next = [...prev];
                      [next[i], next[i + 1]] = [next[i + 1], next[i]];
                      return next;
                    });
                    setSaved(false);
                  }}
                  className="text-slate-400 hover:text-slate-700"
                  aria-label={`Move ${s.full_name} down`}
                >
                  ↓
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setSlots((prev) => prev.filter((_, j) => j !== i));
                    setSaved(false);
                  }}
                  className="text-red-500 hover:underline"
                >
                  ×
                </button>
              </span>
            )}
          </li>
        ))}
      </ul>

      {canEdit && (
        <div className="mt-3 space-y-2 border-t border-slate-100 pt-2">
          <div className="flex flex-wrap gap-1.5">
            {side.members
              .filter((m) => !inLineup.has(m.person_id))
              .map((m) => (
                <span key={m.person_id} className="inline-flex items-center gap-1 rounded-full border border-slate-200 px-2 py-0.5 text-xs text-slate-500">
                  {m.full_name}
                  <button
                    type="button"
                    onClick={() => add(m, "starting")}
                    className="text-purple-600 hover:underline"
                  >
                    start
                  </button>
                  <button
                    type="button"
                    onClick={() => add(m, "bench")}
                    className="text-slate-400 hover:underline"
                  >
                    bench
                  </button>
                </span>
              ))}
            {side.members.length === 0 && (
              <span className="text-xs text-slate-400">
                This entrant has no roster members — add them on the division&apos;s
                Entrants tab.
              </span>
            )}
          </div>
          {error && <p className="text-xs text-red-600">{error}</p>}
          {saved && <p className="text-xs text-emerald-600">Lineup saved.</p>}
          <button
            type="button"
            disabled={busy}
            onClick={save}
            className="btn btn-primary px-3 py-1.5 text-xs"
          >
            {busy ? "Saving…" : "Save lineup"}
          </button>
        </div>
      )}
    </section>
  );
}
