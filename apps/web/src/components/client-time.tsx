"use client";

import { createContext, useContext, useEffect, useState } from "react";
import { fmtDate, fmtTime, fmtDateTime, fmtZoneAbbrev } from "@/lib/format";

/**
 * Viewer timezone (spec 2026-07-14). A logged-in user's saved `users.timezone`
 * is passed down from whichever server component already loaded the user (no
 * extra query, and it keeps the resolution OUT of the root layout so that
 * layout stays static). When no pref is provided we detect the browser zone on
 * the client. Personal-lane times render in this zone; the venue lane uses it
 * only to show the viewer's local equivalent beside the authoritative venue time.
 */
const ViewerTzContext = createContext<string | null | undefined>(undefined);

export function ViewerTzProvider({
  tz,
  children,
}: {
  tz: string | null | undefined;
  children: React.ReactNode;
}) {
  return <ViewerTzContext.Provider value={tz}>{children}</ViewerTzContext.Provider>;
}

/** The viewer's zone: saved preference if present, else browser-detected. */
export function useViewerTz(): string {
  const pref = useContext(ViewerTzContext);
  const [detected, setDetected] = useState<string | null>(null);
  useEffect(() => {
    if (pref) return; // an explicit preference wins; no need to detect
    try {
      setDetected(Intl.DateTimeFormat().resolvedOptions().timeZone || null);
    } catch {
      /* leave null → UTC */
    }
  }, [pref]);
  return pref || detected || "UTC";
}

/** Same wall-clock label in both zones → nothing to disambiguate. */
function zonesAgree(a: string, b: string, value: string | Date): boolean {
  return (
    fmtTime(a, value) === fmtTime(b, value) &&
    fmtZoneAbbrev(a, value) === fmtZoneAbbrev(b, value)
  );
}

/**
 * A time rendered in an explicit zone, always labelled, with the viewer's local
 * equivalent one glance (subtitle) or hover away. Superset of ClientTime:
 *  - `tz`       the zone to render the value in (venue tz, or the viewer's).
 *  - `showZone` append the zone abbrev ("19:00 IST").
 *  - `you`      "subtitle" | "hover" | "off" — expose the viewer's local time
 *               when `tz` differs from the viewer's zone (venue lane). Rendered
 *               client-side because Node ICU emits offsets where browsers emit
 *               IST/BST; the empty-until-mount span keeps SSR + client in step.
 */
export function Zoned({
  value,
  tz,
  mode = "datetime",
  showZone = false,
  you = "off",
}: {
  value: string | Date | null;
  tz: string;
  mode?: "time" | "datetime" | "date";
  showZone?: boolean;
  you?: "off" | "subtitle" | "hover";
}) {
  const viewerTz = useViewerTz();
  const [main, setMain] = useState("");
  const [local, setLocal] = useState<string | null>(null);

  useEffect(() => {
    if (!value) {
      setMain("");
      setLocal(null);
      return;
    }
    const fmtMain = mode === "date" ? fmtDate : mode === "time" ? fmtTime : fmtDateTime;
    const label = fmtMain(tz, value);
    setMain(showZone ? `${label} ${fmtZoneAbbrev(tz, value)}` : label);

    if (you !== "off" && viewerTz && !zonesAgree(tz, viewerTz, value)) {
      const lt = mode === "date" ? fmtDate(viewerTz, value) : fmtTime(viewerTz, value);
      setLocal(`${lt} ${fmtZoneAbbrev(viewerTz, value)}`);
    } else {
      setLocal(null);
    }
  }, [value, tz, mode, showZone, you, viewerTz]);

  if (you === "hover" && local) {
    return (
      <span className="tz-hoverable" tabIndex={0} suppressHydrationWarning>
        {main}
        <span className="tz-tip" role="tooltip">
          <span className="tz-tip-you">{local}</span>
          <span className="tz-tip-lbl">your time</span>
        </span>
      </span>
    );
  }

  return (
    <span suppressHydrationWarning>
      {main}
      {you === "subtitle" && local && (
        <span className="tz-you" aria-label={`your local time ${local}`}>
          {local}
        </span>
      )}
    </span>
  );
}

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
  showZone = false,
}: {
  value: string | Date | null;
  mode?: "time" | "datetime" | "date";
  /** Render in this IANA zone instead of the viewer's (v3/04 §3 — schedule
   *  pages show the competition timezone, never a browser-local surprise). */
  tz?: string;
  /** Append the zone abbrev ("19:00 IST"). No-op for date mode (no clock). */
  showZone?: boolean;
}) {
  const [text, setText] = useState("");

  useEffect(() => {
    if (!value) return;
    const d = value instanceof Date ? value : new Date(value);
    const zone = tz ? { timeZone: tz } : {};
    try {
      const base =
        mode === "datetime"
          ? d.toLocaleString([], { dateStyle: "medium", timeStyle: "short", ...zone })
          : mode === "date"
            ? d.toLocaleDateString([], { dateStyle: "medium", ...zone })
            : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", ...zone });
      const abbrev =
        showZone && mode !== "date" ? ` ${fmtZoneAbbrev(tz ?? UTC_LOCAL(), d)}` : "";
      setText(base + abbrev);
    } catch {
      // Unknown zone string — fall back to the viewer's local time.
      setText(mode === "date" ? d.toLocaleDateString() : d.toLocaleString());
    }
  }, [value, mode, tz, showZone]);

  return <span suppressHydrationWarning>{text}</span>;
}

/** Viewer's own zone, for labelling times ClientTime renders without an
 *  explicit tz (so "showZone" still names a zone rather than guessing). */
function UTC_LOCAL(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
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
