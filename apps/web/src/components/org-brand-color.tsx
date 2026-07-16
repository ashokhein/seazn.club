"use client";

// Org settings wrapper for the brand-color picker: optimistic select,
// PATCHes { branding: { colors: { primary } } }, rolls back on failure.
import { useState } from "react";
import { api } from "@/lib/client";
import { publicBrandColor } from "@/lib/public-theme";
import { BrandColorPicker } from "@/components/brand-color-picker";
import { useMsg } from "@/components/i18n/dict-provider";

export function OrgBrandColor({
  orgId,
  initialBranding,
}: {
  orgId: string;
  initialBranding: unknown;
}) {
  const msg = useMsg();
  const [value, setValue] = useState<string | null>(publicBrandColor(initialBranding));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function select(hex: string | null) {
    const prev = value;
    setValue(hex);
    setBusy(true);
    setError(null);
    try {
      await api(`/api/orgs/${orgId}`, {
        method: "PATCH",
        json: { branding: { colors: { primary: hex } } },
      });
    } catch (err) {
      setValue(prev);
      setError(err instanceof Error ? err.message : msg("settings.saveFailed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <p className="mb-2 text-xs text-slate-500">{msg("settings.org.brand.desc")}</p>
      <BrandColorPicker value={value} onSelect={select} disabled={busy} />
      {error && <p className="mt-1 text-xs text-red-500">{error}</p>}
    </div>
  );
}
