"use client";

// Organisation scheduling timezone (V305) — the VENUE lane. Every division
// inherits this; there is no per-division timezone control any more. It is
// deliberately NOT users.timezone (the personal display lane, spec
// 2026-07-14): a London-based organiser can run an event in Malaga, so the
// zone belongs to the org's venues, not to the person looking at the screen.
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { listTimezones } from "@/lib/tz";
import { useMsg } from "@/components/i18n/dict-provider";

export function OrgTimezone({
  orgId,
  initialTimezone,
}: {
  orgId: string;
  initialTimezone: string | null;
}) {
  const msg = useMsg();
  const router = useRouter();
  const zones = useMemo(() => listTimezones(), []);
  const [value, setValue] = useState(initialTimezone ?? "");
  const [saved, setSaved] = useState(initialTimezone ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Group the (large) IANA list by region for a scannable <select>, same
  // treatment as the account picker.
  const groups = useMemo(() => {
    const by = new Map<string, string[]>();
    for (const z of zones) {
      const region = z.includes("/") ? z.slice(0, z.indexOf("/")) : "Other";
      (by.get(region) ?? by.set(region, []).get(region)!).push(z);
    }
    return [...by.entries()];
  }, [zones]);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/orgs/${orgId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ timezone: value === "" ? null : value }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error ?? msg("settings.saveFailed"));
      }
      setSaved(value);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : msg("settings.saveFailed"));
    } finally {
      setBusy(false);
    }
  }

  const dirty = value !== saved;

  return (
    <div className="space-y-2">
      <p className="text-sm text-slate-500">{msg("settings.org.timezone.desc")}</p>
      <select
        aria-label={msg("settings.org.timezone.aria")}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        className="input w-full"
      >
        <option value="">{msg("settings.org.timezone.notSet")}</option>
        {groups.map(([region, list]) => (
          <optgroup key={region} label={region}>
            {list.map((z) => (
              <option key={z} value={z}>
                {z.replace(/_/g, " ")}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={save}
          disabled={!dirty || busy}
          className="btn btn-primary"
        >
          {busy ? msg("settings.saving") : msg("settings.org.save")}
        </button>
        {error && <p className="text-sm text-red-600">{error}</p>}
      </div>
    </div>
  );
}
