"use client";

// Competition settings panel — PATCH /api/v1/competitions/{id}.
import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiV1, ApiV1Error } from "@/lib/client-v1";
import { UpgradeGate } from "@/components/upgrade-gate";

interface CompetitionLite {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  starts_on: string | null;
  ends_on: string | null;
  visibility: string;
  status: string;
  frozen: boolean;
}

const STATUSES = ["draft", "published", "live", "completed", "archived"];

export function CompetitionSettings({
  competition,
  canEdit,
}: {
  competition: CompetitionLite;
  canEdit: boolean;
}) {
  const router = useRouter();
  const [form, setForm] = useState({
    name: competition.name,
    description: competition.description ?? "",
    starts_on: competition.starts_on ?? "",
    ends_on: competition.ends_on ?? "",
    visibility: competition.visibility,
    status: competition.status,
  });
  const [error, setError] = useState<string | null>(null);
  const [paywallFeature, setPaywallFeature] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  const readOnly = !canEdit || competition.frozen;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setPaywallFeature(null);
    setSaved(false);
    setBusy(true);
    try {
      await apiV1(`/api/v1/competitions/${competition.id}`, {
        method: "PATCH",
        json: {
          name: form.name,
          description: form.description.trim() || null,
          starts_on: form.starts_on || null,
          ends_on: form.ends_on || null,
          visibility: form.visibility,
          status: form.status,
        },
      });
      setSaved(true);
      router.refresh();
    } catch (err) {
      if (err instanceof ApiV1Error && err.code === "PAYMENT_REQUIRED") {
        setPaywallFeature(String(err.extra.feature_key ?? ""));
      } else {
        setError(err instanceof Error ? err.message : "Failed");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={save} className="card space-y-4 p-5">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-slate-700">Settings</h2>
        {competition.frozen && (
          <span className="badge bg-sky-100 text-sky-700">read-only (over quota)</span>
        )}
      </div>

      <label className="block">
        <span className="label">Name</span>
        <input
          required
          disabled={readOnly}
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
          className="input"
        />
      </label>

      <label className="block">
        <span className="label">Description</span>
        <textarea
          disabled={readOnly}
          rows={3}
          value={form.description}
          onChange={(e) => setForm({ ...form, description: e.target.value })}
          className="textarea"
        />
      </label>

      <div className="grid grid-cols-2 gap-3">
        <label className="block">
          <span className="label">Starts</span>
          <input
            type="date"
            disabled={readOnly}
            value={form.starts_on}
            onChange={(e) => setForm({ ...form, starts_on: e.target.value })}
            className="input"
          />
        </label>
        <label className="block">
          <span className="label">Ends</span>
          <input
            type="date"
            disabled={readOnly}
            value={form.ends_on}
            onChange={(e) => setForm({ ...form, ends_on: e.target.value })}
            className="input"
          />
        </label>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <label className="block">
          <span className="label">Visibility</span>
          <select
            disabled={readOnly}
            value={form.visibility}
            onChange={(e) => setForm({ ...form, visibility: e.target.value })}
            className="select"
          >
            <option value="private">private</option>
            <option value="unlisted">unlisted</option>
            <option value="public">public</option>
          </select>
        </label>
        <label className="block">
          <span className="label">Status</span>
          <select
            disabled={!canEdit}
            value={form.status}
            onChange={(e) => setForm({ ...form, status: e.target.value })}
            className="select"
          >
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
      </div>

      <p className="text-xs text-slate-400">
        Slug: <span className="font-mono">{competition.slug}</span>
      </p>

      {paywallFeature && <UpgradeGate feature={paywallFeature} />}
      {error && (
        <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>
      )}
      {saved && <p className="text-sm text-emerald-600">Saved.</p>}

      {canEdit && (
        <button type="submit" disabled={busy} className="btn btn-primary w-full">
          {busy ? "Saving…" : "Save settings"}
        </button>
      )}
    </form>
  );
}
