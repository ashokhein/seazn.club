// Sibling of page.tsx: Next only tolerates its own fixed export set on a
// page module, so a helper the page needs lives here instead.

/**
 * "Not rostered anywhere" and "rostered but nothing scheduled yet" are
 * different situations that need different copy — see fix-ui audit
 * 04-account-public-embed.md.
 */
export function meEmptyState(
  upcomingCount: number,
  resultsCount: number,
  teamsCount: number,
): "unrostered" | "rostered" | null {
  if (upcomingCount > 0 || resultsCount > 0) return null;
  return teamsCount > 0 ? "rostered" : "unrostered";
}
