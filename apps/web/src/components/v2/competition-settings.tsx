"use client";

// Competition settings panel — PATCH /api/v1/competitions/{id}.
import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiV1, ApiV1Error } from "@/lib/client-v1";
import { UpgradeGate } from "@/components/upgrade-gate";
import { BrandColorPicker } from "@/components/brand-color-picker";
import { VisibilityPicker } from "@/components/ui/visibility-picker";
import { Tip } from "@/components/ui/tip";
import { publicBrandColor, publicThemeStyleChain } from "@/lib/public-theme";
import { ProseEditor } from "@/components/prose-editor";
import { msg } from "@/lib/messages";

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
  discoverable: boolean;
  discovery: Record<string, string | null>;
  branding: unknown;
}

const STATUSES = ["draft", "published", "live", "completed", "archived"];

type SettingsTab = "general" | "branding" | "archived";

const STATUS_HINT: Record<string, string> = {
  published: "A timetable is set — publish it?",
  live: "Matches are underway — mark it live?",
  completed: "Every match is decided — mark it completed?",
};

// Doc 15 §1 consent copy lives in lib/messages ("showcase.*") — shared with
// the create wizard so the two surfaces can never drift.

export function CompetitionSettings({
  competition,
  orgId,
  canEdit,
  discoveryBranding,
  themeBranding = false,
  orgBranding = null,
  suggestedStatus = null,
  archivedPanel = null,
  archivedCount = 0,
  sharePath = null,
  hasYouthDivisions = false,
}: {
  competition: CompetitionLite;
  /** Owning org — the description editor uploads images under it. */
  orgId: string;
  canEdit: boolean;
  discoveryBranding: boolean;
  /** Public path for the share-URL row of the visibility picker (v3/03 §7). */
  sharePath?: string | null;
  /** Any U-age division in this competition (v3/11 gap 8 interstitial). */
  hasYouthDivisions?: boolean;
  /** Org has dashboard.branding — public pages/noticeboard honor brand color. */
  themeBranding?: boolean;
  /** Org-level branding blob — the color this competition inherits. */
  orgBranding?: unknown;
  /** State-derived nudge, e.g. "live" once matches are underway. */
  suggestedStatus?: string | null;
  /** Rendered under the Archived tab (outside the settings form). */
  archivedPanel?: React.ReactNode;
  /** The Archived tab only shows when there is something to restore. */
  archivedCount?: number;
}) {
  const router = useRouter();
  const [tab, setTab] = useState<SettingsTab>("general");
  const [form, setForm] = useState({
    name: competition.name,
    description: competition.description ?? "",
    starts_on: competition.starts_on ?? "",
    ends_on: competition.ends_on ?? "",
    visibility: competition.visibility,
    status: competition.status,
    discoverable: competition.discoverable,
    city: competition.discovery.city ?? "",
    country: competition.discovery.country ?? "",
    tagline: competition.discovery.tagline ?? "",
    hero_image_path: competition.discovery.hero_image_path ?? "",
    brand_primary: publicBrandColor(competition.branding),
  });
  const [error, setError] = useState<string | null>(null);
  const [paywallFeature, setPaywallFeature] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  const readOnly = !canEdit || competition.frozen;
  const showSuggestion = !readOnly && suggestedStatus && suggestedStatus !== form.status;

  async function applyStatus(next: string) {
    setError(null);
    setBusy(true);
    try {
      await apiV1(`/api/v1/competitions/${competition.id}`, {
        method: "PATCH",
        json: { status: next },
      });
      setForm((f) => ({ ...f, status: next }));
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update status");
    } finally {
      setBusy(false);
    }
  }

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
          // Hard-coupled server-side too (doc 15 §1): a non-public visibility
          // always sends discoverable=false so the intent is unambiguous.
          discoverable: form.visibility === "public" ? form.discoverable : false,
          discovery: {
            city: form.city.trim() || null,
            country: form.country.trim() || null,
            // Branding-gated fields never ride for non-entitled orgs (the
            // server 402s them anyway — doc 10 §2 rule: never UI-only).
            ...(discoveryBranding
              ? {
                  tagline: form.tagline.trim() || null,
                  hero_image_path: form.hero_image_path.trim() || null,
                }
              : {}),
          },
          // Brand color override; {} = inherit the org color. Only rides for
          // entitled orgs — the public views ignore it otherwise anyway.
          ...(themeBranding
            ? {
                branding: form.brand_primary
                  ? { colors: { primary: form.brand_primary } }
                  : {},
              }
            : {}),
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

  // One form, one save — tabs only organise the fields. Form state lives in
  // `form`, so switching tabs never loses unsaved edits. The Archived panel is
  // a separate surface (its own API calls), so it renders outside the form.
  const tabs: { key: SettingsTab; label: string }[] = [
    { key: "general", label: "General" },
    ...(themeBranding ? [{ key: "branding" as const, label: "Branding" }] : []),
    ...(archivedCount > 0
      ? [{ key: "archived" as const, label: `Archived (${archivedCount})` }]
      : []),
  ];
  // A refresh can remove the selected tab (last archived division restored,
  // entitlement drop) — fall back to General instead of a blank panel.
  const activeTab: SettingsTab = tabs.some((t) => t.key === tab) ? tab : "general";

  return (
    <div>
      <div
        role="tablist"
        aria-label="Competition settings"
        className="mb-4 flex flex-wrap gap-1 border-b border-slate-200"
      >
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={activeTab === t.key}
            onClick={() => setTab(t.key)}
            className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium transition ${
              activeTab === t.key
                ? "border-purple-600 text-purple-700"
                : "border-transparent text-slate-500 hover:text-slate-700"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {activeTab === "archived" ? (
        archivedPanel
      ) : (
        <form onSubmit={save} className="card space-y-4 p-5">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-700">Settings</h2>
            {competition.frozen && (
              <span className="badge bg-sky-100 text-sky-700">read-only (over quota)</span>
            )}
          </div>

          {activeTab === "general" && (
            <>
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

              <div>
                <span className="label">Description</span>
                {readOnly ? (
                  <textarea disabled rows={3} value={form.description} className="textarea" />
                ) : (
                  // v3/06 §2: Markdown editor with Write/Preview — Preview is
                  // the public renderer with this competition's branding.
                  <ProseEditor
                    value={form.description}
                    onChange={(md) => setForm({ ...form, description: md })}
                    orgId={orgId}
                    placeholder="Competition description"
                    previewStyle={publicThemeStyleChain(competition.branding, orgBranding)}
                  />
                )}
              </div>

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

              {/* v3/03 §7: radio cards with consequence sentences replace the
                  engineer-vocabulary select; share URL surfaces on selection. */}
              <div className="flex items-start gap-1.5">
                <div className="min-w-0 flex-1">
                  <VisibilityPicker
                    value={form.visibility}
                    disabled={readOnly}
                    sharePath={sharePath}
                    hasYouthDivisions={hasYouthDivisions}
                    onChange={(next) => setForm({ ...form, visibility: next })}
                  />
                </div>
                <Tip id="division.visibility" className="mt-0.5" />
              </div>

              <div className="grid grid-cols-2 gap-3">
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
                  {showSuggestion && (
                    <span className="mt-1.5 flex flex-wrap items-center gap-2 rounded-md bg-purple-50 px-2.5 py-1.5 text-xs text-purple-800">
                      {STATUS_HINT[suggestedStatus!] ??
                        `Looks like this should be “${suggestedStatus}”.`}
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void applyStatus(suggestedStatus!)}
                        className="btn btn-primary px-2 py-0.5 text-xs"
                      >
                        Set to {suggestedStatus}
                      </button>
                    </span>
                  )}
                </label>
              </div>

              {/* Showcase on seazn.club (doc 15 §1): explicit opt-in, public
                  only — lives right under visibility, which gates it. */}
              <fieldset className="space-y-3 rounded-lg border border-purple-100 bg-purple-50/50 p-3">
                <label className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    disabled={readOnly || form.visibility !== "public"}
                    checked={form.discoverable && form.visibility === "public"}
                    onChange={(e) => setForm({ ...form, discoverable: e.target.checked })}
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
                {form.visibility !== "public" && (
                  <p className="text-xs text-amber-600">
                    Set visibility to <b>public</b> to enable showcasing.
                  </p>
                )}
                {form.discoverable && form.visibility === "public" && (
                  <>
                    <div className="grid grid-cols-2 gap-3">
                      <label className="block">
                        <span className="label">City (optional)</span>
                        <input
                          disabled={readOnly}
                          value={form.city}
                          onChange={(e) => setForm({ ...form, city: e.target.value })}
                          className="input"
                        />
                      </label>
                      <label className="block">
                        <span className="label">Country (optional)</span>
                        <input
                          disabled={readOnly}
                          value={form.country}
                          onChange={(e) => setForm({ ...form, country: e.target.value })}
                          className="input"
                        />
                      </label>
                    </div>
                    <label className="block">
                      <span className="label">
                        Tagline{" "}
                        {!discoveryBranding && <span className="text-purple-500">(Pro)</span>}
                      </span>
                      <input
                        disabled={readOnly || !discoveryBranding}
                        value={form.tagline}
                        onChange={(e) => setForm({ ...form, tagline: e.target.value })}
                        placeholder={
                          discoveryBranding ? "One line on your cards" : "Upgrade for card branding"
                        }
                        className="input"
                      />
                    </label>
                    <label className="block">
                      <span className="label">
                        Hero image URL{" "}
                        {!discoveryBranding && <span className="text-purple-500">(Pro)</span>}
                      </span>
                      <input
                        disabled={readOnly || !discoveryBranding}
                        value={form.hero_image_path}
                        onChange={(e) => setForm({ ...form, hero_image_path: e.target.value })}
                        className="input"
                      />
                    </label>
                  </>
                )}
              </fieldset>

              <p className="text-xs text-slate-400">
                Slug: <span className="font-mono">{competition.slug}</span>
              </p>
            </>
          )}

          {activeTab === "branding" && themeBranding && (
            <div>
              <span className="label">Brand color</span>
              <p className="mb-2 text-xs text-slate-500">
                Colors this competition&apos;s public pages and TV noticeboard.
              </p>
              <BrandColorPicker
                value={form.brand_primary}
                onSelect={(hex) => setForm({ ...form, brand_primary: hex })}
                disabled={readOnly}
                defaultLabel="Same as organisation"
                defaultHex={publicBrandColor(orgBranding) ?? "#7c3aed"}
              />
            </div>
          )}

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
      )}
    </div>
  );
}
