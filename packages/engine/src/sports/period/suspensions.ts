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
  /**
   * W4a (#425) — the same two stamps the active entry carries, kept here
   * because the card log is the immutable scoresheet row and both times are
   * printed on it.
   *
   * They are also the only record left once the fold sweeps the suspension out
   * of `state.suspensions`, which is what lets a LATER explicit release be
   * reconciled against it rather than refused (kernel `alreadyRunOut`). Absent
   * for every unstamped card, so a pre-wave card log is byte-identical.
   */
  startedAt?: GameTime;
  expiresAt?: GameTime;
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
  return Math.max(min, base - shortCount(active, side));
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

/** Running team-short suspensions on one side. */
function shortCount(active: readonly ActiveSuspension[], side: SuspSide): number {
  return active.filter((s) => s.side === side && s.teamShort).length;
}

/**
 * Overtime strength, NHL Rule 84.4 / IIHF Rule 84 — a DIFFERENT algorithm, not
 * a different base.
 *
 * In 3-on-3 overtime the penalised team is never reduced below the overtime
 * complement; the NON-offending team gains a skater instead. So strength is
 * SIDE-RELATIVE:
 *
 *     strength(X) = skaters + max(0, short(opponent) − short(X))
 *
 * The `max(0, …)` is what makes coincidental penalties cancel — one each is
 * played 3-on-3, not 4-on-4, which is where a flat "gain one per opponent
 * penalty" reading goes wrong. Two against one is likewise 4-on-3, not 5-on-4.
 *
 * Why NOT a base swap, since that is the obvious move and it is destructive:
 * ice hockey declares `strength {base: 5, min: 3}` against `overtime.skaters:
 * 3`, and `strengthOf` floors at `min`, so swapping the base makes base === min,
 * both sides sit at base for any number of penalties, `strengthChip` returns
 * null and the power-play chip DISAPPEARS in overtime — strictly less than the
 * `5v4` it printed before. Field hockey's `fih-detail` config collides
 * identically (`skaters: 7` against `min: 7`).
 *
 * CAPPED AT FULL STRENGTH. Rule 84.4 never puts more than five skaters against
 * three: a third penalty against the same side is served consecutively rather
 * than stacking a further on-ice advantage, so the beneficiary stops gaining at
 * `base`. Without the cap the engine renders `6v3`, a strength no rulebook
 * allows.
 *
 * The cap is `base` and the floor on the offending side is `skaters`, and the
 * two come from OPPOSITE ENDS of the same cfg pair — `strength.base` is full
 * strength, `overtime.skaters` is the overtime complement. Neither is
 * simplifiable into the other: the offender is pinned at `skaters` by
 * construction (its `max(0, …)` term is zero), the beneficiary is bounded by
 * `base`, and `strength.min` plays no part here at all because nobody is ever
 * reduced. Do not collapse them.
 */
export function overtimeStrengthOf(
  active: readonly ActiveSuspension[],
  side: SuspSide,
  skaters: number,
  base: number,
): number {
  const opponent: SuspSide = side === "home" ? "away" : "home";
  const gain = Math.max(0, shortCount(active, opponent) - shortCount(active, side));
  return Math.min(base, skaters + gain);
}

/**
 * The overtime counterpart of `strengthChip`.
 *
 * Null when NO team-short suspension is running, which is the same claim
 * `strengthChip` makes with "both sides are at base" — but it cannot be said
 * that way here, because two coincidental penalties leave both sides at
 * `skaters` while the scoresheet is very much not at even strength. Hiding that
 * would drop information regulation shows (coincidental minors print `4v4`).
 */
export function overtimeStrengthChip(
  active: readonly ActiveSuspension[],
  skaters: number,
  base: number,
): string | null {
  if (!active.some((s) => s.teamShort)) return null;
  const home = overtimeStrengthOf(active, "home", skaters, base);
  const away = overtimeStrengthOf(active, "away", skaters, base);
  return `${home}v${away}`;
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
