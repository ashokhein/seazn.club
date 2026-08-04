// Sibling of page.tsx: Next only tolerates its own fixed export set on a
// page module, so a helper the page needs lives here instead.

/**
 * "Time TBD" only makes sense pre-match — a live fixture with no
 * scheduled_at (started ad hoc) should say so instead of implying it
 * hasn't started, which contradicts the LIVE scorebug right below it.
 */
export function fixtureSubheading(
  status: string,
  scheduledAt: string | null | undefined,
): string {
  if (scheduledAt) {
    return new Date(scheduledAt).toLocaleString("en-GB", {
      weekday: "long",
      day: "numeric",
      month: "long",
      hour: "2-digit",
      minute: "2-digit",
    });
  }
  return status === "in_play" ? "Live" : "Time TBD";
}
