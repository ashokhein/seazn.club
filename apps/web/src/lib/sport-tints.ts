// v8 (spec §1): sport-tinted banner gradients for competition cards.
// Decorative identity only — never a data encoding. Keys mirror SPORT_EMOJI;
// anything unknown wears the house violet.

export const SPORT_TINTS: Record<string, string> = {
  football: "#16a34a",
  cricket: "#ca8a04",
  volleyball: "#ea580c",
  badminton: "#0284c7",
  tabletennis: "#dc2626",
  boardgame: "#475569",
  carrom: "#b45309",
  tennis: "#65a30d",
  icehockey: "#0891b2",
  hockey: "#0d9488",
  generic: "#7c3aed",
};

export function sportTint(key: string | null | undefined): string {
  return SPORT_TINTS[key ?? "generic"] ?? "#7c3aed";
}
