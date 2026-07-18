import { publicStorageUrl } from "@/lib/supabase-storage";

// PROMPT-60 — ONE badge resolver reused by every surface (console standings,
// public pages, embeds, bracket nodes, PDF builders): the entrant's own
// badge_url wins (external http(s) URL verbatim, anything else treated as an
// assets-bucket storage path), then the linked team's logo path, then null —
// callers render the existing initials monogram on null (no layout shift).
export function resolveEntrantBadge(e: {
  badge_url?: string | null;
  team_logo_path?: string | null;
}): string | null {
  const badge = e.badge_url?.trim();
  if (badge) return /^https?:\/\//i.test(badge) ? badge : publicStorageUrl(badge);
  const logo = e.team_logo_path?.trim();
  return logo ? publicStorageUrl(logo) : null;
}
