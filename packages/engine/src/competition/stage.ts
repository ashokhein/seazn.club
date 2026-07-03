// Stage state machines — spec 05 §1 (six kinds), §3 (rank locks), §5 (division
// events, withdrawal policies). A stage moves draft → open → complete; this
// module owns the completion predicate per kind, the ranking of a completed
// stage into `finalRanks`, and the division-event ledger those transitions
// emit. Fixture GENERATION is PROMPT-09 — a stage here consumes an
// already-generated fixture set (its status + results) and never builds one.
import type { EntrantId, StageKind } from "../core/types.ts";
import { foldResults, type FixtureResult } from "./standings.ts";
import type { PoolTable, StageTables } from "./qualification.ts";
import type { TiebreakerKey } from "../sport/module.ts";
import { buildSwissTable, rankStandings } from "./tiebreakers.ts";

// spec 02 §6 fixture statuses that matter to a stage's completion/ranking.
export type FixtureStatus = "scheduled" | "in_play" | "decided" | "void" | "walkover";

const SETTLED: ReadonlySet<FixtureStatus> = new Set(["decided", "void", "walkover"]);
const COUNTS_FOR_STANDINGS: ReadonlySet<FixtureStatus> = new Set(["decided", "walkover"]);

// A league/group/swiss fixture as the stage sees it: a status and, once
// decided, the sport module's [home, away] delta pair (void fixtures carry no
// result and never reach the standings fold).
export interface TableFixture {
  id: string;
  poolId?: string;
  roundNo?: number;
  status: FixtureStatus;
  result?: FixtureResult;
}

// A bracket fixture (knockout / double_elim / stepladder). `round` is 0-based
// and monotonic (higher = later); the deciding game carries `isFinal`.
export interface BracketFixture {
  id: string;
  bracket?: "WB" | "LB" | "GF"; // double-elim lanes; omit for single bracket
  round: number;
  isFinal?: boolean; // SE final / DE grand final (or bracket-reset game)
  thirdPlace?: boolean;
  status: FixtureStatus;
  home?: EntrantId;
  away?: EntrantId;
  winner?: EntrantId; // set once decided/walkover
  loser?: EntrantId;
}

// Everything the ranking pass needs about a table stage that isn't in the
// fixtures themselves (spec 05 §4 cascade is data).
export interface TableStage {
  id: string;
  kind: Extract<StageKind, "league" | "group" | "swiss">;
  entrants: readonly EntrantId[];
  cascade: readonly TiebreakerKey[];
  h2hRecursive?: boolean;
  swiss?: boolean; // assemble the Swiss ledger for buchholz/sberger/direct
  seeds?: ReadonlyMap<EntrantId, number>;
  rngSeed?: number;
  rounds?: number; // swiss: N rounds to play
}

export interface BracketStage {
  id: string;
  kind: Extract<StageKind, "knockout" | "double_elim" | "stepladder">;
  seeds?: ReadonlyMap<EntrantId, number>;
}

// spec 05 §5 — the structural ledger. (fixtures_generated / fixture_replaced
// belong to generation, PROMPT-09.)
export type DivisionEvent =
  | { type: "stage_opened"; stageId: string }
  | { type: "stage_completed"; stageId: string; finalRanks: EntrantId[] }
  | { type: "rank_lock_required"; stageId: string; group: EntrantId[] }
  | { type: "rank_lock"; stageId: string; method: "lots"; group: EntrantId[] }
  | {
      type: "entrant_withdrawn";
      stageId: string;
      entrantId: EntrantId;
      policy: "void_remaining" | "bracket_walkover";
      mode?: "expunge" | "award";
    };

// spec 05 §5 — a stage's instruction to re-status fixtures after a withdrawal
// (the sport-agnostic stage can't mint an award delta; the adapter turns
// `walkoverTo` into an `award` outcome via the sport module).
export interface FixtureUpdate {
  fixtureId: string;
  status: Extract<FixtureStatus, "void" | "walkover">;
  walkoverTo?: EntrantId;
}

// ---------------------------------------------------------------------------
// Completion predicates — spec 05 §1
// ---------------------------------------------------------------------------

function poolOf(fixture: TableFixture): string {
  return fixture.poolId ?? "";
}

// league / group: every fixture decided or void (group pools all complete is
// the same condition — pools only partition the fixtures). swiss: the first
// `rounds` rounds all settled.
export function isTableStageComplete(stage: TableStage, fixtures: readonly TableFixture[]): boolean {
  if (fixtures.length === 0) return false;
  if (stage.kind === "swiss") {
    const rounds = stage.rounds ?? 0;
    if (rounds <= 0) return false;
    for (let round = 1; round <= rounds; round++) {
      const inRound = fixtures.filter((fixture) => fixture.roundNo === round);
      if (inRound.length === 0 || !inRound.every((fixture) => SETTLED.has(fixture.status))) {
        return false;
      }
    }
    return true;
  }
  return fixtures.every((fixture) => SETTLED.has(fixture.status));
}

// knockout / stepladder: the final is decided. double_elim: the grand final
// (the last `isFinal` game — a bracket reset adds a second) is decided.
export function isBracketStageComplete(
  _stage: BracketStage,
  fixtures: readonly BracketFixture[],
): boolean {
  const finals = fixtures.filter((fixture) => fixture.isFinal === true);
  if (finals.length === 0) return false;
  return finals.every((fixture) => SETTLED.has(fixture.status));
}

// ---------------------------------------------------------------------------
// Opening
// ---------------------------------------------------------------------------

export function openStage(stageId: string): DivisionEvent[] {
  return [{ type: "stage_opened", stageId }];
}

// ---------------------------------------------------------------------------
// Completing a table stage → per-pool ranked tables + division events
// ---------------------------------------------------------------------------

function poolNames(fixtures: readonly TableFixture[]): string[] {
  const names = new Set<string>();
  for (const fixture of fixtures) names.add(poolOf(fixture));
  if (names.size === 0) names.add("");
  return [...names];
}

// Which entrants belong to a pool: those appearing in the pool's fixtures. For
// a single-pool (league) stage every entrant is in the one pool.
function entrantsOfPool(
  pool: string,
  fixtures: readonly TableFixture[],
  allEntrants: readonly EntrantId[],
  single: boolean,
): EntrantId[] {
  if (single) return [...allEntrants];
  const ids = new Set<EntrantId>();
  for (const fixture of fixtures) {
    if (poolOf(fixture) !== pool || fixture.result === undefined) continue;
    ids.add(fixture.result[0].entrantId);
    ids.add(fixture.result[1].entrantId);
  }
  // Include declared entrants that happen to sit in this pool but have no
  // counted result yet (e.g. all their games void) via the allEntrants order.
  return allEntrants.filter((id) => ids.has(id));
}

export interface CompletedTableStage {
  events: DivisionEvent[];
  tables: StageTables;
}

// Fold + rank each pool of a completed table stage. Emits stage_completed
// {finalRanks}, plus rank_lock_required + rank_lock for any tie the cascade
// left to a drawing of lots (spec 05 §3/§4.4). finalRanks interleaves pools by
// rank (all pool winners, then all runners-up, …) — the cross-pool seeding
// order (spec 05 §2.3).
export function completeTableStage(
  stage: TableStage,
  fixtures: readonly TableFixture[],
): CompletedTableStage {
  const pools = poolNames(fixtures);
  const single = pools.length === 1;
  const events: DivisionEvent[] = [];
  const poolTables: PoolTable[] = [];

  for (const pool of pools) {
    const poolFixtures = single ? fixtures : fixtures.filter((fixture) => poolOf(fixture) === pool);
    const entrants = entrantsOfPool(pool, fixtures, stage.entrants, single);
    const results = poolFixtures
      .filter((fixture) => COUNTS_FOR_STANDINGS.has(fixture.status) && fixture.result !== undefined)
      .map((fixture) => fixture.result as FixtureResult);

    const rows = foldResults(entrants, results);
    const ranked = rankStandings(rows, {
      cascade: stage.cascade,
      results,
      h2hRecursive: stage.h2hRecursive === true,
      ...(stage.seeds === undefined ? {} : { seeds: stage.seeds }),
      ...(stage.rngSeed === undefined ? {} : { rngSeed: stage.rngSeed }),
      ...(stage.swiss === true ? { swiss: buildSwissTable(entrants, results) } : {}),
    });

    for (const group of ranked.lotsGroups) {
      events.push({ type: "rank_lock_required", stageId: stage.id, group });
      events.push({ type: "rank_lock", stageId: stage.id, method: "lots", group });
    }
    poolTables.push({ pool, rows: ranked.rows, results });
  }

  const finalRanks = crossPoolOrder(poolTables);
  events.push({ type: "stage_completed", stageId: stage.id, finalRanks });

  const overall = single ? (poolTables[0] as PoolTable).rows : undefined;
  return {
    events,
    tables: { pools: poolTables, ...(overall === undefined ? {} : { overall }) },
  };
}

// Interleave pools by rank: rank-1 of every pool (in pool order), then rank-2,
// … — the group→knockout seeding template (spec 05 §2.3).
function crossPoolOrder(pools: readonly PoolTable[]): EntrantId[] {
  const maxRank = Math.max(0, ...pools.map((pool) => pool.rows.length));
  const order: EntrantId[] = [];
  for (let rank = 1; rank <= maxRank; rank++) {
    for (const pool of pools) {
      const row = pool.rows.find((entry) => entry.rank === rank);
      if (row !== undefined) order.push(row.entrantId);
    }
  }
  return order;
}

// ---------------------------------------------------------------------------
// Completing a bracket stage → final ranks from bracket position
// ---------------------------------------------------------------------------

export interface CompletedBracketStage {
  events: DivisionEvent[];
  finalRanks: EntrantId[];
}

export function completeBracketStage(
  stage: BracketStage,
  fixtures: readonly BracketFixture[],
): CompletedBracketStage {
  const finalRanks = bracketRanks(stage, fixtures);
  return {
    events: [{ type: "stage_completed", stageId: stage.id, finalRanks }],
    finalRanks,
  };
}

// Rank entrants by bracket position (spec 05 §1 "ranking" column). Champion =
// winner of the last `isFinal` game; runner-up = its loser; everyone else is
// ordered by how late they were eliminated (later round = better), then by
// seed. An optional 3rd-place playoff fixes ranks 3 and 4 from its result.
export function bracketRanks(
  stage: BracketStage,
  fixtures: readonly BracketFixture[],
): EntrantId[] {
  const entrants = new Set<EntrantId>();
  for (const fixture of fixtures) {
    for (const id of [fixture.home, fixture.away, fixture.winner, fixture.loser]) {
      if (id !== undefined) entrants.add(id);
    }
  }

  // The deciding game: the latest-round decided final.
  const decidedFinals = fixtures
    .filter((fixture) => fixture.isFinal === true && SETTLED.has(fixture.status))
    .sort((a, b) => b.round - a.round);
  const grandFinal = decidedFinals[0];

  const lastLossRound = new Map<EntrantId, number>();
  for (const fixture of fixtures) {
    if (!SETTLED.has(fixture.status) || fixture.loser === undefined) continue;
    const prev = lastLossRound.get(fixture.loser) ?? -1;
    if (fixture.round > prev) lastLossRound.set(fixture.loser, fixture.round);
  }

  const seedOf = (id: EntrantId): number => stage.seeds?.get(id) ?? Number.MAX_SAFE_INTEGER;
  const rankRest = (ids: EntrantId[]): EntrantId[] =>
    ids.sort((a, b) => {
      const ra = lastLossRound.get(a) ?? -1;
      const rb = lastLossRound.get(b) ?? -1;
      if (ra !== rb) return rb - ra; // eliminated later ⇒ ranked higher
      const sa = seedOf(a);
      const sb = seedOf(b);
      if (sa !== sb) return sa - sb;
      return a < b ? -1 : a > b ? 1 : 0;
    });

  const order: EntrantId[] = [];
  const placed = new Set<EntrantId>();
  const place = (id: EntrantId | undefined): void => {
    if (id === undefined || placed.has(id)) return;
    order.push(id);
    placed.add(id);
  };

  if (grandFinal !== undefined) {
    place(grandFinal.winner);
    place(grandFinal.loser);
  }

  // 3rd-place playoff overrides the semifinal-loser ordering for ranks 3–4.
  const thirdPlace = fixtures.find(
    (fixture) => fixture.thirdPlace === true && SETTLED.has(fixture.status),
  );
  if (thirdPlace !== undefined) {
    place(thirdPlace.winner);
    place(thirdPlace.loser);
  }

  for (const id of rankRest([...entrants].filter((id) => !placed.has(id)))) place(id);
  return order;
}

// ---------------------------------------------------------------------------
// Withdrawal policies — spec 05 §5
// ---------------------------------------------------------------------------

export interface WithdrawalResult {
  events: DivisionEvent[];
  updates: FixtureUpdate[];
}

function involvesEntrant(fixture: TableFixture, entrantId: EntrantId): boolean {
  return (
    fixture.result?.[0].entrantId === entrantId || fixture.result?.[1].entrantId === entrantId
  );
}

// spec 05 §5 — league/group `void_remaining`: if the withdrawing entrant has
// played < 50% of its fixtures, EXPUNGE (void all its games so the standings
// read as if it never entered); otherwise AWARD its remaining fixtures to the
// opponents as forfeits and keep the games already played. `played`/`total`
// are the entrant's decided vs scheduled fixture counts (the caller knows the
// full schedule, including result-less pending fixtures).
export function withdrawTableEntrant(
  stage: TableStage,
  entrantId: EntrantId,
  fixtures: {
    played: readonly TableFixture[]; // decided games this entrant appears in
    pending: readonly { id: string; opponent: EntrantId }[]; // its unplayed games
  },
): WithdrawalResult {
  const playedCount = fixtures.played.filter((fixture) => involvesEntrant(fixture, entrantId)).length;
  const total = playedCount + fixtures.pending.length;
  const fraction = total === 0 ? 0 : playedCount / total;
  const expunge = fraction < 0.5;

  const updates: FixtureUpdate[] = [];
  if (expunge) {
    for (const fixture of fixtures.played) {
      if (involvesEntrant(fixture, entrantId)) updates.push({ fixtureId: fixture.id, status: "void" });
    }
    for (const pending of fixtures.pending) updates.push({ fixtureId: pending.id, status: "void" });
  } else {
    for (const pending of fixtures.pending) {
      updates.push({ fixtureId: pending.id, status: "walkover", walkoverTo: pending.opponent });
    }
  }

  return {
    events: [
      {
        type: "entrant_withdrawn",
        stageId: stage.id,
        entrantId,
        policy: "void_remaining",
        mode: expunge ? "expunge" : "award",
      },
    ],
    updates,
  };
}

// spec 05 §5 — knockout `bracket_walkover`: the withdrawing entrant's remaining
// fixtures are walked over to the opponent, who advances.
export function withdrawBracketEntrant(
  stage: BracketStage,
  entrantId: EntrantId,
  fixtures: readonly BracketFixture[],
): WithdrawalResult {
  const updates: FixtureUpdate[] = [];
  for (const fixture of fixtures) {
    if (SETTLED.has(fixture.status)) continue;
    if (fixture.home !== entrantId && fixture.away !== entrantId) continue;
    const opponent = fixture.home === entrantId ? fixture.away : fixture.home;
    updates.push({
      fixtureId: fixture.id,
      status: "walkover",
      ...(opponent === undefined ? {} : { walkoverTo: opponent }),
    });
  }
  return {
    events: [{ type: "entrant_withdrawn", stageId: stage.id, entrantId, policy: "bracket_walkover" }],
    updates,
  };
}
