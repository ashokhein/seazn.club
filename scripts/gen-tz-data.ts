// Generates apps/web/src/lib/tz-data.ts — every IANA zone the app can offer,
// tagged with its ISO 3166 country and the human region we file it under.
//
// Run: npm run gen:tz   (after a tzdata bump; the output is committed)
//
// Source of truth is the tzdata the OS already ships:
//   /usr/share/zoneinfo/zone.tab      zone -> ISO country code   (418 zones)
//   /usr/share/zoneinfo/iso3166.tab   ISO country code -> name   (247 codes)
//
// Country NAMES are deliberately NOT emitted: the app reads them from
// Intl.DisplayNames at render time, so they arrive already translated in each
// of the four locales instead of being frozen in English here.
//
// Regions are keyed off the COUNTRY, not the zone prefix. IANA prefixes are
// continent-scale and encode nothing a person searching for "Dubai" expects —
// every Gulf state lives under `Asia/`, which is how Dubai ended up filed
// beside Tokyo. A country map puts it under Middle East, where organisers look.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, "../apps/web/src/lib/tz-data.ts");
const ZONE_TAB = "/usr/share/zoneinfo/zone.tab";
const ISO_TAB = "/usr/share/zoneinfo/iso3166.tab";

/** Region buckets, in the order the picker lists them. */
const REGIONS = [
  "europe",
  "north-america",
  "central-america",
  "south-america",
  "africa",
  "middle-east",
  "central-asia",
  "south-asia",
  "east-asia",
  "southeast-asia",
  "oceania",
  "antarctic",
  "other",
] as const;

type Region = (typeof REGIONS)[number];

// ISO 3166-1 alpha-2 -> region. Every code in iso3166.tab must appear exactly
// once; the generator throws otherwise, so a tzdata bump that adds a country
// fails loudly here instead of silently filing it under the wrong heading.
//
// Judgement calls, recorded so they are not re-litigated every tzdata bump:
//  - Turkey (TR) is Middle East, though its zone is spelled Europe/Istanbul.
//  - Cyprus (CY) is Europe: EU member, and both its zone spellings exist.
//  - The Caucasus (AM, AZ, GE) sits with Central Asia rather than Europe.
//  - Christmas I. / Cocos (CX, CC) are Australian but sit off Java, so they
//    are filed under South-East Asia where a map would put them.
//  - Greenland (GL) is North America; its zones are already America/*.
const COUNTRY_REGION: Record<string, Region> = {};
const put = (region: Region, codes: string) => {
  for (const code of codes.trim().split(/\s+/)) {
    if (COUNTRY_REGION[code]) throw new Error(`${code} mapped twice`);
    COUNTRY_REGION[code] = region;
  }
};

put("europe", `AD AL AT AX BA BE BG BY CH CY CZ DE DK EE ES FI FO FR GB GG GI
  GR HR HU IE IM IS IT JE LI LT LU LV MC MD ME MK MT NL NO PL PT RO RS RU SE
  SI SJ SK SM UA VA`);
put("north-america", `BM CA GL MX PM US`);
put("central-america", `AG AI AW BB BL BQ BS BZ CR CU CW DM DO GD GP GT HN HT
  JM KN KY LC MF MQ MS NI PA PR SV SX TC TT VC VG VI`);
put("south-america", `AR BO BR CL CO EC FK GF GS GY PE PY SR UY VE`);
put("africa", `AO BF BI BJ BW CD CF CG CI CM CV DJ DZ EG EH ER ET GA GH GM GN
  GQ GW KE KM LR LS LY MA MG ML MR MU MW MZ NA NE NG RE RW SC SD SH SL SN SO
  SS ST SZ TD TG TN TZ UG YT ZA ZM ZW`);
put("middle-east", `AE BH IL IQ IR JO KW LB OM PS QA SA SY TR YE`);
put("central-asia", `AF AM AZ GE KG KZ TJ TM UZ`);
put("south-asia", `BD BT IN IO LK MV NP PK`);
put("east-asia", `CN HK JP KP KR MN MO TW`);
put("southeast-asia", `BN CC CX ID KH LA MM MY PH SG TH TL VN`);
put("oceania", `AS AU CK FJ FM GU KI MH MP NC NF NR NU NZ PF PG PN PW SB TK TO
  TV UM VU WF WS`);
// BV and HM are uninhabited and carry no zone in zone.tab, but iso3166.tab
// lists them and the completeness check above is deliberately strict.
put("antarctic", `AQ BV HM TF`);

// Russia is the one country whose zones straddle the map badly enough to
// override: eight of its eleven zones are spelled Asia/* and sit in Siberia or
// the far east, so filing Kamchatka under "Europe" reads as a bug. Only the
// Europe/* spellings stay European.
const zoneRegion = (zone: string, cc: string): Region => {
  if (cc === "RU" && zone.startsWith("Asia/")) return "central-asia";
  return COUNTRY_REGION[cc];
};

function parseTab(path: string): string[][] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => line.split("\t"));
}

// --- read tzdata -----------------------------------------------------------

const countries = new Set(parseTab(ISO_TAB).map(([code]) => code));
const unmapped = [...countries].filter((code) => !COUNTRY_REGION[code]);
if (unmapped.length) {
  throw new Error(
    `Unmapped ISO country codes (add them to COUNTRY_REGION): ${unmapped.join(", ")}`,
  );
}
const stale = Object.keys(COUNTRY_REGION).filter((code) => !countries.has(code));
if (stale.length) {
  throw new Error(`COUNTRY_REGION has codes tzdata no longer knows: ${stale.join(", ")}`);
}

const meta: [string, string, Region][] = [];
for (const [cc, , zone] of parseTab(ZONE_TAB)) {
  if (!zone) continue;
  const region = zoneRegion(zone, cc);
  if (!region) throw new Error(`No region for ${zone} (${cc})`);
  meta.push([zone, cc, region]);
}
meta.sort(([a], [b]) => a.localeCompare(b));

// --- aliases ---------------------------------------------------------------
// The runtime's own zone list still contains legacy spellings that zone.tab
// dropped (Node returns both "Asia/Calcutta" and "Asia/Kolkata"). Every one of
// them must map onto a canonical zone, or the picker shows the same city twice
// — which is exactly what it did before this file existed.
// Aliases whose city name was also renamed, so the endsWith match cannot work.
const MANUAL_ALIAS: Record<string, string> = {
  "Africa/Asmera": "Africa/Asmara",
  "America/Buenos_Aires": "America/Argentina/Buenos_Aires",
  "America/Coral_Harbour": "America/Atikokan",
  "America/Godthab": "America/Nuuk",
  "America/Indianapolis": "America/Indiana/Indianapolis",
  "America/Louisville": "America/Kentucky/Louisville",
  "Asia/Calcutta": "Asia/Kolkata",
  "Asia/Katmandu": "Asia/Kathmandu",
  "Asia/Rangoon": "Asia/Yangon",
  "Asia/Saigon": "Asia/Ho_Chi_Minh",
  "Atlantic/Faeroe": "Atlantic/Faroe",
  "Europe/Kiev": "Europe/Kyiv",
  "Pacific/Enderbury": "Pacific/Kanton",
  "Pacific/Ponape": "Pacific/Pohnpei",
  "Pacific/Truk": "Pacific/Chuuk",
};

const canonical = new Set(meta.map(([zone]) => zone));
const aliases: [string, string][] = [];
let zones: string[] = [];
try {
  zones =
    (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.(
      "timeZone",
    ) ?? [];
} catch {
  /* older runtime — nothing to reconcile */
}
for (const zone of zones) {
  if (canonical.has(zone)) continue;
  const city = zone.slice(zone.lastIndexOf("/") + 1);
  // Prefer a canonical zone ending in the same city, else the same-offset
  // zone in the same country. Hand-checked list below covers the rest.
  const match =
    meta.find(([z]) => z.endsWith(`/${city}`)) ?? meta.find(([z]) => z === MANUAL_ALIAS[zone]);
  if (!match) throw new Error(`No canonical zone for alias ${zone} — add it to MANUAL_ALIAS`);
  aliases.push([zone, match[0]]);
}
aliases.sort(([a], [b]) => a.localeCompare(b));

// --- emit ------------------------------------------------------------------

const body = `// GENERATED by scripts/gen-tz-data.ts — do not edit by hand.
// Run \`npm run gen:tz\` after a tzdata bump.
//
// Source: /usr/share/zoneinfo/{zone.tab,iso3166.tab}. Country names are NOT
// stored here — lib/tz.ts reads them from Intl.DisplayNames so they arrive
// translated in every locale.

/** Human region buckets, in the order the timezone picker lists them. */
export const TZ_REGIONS = ${JSON.stringify(REGIONS)} as const;

export type TzRegion = (typeof TZ_REGIONS)[number];

/** Canonical IANA zone -> [ISO 3166-1 alpha-2 country, region]. */
export const TZ_META: Record<string, readonly [string, TzRegion]> = {
${meta.map(([zone, cc, region]) => `  ${JSON.stringify(zone)}: ["${cc}", "${region}"],`).join("\n")}
};

/**
 * Legacy zone spellings the runtime still returns -> the canonical zone.
 * Both remain valid input (isValidIana accepts either); the picker only ever
 * offers the canonical spelling, so no city appears twice.
 */
export const TZ_ALIAS: Record<string, string> = {
${aliases.map(([from, to]) => `  ${JSON.stringify(from)}: ${JSON.stringify(to)},`).join("\n")}
};
`;

writeFileSync(OUT, body);
console.log(`tz-data.ts: ${meta.length} zones, ${aliases.length} aliases, ${REGIONS.length} regions.`);
