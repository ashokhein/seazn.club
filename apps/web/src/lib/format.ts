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
