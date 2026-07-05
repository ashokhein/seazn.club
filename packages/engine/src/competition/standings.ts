// Standings fold — spec 02 §7 + spec 05 §4. A standings table is a derived fold
// over decided fixtures: the sport module contributes a [home, away] pair of
// StandingsDeltas per outcome (spec 03 §3), the competition engine sums them
// into StandingsRows, then ranks via the tiebreaker cascade (tiebreakers.ts).
//
// The fold is deterministic and ORDER-INDEPENDENT: addition is commutative, so
// shuffling the decided-fixture set yields byte-identical rows (property test in
// standings.test.ts, spec 05 §6). Ranking is a separate pass — this file never
// sorts.
import type { EntrantId, StandingsDelta } from "../core/types.ts";

// spec 02 §7 — the folded row. `metrics` is the sport's ledger (gf/ga/gd ·
// runs_for/balls_faced_eff · sets_won/sets_lost · …); ratio tiebreaks read the
// integer ledger and cross-multiply, never divide (spec 05 §4.3). `rank` /
// `rankLocked` are filled by the ranking pass, not the fold.
export interface StandingsRow {
  entrantId: EntrantId;
  played: number;
  won: number;
  drawn: number;
  lost: number;
  points: number;
  metrics: Record<string, number>;
  rank?: number;
  rankLocked?: boolean;
  // Which cascade rule separated this row from the entrants it was tied with
  // (spec 05 §4, doc 09 §2 tie-explanation popover). Written by the ranking
  // pass for every row that needed a tiebreaker beyond the cascade's primary
  // key; the finest rule that applied wins. Rides into standings_snapshots.
  tieBreak?: { key: string; with: EntrantId[] };
}

// The two deltas a decided fixture contributes, in [home, away] order (the pair
// a SportModule.standingsDelta returns). The pair also names both entrants of
// the fixture, which is what head-to-head sub-tables need (spec 05 §4.2).
export type FixtureResult = readonly [StandingsDelta, StandingsDelta];

function zeroRow(entrantId: EntrantId): StandingsRow {
  return { entrantId, played: 0, won: 0, drawn: 0, lost: 0, points: 0, metrics: {} };
}

function addDelta(row: StandingsRow, delta: StandingsDelta): void {
  row.played += delta.played;
  row.won += delta.won;
  row.drawn += delta.drawn;
  row.lost += delta.lost;
  row.points += delta.points;
  for (const [key, value] of Object.entries(delta.metrics)) {
    row.metrics[key] = (row.metrics[key] ?? 0) + value;
  }
}

// Folds every delta over the given entrant set into one row per entrant. Rows
// come back in `entrants` order (deterministic); a delta for an entrant not in
// the set is a bug (mismatched pool/fixture wiring) and throws rather than
// silently inventing a row — that would make the fold order-dependent.
export function foldStandings(
  entrants: readonly EntrantId[],
  deltas: Iterable<StandingsDelta>,
): StandingsRow[] {
  const byEntrant = new Map<EntrantId, StandingsRow>();
  const order: EntrantId[] = [];
  for (const id of entrants) {
    if (!byEntrant.has(id)) {
      byEntrant.set(id, zeroRow(id));
      order.push(id);
    }
  }
  for (const delta of deltas) {
    const row = byEntrant.get(delta.entrantId);
    if (row === undefined) {
      throw new Error(`standings delta references entrant "${delta.entrantId}" not in the pool`);
    }
    addDelta(row, delta);
  }
  return order.map((id) => byEntrant.get(id) as StandingsRow);
}

// Convenience: fold a set of fixture results (delta pairs) rather than a flat
// delta stream. Equivalent to foldStandings over the flattened deltas.
export function foldResults(
  entrants: readonly EntrantId[],
  results: Iterable<FixtureResult>,
): StandingsRow[] {
  return foldStandings(entrants, flattenResults(results));
}

// Flattens delta pairs into a single delta stream (home, away, home, away, …).
export function flattenResults(results: Iterable<FixtureResult>): StandingsDelta[] {
  const out: StandingsDelta[] = [];
  for (const [home, away] of results) {
    out.push(home, away);
  }
  return out;
}

// The subset of results contested entirely within `group` — the mini-table
// source for head-to-head refinement (spec 05 §4.2 step 1).
export function resultsAmong(
  group: ReadonlySet<EntrantId>,
  results: readonly FixtureResult[],
): FixtureResult[] {
  return results.filter(
    ([home, away]) => group.has(home.entrantId) && group.has(away.entrantId),
  );
}
