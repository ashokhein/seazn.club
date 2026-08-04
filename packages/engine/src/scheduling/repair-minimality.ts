// The minimality CERTIFICATE for a decomposed repair (#401).
//
// A decomposed repair solves one component with the rest of the board frozen, so
// its `k` is an UPPER BOUND by construction: restricting which fixtures may move
// can only raise the number of moves, never lower it. The ascending-k search
// inside one component proves that component minimal against a frozen board and
// nothing more. Reporting that as "minimal" would be a claim the search does not
// support — and minimal movement is a SAFETY property here, not a nicety: a
// repair that moves more cards than it had to has told entrants the wrong time.
//
// So minimality is proved the other way round, by a LOWER bound that meets it.
//
//   Take a set of conflicts on the ORIGINAL board whose fixtures do not overlap.
//   Each one can only be resolved by moving a fixture it names — a court clash
//   between two cards is a function of exactly those two placements, and nothing
//   else on the board changes it. Because the sets are disjoint, no single move
//   can serve two of them. So any repair must move at least one fixture per
//   conflict in the set: `k >= |set|`.
//
// When the found `k` equals that bound it IS the global minimum, decomposition
// or no decomposition, and the certificate says `proved`. When it does not, the
// answer is reported as an upper bound and the caller is told why.
//
// WHICH FIXTURES A CONFLICT NAMES is the one thing this file must not guess. A
// `court` row carries its counterparty in its detail; a `rest` row does not; a
// per-day cap row names one card out of a whole day. Rather than parse strings
// or re-derive the rule, every witness is obtained FROM THE VERIFIER: run
// `validateAssignments` on the fixture alone, then on the fixture plus one
// neighbour, and attribute by `conflictKey`. A conflict no sub-board reproduces
// — the per-day cap, whose detail carries the whole day's total — is left
// UNATTRIBUTED and simply does not enter the bound. That is the safe direction:
// fewer certified conflicts is a weaker lower bound, never a wrong one.
import {
  conflictKey,
  validateAssignments,
  type Assignment,
  type Conflict,
  type ConflictReason,
  type OrderDependency,
  type VerifyConfig,
} from "./calendar.ts";
import { maxSeparationMinutes, sharesParticipant } from "./repair-domain.ts";

const MS_PER_MIN = 60_000;

/** One conflict in the independent set, and the MOVABLE fixtures at least one of
 *  which has to move to resolve it. */
export interface MinimalityWitness {
  fixtureIds: readonly string[];
  reason: ConflictReason;
  detail: string;
}

export interface MinimalityBoundInput {
  proposal: readonly Assignment[];
  existing?: readonly Assignment[];
  dependencies?: readonly OrderDependency[];
  config: VerifyConfig;
  /** The conflicts on the ORIGINAL board — the ones any repair has to resolve.
   *  Pass the blocking subset when the repair relaxed families, since those are
   *  then the only conflicts the answer is required to have resolved. */
  conflicts: readonly Conflict[];
}

export interface MinimalityBound {
  lowerBound: number;
  witnesses: MinimalityWitness[];
  /** Conflicts no sub-board reproduced, so nothing could be proved from them.
   *  Reported rather than hidden: a bound that quietly ignores half the board is
   *  a bound nobody can audit. */
  unattributed: number;
}

/**
 * The largest set of pairwise-disjoint conflicts this can find, greedily.
 *
 * Greedy, not maximum: a maximum independent set is the wrong amount of
 * machinery here, and a smaller set is still a VALID lower bound — it can only
 * make the certificate say `upper_bound` where a stronger search would have said
 * `proved`. Never the other way round.
 *
 * The order is deterministic and degree-aware: single-fixture witnesses first
 * (nothing can displace them), then pairs whose fixtures appear in the fewest
 * other conflicts, then by id. Picking a low-degree conflict first is what keeps
 * one busy card from swallowing two otherwise independent clashes.
 */
export function disjointConflictBound(input: MinimalityBoundInput): MinimalityBound {
  const { config, proposal, conflicts } = input;
  const existing = input.existing ?? [];
  const dependencies = input.dependencies ?? [];
  if (conflicts.length === 0) return { lowerBound: 0, witnesses: [], unattributed: 0 };

  const movable = new Set(proposal.map((a) => a.fixtureId));
  const board = [...proposal, ...existing];
  const byId = new Map(board.map((a) => [a.fixtureId, a]));
  const slackMs = maxSeparationMinutes(config) * MS_PER_MIN;
  let maxDurationMs = 0;
  for (const a of board) maxDurationMs = Math.max(maxDurationMs, a.endAt - a.startAt);

  // Deterministic: sorted by start, ties by id.
  const byTime = [...board].sort(
    (a, b) => a.startAt - b.startAt || (a.fixtureId < b.fixtureId ? -1 : 1),
  );
  const positionOf = new Map(byTime.map((a, i) => [a.fixtureId, i]));

  const depsByFixture = new Map<string, OrderDependency[]>();
  const addDep = (id: string, dep: OrderDependency): void => {
    const list = depsByFixture.get(id);
    if (list === undefined) depsByFixture.set(id, [dep]);
    else list.push(dep);
  };
  for (const dep of dependencies) {
    addDep(dep.fixtureId, dep);
    addDep(dep.dependsOn, dep);
  }

  /** Everything whose placement could possibly enter a conflict row of `a`: the
   *  cards it could share a court or a participant with where they both stand,
   *  plus every fixture it is wired to by an order dependency, however far apart
   *  they sit. The same edge rule the component graph uses, and for the same
   *  reason — a pair that never overlaps can still owe rest. */
  const neighboursOf = (a: Assignment): Assignment[] => {
    const out = new Map<string, Assignment>();
    const p = positionOf.get(a.fixtureId)!;
    for (let i = p - 1; i >= 0; i--) {
      const other = byTime[i]!;
      if (other.startAt <= a.startAt - slackMs - maxDurationMs) break;
      if (other.endAt + slackMs <= a.startAt) continue;
      if (other.court === a.court || sharesParticipant(a, other)) out.set(other.fixtureId, other);
    }
    for (let i = p + 1; i < byTime.length; i++) {
      const other = byTime[i]!;
      if (other.startAt >= a.endAt + slackMs) break;
      if (other.court === a.court || sharesParticipant(a, other)) out.set(other.fixtureId, other);
    }
    for (const dep of depsByFixture.get(a.fixtureId) ?? []) {
      const otherId = dep.fixtureId === a.fixtureId ? dep.dependsOn : dep.fixtureId;
      const other = byId.get(otherId);
      if (other !== undefined && otherId !== a.fixtureId) out.set(otherId, other);
    }
    return [...out.values()].sort((x, y) => (x.fixtureId < y.fixtureId ? -1 : 1));
  };

  const depsBetween = (a: string, b: string): OrderDependency[] =>
    (depsByFixture.get(a) ?? []).filter(
      (d) =>
        (d.fixtureId === a && d.dependsOn === b) || (d.fixtureId === b && d.dependsOn === a),
    );

  // --- attribution ----------------------------------------------------------
  // For every fixture that carries a conflict, ask the VERIFIER which of its
  // conflicts survive on the fixture alone (witness: itself) and which appear
  // only once a given neighbour is on the board (witness: the pair). A witness
  // may collect several neighbours — `rest` rows do not name their counterparty,
  // so one key can stand for two breaches — and a SUPERSET of the true witness
  // is safe: it can only make disjointness harder to satisfy.
  //
  // A SUBSET would not be safe, which is why the self keys are subtracted rather
  // than merged: a conflict the fixture produces ALONE is caused by its own
  // placement and nothing else on the board can clear it, so `{a}` there is
  // exact, not a subset. Only conflicts that need a second card get a second
  // fixture in their witness.
  const witnessByKey = new Map<string, Set<string>>();
  const add = (key: string, ids: readonly string[]): void => {
    const set = witnessByKey.get(key);
    if (set === undefined) witnessByKey.set(key, new Set(ids));
    else for (const id of ids) set.add(id);
  };
  for (const id of [...new Set(conflicts.map((c) => c.fixtureId))].sort()) {
    const a = byId.get(id);
    if (a === undefined || !movable.has(id)) continue;
    const alone = validateAssignments([a], config, [], []);
    const selfKeys = new Set(alone.map(conflictKey));
    for (const key of selfKeys) add(key, [id]);
    for (const other of neighboursOf(a)) {
      const paired = validateAssignments([a], config, [other], depsBetween(id, other.fixtureId));
      for (const c of paired) {
        const key = conflictKey(c);
        if (selfKeys.has(key)) continue;
        add(key, [id, other.fixtureId]);
      }
    }
  }

  // --- the independent set --------------------------------------------------
  type Candidate = { key: string; ids: string[]; reason: ConflictReason; detail: string };
  const candidates = new Map<string, Candidate>();
  let unattributed = 0;
  for (const c of conflicts) {
    const key = conflictKey(c);
    if (candidates.has(key)) continue;
    const witness = witnessByKey.get(key);
    if (witness === undefined) {
      unattributed++;
      continue;
    }
    const ids = [...witness].filter((id) => movable.has(id)).sort();
    // A conflict with no movable fixture in it cannot be repaired by moving
    // anything, so it demands no move and proves no bound.
    if (ids.length === 0) continue;
    candidates.set(key, { key, ids, reason: c.reason, detail: c.detail ?? "" });
  }

  const degree = new Map<string, number>();
  for (const cand of candidates.values()) {
    for (const id of cand.ids) degree.set(id, (degree.get(id) ?? 0) + 1);
  }
  const weight = (cand: Candidate): number =>
    cand.ids.reduce((sum, id) => sum + (degree.get(id) ?? 0), 0);
  const ordered = [...candidates.values()].sort(
    (x, y) =>
      x.ids.length - y.ids.length ||
      weight(x) - weight(y) ||
      (x.key < y.key ? -1 : x.key > y.key ? 1 : 0),
  );

  const used = new Set<string>();
  const witnesses: MinimalityWitness[] = [];
  for (const cand of ordered) {
    if (cand.ids.some((id) => used.has(id))) continue;
    for (const id of cand.ids) used.add(id);
    witnesses.push({ fixtureIds: cand.ids, reason: cand.reason, detail: cand.detail });
  }
  witnesses.sort((x, y) => (x.fixtureIds[0]! < y.fixtureIds[0]! ? -1 : 1));
  return { lowerBound: witnesses.length, witnesses, unattributed };
}
