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
 * VENUE-lane precedence (V305): the division's own `schedule_settings.tz`
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

// The zone LIST used to live here as `listTimezones()`, reading
// Intl.supportedValuesOf with a 19-zone static fallback and canonicalizing six
// legacy spellings by hand. It now lives in lib/tz-options.ts over the
// generated lib/tz-data.ts table, which is complete (all 418 zones, all 19
// aliases — the old six-entry rename table let Córdoba, Mendoza, Jujuy and ten
// others appear twice in the picker) and carries the country and region every
// row needs. This module stays dependency-free so the shared zod schemas and
// the client islands that only need `isValidIana` do not pull that table in.
