"use client";

// Competition wizard (PROMPT-15 task 1): description, visibility, branding.
// POSTs /api/v1/competitions and lands on the competition page to add divisions.
import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiV1, ApiV1Error } from "@/lib/client-v1";
import { UpgradeGate } from "@/components/upgrade-gate";
import { VisibilityPicker } from "@/components/ui/visibility-picker";
import { routes } from "@/lib/routes";
import { useMsg } from "@/components/i18n/dict-provider";


export function CompetitionWizard({ orgSlug }: { orgSlug: string }) {
  const msg = useMsg();
  const router = useRouter();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [visibility, setVisibility] = useState<string>("private");
  const [discoverable, setDiscoverable] = useState(false);
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
      const created = await apiV1<{ id: string; slug: string }>("/api/v1/competitions", {
        method: "POST",
        json: {
          name,
          description: description.trim() || null,
          visibility,
          // Same hard coupling as settings (doc 15 §1): showcase only public.
          discoverable: visibility === "public" && discoverable,
          starts_on: startsOn || null,
          ends_on: endsOn || null,
          branding: accent ? { accent } : {},
        },
      });
      router.push(routes.competition(orgSlug, created.slug));
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

      {/* v3/03 §7: the one visibility component everywhere. No share URL at
          create time (the competition has no public page yet). */}
      <VisibilityPicker value={visibility} onChange={setVisibility} />

      {/* Showcase opt-in (doc 15 §1) — same checkbox + consent copy as
          settings, gated on public visibility. */}
      <fieldset className="space-y-2 rounded-lg border border-purple-100 bg-purple-50/50 p-3">
        <label className="flex items-start gap-2">
          <input
            type="checkbox"
            disabled={visibility !== "public"}
            checked={discoverable && visibility === "public"}
            onChange={(e) => setDiscoverable(e.target.checked)}
            className="mt-0.5"
          />
          <span>
            <span className="text-sm font-semibold text-slate-700">
              {msg("showcase.label")}
            </span>
            <span className="mt-1 block text-xs leading-relaxed text-slate-500">
              {msg("showcase.consent")}
            </span>
          </span>
        </label>
        {visibility !== "public" && (
          <p className="text-xs text-amber-600">{msg("showcase.needsPublic")}</p>
        )}
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
          onClick={() => router.push(routes.orgHome(orgSlug))}
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
