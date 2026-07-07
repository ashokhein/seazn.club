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

// Keyed by `${sport}:${variant}` (both lowercased).
const VARIANT_OVERRIDE: Record<string, number> = {
  "boardgame:blitz": 10,
  "boardgame:rapid": 25,
  "boardgame:classical": 90,
  "chess:blitz": 10,
  "chess:rapid": 25,
  "chess:classical": 90,
  "cricket:t20": 180,
  "cricket:hundred": 150,
  "cricket:t10": 90,
  "football:sevens": 40,
  "football:fives": 30,
  "football:futsal": 40,
  "padel:americano": 15,
  "padel:mexicano": 15,
};

/** Default match length in minutes for a sport (+ optional variant). 30 if unknown. */
export function defaultMatchMinutes(sportKey?: string | null, variantKey?: string | null): number {
  const s = (sportKey ?? "").toLowerCase();
  const v = (variantKey ?? "").toLowerCase();
  return VARIANT_OVERRIDE[`${s}:${v}`] ?? SPORT_DEFAULT[s] ?? 30;
}
