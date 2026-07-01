"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/client";
import { supportsProgressScore } from "@/lib/scoring";
import { sportIcon } from "@/lib/sport-icons";
import type {
  ResultMode,
  SportPreset,
  TournamentCategory,
  TournamentFormat,
} from "@/lib/types";

/** Manage per-organization sport presets in Settings. */
export function OrgSportPresets({
  orgId,
  initialPresets,
  canEdit,
}: {
  orgId: string;
  initialPresets: SportPreset[];
  canEdit: boolean;
}) {
  const router = useRouter();
  const [presets, setPresets] = useState(initialPresets);
  const [showAdd, setShowAdd] = useState(false);

  function onUpdated(updated: SportPreset) {
    setPresets((prev) =>
      prev.map((p) => (p.id === updated.id ? updated : p)),
    );
    router.refresh();
  }

  function onDeleted(id: string) {
    setPresets((prev) => prev.filter((p) => p.id !== id));
    router.refresh();
  }

  function onCreated(created: SportPreset) {
    setPresets((prev) => [...prev, created]);
    setShowAdd(false);
    router.refresh();
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-slate-500">
        Defaults used when you create a tournament — format, scoring, clocks, and
        round timing. You can still override any field on the tournament page.
      </p>

      {presets.map((preset) => (
        <PresetEditor
          key={preset.id}
          orgId={orgId}
          preset={preset}
          canEdit={canEdit}
          onUpdated={onUpdated}
          onDeleted={onDeleted}
        />
      ))}

      {canEdit && (
        <div className="pt-2">
          {showAdd ? (
            <AddPresetForm
              orgId={orgId}
              onCreated={onCreated}
              onCancel={() => setShowAdd(false)}
            />
          ) : (
            <button
              type="button"
              onClick={() => setShowAdd(true)}
              className="btn btn-ghost w-full border border-dashed border-purple-200 text-purple-700"
            >
              + Add custom sport
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function PresetEditor({
  orgId,
  preset,
  canEdit,
  onUpdated,
  onDeleted,
}: {
  orgId: string;
  preset: SportPreset;
  canEdit: boolean;
  onUpdated: (p: SportPreset) => void;
  onDeleted: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(preset);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const dirty = JSON.stringify(draft) !== JSON.stringify(preset);
  const Icon = sportIcon(preset.sport_key);

  async function save() {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const updated = await api<SportPreset>(
        `/api/orgs/${orgId}/sport-presets/${preset.id}`,
        { method: "PATCH", json: draft },
      );
      onUpdated(updated);
      setDraft(updated);
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setBusy(false);
    }
  }

  async function reset() {
    if (!confirm(`Reset ${preset.sport_name} to factory defaults?`)) return;
    setBusy(true);
    setError(null);
    try {
      const updated = await api<SportPreset>(
        `/api/orgs/${orgId}/sport-presets/${preset.id}/reset`,
        { method: "POST" },
      );
      onUpdated(updated);
      setDraft(updated);
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to reset");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!confirm(`Delete ${preset.sport_name}?`)) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/api/orgs/${orgId}/sport-presets/${preset.id}`, {
        method: "DELETE",
      });
      onDeleted(preset.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete");
    } finally {
      setBusy(false);
    }
  }

  return (
    <details
      open={open}
      onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}
      className="rounded-xl border border-purple-100 bg-white"
    >
      <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-4 py-3">
        <span className="flex items-center gap-2 font-medium text-purple-900">
          <Icon className="h-4 w-4 shrink-0 text-purple-500" strokeWidth={1.75} />
          {preset.sport_name}
        </span>
        <span className="text-xs text-slate-400">
          {preset.entity_label} · {formatLabel(preset.format)}
          {preset.clock_minutes > 0 && ` · ${preset.clock_minutes}m clock`}
        </span>
      </summary>

      <div className="space-y-4 border-t border-purple-50 px-4 py-4">
        <PresetFields
          draft={draft}
          setDraft={setDraft}
          disabled={!canEdit}
        />

        {canEdit && (
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={save}
              disabled={busy || !dirty}
              className="btn btn-primary px-4"
            >
              {busy ? "Saving…" : "Save preset"}
            </button>
            {preset.is_system && (
              <button
                type="button"
                onClick={reset}
                disabled={busy}
                className="btn btn-ghost text-sm"
              >
                Reset to default
              </button>
            )}
            {!preset.is_system && (
              <button
                type="button"
                onClick={remove}
                disabled={busy}
                className="btn btn-ghost text-sm text-red-600"
              >
                Delete
              </button>
            )}
          </div>
        )}

        {error && <p className="text-xs text-red-600">{error}</p>}
        {saved && !error && (
          <p className="text-xs text-green-600">Saved.</p>
        )}
      </div>
    </details>
  );
}

function AddPresetForm({
  orgId,
  onCreated,
  onCancel,
}: {
  orgId: string;
  onCreated: (p: SportPreset) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<Omit<SportPreset, "id" | "org_id" | "sport_key" | "is_system" | "sort_order" | "created_at">>({
    sport_name: "",
    entity_label: "Players",
    format: "swiss_knockout",
    result_mode: "win_loss",
    score_label: "Score",
    points_win: 1,
    points_draw: 0,
    points_loss: 0,
    allow_draws: false,
    use_progress_score: false,
    round_minutes: 30,
    clock_minutes: 0,
    default_category: "adult",
    default_group_rounds: null,
    default_knockout_size: null,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!draft.sport_name.trim()) {
      setError("Sport name is required");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const created = await api<SportPreset>(`/api/orgs/${orgId}/sport-presets`, {
        method: "POST",
        json: { ...draft, sport_name: draft.sport_name.trim() },
      });
      onCreated(created);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={submit}
      className="rounded-xl border border-purple-200 bg-purple-50/40 p-4 space-y-4"
    >
      <h3 className="text-sm font-semibold text-purple-900">New custom sport</h3>
      <PresetFields
        draft={draft as SportPreset}
        setDraft={(d) => setDraft(d as typeof draft)}
        disabled={false}
        showName
      />
      <div className="flex gap-2">
        <button type="submit" disabled={busy} className="btn btn-primary px-4">
          {busy ? "Creating…" : "Create preset"}
        </button>
        <button type="button" onClick={onCancel} className="btn btn-ghost">
          Cancel
        </button>
      </div>
      {error && <p className="text-xs text-red-600">{error}</p>}
    </form>
  );
}

function PresetFields({
  draft,
  setDraft,
  disabled,
  showName,
}: {
  draft: SportPreset;
  setDraft: (d: SportPreset) => void;
  disabled: boolean;
  showName?: boolean;
}) {
  function set<K extends keyof SportPreset>(key: K, value: SportPreset[K]) {
    const next = { ...draft, [key]: value };
    if (
      key === "format" ||
      key === "result_mode" ||
      key === "use_progress_score"
    ) {
      if (
        !supportsProgressScore({
          result_mode: next.result_mode,
          format: next.format,
        })
      ) {
        next.use_progress_score = false;
      }
    }
    setDraft(next);
  }

  const showProgressScore = supportsProgressScore({
    result_mode: draft.result_mode,
    format: draft.format,
  });

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {showName && (
        <Field label="Sport name" className="sm:col-span-2">
          <input
            value={draft.sport_name}
            onChange={(e) => set("sport_name", e.target.value)}
            disabled={disabled}
            className="input"
            placeholder="e.g. Darts"
          />
        </Field>
      )}

      <Field label="Participants">
        <select
          value={draft.entity_label}
          onChange={(e) => set("entity_label", e.target.value)}
          disabled={disabled}
          className="input"
        >
          <option value="Players">Players</option>
          <option value="Teams">Teams</option>
        </select>
      </Field>

      <Field label="Default format">
        <select
          value={draft.format}
          onChange={(e) => set("format", e.target.value as TournamentFormat)}
          disabled={disabled}
          className="input"
        >
          <option value="swiss_knockout">Progress league + knockout</option>
          <option value="progress_stepladder">Progress + stepladder</option>
          <option value="round_robin">Round robin</option>
          <option value="knockout">Single elimination</option>
        </select>
      </Field>

      <Field label="Default category">
        <select
          value={draft.default_category}
          onChange={(e) =>
            set("default_category", e.target.value as TournamentCategory)
          }
          disabled={disabled}
          className="input"
        >
          <option value="adult">Adult</option>
          <option value="kids">Kids</option>
          <option value="open">Open</option>
        </select>
      </Field>

      <Field label="Result entry">
        <select
          value={draft.result_mode}
          onChange={(e) => set("result_mode", e.target.value as ResultMode)}
          disabled={disabled}
          className="input"
        >
          <option value="win_loss">Winner only</option>
          <option value="score">Enter scores</option>
        </select>
      </Field>

      {draft.result_mode === "score" && (
        <Field label="Score label">
          <input
            value={draft.score_label}
            onChange={(e) => set("score_label", e.target.value)}
            disabled={disabled}
            className="input"
            placeholder="Goals / Sets / Runs"
          />
        </Field>
      )}

      <Field label="Points for win">
        <input
          type="number"
          min={0}
          value={draft.points_win}
          onChange={(e) => set("points_win", Number(e.target.value))}
          disabled={disabled}
          className="input"
        />
      </Field>
      <Field label="Points for draw">
        <input
          type="number"
          min={0}
          value={draft.points_draw}
          onChange={(e) => set("points_draw", Number(e.target.value))}
          disabled={disabled}
          className="input"
        />
      </Field>
      <Field label="Points for loss">
        <input
          type="number"
          min={0}
          value={draft.points_loss}
          onChange={(e) => set("points_loss", Number(e.target.value))}
          disabled={disabled}
          className="input"
        />
      </Field>

      <Field label="Minutes per round">
        <input
          type="number"
          min={1}
          value={draft.round_minutes}
          onChange={(e) => set("round_minutes", Number(e.target.value))}
          disabled={disabled}
          className="input"
        />
      </Field>
      <Field label="Match clock (min/player, 0 = off)">
        <input
          type="number"
          min={0}
          value={draft.clock_minutes}
          onChange={(e) => set("clock_minutes", Number(e.target.value))}
          disabled={disabled}
          className="input"
        />
      </Field>

      <div className="flex flex-wrap gap-4 sm:col-span-2">
        <label className="flex items-center gap-2 text-sm text-slate-600">
          <input
            type="checkbox"
            className="accent-purple-600"
            checked={draft.allow_draws}
            onChange={(e) => set("allow_draws", e.target.checked)}
            disabled={disabled}
          />
          Allow draws (group stage)
        </label>
        {showProgressScore && (
          <label className="flex items-center gap-2 text-sm text-slate-600">
            <input
              type="checkbox"
              className="accent-purple-600"
              checked={draft.use_progress_score}
              onChange={(e) => set("use_progress_score", e.target.checked)}
              disabled={disabled}
            />
            Progress score tiebreaker (chess-style win streaks)
          </label>
        )}
      </div>

      <Field label="Default knockout size (optional)">
        <select
          value={draft.default_knockout_size ?? ""}
          onChange={(e) =>
            set(
              "default_knockout_size",
              e.target.value === "" ? null : Number(e.target.value),
            )
          }
          disabled={disabled}
          className="input"
        >
          <option value="">Auto from player count</option>
          {[0, 2, 4, 8, 16].map((n) => (
            <option key={n} value={n}>
              {n === 0 ? "No knockout" : `Top ${n}`}
            </option>
          ))}
        </select>
      </Field>

      <Field label="Default progress rounds (optional)">
        <input
          type="number"
          min={0}
          max={20}
          value={draft.default_group_rounds ?? ""}
          onChange={(e) =>
            set(
              "default_group_rounds",
              e.target.value === "" ? null : Number(e.target.value),
            )
          }
          disabled={disabled}
          className="input"
          placeholder="Auto"
        />
      </Field>
    </div>
  );
}

function Field({
  label,
  children,
  className = "",
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <label className={`block ${className}`}>
      <span className="label">{label}</span>
      {children}
    </label>
  );
}

function formatLabel(format: TournamentFormat): string {
  switch (format) {
    case "swiss_knockout":
      return "League + KO";
    case "progress_stepladder":
      return "Stepladder";
    case "round_robin":
      return "Round robin";
    case "knockout":
      return "Knockout";
    default:
      return format;
  }
}
