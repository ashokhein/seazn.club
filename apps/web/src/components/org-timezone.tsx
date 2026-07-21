"use client";

// Organisation scheduling timezone (V305) — the VENUE lane. Every division
// inherits this; there is no per-division timezone control any more. It is
// deliberately NOT users.timezone (the personal display lane, spec
// 2026-07-14): a London-based organiser can run an event in Malaga, so the
// zone belongs to the org's venues, not to the person looking at the screen.
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { TimezoneCombobox } from "@/components/ui/timezone-combobox";
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
  const [value, setValue] = useState(initialTimezone ?? "");
  const [saved, setSaved] = useState(initialTimezone ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Safe to read during render, unlike most browser-only values: it is only
  // ever used inside the picker's popup, which does not exist until the
  // organiser opens it — so it can never reach the server-rendered markup and
  // cannot cause a hydration mismatch. Same treatment as the account picker.
  const browserTz = useMemo(() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || "";
    } catch {
      return "";
    }
  }, []);

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
      <TimezoneCombobox
        value={value}
        onChange={setValue}
        ariaLabel={msg("settings.org.timezone.aria")}
        emptyLabel={msg("settings.org.timezone.notSet")}
        allowEmpty
        // The zone already saved is worth one click to get back to after an
        // exploratory search; the browser zone is the common answer for an
        // organiser who does run events where they live.
        suggested={[saved, browserTz].filter(Boolean)}
      />
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
