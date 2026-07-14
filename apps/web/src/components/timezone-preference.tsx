"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { fmtTime, fmtZoneAbbrev } from "@/lib/format";
import { listTimezones, TZ_COOKIE } from "@/lib/tz";

/**
 * Account → Preferences timezone picker (spec 2026-07-14). Saves to
 * users.timezone via PATCH /api/users/me and mirrors the choice into the
 * seazn_tz cookie so server-side resolveTimezone() agrees. Empty selection
 * clears the preference ("follow my browser").
 */
export function TimezonePreference({ current }: { current: string | null }) {
  const router = useRouter();
  const zones = useMemo(() => listTimezones(), []);
  const browserTz = useMemo(() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    } catch {
      return "UTC";
    }
  }, []);

  const [value, setValue] = useState(current ?? "");
  const [status, setStatus] = useState<"idle" | "loading" | "saved" | "error">("idle");
  const [error, setError] = useState("");
  const [now, setNow] = useState(() => new Date());

  // Keep the live preview honest as minutes tick over.
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 15_000);
    return () => clearInterval(id);
  }, []);

  // Group the (large) IANA list by region for a scannable <select>.
  const groups = useMemo(() => {
    const by = new Map<string, string[]>();
    for (const z of zones) {
      const region = z.includes("/") ? z.slice(0, z.indexOf("/")) : "Other";
      (by.get(region) ?? by.set(region, []).get(region)!).push(z);
    }
    return [...by.entries()];
  }, [zones]);

  const previewZone = value || browserTz;
  const preview = `${fmtTime(previewZone, now)} ${fmtZoneAbbrev(previewZone, now)}`;

  async function save(next: string) {
    setStatus("loading");
    setError("");
    try {
      const res = await fetch("/api/users/me", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ timezone: next === "" ? null : next }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? "Failed to save timezone");
      }
      // Mirror into the cookie so anonymous/SSR resolution matches the pref.
      document.cookie = `${TZ_COOKIE}=${encodeURIComponent(next)}; path=/; max-age=${next === "" ? 0 : 60 * 60 * 24 * 365}; SameSite=Lax`;
      setStatus("saved");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
      setStatus("error");
    }
  }

  const unchanged = value === (current ?? "");

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-0 flex-1">
          <select
            aria-label="Your timezone"
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              setStatus("idle");
            }}
            className="input w-full"
          >
            <option value="">Use my browser’s timezone ({browserTz})</option>
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
        </div>
        <button
          type="button"
          onClick={() => {
            setValue(browserTz);
            setStatus("idle");
          }}
          className="btn btn-ghost shrink-0"
          title={`Detect: ${browserTz}`}
        >
          ⌖ Detect
        </button>
        <button
          type="button"
          onClick={() => save(value)}
          disabled={status === "loading" || unchanged}
          className="btn btn-primary shrink-0"
        >
          {status === "loading" ? "Saving…" : "Save"}
        </button>
      </div>

      <div className="flex items-baseline gap-2 rounded-lg bg-[var(--tz-you-soft)] px-3 py-2">
        <span className="text-xs font-medium text-[var(--tz-you)]">Current time here</span>
        <span
          className="text-lg font-bold tabular-nums text-[var(--tz-you)]"
          suppressHydrationWarning
        >
          {preview}
        </span>
      </div>

      <p className="text-xs text-slate-500">
        Schedules always show the <strong>venue’s</strong> time; this controls your own times
        (your schedule, activity, billing) and the local-time hint beside every venue time.
      </p>
      {status === "saved" && <p className="text-sm text-emerald-600">Timezone saved.</p>}
      {status === "error" && <p className="text-sm text-red-600">{error}</p>}
    </div>
  );
}
