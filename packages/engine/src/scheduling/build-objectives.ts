// The three numbers that decide whether one board is better than another, and
// the lexicographic comparison over them (design D3: compact > fairness >
// balance, with placed-count above all three).
//
// PURE on purpose. No config, no rules, no z3. Four callers read these — the
// solver's tier bounds, the API response, the board's result strip, and the
// tests that assert the solver never returns a board worse than greedy — and a
// metric computed inside the solver would be one no test could reproduce.
import type { Assignment } from "./calendar.ts";

const MS_PER_MIN = 60_000;

export interface BoardMetrics {
  /** Earliest start to latest end, in minutes. 0 for an empty board. */
  makespanMinutes: number;
  /** The largest gap any single participant waits between two of its matches.
   *  Measured over entrants AND people: a human umpiring two divisions waits
   *  just as long as a team does, and `people` is what carries them. */
  worstIdleGapMinutes: number;
  /** Busiest court's minutes minus the quietest's, over the configured courts
   *  plus any court the board actually uses. A configured court nobody plays on
   *  counts as zero, which is the whole point of the metric. */
  courtImbalanceMinutes: number;
  placed: number;
  total: number;
}

export function boardMetrics(
  assignments: readonly Assignment[],
  courts: readonly string[],
  total: number,
): BoardMetrics {
  if (assignments.length === 0) {
    return { makespanMinutes: 0, worstIdleGapMinutes: 0, courtImbalanceMinutes: 0, placed: 0, total };
  }

  let lo = Infinity;
  let hi = -Infinity;
  const byParticipant = new Map<string, Assignment[]>();
  const courtMinutes = new Map<string, number>(courts.map((c) => [c, 0]));

  for (const a of assignments) {
    if (a.startAt < lo) lo = a.startAt;
    if (a.endAt > hi) hi = a.endAt;
    courtMinutes.set(a.court, (courtMinutes.get(a.court) ?? 0) + (a.endAt - a.startAt) / MS_PER_MIN);
    // Namespaced so an entrant id can never collide with a person id — the
    // identity-seam defect shape this repo has hit eight times.
    for (const e of a.entrants) push(byParticipant, `e:${e}`, a);
    for (const p of a.people) push(byParticipant, `p:${p}`, a);
  }

  let worstIdleGapMinutes = 0;
  for (const rows of byParticipant.values()) {
    if (rows.length < 2) continue;
    const sorted = [...rows].sort((x, y) => x.startAt - y.startAt);
    for (let i = 1; i < sorted.length; i++) {
      const gap = (sorted[i]!.startAt - sorted[i - 1]!.endAt) / MS_PER_MIN;
      if (gap > worstIdleGapMinutes) worstIdleGapMinutes = gap;
    }
  }

  const mins = [...courtMinutes.values()];
  return {
    makespanMinutes: (hi - lo) / MS_PER_MIN,
    worstIdleGapMinutes,
    courtImbalanceMinutes: Math.max(...mins) - Math.min(...mins),
    placed: assignments.length,
    total,
  };
}

function push(map: Map<string, Assignment[]>, key: string, a: Assignment): void {
  const rows = map.get(key);
  if (rows === undefined) map.set(key, [a]);
  else rows.push(a);
}

/** Design D3's ordering, as one comparison. Lexicographic rather than weighted
 *  so a reviewer and an organiser can both say WHY one board won. */
export function isStrictlyBetter(a: BoardMetrics, b: BoardMetrics): boolean {
  if (a.placed !== b.placed) return a.placed > b.placed;
  if (a.makespanMinutes !== b.makespanMinutes) return a.makespanMinutes < b.makespanMinutes;
  if (a.worstIdleGapMinutes !== b.worstIdleGapMinutes) return a.worstIdleGapMinutes < b.worstIdleGapMinutes;
  return a.courtImbalanceMinutes < b.courtImbalanceMinutes;
}
