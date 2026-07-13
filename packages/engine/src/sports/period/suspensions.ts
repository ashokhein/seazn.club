// Timed-suspension track — v6/00 §3 + v6/01 §2/§3. Class tables (IIHF
// penalty minutes, FIH cards), the active-suspension ledger and the derived
// facts: team strength while suspensions run, PIM tallies, FIH progressive-
// escalation hints. The engine has NO clock (v6/00 §6.1): a suspension starts
// and ends by scorer events only; pads show a countdown hint from wall time,
// but the fold trusts nothing except `suspension.start` / `suspension.end`.

export type SuspSide = "home" | "away";

export interface SuspensionClass {
  /** Nominal length in minutes (display + pad countdown hint); null = for the
   *  rest of the match (red card, game misconduct). */
  minutes: number | null;
  /** Does the team play short while it runs (IIHF minors/majors, ALL FIH
   *  cards)? Misconducts park the player but the team stays full. */
  teamShort: boolean;
  /** Penalty minutes recorded against player + team (IIHF: misconduct 10,
   *  game misconduct 20, match 25). Defaults to `minutes`. */
  pim?: number;
  /** Cannot be released by a suspension.end — the player is off for good
   *  (FIH red). Team-short reds keep the team short to full time. */
  permanent?: boolean;
}

export type SuspensionClasses = Record<string, SuspensionClass>;

export interface SuspensionCfg {
  classes: SuspensionClasses;
}

// v6/01 §2 — IIHF Rules 16–28. Match penalty: player off for good but the
// team is short for 5' (released by event like a major); modelled as a
// releasable 5' team-short class carrying 25 PIM.
export const ICEHOCKEY_SUSPENSIONS: SuspensionClasses = {
  minor: { minutes: 2, teamShort: true },
  bench_minor: { minutes: 2, teamShort: true },
  double_minor: { minutes: 4, teamShort: true },
  major: { minutes: 5, teamShort: true },
  misconduct: { minutes: 10, teamShort: false, pim: 10 },
  game_misconduct: { minutes: null, teamShort: false, pim: 20, permanent: true },
  match: { minutes: 5, teamShort: true, pim: 25 },
};

// v6/01 §3 — FIH Rule 14: the team plays short on EVERY card (unlike
// football yellows); red is permanent exclusion.
export const HOCKEY_SUSPENSIONS: SuspensionClasses = {
  green: { minutes: 2, teamShort: true },
  yellow: { minutes: 5, teamShort: true },
  red: { minutes: null, teamShort: true, permanent: true },
};

export interface ActiveSuspension {
  side: SuspSide;
  person?: string;
  classKey: string;
  teamShort: boolean;
  permanent: boolean;
}

export interface CardRecordEntry {
  side: SuspSide;
  person?: string;
  classKey: string;
}

/** PIM recorded for one suspension class (defaults to its minutes). */
export function pimOf(cls: SuspensionClass): number {
  return cls.pim ?? cls.minutes ?? 0;
}

/** On-field strength per side: base minus running team-short suspensions,
 *  floored at `min` (IIHF: penalties beyond 5v3 stack but don't reduce). */
export function strengthOf(
  active: readonly ActiveSuspension[],
  side: SuspSide,
  base: number,
  min: number,
): number {
  const short = active.filter((s) => s.side === side && s.teamShort).length;
  return Math.max(min, base - short);
}

/** "5v4" / "5v3" / "10v11" — null at equal strength (no chip shown). */
export function strengthChip(
  active: readonly ActiveSuspension[],
  base: number,
  min: number,
): string | null {
  const home = strengthOf(active, "home", base, min);
  const away = strengthOf(active, "away", base, min);
  return home === base && away === base ? null : `${home}v${away}`;
}

/** FIH progressive escalation (v6/01 §3): persons already carrying a green
 *  card this match — a further offence suggests yellow. */
export function escalationHints(log: readonly CardRecordEntry[]): string[] {
  const greens = new Set<string>();
  for (const entry of log) {
    if (entry.classKey === "green" && entry.person !== undefined) greens.add(entry.person);
  }
  return [...greens].sort();
}
