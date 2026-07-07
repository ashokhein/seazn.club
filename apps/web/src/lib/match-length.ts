// Sensible default match/slot length (minutes) per sport, with a few
// variant-specific overrides. Used to pre-fill the scheduling match length in
// the division builder — the organiser can always change it.

const SPORT_DEFAULT: Record<string, number> = {
  football: 60,
  soccer: 60,
  cricket: 180,
  rugby: 80,
  hockey: 70,
  badminton: 30,
  tennis: 90,
  squash: 40,
  padel: 60,
  tabletennis: 20,
  table_tennis: 20,
  volleyball: 60,
  basketball: 40,
  netball: 60,
  boardgame: 45,
  chess: 45,
  carrom: 30,
  draughts: 45,
};

// Keyed by `${sport}:${variant}` (both lowercased). Variant keys match the
// sport_variants table (e.g. cricket: t20, hundred, odi, test, pairs-6-a-side).
const VARIANT_OVERRIDE: Record<string, number> = {
  // Board games: game clock, not a fixed slot.
  "boardgame:blitz": 10,
  "boardgame:rapid": 25,
  "boardgame:classical": 90,
  // Cricket, roughly by innings length. The Hundred = 100 balls/side (~16
  // overs) → shorter than T20's 20 overs; ODI is 50 overs → a full day.
  "cricket:t20": 180,
  "cricket:hundred": 150,
  "cricket:odi": 420,
  "cricket:test": 480,
  "cricket:pairs-6-a-side": 45,
  // Football by side size.
  "football:11-a-side": 90,
  "football:small-sided": 40,
  "football:youth": 50,
  // Badminton / table tennis by rally length.
  "badminton:bwf": 40,
  "badminton:short": 25,
  "tabletennis:bo5": 20,
  "tabletennis:bo7": 30,
  "tabletennis:hardbat-21": 15,
};

/** Default match length in minutes for a sport (+ optional variant). 30 if unknown. */
export function defaultMatchMinutes(sportKey?: string | null, variantKey?: string | null): number {
  const s = (sportKey ?? "").toLowerCase();
  const v = (variantKey ?? "").toLowerCase();
  return VARIANT_OVERRIDE[`${s}:${v}`] ?? SPORT_DEFAULT[s] ?? 30;
}
