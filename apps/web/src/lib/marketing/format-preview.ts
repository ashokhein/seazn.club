import { formatFamily } from "@/config/format-gallery";
import { previewDivisionFixtures, type PreviewPhase } from "@/server/usecases/stages";
import { type MarketingFormat } from "@/lib/marketing/formats";

// Server-side only — pulls the engine (and via it posthog-server) into the
// module graph. Client components import from ./formats instead.
export { MARKETING_FORMATS, MARKETING_FORMAT_LABELS, type MarketingFormat } from "@/lib/marketing/formats";

export function marketingPreview(format: MarketingFormat, entrants: number): PreviewPhase[] {
  const family = formatFamily(format);
  if (!family) throw new Error(`unknown marketing format '${format}'`);
  const n = Math.min(Math.max(Math.trunc(entrants) || 8, 4), 16);
  return previewDivisionFixtures(family.cannedStages, n);
}
