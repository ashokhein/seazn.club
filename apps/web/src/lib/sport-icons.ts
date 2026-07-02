import {
  Castle,
  CircleDot,
  Goal,
  Target,
  Volleyball,
  Table2,
  Feather,
  Trophy,
  type LucideIcon,
} from "lucide-react";

/**
 * Icon per built-in sport (keys match SYSTEM_SPORT_PRESET_DEFS in
 * sport-presets.ts). Custom sports (`custom-*`) and any unknown key fall back
 * to a trophy.
 */
export const SPORT_ICONS: Record<string, LucideIcon> = {
  chess: Castle,
  carrom: CircleDot,
  football: Goal,
  cricket: Target,
  volleyball: Volleyball,
  tabletennis: Table2,
  badminton: Feather,
};

export function sportIcon(sportKey: string): LucideIcon {
  return SPORT_ICONS[sportKey] ?? Trophy;
}
