"use client";

// Scheduling settings (doc 12 §3) — unchanged behaviour from PROMPT-17,
// extracted from the board monolith in the v3 split.
import { useState } from "react";
import { apiV1 } from "@/lib/client-v1";
import { UpgradeGate } from "@/components/upgrade-gate";
import { dayKey, toLocalInput } from "@/lib/schedule-board";
import type { BoardConfig } from "./types";

export function SettingsPanel({
  divisionId,
  config,
  tz,
  canEdit,
  constraintsAllowed,
  venueCap = "Court",
  onSaved,
  onError,
}: {
  divisionId: string;
  config: BoardConfig;
  tz: string;
  canEdit: boolean;
  constraintsAllowed: boolean;
  venueCap?: string;
  onSaved: () => void;
  onError: (err: unknown) => void;
}) {
  const [open, setOpen] = useState(false);
  const [startAt, setStartAt] = useState(config.startAt ? toLocalInput(config.startAt) : "");
  const [endAt, setEndAt] = useState(config.endAt ? dayKey(config.endAt) : "");
  const [matchMinutes, setMatchMinutes] = useState(config.matchMinutes);
  const [gapMinutes, setGapMinutes] = useState(config.gapMinutes);
  const [rest, setRest] = useState(config.perEntrantMinRest);
  const [courtsText, setCourtsText] = useState(config.courts.join(", "));
  const [zone, setZone] = useState(tz);
  const [saving, setSaving] = useState(false);

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="text-xs text-purple-600 hover:underline">
        Scheduling settings ({config.courts.length} {venueCap.toLowerCase()}{config.courts.length === 1 ? "" : "s"}, {config.matchMinutes}
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
            endAt: endAt ? new Date(`${endAt}T23:59:00`).toISOString() : null,
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
          <span className="label">End date</span>
          <input type="date" value={endAt} onChange={(e) => setEndAt(e.target.value)} className="input px-2 py-1 text-xs" disabled={!canEdit} />
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
          <span className="label">{venueCap}s (comma-separated)</span>
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
      <p className="text-[11px] text-slate-500">
        Blackouts and session windows are honoured by the auto pass and validator; multi-court,
        rest, blackout and session constraints need the Pro constraint solver.
      </p>
    </section>
  );
}
