import { formatFamily } from "@/config/format-gallery";
import { previewDivisionFixtures, type PreviewPhase } from "@/server/usecases/stages";

/** Formats offered by the home-page configurator (design/v3/12 §4.4).
 *  Swiss is deliberately absent: previewDivisionFixtures returns a note-only
 *  phase for score-dependent formats, and a note is a dead tab in a
 *  play-first demo. Slugs match src/config/format-gallery.tsx. */
export const MARKETING_FORMATS = [
  "league",
  "groups-knockout",
  "knockout",
  "double_elim",
] as const;
export type MarketingFormat = (typeof MARKETING_FORMATS)[number];

export const MARKETING_FORMAT_LABELS: Record<MarketingFormat, string> = {
  league: "League",
  "groups-knockout": "Groups + KO",
  knockout: "Knockout",
  double_elim: "Double elim",
};

export function marketingPreview(format: MarketingFormat, entrants: number): PreviewPhase[] {
  const family = formatFamily(format);
  if (!family) throw new Error(`unknown marketing format '${format}'`);
  const n = Math.min(Math.max(Math.trunc(entrants) || 8, 4), 16);
  return previewDivisionFixtures(family.cannedStages, n);
}
