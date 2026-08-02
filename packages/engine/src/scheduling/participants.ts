/**
 * Who could stand in a fixture — including the advancers behind a null slot.
 *
 * A TBD slot is not empty: whoever advances is a participant, and before
 * results exist the schedule must be safe for every possible outcome. Deriving
 * `people` from named entrants alone makes every person rule silently pass on
 * exactly the fixtures where a clash is most likely (10 of 13 in the badminton
 * double-elimination payload).
 *
 * Pure by contract: no DB, no provider, no wall clock. W6's repair solver
 * imports this module and must agree with the verifier on what a rule means.
 */

/** Minimal fixture shape the recursion needs. `PackFixture` satisfies it. */
export interface ParticipantFixture {
  id: string;
  ext_key?: string | null;
  home: string | null;
  away: string | null;
  feeds: { after: readonly string[] };
}

export interface StripByesResult<F> {
  fixtures: F[];
  assumptions: string[];
}

/**
 * Drop `feeds.after` ids that are not in the movable set: a bye, or a round
 * that has already finished. Recorded as an assumption rather than dropped
 * silently — `validateAssignments` tolerates a dangling dep today by accident
 * (it skips a dep whose source is not on the board), but the missing rest
 * constraint is invisible and W6's solver would deadlock on one.
 *
 * Assumption strings name `ext_key` when there is one, else the full id. Never
 * a sliced id — the pack's determinism test redacts whole UUIDs only.
 */
export function stripByes<F extends ParticipantFixture>(fixtures: readonly F[]): StripByesResult<F> {
  const present = new Set(fixtures.map((f) => f.id));
  const assumptions: string[] = [];
  const label = (f: F): string => f.ext_key ?? f.id;
  const out = fixtures.map((f) => {
    const kept = f.feeds.after.filter((id) => present.has(id));
    if (kept.length === f.feeds.after.length) return f;
    for (const id of f.feeds.after) {
      if (!present.has(id)) {
        assumptions.push(
          `feeder ${id} of ${label(f)} is not in the movable set — treated as completed (bye or finished round)`,
        );
      }
    }
    return { ...f, feeds: { ...f.feeds, after: kept } };
  });
  return { fixtures: out, assumptions: assumptions.sort() };
}

export interface ParticipantsOptions {
  /**
   * Stable sort key for a person id. Defaults to the id itself, which is fine
   * for synthetic keys but NOT for UUIDs: the pack builder passes
   * `${full_name}|${id}` so array order survives a reseed of the same board.
   */
  sortKey?: (personId: string) => string;
}

/**
 * participants(f) = persons of named home/away entrants
 *                 ∪ (if a slot is null) participants of every fixture in feeds.after
 *
 * Set-valued: an entrant is a team, so `personsByEntrant` maps one entrant to
 * many person ids and every roster member is kept. Memoised and cycle-guarded.
 */
export function computeParticipants<F extends ParticipantFixture>(
  fixtures: readonly F[],
  personsByEntrant: ReadonlyMap<string, readonly string[]>,
  opts: ParticipantsOptions = {},
): Record<string, string[]> {
  const byId = new Map(fixtures.map((f) => [f.id, f]));
  const memo = new Map<string, Set<string>>();
  const key = opts.sortKey ?? ((p: string) => p);

  const walk = (id: string, path: Set<string>): Set<string> => {
    const hit = memo.get(id);
    if (hit) return hit;
    if (path.has(id)) return new Set(); // cycle guard — feedgraph.ts flags cycles
    const f = byId.get(id);
    if (!f) return new Set();
    path.add(id);
    const out = new Set<string>();
    for (const side of [f.home, f.away]) {
      if (side !== null) for (const p of personsByEntrant.get(side) ?? []) out.add(p);
    }
    if (f.home === null || f.away === null) {
      for (const dep of f.feeds.after) for (const p of walk(dep, path)) out.add(p);
    }
    path.delete(id);
    memo.set(id, out);
    return out;
  };

  const result: Record<string, string[]> = {};
  for (const f of fixtures) {
    result[f.id] = [...walk(f.id, new Set())].sort((a, b) => {
      const ka = key(a);
      const kb = key(b);
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
  }
  return result;
}
