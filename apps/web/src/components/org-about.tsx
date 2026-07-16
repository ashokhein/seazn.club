"use client";

// Org "About" (v3/06 §2): Markdown shown on the public org page. Same
// editor as competition descriptions — Write/Preview, preview themed with
// the org's brand color.
import { useState } from "react";
import { ProseEditor } from "@/components/prose-editor";
import { publicThemeStyleChain } from "@/lib/public-theme";
import { useMsg } from "@/components/i18n/dict-provider";

export function OrgAbout({
  orgId,
  initialValue,
  branding,
}: {
  orgId: string;
  initialValue: string | null;
  branding: unknown;
}) {
  const msg = useMsg();
  const [value, setValue] = useState(initialValue ?? "");
  const [saved, setSaved] = useState(initialValue ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/orgs/${orgId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ about: value.trim() || null }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error ?? msg("settings.saveFailed"));
      }
      setSaved(value);
    } catch (err) {
      setError(err instanceof Error ? err.message : msg("settings.saveFailed"));
    } finally {
      setBusy(false);
    }
  }

  const dirty = value !== saved;

  return (
    <div className="space-y-2">
      <p className="text-sm text-slate-500">{msg("settings.org.about.desc")}</p>
      <ProseEditor
        value={value}
        onChange={setValue}
        orgId={orgId}
        placeholder={msg("settings.org.about.placeholder")}
        previewStyle={publicThemeStyleChain(branding)}
      />
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={save}
          disabled={!dirty || busy}
          className="btn btn-primary"
        >
          {busy ? msg("settings.saving") : msg("settings.org.about.save")}
        </button>
        {error && <p className="text-sm text-red-600">{error}</p>}
      </div>
    </div>
  );
}
