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
 *
 * ORDER: the returned list is sorted on the OWNING fixture's stable label, with
 * `feeds.after` order preserved for ties inside one fixture. It must NOT be
 * sorted on the strings themselves: in production `feeds.after` holds fixture
 * UUIDs (`schedule-ai.ts` fills it from `feedDependencies`), so a text sort
 * orders on a per-seed random value and breaks the pack's double-seed
 * determinism test. The UUID stays whole inside the message body — `redact()`
 * matches whole UUIDs only, so a slice would break the same test.
 */
export function stripByes<F extends ParticipantFixture>(fixtures: readonly F[]): StripByesResult<F> {
  const present = new Set(fixtures.map((f) => f.id));
  const label = (f: F): string => f.ext_key ?? f.id;
  const found: { key: string; seq: number; text: string }[] = [];
  const out = fixtures.map((f) => {
    const kept = f.feeds.after.filter((id) => present.has(id));
    if (kept.length === f.feeds.after.length) return f;
    for (const id of f.feeds.after) {
      if (!present.has(id)) {
        found.push({
          key: label(f),
          seq: found.length,
          text: `feeder ${id} of ${label(f)} is not in the movable set — treated as completed (bye or finished round)`,
        });
      }
    }
    return { ...f, feeds: { ...f.feeds, after: kept } };
  });
  const assumptions = found
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.seq - b.seq))
    .map((a) => a.text);
  return { fixtures: out, assumptions };
}

export interface ParticipantsOptions {
  /**
   * Stable sort key for a person id.
   *
   * ANY CALLER WHOSE PERSON IDS ARE UUIDs MUST PASS THIS. It is optional only
   * because callers with synthetic keys (tests, fixtures built from names) are
   * legitimate. It defaults to the person id itself, so omitting it on real
   * data sorts every list on a per-seed random value: `redact()` maps UUIDs to
   * first-seen placeholders, so two runs over the same board emit different
   * arrays and the pack's double-seed determinism test fails. The pack builder
   * passes `${full_name}|${id}` — a stable domain key, with the id only as a
   * tiebreak between two people of the same name.
   */
  sortKey?: (personId: string) => string;
}

/**
 * participants(f) = persons of named home/away entrants
 *                 ∪ (if a slot is null) participants of every fixture in feeds.after
 *
 * Set-valued: an entrant is a team, so `personsByEntrant` maps one entrant to
 * many person ids and every roster member is kept. Memoised and cycle-guarded.
 *
 * Pass `opts.sortKey` whenever the person ids are UUIDs — see
 * {@link ParticipantsOptions.sortKey}. Omitting it orders every list on a raw
 * UUID, which is not stable across runs.
 */
export function computeParticipants<F extends ParticipantFixture>(
  fixtures: readonly F[],
  personsByEntrant: ReadonlyMap<string, readonly string[]>,
  opts: ParticipantsOptions = {},
): Record<string, string[]> {
  const byId = new Map(fixtures.map((f) => [f.id, f]));
  const memo = new Map<string, Set<string>>();
  const key = opts.sortKey ?? ((p: string) => p);

  /**
   * `tainted` = this node's set was truncated by the cycle guard, somewhere in
   * its subtree. Such a set is only correct relative to where the walk started,
   * so it must never reach `memo`: caching it makes the answer depend on the
   * order of the `fixtures` array, and a person rule scoped to the node behind
   * the cut then silently passes — the exact failure this module exists to stop.
   *
   * The guard is load-bearing, not belt-and-braces: NOTHING upstream rejects a
   * fixture-level cycle. `validateFeedGraph` (feedgraph.ts) is the only cycle
   * check in the codebase and it validates edges between STAGES — `stages.ts`
   * calls it with stage seqs — never fixture `feeds.after`. A cyclic board
   * reaches us intact, so this must terminate on one and answer consistently.
   */
  const walk = (id: string, path: Set<string>): { people: Set<string>; tainted: boolean } => {
    const hit = memo.get(id);
    if (hit) return { people: hit, tainted: false };
    if (path.has(id)) return { people: new Set(), tainted: true }; // cycle guard
    const f = byId.get(id);
    if (!f) return { people: new Set(), tainted: false };
    path.add(id);
    const out = new Set<string>();
    let tainted = false;
    // `!= null` not `!== null`: a fixture may arrive with the key absent rather
    // than null, and `undefined` must read as an unfilled slot on both lines.
    for (const side of [f.home, f.away]) {
      if (side != null) for (const p of personsByEntrant.get(side) ?? []) out.add(p);
    }
    if (f.home == null || f.away == null) {
      for (const dep of f.feeds.after) {
        const sub = walk(dep, path);
        if (sub.tainted) tainted = true;
        for (const p of sub.people) out.add(p);
      }
    }
    path.delete(id);
    if (!tainted) memo.set(id, out);
    return { people: out, tainted };
  };

  const result: Record<string, string[]> = {};
  for (const f of fixtures) {
    result[f.id] = [...walk(f.id, new Set()).people].sort((a, b) => {
      const ka = key(a);
      const kb = key(b);
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
  }
  return result;
}
