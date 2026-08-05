// The legal slot lattice a BUILD searches over (design §Architecture).
//
// This is the whole reason the build solver reaches 200 fixtures where the
// repair solver stalls at 80: the repair encoding gives every fixture an
// integer start and pays O(n²) arithmetic to keep them apart, while this one
// pre-computes the finite set of legal (court, start) pairs and lets the SAT
// core do cardinality reasoning over booleans.
//
// Everything removed here is a constraint the encoder then never has to state.
import { intervalsOverlap, type Assignment, type Blackout, type SlotConfig } from "./calendar.ts";
import { calendarDaysCovering, repairCourts, repairUniverse } from "./repair-domain.ts";
import { REPAIR_GRID_MINUTES } from "./repair.ts";

const MS_PER_MIN = 60_000;

/** The lattice size past which the boolean model stops being the right tool.
 *  A season-length window over four courts at a five-minute step is >100k
 *  slots; the encoder would spend the whole budget building clauses it never
 *  gets to solve. Over the cap, `build.ts` goes straight to LNS. */
export const MAX_SLOTS = 20_000;

export interface BuildSlot {
  court: string;
  startAt: number;
}

export interface BuildGrid {
  /** Sorted by (court, startAt) — the order is part of the determinism
   *  contract, because slot INDEX is what the encoder names its variables by. */
  slots: readonly BuildSlot[];
  byCourt: ReadonlyMap<string, readonly number[]>;
  stepMinutes: number;
  /** True when the lattice would exceed `MAX_SLOTS`. `slots` is then empty:
   *  a truncated lattice is worse than none, because the encoder cannot tell a
   *  missing slot from an illegal one and would report a spurious infeasible. */
  overCap: boolean;
}

export interface BuildGridInput {
  config: SlotConfig & { courts: string[] };
  existing?: readonly Assignment[];
  /** Locked cards' exact placements. Admitted even when off-grid, so `k = 0`
   *  is representable and a pinned card never forces an infeasible. */
  pinned?: readonly BuildSlot[];
}

/**
 * The lattice step, in minutes.
 *
 * The gcd of match and gap length is the coarsest step that can still express
 * every back-to-back placement: on one court a match starts at a multiple of
 * `matchMinutes + gapMinutes`, and around a blackout or an existing booking it
 * starts at that edge, which is a multiple of neither alone. `gapMinutes: 0` is
 * legal and makes the gcd the match length, which is exactly right for a
 * back-to-back court rather than a degenerate case.
 *
 * Floored at `REPAIR_GRID_MINUTES` so the two solvers agree about what
 * "on-grid" means, and so a five-minute sport cannot explode the lattice.
 */
export function gridStepMinutes(config: Pick<SlotConfig, "matchMinutes" | "gapMinutes">): number {
  const g = gcd(Math.max(1, Math.round(config.matchMinutes)), Math.max(0, Math.round(config.gapMinutes)));
  return Math.max(REPAIR_GRID_MINUTES, g);
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

export function buildGrid(input: BuildGridInput): BuildGrid {
  const { config } = input;
  const existing = input.existing ?? [];
  const pinned = input.pinned ?? [];
  const stepMinutes = gridStepMinutes(config);
  const stepMs = stepMinutes * MS_PER_MIN;
  const durMs = config.matchMinutes * MS_PER_MIN;
  const gapMs = config.gapMinutes * MS_PER_MIN;

  const courts = repairCourts({ proposal: [], existing, config });
  const universe = repairUniverse({ proposal: [], existing, config });

  // Day anchors. Stepping from `universe.from` alone stays aligned in UTC and
  // DRIFTS in wall clock across a DST boundary — a 10:00 lattice becomes an
  // 09:00 one. Anchoring each day at its own local midnight is what keeps a
  // start on a whole local hour on both sides of the transition.
  //
  // With no `tz` there is no local midnight to anchor to, so the whole universe
  // is one bucket. That matches the verifier, which SKIPS day-shaped rules
  // rather than bucketing them in UTC.
  const buckets =
    config.tz !== undefined
      ? calendarDaysCovering(universe, config.tz)
      : [{ ymd: "", from: universe.from, to: universe.to }];

  const sessions = config.sessionWindows ?? [];
  const blackouts: readonly Blackout[] = config.blackouts ?? [];

  const slots: BuildSlot[] = [];
  const seen = new Set<string>();
  let overCap = false;

  const admits = (court: string, start: number): boolean => {
    const end = start + durMs;
    if (sessions.length > 0 && !sessions.some((w) => start >= w.from && end <= w.to)) return false;
    for (const b of blackouts) {
      if (b.court !== undefined && b.court !== court) continue;
      if (intervalsOverlap(start, end, b.from, b.to)) return false;
    }
    for (const a of existing) {
      if (a.court !== court) continue;
      // The same half-open, gap-padded test `slotFixtures` uses, so the
      // lattice and the placer agree about what "free court time" is.
      if (intervalsOverlap(start, end + gapMs, a.startAt, a.endAt + gapMs)) return false;
    }
    return true;
  };

  outer: for (const court of courts) {
    for (const bucket of buckets) {
      const lo = Math.max(bucket.from, universe.from);
      // A bucket bounds the START, never the OCCUPANCY.
      //
      // Anchoring the step at each bucket's own local midnight is what keeps
      // the lattice on the wall clock across a DST boundary, so the day must
      // gate which starts belong to it. But a match that starts before midnight
      // and runs past it is perfectly legal, and ending the loop at `bucket.to`
      // deletes it from the lattice outright — the next bucket cannot recover
      // it, because that bucket opens AT midnight. Occupancy is therefore bound
      // by the universe, the only real limit on where a match may end.
      //
      // `buildDomains` in repair-domain.ts draws the same line: its position
      // domain is continuous across the whole universe, and day buckets there
      // restrict day-SCOPED rules only, never raw start admissibility.
      for (let start = lo; start < bucket.to && start + durMs <= universe.to; start += stepMs) {
        if (!admits(court, start)) continue;
        if (slots.length >= MAX_SLOTS) {
          overCap = true;
          break outer;
        }
        slots.push({ court, startAt: start });
        seen.add(`${court}|${start}`);
      }
    }
  }

  if (overCap) {
    return { slots: [], byCourt: new Map(), stepMinutes, overCap: true };
  }

  // Pinned placements are admitted UNCONDITIONALLY — a locked card's own slot
  // must exist even when it is off-grid, outside the session windows, or inside
  // a blackout the organiser added afterwards. Refusing it would report the
  // board infeasible for a card nobody asked to move.
  for (const p of pinned) {
    const key = `${p.court}|${p.startAt}`;
    if (seen.has(key)) continue;
    seen.add(key);
    slots.push({ court: p.court, startAt: p.startAt });
  }

  slots.sort((a, b) => (a.court === b.court ? a.startAt - b.startAt : a.court < b.court ? -1 : 1));

  const byCourt = new Map<string, number[]>();
  slots.forEach((s, i) => {
    const rows = byCourt.get(s.court);
    if (rows === undefined) byCourt.set(s.court, [i]);
    else rows.push(i);
  });

  return { slots, byCourt, stepMinutes, overCap: false };
}
