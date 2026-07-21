// Timezone PICKER data — the labelled, searchable, region-grouped view of the
// IANA list. Pure: no react, no next, no DOM.
//
// Deliberately separate from lib/tz.ts. That module is imported by shared zod
// schemas and by client islands all over the app for isValidIana/pickTimezone;
// pulling the ~20KB TZ_META table in beside them would ship the whole zone
// table to every page that validates a timezone. Only the two pickers import
// this file.
import { TZ_ALIAS, TZ_META, TZ_REGIONS, type TzRegion } from "@/lib/tz-data";

export type { TzRegion };
export { TZ_REGIONS };

export interface ZoneOption {
  /** Canonical IANA id — the value actually stored. */
  zone: string;
  /** Last path segment, humanised: "Asia/Dubai" -> "Dubai". */
  city: string;
  /** Localised country name from Intl.DisplayNames, e.g. "United Arab Emirates". */
  country: string;
  /** ISO 3166-1 alpha-2, kept so "AE" and "UAE"-style queries can match. */
  cc: string;
  region: TzRegion;
  /** Lowercased haystack: city, country, code, and every zone path segment. */
  haystack: string;
}

/** "Asia/Ho_Chi_Minh" -> "Ho Chi Minh"; "America/Indiana/Knox" -> "Knox". */
export function zoneCity(zone: string): string {
  return zone.slice(zone.lastIndexOf("/") + 1).replace(/_/g, " ");
}

/**
 * Canonicalise a stored zone for display. Values written before this table
 * existed may be legacy spellings ("Asia/Calcutta"); both stay valid input, but
 * the picker only ever shows — and writes — the canonical one.
 */
export function canonicalZone(zone: string): string {
  return TZ_ALIAS[zone] ?? zone;
}

function countryNamer(locale: string): (cc: string) => string {
  try {
    const names = new Intl.DisplayNames([locale], { type: "region" });
    return (cc) => {
      try {
        return names.of(cc) ?? cc;
      } catch {
        return cc;
      }
    };
  } catch {
    // Runtime without DisplayNames — the code alone still identifies the place.
    return (cc) => cc;
  }
}

/**
 * Every selectable zone, labelled in `locale` and sorted by city. Country names
 * come from Intl.DisplayNames so they arrive translated rather than frozen in
 * English in the generated table.
 */
export function listZoneOptions(locale: string): ZoneOption[] {
  const nameOf = countryNamer(locale);
  const options: ZoneOption[] = [];
  for (const [zone, [cc, region]] of Object.entries(TZ_META)) {
    const city = zoneCity(zone);
    const country = nameOf(cc);
    options.push({
      zone,
      city,
      country,
      cc,
      region,
      // Path segments are included so "Indiana" finds Knox and "Argentina"
      // finds Jujuy, even though neither word is in the city or the country.
      haystack: `${city} ${country} ${cc} ${zone.replace(/[/_]/g, " ")}`.toLowerCase(),
    });
  }
  return options.sort((a, b) => a.city.localeCompare(b.city, locale));
}

/**
 * Rank `options` against a free-text query. Exact city, then city prefix, then
 * country prefix, then anything else — so "dub" leads with Dubai and Dublin,
 * and "united" does not bury Denver under thirty American cities.
 *
 * Plain ranked matching rather than an index: 418 rows is small enough that
 * building one costs more than scanning, and the ranking is the point.
 */
export function searchZones(options: ZoneOption[], query: string, limit = 60): ZoneOption[] {
  const q = query.trim().toLowerCase();
  // No query means "browse", not "search": the caller groups the whole list
  // under its region headings, and truncating it there would silently cut the
  // list off at the first 60 cities alphabetically — Abidjan to Bogota, with
  // every region after Africa missing entirely. The cap exists to keep a
  // *search* responsive, so it only applies once there is something to match.
  if (!q) return options;
  const scored: [number, ZoneOption][] = [];
  for (const option of options) {
    const city = option.city.toLowerCase();
    const country = option.country.toLowerCase();
    let score: number;
    if (city === q) score = 0;
    else if (city.startsWith(q)) score = 1;
    else if (country.startsWith(q) || option.cc.toLowerCase() === q) score = 2;
    else if (city.includes(q)) score = 3;
    else if (option.haystack.includes(q)) score = 4;
    else continue;
    scored.push([score, option]);
  }
  scored.sort((a, b) => a[0] - b[0] || a[1].city.localeCompare(b[1].city));
  return scored.slice(0, limit).map(([, option]) => option);
}

/**
 * Bucket into regions, in TZ_REGIONS order. Empty regions are dropped, so a
 * filtered list never shows a heading with nothing under it.
 */
export function groupByRegion(options: ZoneOption[]): [TzRegion, ZoneOption[]][] {
  const by = new Map<TzRegion, ZoneOption[]>();
  for (const option of options) {
    const list = by.get(option.region);
    if (list) list.push(option);
    else by.set(option.region, [option]);
  }
  return TZ_REGIONS.filter((region) => by.has(region)).map(
    (region) => [region, by.get(region)!] as [TzRegion, ZoneOption[]],
  );
}
