// Timed-suspension track — v6/00 §3 + v6/01 §2/§3. Class tables (IIHF
// penalty minutes, FIH cards), the active-suspension ledger and the derived
// facts: team strength while suspensions run, PIM tallies, FIH progressive-
// escalation hints.
//
// W4a (#425) refines the old "the engine has NO clock" statement into the split
// the wave established: the engine models DURATIONS and ELAPSED-AT-EVENT, the
// pad owns the TICKING. A suspension still starts and ends by scorer events —
// nothing here reads wall time — but where the start carries a game-time stamp
// the fold can now derive when it ends and release it lazily, at the next
// stamped event (kernel.ts). Where no stamp was recorded, everything below
// behaves exactly as it did: the release is an explicit event, and nothing
// expires.

import type { GameTime } from "../../core/time.ts";

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
  /**
   * W4a (#425) §3.4 — a goal by the opposition ends this suspension early
   * (IIHF Rule 20.4: a minor terminates when the non-offending team scores).
   * IIHF minors and bench minors set it; majors, misconducts and match
   * penalties do not, and no FIH card does — field hockey has no
   * powerplay-goal release at all.
   *
   * The release is gated a second time in the fold, on BOTH the goal and the
   * suspension carrying a stamp. That gate — not this flag — is what keeps the
   * eleven frozen goldens byte-identical: no recorded stream carries `at`, so
   * setting the flag here cannot change how any recorded goal folds.
   */
  releaseOnGoal?: boolean;
}

export type SuspensionClasses = Record<string, SuspensionClass>;

export interface SuspensionCfg {
  classes: SuspensionClasses;
}

// v6/01 §2 — IIHF Rules 16–28. Match penalty: player off for good but the
// team is short for 5' (released by event like a major); modelled as a
// releasable 5' team-short class carrying 25 PIM.
export const ICEHOCKEY_SUSPENSIONS: SuspensionClasses = {
  minor: { minutes: 2, teamShort: true, releaseOnGoal: true },
  bench_minor: { minutes: 2, teamShort: true, releaseOnGoal: true },
  // NOT releaseOnGoal, deliberately. A double minor's FIRST half terminates on
  // a goal and the second then starts running — that is two suspensions, not
  // one shortened by half, and modelling it as a single releasable 4' class
  // would wipe the remaining 2:00 the offender still owes. Splitting it needs
  // its own state and is recorded as a deferred dossier row.
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

// W4 (#407) — the scoresheet detail an IIHF penalty row / FIH card row carries
// beyond "who and what colour". All three are optional and only ever present
// when the scorer recorded them, so a coarse card folds to exactly the shape it
// did before (the golden corpus pins that).
export interface SuspensionDetail {
  /** The infraction as the official called it — IIHF code or plain text
   *  ("tripping", "dangerous play"). Never adjudicated, only recorded. */
  reason?: string;
  /** The player who SITS when he is not the player penalised: a bench minor,
   *  a goalkeeper's penalty, a coach's card (IIHF Rule 33 / FIH Rule 14). */
  servedBy?: string;
  /** The duration the official actually awarded, when it differs from the
   *  class nominal (an FIH yellow is a MINIMUM of 5 minutes — the umpire may
   *  give 10). Pads count down from here in preference to the class. */
  minutes?: number;
}

export interface ActiveSuspension extends SuspensionDetail {
  side: SuspSide;
  person?: string;
  classKey: string;
  teamShort: boolean;
  permanent: boolean;
  /**
   * W4a (#425) — the game time the suspension started, when the pad recorded
   * one. ABSENT for every suspension recorded before this wave, and its absence
   * is load-bearing: an unstamped suspension neither expires by time nor is
   * eligible for release-on-goal, so it behaves exactly as it always did.
   */
  startedAt?: GameTime;
  /**
   * When it runs out, derived at start from `startedAt` + the AWARDED minutes
   * (`SuspensionDetail.minutes` where the umpire gave one, else the class
   * nominal — an FIH yellow is a MINIMUM of 5 and 10 is common).
   *
   * Absent when there is no `startedAt`, when the class is for the rest of the
   * match (`minutes: null`), or when the start was stamped in a phase where no
   * play clock runs ("pre", "SHOOTOUT") — penalty time only runs while play
   * runs, so a pre-game card is served from the opening whistle and expires by
   * event, not by arithmetic against a clock that was not on.
   *
   * The fold sweeps against this LAZILY, at the next stamped event and at each
   * phase whistle. Between an expiry and the next event the pad and the fold
   * legitimately disagree — the pad is counting down, the fold is a record of
   * facts (§3.1).
   */
  expiresAt?: GameTime;
}

export interface CardRecordEntry extends SuspensionDetail {
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
