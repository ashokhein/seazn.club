// Timezone-aware date/time formatting — the single place Intl.* is called for
// display (spec 2026-07-14 user-timezone-design §5.2; also the v5/00 §5
// foundation, tz slice only). Every function takes an EXPLICIT tz: no helper
// ever falls back to the runtime's resolvedOptions() zone, which is the silent,
// unstable choice this module exists to kill. Locale is fixed to en-GB for now;
// the v5 i18n wave threads the resolved locale through the same signatures.
//
// Safe on both server and client (no server-only, no next imports).

const LOCALE = "en-GB";
export const UTC = "UTC";

/** Coerce loose input to a Date; null/invalid → null. */
function toDate(value: string | number | Date | null | undefined): Date | null {
  if (value == null) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Build a DateTimeFormat, retrying in UTC if the zone string is unknown. An
 *  invalid IANA name throws RangeError at construction — we never want that to
 *  bubble into a render, so fall back and (in dev) warn. */
function fmt(tz: string, opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  try {
    return new Intl.DateTimeFormat(LOCALE, { timeZone: tz, ...opts });
  } catch {
    if (process.env.NODE_ENV !== "production")
      console.warn(`[format] unknown timezone "${tz}", falling back to UTC`);
    return new Intl.DateTimeFormat(LOCALE, { timeZone: UTC, ...opts });
  }
}

export function fmtDate(
  tz: string,
  value: string | number | Date | null | undefined,
  opts: Intl.DateTimeFormatOptions = { weekday: "short", day: "numeric", month: "short" },
): string {
  const d = toDate(value);
  return d ? fmt(tz, opts).format(d) : "";
}

export function fmtTime(
  tz: string,
  value: string | number | Date | null | undefined,
  opts: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit", hourCycle: "h23" },
): string {
  const d = toDate(value);
  return d ? fmt(tz, opts).format(d) : "";
}

export function fmtDateTime(
  tz: string,
  value: string | number | Date | null | undefined,
  opts: Intl.DateTimeFormatOptions = { dateStyle: "medium", timeStyle: "short" },
): string {
  const d = toDate(value);
  return d ? fmt(tz, opts).format(d) : "";
}

/**
 * Short zone label at THIS instant — "IST", "BST"/"GMT", "EDT"/"EST". The
 * abbreviation is DST-dependent, so the moment matters: Europe/London is GMT in
 * January and BST in July. Returned bare (no time) for callers that append it.
 */
export function fmtZoneAbbrev(
  tz: string,
  value: string | number | Date | null | undefined,
): string {
  const d = toDate(value) ?? new Date();
  const parts = fmt(tz, { timeZoneName: "short" }).formatToParts(d);
  const raw = parts.find((p) => p.type === "timeZoneName")?.value ?? tz;
  // ICU builds vary: some emit "IST"/"BST", others fall back to an offset
  // ("GMT+5:30") for the very same zone (Node and some headless browsers do
  // this for Asia/Kolkata). When the runtime punts to an offset AND we have a
  // stable, DST-free abbreviation for the zone, prefer the recognizable name so
  // "IST" doesn't read as "GMT+5:30". We never override a runtime that already
  // produced a name, so DST zones (London GMT/BST, New York EST/EDT) are
  // untouched and stay correct across the year.
  if (/^(?:GMT|UTC)[+-]/.test(raw) && DST_FREE_ABBREV[tz]) return DST_FREE_ABBREV[tz];
  return raw;
}

// DST-free zones whose common abbreviation some ICU builds don't emit. All are
// year-round fixed offsets, so a static label is always correct.
const DST_FREE_ABBREV: Record<string, string> = {
  "Asia/Kolkata": "IST",
  "Asia/Colombo": "IST", // Sri Lanka shares +05:30
  "Asia/Karachi": "PKT",
  "Asia/Dhaka": "BST", // Bangladesh Standard Time
  "Asia/Kathmandu": "NPT",
  "Asia/Yangon": "MMT",
  "Asia/Kabul": "AFT",
  "Asia/Tehran": "IRST",
  "Asia/Dubai": "GST",
  "Asia/Muscat": "GST",
  "Asia/Singapore": "SGT",
  "Asia/Kuala_Lumpur": "MYT",
  "Asia/Bangkok": "ICT",
  "Asia/Jakarta": "WIB",
};

/**
 * Compact date range in one zone: "12–14 Aug", "30 Aug – 2 Sep", "16 Aug"
 * (single day). Absorbs the old client-time.tsx ClientDateRange logic.
 */
export function fmtRange(
  tz: string,
  from: string | number | Date | null | undefined,
  to: string | number | Date | null | undefined,
  opts: Intl.DateTimeFormatOptions = { day: "numeric", month: "short" },
): string {
  const a = toDate(from);
  if (!a) return "";
  const b = toDate(to) ?? a;
  const f = fmt(tz, opts);
  const fa = f.format(a);
  const fb = f.format(b);
  return fa === fb ? fa : `${fa} – ${fb}`;
}

// ── Locale-aware helpers (v5 i18n §5) ───────────────────────────────────────
// These take an explicit locale (unlike the tz date helpers above, which stay
// en-GB until each surface adopts the resolved locale in cycles 45/46). Numbers,
// durations, and relative times localize independently of timezone.

/** Integer/decimal formatting per locale (grouping + decimal marks differ). */
export function fmtNumber(
  locale: string,
  n: number,
  opts: Intl.NumberFormatOptions = {},
): string {
  return new Intl.NumberFormat(locale, opts).format(n);
}

/** Match/segment duration, e.g. "1 hr 5 min". Rounds to whole minutes; omits an
 *  empty hours field so short matches read "5 min", not "0 hr 5 min".
 *  Uses Intl.NumberFormat unit style (universally supported) rather than
 *  Intl.DurationFormat, which isn't a constructor on older Node runtimes. */
export function fmtDuration(locale: string, seconds: number): string {
  const totalMin = Math.max(0, Math.round(seconds / 60));
  const hours = Math.floor(totalMin / 60);
  const minutes = totalMin % 60;
  const unit = (value: number, u: "hour" | "minute") =>
    new Intl.NumberFormat(locale, { style: "unit", unit: u, unitDisplay: "short" }).format(value);
  const parts: string[] = [];
  if (hours > 0) parts.push(unit(hours, "hour"));
  if (minutes > 0 || hours === 0) parts.push(unit(minutes, "minute"));
  return parts.join(" ");
}

/** Relative time, e.g. "2 hours ago" / "in 3 days". Negative value = past. */
export function fmtRelative(
  locale: string,
  value: number,
  unit: Intl.RelativeTimeFormatUnit,
): string {
  return new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(value, unit);
}
