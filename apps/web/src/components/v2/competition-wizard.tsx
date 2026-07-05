"use client";

// Competition wizard (PROMPT-15 task 1): description, visibility, branding.
// POSTs /api/v1/competitions and lands on the competition page to add divisions.
import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiV1, ApiV1Error } from "@/lib/client-v1";
import { UpgradeGate } from "@/components/upgrade-gate";

const VISIBILITIES = [
  { key: "private", label: "Private", help: "Only your organisation can see it." },
  { key: "unlisted", label: "Unlisted", help: "Anyone with the link; not indexed." },
  { key: "public", label: "Public", help: "On your public dashboard, indexable." },
] as const;

export function CompetitionWizard() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [visibility, setVisibility] = useState<string>("private");
  const [startsOn, setStartsOn] = useState("");
  const [endsOn, setEndsOn] = useState("");
  const [accent, setAccent] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [paywall, setPaywall] = useState<{ feature: string; reason?: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setPaywall(null);
    setBusy(true);
    try {
      const created = await apiV1<{ id: string }>("/api/v1/competitions", {
        method: "POST",
        json: {
          name,
          description: description.trim() || null,
          visibility,
          starts_on: startsOn || null,
          ends_on: endsOn || null,
          branding: accent ? { accent } : {},
        },
      });
      router.push(`/competitions/${created.id}`);
    } catch (err) {
      if (err instanceof ApiV1Error && err.code === "PAYMENT_REQUIRED") {
        setPaywall({
          feature: String(err.extra.feature_key ?? ""),
          reason: typeof err.extra.reason === "string" ? err.extra.reason : undefined,
        });
      } else {
        setError(err instanceof Error ? err.message : "Failed");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="card space-y-5 p-6">
      <label className="block">
        <span className="label">Name</span>
        <input
          autoFocus
          required
          maxLength={200}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Summer Championship 2026"
          className="input"
        />
      </label>

      <label className="block">
        <span className="label">Description</span>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={4}
          maxLength={5000}
          placeholder="Shown on the public dashboard. Markdown supported."
          className="textarea"
        />
      </label>

      <fieldset>
        <legend className="label">Visibility</legend>
        <div className="grid gap-2 sm:grid-cols-3">
          {VISIBILITIES.map((v) => (
            <label
              key={v.key}
              className={`cursor-pointer rounded-lg border p-3 text-sm transition ${
                visibility === v.key
                  ? "border-purple-500 bg-purple-50 text-purple-800"
                  : "border-slate-200 bg-white text-slate-600 hover:border-purple-200"
              }`}
            >
              <input
                type="radio"
                name="visibility"
                value={v.key}
                checked={visibility === v.key}
                onChange={() => setVisibility(v.key)}
                className="sr-only"
              />
              <span className="block font-medium">{v.label}</span>
              <span className="mt-0.5 block text-xs text-slate-500">{v.help}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block">
          <span className="label">Starts on</span>
          <input
            type="date"
            value={startsOn}
            onChange={(e) => setStartsOn(e.target.value)}
            className="input"
          />
        </label>
        <label className="block">
          <span className="label">Ends on</span>
          <input
            type="date"
            value={endsOn}
            onChange={(e) => setEndsOn(e.target.value)}
            className="input"
          />
        </label>
      </div>

      <label className="block">
        <span className="label">Brand accent colour (Pro branding)</span>
        <div className="flex items-center gap-2">
          <input
            type="color"
            value={accent || "#7c3aed"}
            onChange={(e) => setAccent(e.target.value)}
            className="h-9 w-14 cursor-pointer rounded border border-slate-200"
            aria-label="Accent colour"
          />
          {accent && (
            <button type="button" onClick={() => setAccent("")} className="btn btn-ghost">
              Clear
            </button>
          )}
          <span className="text-xs text-slate-400">
            Applied to the public dashboard when your plan includes branding.
          </span>
        </div>
      </label>

      {paywall && <UpgradeGate feature={paywall.feature} />}
      {error && (
        <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>
      )}

      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={() => router.push("/dashboard")}
          className="btn btn-ghost"
        >
          Cancel
        </button>
        <button type="submit" disabled={busy || !name.trim()} className="btn btn-primary">
          {busy ? "Creating…" : "Create competition"}
        </button>
      </div>
    </form>
  );
}
