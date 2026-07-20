// Pure timezone helpers (spec 2026-07-14 user-timezone-design §5.3). No
// server-only / next imports — safe in client components (the account picker
// reads listTimezones) and shared zod schemas (updateProfileSchema validates
// with isValidIana). The request-scoped resolver lives in lib/tz-server.ts.

export const TZ_COOKIE = "seazn_tz";
export const DEFAULT_TZ = "UTC";

/**
 * True when `tz` is a zone the runtime's Intl accepts. Uses DateTimeFormat
 * construction (throws RangeError on an unknown zone) rather than
 * `supportedValuesOf`, so accepted aliases (e.g. "Asia/Calcutta") validate too.
 * Blank / null → false.
 */
export function isValidIana(tz: string | null | undefined): tz is string {
  if (!tz || !tz.trim()) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Pure precedence: first valid of user pref, then cookie, then UTC. */
export function pickTimezone(
  userTz: string | null | undefined,
  cookieTz: string | null | undefined,
): string {
  if (isValidIana(userTz)) return userTz;
  if (isValidIana(cookieTz)) return cookieTz;
  return DEFAULT_TZ;
}

/**
 * VENUE-lane precedence (V304): the division's own `schedule_settings.tz`
 * override, else the organisation's `organizations.timezone`, else UTC.
 *
 * Deliberately separate from `pickTimezone` (the PERSONAL lane): a
 * London-based organiser can run an event in Malaga, so the venue zone must
 * never fall back to `users.timezone` or the browser cookie. An existing
 * per-division value always wins — inheritance only fills the gap.
 */
export function resolveVenueTz(
  divisionTz: string | null | undefined,
  orgTz: string | null | undefined,
): string {
  if (isValidIana(divisionTz)) return divisionTz;
  if (isValidIana(orgTz)) return orgTz;
  return DEFAULT_TZ;
}

// Queries that must bucket/format in-database mirror this precedence inline as
// `coalesce(ss.tz, o.timezone, 'UTC')` (a raw string helper cannot be spliced
// into postgres.js tagged templates — it would be sent as a bind parameter).

/**
 * IANA zone list for the account picker. `Intl.supportedValuesOf` is the source
 * of truth on modern runtimes (~400+ zones); a small static fallback covers
 * older ones so the picker is never empty. Not for validation — that's
 * `isValidIana`.
 *
 * Runtimes still emit legacy zone names (e.g. Node returns "Asia/Calcutta");
 * canonicalize to the modern spelling so an India-based user picks
 * "Asia/Kolkata", not a 40-year-old alias. Both remain isValidIana.
 */
export function listTimezones(): string[] {
  let zones: string[] | undefined;
  try {
    zones = (
      Intl as unknown as { supportedValuesOf?: (k: string) => string[] }
    ).supportedValuesOf?.("timeZone");
  } catch {
    /* fall through */
  }
  const base = zones && zones.length ? zones : TZ_FALLBACK;
  const canonical = new Set(base.map((z) => TZ_RENAME[z] ?? z));
  return [...canonical].sort();
}

/** Legacy → modern IANA names some ICU builds still return. */
const TZ_RENAME: Record<string, string> = {
  "Asia/Calcutta": "Asia/Kolkata",
  "Asia/Rangoon": "Asia/Yangon",
  "Asia/Saigon": "Asia/Ho_Chi_Minh",
  "Asia/Katmandu": "Asia/Kathmandu",
  "Europe/Kiev": "Europe/Kyiv",
  "America/Buenos_Aires": "America/Argentina/Buenos_Aires",
};

const TZ_FALLBACK = [
  "UTC",
  "Europe/London", "Europe/Paris", "Europe/Berlin", "Europe/Madrid", "Europe/Amsterdam",
  "America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles",
  "America/Sao_Paulo", "America/Toronto",
  "Asia/Kolkata", "Asia/Dubai", "Asia/Singapore", "Asia/Tokyo", "Asia/Shanghai",
  "Australia/Sydney", "Pacific/Auckland",
];
