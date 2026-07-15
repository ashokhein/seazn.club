"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { LOCALES, type Locale } from "@/lib/i18n-constants";

const LABELS: Record<Locale, string> = {
  en: "English",
  fr: "Français",
  es: "Español",
  nl: "Nederlands",
};

/**
 * Account → Preferences language picker (v5 i18n §9). Saves to users.locale via
 * PATCH /api/users/me and mirrors the choice into the seazn_locale cookie so
 * server-side resolveLocale() agrees immediately.
 */
export function LocalePreference({ current }: { current: string | null }) {
  const router = useRouter();
  const [value, setValue] = useState<string>(current ?? "en");
  const [status, setStatus] = useState<"idle" | "loading" | "saved" | "error">("idle");
  const [error, setError] = useState("");

  async function save(next: string) {
    setStatus("loading");
    setError("");
    try {
      const res = await fetch("/api/users/me", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ locale: next }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? "Failed to save language");
      }
      document.cookie = `seazn_locale=${next}; path=/; max-age=${60 * 60 * 24 * 365}; SameSite=Lax`;
      setStatus("saved");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
      setStatus("error");
    }
  }

  const unchanged = value === (current ?? "en");

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-0 flex-1">
          <select
            aria-label="Your language"
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              setStatus("idle");
            }}
            className="input w-full"
          >
            {LOCALES.map((l) => (
              <option key={l} value={l}>
                {LABELS[l as Locale]}
              </option>
            ))}
          </select>
        </div>
        <button
          type="button"
          onClick={() => save(value)}
          disabled={status === "loading" || unchanged}
          className="btn btn-primary shrink-0"
        >
          {status === "loading" ? "Saving…" : "Save"}
        </button>
      </div>

      <p className="text-xs text-slate-500">
        Sets the language for the app interface. Your organisation’s public pages follow the
        organisation’s language, not this.
      </p>
      {status === "saved" && <p className="text-sm text-emerald-600">Language saved.</p>}
      {status === "error" && <p className="text-sm text-red-600">{error}</p>}
    </div>
  );
}
