/** Client-safe marketing format constants (design/v3/12 §4.4). Kept apart
 *  from format-preview.ts because that module reaches into the server engine
 *  (stages → posthog-server), which must never enter the client bundle.
 *
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
