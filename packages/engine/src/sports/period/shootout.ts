// Shared shootout primitive — v6/00 §3. Extracted from football's private
// best-of-5 alternating early-out (spec 04 §1.4) and parameterized so one
// shape serves football pens, IIHF GWS and the FIH shoot-out: `attempts`
// regulation kicks per side with an early decision when the lead exceeds the
// opponent's remaining entitlement, then sudden-death pairs until decided.
// Attempt metadata (FIH 8-second clock, GWS penalty-box ineligibility) rides
// on the events, never in this math (v6/00 §6.5).

export type ShootoutSide = "home" | "away";

export interface ShootoutKick {
  side: ShootoutSide;
  scored: boolean;
}

function opponent(side: ShootoutSide): ShootoutSide {
  return side === "home" ? "away" : "home";
}

// Winner of the shootout at this kick sequence, or null while undecided.
// Early decision when lead exceeds the opponent's remaining entitlement: up
// to `attempts` in regulation; in sudden death a side is entitled to match
// the opponent's kick count (complete the pair).
export function shootoutDecision(
  kicks: readonly ShootoutKick[],
  attempts = 5,
): ShootoutSide | null {
  const taken = { home: 0, away: 0 };
  const scored = { home: 0, away: 0 };
  for (const kick of kicks) {
    taken[kick.side]++;
    if (kick.scored) scored[kick.side]++;
  }
  const remaining = (side: ShootoutSide): number =>
    taken[side] < attempts
      ? attempts - taken[side]
      : Math.max(0, taken[opponent(side)] - taken[side]);
  if (scored.home > scored.away + remaining("away")) return "home";
  if (scored.away > scored.home + remaining("home")) return "away";
  return null;
}

// The side due to kick next, or null when either side may start.
export function expectedKicker(kicks: readonly ShootoutKick[]): ShootoutSide | null {
  if (kicks.length === 0) return null;
  const taken = { home: 0, away: 0 };
  for (const kick of kicks) taken[kick.side]++;
  if (taken.home === taken.away) return (kicks[0] as ShootoutKick).side;
  return taken.home < taken.away ? "home" : "away";
}

/** Scored tallies per side — the scorebug's "(GWS 2–1)" numbers. */
export function shootoutTally(kicks: readonly ShootoutKick[]): { home: number; away: number } {
  const tally = { home: 0, away: 0 };
  for (const kick of kicks) if (kick.scored) tally[kick.side]++;
  return tally;
}
