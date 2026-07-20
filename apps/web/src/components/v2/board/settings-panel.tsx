"use client";

// Scheduling settings (doc 12 §3) — extracted from the board monolith in the
// v3 split. Play hours expose the engine's sessionWindows as plain daily
// times: the auto pass and validator already refuse slots outside them, the
// panel just never offered the knob.
import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiV1 } from "@/lib/client-v1";
import { UpgradeGate } from "@/components/upgrade-gate";
import {
  dailyHoursToWindows,
  dayKey,
  toLocalInput,
  windowsToDailyHours,
} from "@/lib/schedule-board";
import type { BoardConfig } from "./types";
import { useMsg } from "@/components/i18n/dict-provider";
import { pluralizeVenue } from "@/lib/venue";

/** Self-contained wrapper for RSC pages (constraints tab): owns the saved/
 *  error notice the board would otherwise host. Opens expanded — on a
 *  settings tab a collapsed one-liner would just be a second click. */
export function StandaloneScheduleSettings(props: {
  divisionId: string;
  config: BoardConfig;
  canEdit: boolean;
  constraintsAllowed: boolean;
  venueCap?: string;
}) {
  const msg = useMsg();
  const router = useRouter();
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="space-y-2">
      {notice && <p className="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{notice}</p>}
      {error && <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>}
      <SettingsPanel
        {...props}
        defaultOpen
        onSaved={() => {
          setError(null);
          setNotice(msg("boardset.saved"));
          router.refresh();
        }}
        onError={(err) => {
          setNotice(null);
          setError(err instanceof Error ? err.message : msg("boardset.error"));
        }}
      />
    </div>
  );
}

export function SettingsPanel({
  divisionId,
  config,
  canEdit,
  constraintsAllowed,
  venueCap = "Court",
  defaultOpen = false,
  onSaved,
  onError,
}: {
  divisionId: string;
  config: BoardConfig;
  canEdit: boolean;
  constraintsAllowed: boolean;
  venueCap?: string;
  defaultOpen?: boolean;
  onSaved: () => void;
  onError: (err: unknown) => void;
}) {
  const msg = useMsg();
  const [open, setOpen] = useState(defaultOpen);
  const [startAt, setStartAt] = useState(config.startAt ? toLocalInput(config.startAt) : "");
  const [endAt, setEndAt] = useState(config.endAt ? dayKey(config.endAt) : "");
  const [matchMinutes, setMatchMinutes] = useState(config.matchMinutes);
  const [gapMinutes, setGapMinutes] = useState(config.gapMinutes);
  const [rest, setRest] = useState(config.perEntrantMinRest);
  // Courts as a list (same UX as the division-creation wizard) — one input
  // per venue with add/remove, not a comma-separated blob.
  const [courts, setCourts] = useState<string[]>(
    config.courts.length > 0 ? [...config.courts] : [`${venueCap} 1`],
  );
  const [saving, setSaving] = useState(false);
  const [hoursError, setHoursError] = useState<string | null>(null);
  // Prefill only when the stored windows are a uniform daily pattern —
  // hand-built windows (constraints panel) show as "custom" and stay put.
  const daily = windowsToDailyHours(config.sessionWindows);
  const customWindows = config.sessionWindows.length > 0 && daily === null;
  const [playFrom, setPlayFrom] = useState(daily?.from ?? "");
  const [playTo, setPlayTo] = useState(daily?.to ?? "");

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="text-xs text-purple-600 hover:underline">
        {msg("boardset.title")} ({config.courts.length} {venueCap.toLowerCase()}{config.courts.length === 1 ? "" : "s"}, {msg("boardset.sum.matches", { n: config.matchMinutes })}
        {config.gapMinutes > 0 ? msg("boardset.sum.gap", { n: config.gapMinutes }) : ""}
        {config.perEntrantMinRest > 0 ? msg("boardset.sum.rest", { n: config.perEntrantMinRest }) : ""}
        {daily ? msg("boardset.sum.play", { from: daily.from, to: daily.to }) : customWindows ? msg("boardset.sum.custom") : ""})
      </button>
    );
  }

  async function save() {
    setHoursError(null);
    // Play hours → session windows. Both set: expand across the schedule
    // span. Both blank: clear a previously-uniform pattern (all hours play),
    // but never clobber hand-built windows. Half-filled or inverted: refuse.
    let sessionWindows = config.sessionWindows;
    const hoursTouched = playFrom !== "" || playTo !== "";
    if (hoursTouched) {
      const startIso = startAt
        ? new Date(startAt).toISOString()
        : (config.startAt ?? new Date().toISOString());
      const endIso = endAt ? new Date(`${endAt}T23:59:00`).toISOString() : null;
      const expanded = dailyHoursToWindows(playFrom, playTo, startIso, endIso);
      if (!expanded) {
        setHoursError(msg("boardset.hoursError"));
        return;
      }
      sessionWindows = expanded;
    } else if (!customWindows) {
      sessionWindows = [];
    }
    setSaving(true);
    try {
      const cleanCourts = courts.map((c) => c.trim()).filter(Boolean);
      // No `tz` key (V304): the venue timezone is an ORGANISATION setting now
      // and is inherited. Omitting it is load-bearing — the PUT treats an
      // absent tz as "leave the stored value alone", so divisions that already
      // carry their own zone keep it instead of being silently reset.
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
            courts: cleanCourts.length > 0 ? cleanCourts : [`${venueCap} 1`],
            sessionWindows,
          },
        },
      });
      // Board's inline card collapses back to its one-liner; the settings
      // TAB stays open — saving is not leaving (organiser feedback).
      if (!defaultOpen) setOpen(false);
      onSaved();
    } catch (err) {
      onError(err);
    } finally {
      setSaving(false);
    }
  }

  const constrained = !constraintsAllowed;
  const venue = venueCap.toLowerCase();
  // Field markup mirrors the division-creation wizard — one input system
  // everywhere (default-size .input, wizard hint lines, courts as a list).
  return (
    <section className="card space-y-6 p-5">
      <div>
        <h4 className="text-sm font-semibold text-slate-700">{msg("boardset.title")}</h4>
        <p className="mt-0.5 text-xs text-slate-500">{msg("boardset.desc")}</p>
      </div>
      {constrained && <UpgradeGate feature="scheduling.constraints" compact />}

      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block">
          <span className="label">{msg("boardset.startAt")}</span>
          <input type="datetime-local" value={startAt} onChange={(e) => setStartAt(e.target.value)} className="input w-full" disabled={!canEdit} />
          <span className="mt-0.5 block text-xs text-slate-400">{msg("boardset.startAtHint")}</span>
        </label>
        <label className="block">
          <span className="label">{msg("boardset.endAt")}</span>
          <input type="date" value={endAt} min={startAt ? startAt.slice(0, 10) : undefined} onChange={(e) => setEndAt(e.target.value)} className="input w-full" disabled={!canEdit} />
          <span className="mt-0.5 block text-xs text-slate-400">{msg("boardset.endAtHint")}</span>
        </label>
        <fieldset className="block">
          <legend className="label">{msg("boardset.playHours")}</legend>
          {customWindows ? (
            <p className="text-xs text-slate-500">{msg("boardset.customWindows")}</p>
          ) : (
            <div className="flex items-center gap-2">
              <input
                type="time"
                aria-label={msg("boardset.playFrom")}
                value={playFrom}
                onChange={(e) => setPlayFrom(e.target.value)}
                className="input w-full"
                disabled={!canEdit}
              />
              <span className="text-sm text-slate-500">–</span>
              <input
                type="time"
                aria-label={msg("boardset.playUntil")}
                value={playTo}
                onChange={(e) => setPlayTo(e.target.value)}
                className="input w-full"
                disabled={!canEdit}
              />
            </div>
          )}
          <span className="mt-0.5 block text-xs text-slate-400">{msg("boardset.playHoursHint")}</span>
        </fieldset>
        <label className="block">
          <span className="label">{msg("boardset.matchLength")}</span>
          <input type="number" min={1} max={1440} inputMode="numeric" value={matchMinutes} onChange={(e) => setMatchMinutes(Number(e.target.value) || 30)} className="input w-full" disabled={!canEdit} />
        </label>
        <label className="block">
          <span className="label">{msg("boardset.gap")}</span>
          <input type="number" min={0} inputMode="numeric" value={gapMinutes} onChange={(e) => setGapMinutes(Number(e.target.value))} className="input w-full" disabled={!canEdit} />
          <span className="mt-0.5 block text-xs text-slate-400">{msg("boardset.gapHint", { venue })}</span>
        </label>
        <label className="block">
          <span className="label">{msg("boardset.rest")}</span>
          <input type="number" min={0} inputMode="numeric" value={rest} onChange={(e) => setRest(Number(e.target.value))} className="input w-full" disabled={!canEdit || constrained} />
          <span className="mt-0.5 block text-xs text-slate-400">
            {msg("boardset.restHint")}{constrained ? msg("boardset.proSuffix") : ""}
          </span>
        </label>
      </div>

      <div>
        <span className="label">{msg("boardset.venuesLabel", { venue: pluralizeVenue(venueCap) })}</span>
        <p className="mb-2 text-xs text-slate-400">{msg("boardset.venuesDesc", { venue })}</p>
        {/* Court names are short ("Court 1", "Show court"), so a full-bleed
            input looked like a paragraph field. Capped at one column of the
            gap-4 two-col grid above so it lines up with those fields. */}
        <ul className="space-y-2 sm:max-w-[calc(50%-0.5rem)]">
          {courts.map((c, i) => (
            <li key={i} className="flex items-center gap-2">
              <input
                value={c}
                onChange={(e) =>
                  setCourts((cs) => cs.map((x, j) => (j === i ? e.target.value : x)))
                }
                placeholder={`${venueCap} ${i + 1}`}
                maxLength={100}
                className="input flex-1"
                disabled={!canEdit}
              />
              {canEdit && courts.length > 1 && (
                <button
                  type="button"
                  onClick={() => setCourts((cs) => cs.filter((_, j) => j !== i))}
                  aria-label={msg("boardset.removeVenue", { venue, n: i + 1 })}
                  className="rounded-md px-2 py-1 text-sm text-red-500 hover:bg-red-50"
                >
                  ✕
                </button>
              )}
            </li>
          ))}
        </ul>
        {canEdit && (
          <button
            type="button"
            onClick={() =>
              setCourts((cs) => (cs.length < 50 ? [...cs, `${venueCap} ${cs.length + 1}`] : cs))
            }
            className="btn btn-ghost mt-2 text-sm"
          >
            {msg("boardset.addVenue", { venue })}
          </button>
        )}
      </div>

      {hoursError && <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-600">{hoursError}</p>}
      <div className="flex flex-wrap items-center gap-2">
        {canEdit && (
          <button type="button" disabled={saving} onClick={save} className="btn btn-primary">
            {saving ? msg("boardset.saving") : msg("boardset.save")}
          </button>
        )}
        {!defaultOpen && (
          <button type="button" onClick={() => setOpen(false)} className="btn btn-ghost">
            {msg("boardset.close")}
          </button>
        )}
      </div>
    </section>
  );
}
