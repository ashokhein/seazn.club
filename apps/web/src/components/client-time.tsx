"use client";

import { useEffect, useState } from "react";

/**
 * Renders a locale/timezone-formatted time on the client only. The first
 * render (server + client hydration) is an empty span, so the markup matches
 * and React doesn't report a hydration mismatch; the formatted value fills in
 * after mount using the viewer's local timezone.
 */
export function ClientTime({
  value,
  mode = "time",
  tz,
}: {
  value: string | Date | null;
  mode?: "time" | "datetime" | "date";
  /** Render in this IANA zone instead of the viewer's (v3/04 §3 — schedule
   *  pages show the competition timezone, never a browser-local surprise). */
  tz?: string;
}) {
  const [text, setText] = useState("");

  useEffect(() => {
    if (!value) return;
    const d = value instanceof Date ? value : new Date(value);
    const zone = tz ? { timeZone: tz } : {};
    try {
      setText(
        mode === "datetime"
          ? d.toLocaleString([], { dateStyle: "medium", timeStyle: "short", ...zone })
          : mode === "date"
            ? d.toLocaleDateString([], { dateStyle: "medium", ...zone })
            : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", ...zone }),
      );
    } catch {
      // Unknown zone string — fall back to the viewer's local time.
      setText(mode === "date" ? d.toLocaleDateString() : d.toLocaleString());
    }
  }, [value, mode, tz]);

  return <span suppressHydrationWarning>{text}</span>;
}

/**
 * Compact date range ("12–14 Aug" / "30 Aug – 2 Sep"), same client-only fill
 * pattern as ClientTime. Used by round headers on the division schedule
 * (v3/04 §3 item 1).
 */
export function ClientDateRange({
  from,
  to,
  tz,
}: {
  from: string | Date | null;
  to: string | Date | null;
  tz?: string;
}) {
  const [text, setText] = useState("");

  useEffect(() => {
    if (!from) return;
    const a = from instanceof Date ? from : new Date(from);
    const b = to ? (to instanceof Date ? to : new Date(to)) : a;
    const opts: Intl.DateTimeFormatOptions = { day: "numeric", month: "short" };
    if (tz) opts.timeZone = tz;
    try {
      const fa = a.toLocaleDateString([], opts);
      const fb = b.toLocaleDateString([], opts);
      setText(fa === fb ? fa : `${fa} – ${fb}`);
    } catch {
      setText(a.toLocaleDateString());
    }
  }, [from, to, tz]);

  return <span suppressHydrationWarning>{text}</span>;
}
