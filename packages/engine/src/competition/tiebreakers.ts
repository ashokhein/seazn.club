// Swiss / cascade-time tiebreak computations — spec 05 §4 + engine/sports/
// chess.md §4 (PROMPT-07). Buchholz, Buchholz Cut-1 and Sonneborn-Berger depend
// on opponents' *final* scores, so they cannot be folded incrementally into a
// StandingsDelta — they are computed here, at rank time, from a ledger the
// competition engine assembles (opponent list + per-game score/result/colour
// the boardgame module exposes via standingsDelta).
//
// Everything is integer (spec 04 §9.4, PROMPT-07 acceptance — no floats):
// scores are HALF-POINTS (1 = 2, ½ = 1, 0 = 0). Buchholz keeps half-points;
// Sonneborn-Berger is returned in QUARTER-points (÷4 for the conventional
// value) because ½·(opponent score) is a quarter-point. Use pointsToText for
// display.
//
// The comparator *registry* (TiebreakerKey → comparator), h2h partition
// refinement and the ranking driver are in the second half of this file
// (PROMPT-08); the functions above are the cascade-time metrics those
// comparators call.
import { EngineError } from "../core/errors.ts";
import { shuffle } from "../core/rng.ts";
import type { EntrantId, MetricSpec } from "../core/types.ts";
import type { TiebreakerKey } from "../sport/module.ts";
import {
  foldResults,
  resultsAmong,
  type FixtureResult,
  type StandingsRow,
} from "./standings.ts";

export type Color = "W" | "B";
export type GameResult = "win" | "draw" | "loss";

// One game on an entrant's card, in round order.
export interface SwissGame {
  // The real opponent, or null for a bye (no opponent). `unplayed` games (byes,
  // forfeits, absences) use a FIDE virtual opponent for Buchholz/SB.
  opponent: EntrantId | null;
  result: GameResult;
  scored: number; // half-points earned in this game (win 2 / draw 1 / loss 0 / byeScore)
  color?: Color | null; // colour held; null/absent ⇒ excluded from colour history
  unplayed?: boolean;
}

export interface SwissRow {
  entrant: EntrantId;
  score: number; // Σ scored (half-points) — the primary standings key
  games: SwissGame[]; // in round order (index = round − 1)
}

export type SwissTable = readonly SwissRow[];

function indexTable(table: SwissTable): Map<EntrantId, SwissRow> {
  const map = new Map<EntrantId, SwissRow>();
  for (const row of table) map.set(row.entrant, row);
  return map;
}

// FIDE virtual opponent (Handbook C.07 — Tie-Break Regulations 2023, "Unplayed
// games"): a bye/forfeit is scored against a virtual opponent whose score = the
// player's score *before* that round, plus ½ point for every round from the
// unplayed one to the end inclusive (i.e. the opponent is assumed to draw the
// rest). In half-points: scoreBefore + (rounds − index).
function virtualOpponentScore(row: SwissRow, gameIndex: number): number {
  const rounds = row.games.length;
  let scoreBefore = 0;
  for (let i = 0; i < gameIndex; i++) scoreBefore += (row.games[i] as SwissGame).scored;
  return scoreBefore + (rounds - gameIndex);
}

// The score attributed to the opponent of `row`'s game at `index` — the real
// opponent's final score, or the virtual opponent's for an unplayed game.
function opponentScore(byEntrant: Map<EntrantId, SwissRow>, row: SwissRow, index: number): number {
  const game = row.games[index] as SwissGame;
  if (game.unplayed || game.opponent === null) return virtualOpponentScore(row, index);
  const opp = byEntrant.get(game.opponent);
  if (opp === undefined) {
    throw new Error(`Swiss ledger references unknown opponent "${game.opponent}"`);
  }
  return opp.score;
}

function requireRow(byEntrant: Map<EntrantId, SwissRow>, entrant: EntrantId): SwissRow {
  const row = byEntrant.get(entrant);
  if (row === undefined) throw new Error(`entrant "${entrant}" is not in the Swiss table`);
  return row;
}

// Buchholz = Σ opponents' final scores (half-points). Cut-`cut` drops the
// `cut` lowest opponent scores (FIDE recommends Cut-1 first) — spec 04 §6.3.
export function buchholz(table: SwissTable, entrant: EntrantId, opts: { cut?: number } = {}): number {
  const byEntrant = indexTable(table);
  const row = requireRow(byEntrant, entrant);
  const scores = row.games.map((_, i) => opponentScore(byEntrant, row, i));
  const cut = opts.cut ?? 0;
  if (cut <= 0) return scores.reduce((sum, s) => sum + s, 0);
  const sorted = [...scores].sort((a, b) => a - b);
  return sorted.slice(cut).reduce((sum, s) => sum + s, 0);
}

export function buchholzCut1(table: SwissTable, entrant: EntrantId): number {
  return buchholz(table, entrant, { cut: 1 });
}

// Sonneborn-Berger = Σ (defeated opponents' scores) + ½ Σ (drawn opponents'
// scores) — spec 04 §6.3. Returned in QUARTER-points (integer): a win weights
// the opponent score ×2, a draw ×1, a loss ×0 (½·score → quarter-points).
export function sonnebornBerger(table: SwissTable, entrant: EntrantId): number {
  const byEntrant = indexTable(table);
  const row = requireRow(byEntrant, entrant);
  let total = 0;
  row.games.forEach((game, i) => {
    const oppScore = opponentScore(byEntrant, row, i);
    const weight = game.result === "win" ? 2 : game.result === "draw" ? 1 : 0;
    total += weight * oppScore;
  });
  return total;
}

// Number of wins (cascade tail) — spec 04 §6.3.
export function wins(table: SwissTable, entrant: EntrantId): number {
  const row = requireRow(indexTable(table), entrant);
  return row.games.filter((game) => game.result === "win").length;
}

// Direct-encounter result between two tied entrants (building block for the
// `direct` comparator, spec 05 §4.2): +1 if `a` scored more head-to-head, −1 if
// less, 0 if level or they never met. Half-point aware.
export function directEncounter(table: SwissTable, a: EntrantId, b: EntrantId): number {
  const byEntrant = indexTable(table);
  // Each side's head-to-head half-points, read straight off its own card.
  const scoredAgainst = (row: SwissRow, foe: EntrantId): { met: boolean; scored: number } => {
    let scored = 0;
    let met = false;
    for (const game of row.games) {
      if (game.opponent !== foe || game.unplayed) continue;
      met = true;
      scored += game.scored;
    }
    return { met, scored };
  };
  const aVsB = scoredAgainst(requireRow(byEntrant, a), b);
  const bVsA = scoredAgainst(requireRow(byEntrant, b), a);
  if (!aVsB.met && !bVsA.met) return 0; // never met
  return aVsB.scored > bVsA.scored ? 1 : aVsB.scored < bVsA.scored ? -1 : 0;
}

// Colour history string for the pairing algorithm (spec 05 §2.2, chess.md §3):
// 'W'/'B' in round order, skipping games with no colour (byes/forfeits/colours
// off). Constraint checks (no 3 in a row, |W−B| ≤ 2) live in the pairing code.
export function colorHistory(row: SwissRow): string {
  return row.games
    .filter((game) => game.color === "W" || game.color === "B")
    .map((game) => game.color)
    .join("");
}

// Convenience bundle for the ranking cascade — all integers.
export interface SwissTiebreaks {
  score: number; // half-points
  buchholzCut1: number; // half-points
  buchholz: number; // half-points
  sonnebornBerger: number; // quarter-points
  wins: number;
  colorHistory: string;
}

export function swissTiebreaks(table: SwissTable, entrant: EntrantId): SwissTiebreaks {
  const row = requireRow(indexTable(table), entrant);
  return {
    score: row.score,
    buchholzCut1: buchholzCut1(table, entrant),
    buchholz: buchholz(table, entrant),
    sonnebornBerger: sonnebornBerger(table, entrant),
    wins: wins(table, entrant),
    colorHistory: colorHistory(row),
  };
}

// Half-points → conventional score string (2 → "1", 1 → "½", 7 → "3½").
export function pointsToText(halfPoints: number): string {
  const whole = Math.floor(halfPoints / 2);
  const half = halfPoints % 2 === 1 ? "½" : "";
  if (whole === 0) return half === "" ? "0" : "½";
  return `${whole}${half}`;
}

// ===========================================================================
// Comparator registry + tiebreaker cascade — spec 05 §4 (PROMPT-08).
//
// A standings table is entrants sorted by a *cascade of comparators*. The
// cascade is data (a TiebreakerKey[]); ranking is iterative PARTITION
// REFINEMENT, never a pairwise sort — pairwise comparison breaks transitivity
// for head-to-head keys (spec 05 §4.2). Each key refines the current
// equivalence classes into finer, ordered sub-classes; a class of size 1 is
// final. Ratio metrics compare by cross-multiplication of integer ledgers, so
// ordering never touches a float (spec 05 §4.3).
// ===========================================================================

// >0 ⇒ a ranks ABOVE b; <0 ⇒ below; 0 ⇒ level on this key.
export type Comparator = (a: StandingsRow, b: StandingsRow, ctx: RankContext) => number;

export interface RankContext {
  cascade: readonly TiebreakerKey[];
  // Decided fixtures of the pool being ranked — the source for head-to-head
  // and direct-encounter mini-tables (spec 05 §4.2). Empty ⇒ no h2h data.
  results?: readonly FixtureResult[];
  // UEFA recursive h2h re-application (true) vs FIFA fall-through (false),
  // spec 05 §4.2 step 3.
  h2hRecursive?: boolean;
  // Assembled Swiss ledger for buchholz/sberger/direct (spec 05 §4.1); the
  // boardgame cascade needs it, most sports do not.
  swiss?: SwissTable;
  // Entrant seeds for the `seed` comparator and deterministic residual-tie
  // ordering; lower number = higher seed.
  seeds?: ReadonlyMap<EntrantId, number>;
  // Division rngSeed for `lots` (spec 05 §4.4); combined with sorted tie-group
  // ids so the draw is reproducible and audited.
  rngSeed?: number;
}

export interface RankingResult {
  // Ranked rows (clones — the input is never mutated), `rank` = 1..n, distinct.
  rows: StandingsRow[];
  // Tie-groups a drawing of lots decided (sorted ids) — each needs a
  // `rank_lock_required` division event before progression (spec 05 §3).
  lotsGroups: EntrantId[][];
}

const sgn = (n: number): number => (n > 0 ? 1 : n < 0 ? -1 : 0);

// Ledger key aliases: the abstract `diff`/`for` tiebreaks map to whatever the
// sport calls goal/run difference and goals/runs for (spec 04 per-sport).
const DIFF_KEYS = ["gd", "diff", "run_diff"] as const;
const FOR_KEYS = ["gf", "for", "runs_for"] as const;

function metricOf(row: StandingsRow, keys: readonly string[]): number {
  for (const key of keys) {
    const value = row.metrics[key];
    if (value !== undefined) return value;
  }
  return 0;
}

// Compare fractions an/ad vs bn/bd by cross-multiplication — no floats (spec 05
// §4.3). Denominators are ≥ 0; x/0 with x>0 is treated as +∞ (an unbeaten
// ratio), and 0/0 as 0 (no data). Numerators may be negative (net run rate).
function compareRatio(an: number, ad: number, bn: number, bd: number): number {
  const aInf = ad === 0 && an > 0;
  const bInf = bd === 0 && bn > 0;
  if (aInf || bInf) return aInf && bInf ? 0 : aInf ? 1 : -1;
  const an2 = ad === 0 ? 0 : an;
  const ad2 = ad === 0 ? 1 : ad;
  const bn2 = bd === 0 ? 0 : bn;
  const bd2 = bd === 0 ? 1 : bd;
  const lhs = BigInt(an2) * BigInt(bd2);
  const rhs = BigInt(bn2) * BigInt(ad2);
  return lhs > rhs ? 1 : lhs < rhs ? -1 : 0;
}

// Net run rate as an exact fraction: rf/bf − ra/bb = (rf·bb − ra·bf)/(bf·bb)
// (spec 04 §5 / cricket.md). Compared, never divided.
function nrrFraction(row: StandingsRow): { n: number; d: number } {
  const rf = metricOf(row, ["runs_for"]);
  const bf = metricOf(row, ["balls_faced_eff"]);
  const ra = metricOf(row, ["runs_against"]);
  const bb = metricOf(row, ["balls_bowled_eff"]);
  return { n: rf * bb - ra * bf, d: bf * bb };
}

// spec 05 §4.1 — one comparator per non-structural TiebreakerKey. h2h_* /
// direct / lots are handled by the refinement driver (they need the tie-group
// context, not a pairwise value).
const COMPARATORS: Partial<Record<TiebreakerKey, Comparator>> = {
  points: (a, b) => sgn(a.points - b.points),
  wins: (a, b) => sgn(a.won - b.won),
  diff: (a, b) => sgn(metricOf(a, DIFF_KEYS) - metricOf(b, DIFF_KEYS)),
  for: (a, b) => sgn(metricOf(a, FOR_KEYS) - metricOf(b, FOR_KEYS)),
  fair_play: (a, b) => sgn(metricOf(a, ["fair_play"]) - metricOf(b, ["fair_play"])),
  nrr: (a, b) => {
    const na = nrrFraction(a);
    const nb = nrrFraction(b);
    return compareRatio(na.n, na.d, nb.n, nb.d);
  },
  set_ratio: (a, b) =>
    compareRatio(
      metricOf(a, ["sets_won"]),
      metricOf(a, ["sets_lost"]),
      metricOf(b, ["sets_won"]),
      metricOf(b, ["sets_lost"]),
    ),
  point_ratio: (a, b) =>
    compareRatio(
      metricOf(a, ["points_won"]),
      metricOf(a, ["points_lost"]),
      metricOf(b, ["points_won"]),
      metricOf(b, ["points_lost"]),
    ),
  // Swiss cascade-time metrics — read the assembled ledger (spec 05 §4.1).
  buchholz: (a, b, ctx) =>
    ctx.swiss ? sgn(buchholz(ctx.swiss, a.entrantId) - buchholz(ctx.swiss, b.entrantId)) : 0,
  buchholz_cut1: (a, b, ctx) =>
    ctx.swiss
      ? sgn(buchholzCut1(ctx.swiss, a.entrantId) - buchholzCut1(ctx.swiss, b.entrantId))
      : 0,
  sberger: (a, b, ctx) =>
    ctx.swiss
      ? sgn(sonnebornBerger(ctx.swiss, a.entrantId) - sonnebornBerger(ctx.swiss, b.entrantId))
      : 0,
  seed: (a, b, ctx) => {
    const sa = ctx.seeds?.get(a.entrantId) ?? Number.MAX_SAFE_INTEGER;
    const sb = ctx.seeds?.get(b.entrantId) ?? Number.MAX_SAFE_INTEGER;
    return sgn(sb - sa); // lower seed number ranks above
  },
};

const H2H_KEYS = new Set<TiebreakerKey>(["h2h_points", "h2h_diff", "h2h_for"]);

function isH2HKey(key: TiebreakerKey): boolean {
  return H2H_KEYS.has(key);
}

// Inside an h2h mini-table, "h2h GD" simply means "GD computed among the tied
// set" — so the block keys map to their plain equivalents applied to mini rows.
function h2hToPlain(key: TiebreakerKey): TiebreakerKey {
  return key === "h2h_points" ? "points" : key === "h2h_diff" ? "diff" : "for";
}

// Sort a tied class by a comparator (best first) and split into equal-neighbour
// sub-classes. Sound because every comparator here is a total preorder.
function groupBySort(cls: StandingsRow[], cmp: Comparator, ctx: RankContext): StandingsRow[][] {
  const sorted = [...cls].sort((a, b) => -sgn(cmp(a, b, ctx)));
  const groups: StandingsRow[][] = [];
  let current: StandingsRow[] = [];
  for (const row of sorted) {
    const prev = current[current.length - 1];
    if (prev !== undefined && sgn(cmp(prev, row, ctx)) !== 0) {
      groups.push(current);
      current = [];
    }
    current.push(row);
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

// Record on every row of a just-split tie group which cascade rule separated
// it (doc 09 §2 tie-explanation popover). Later, finer splits overwrite — the
// snapshot keeps the finest rule that applied to each row.
function markTieBreak(cls: readonly StandingsRow[], key: string): void {
  const ids = cls.map((row) => row.entrantId);
  for (const row of cls) {
    row.tieBreak = { key, with: ids.filter((id) => id !== row.entrantId) };
  }
}

// spec 05 §4.2 — head-to-head partition refinement over a maximal run of h2h_*
// keys. (1) build a mini-table from fixtures among the tied set; (2) refine it
// by the block's plain equivalents; (3) UEFA only: re-run the block on any
// partially-split sub-tie (rebuilding the mini-table among just those
// entrants). FIFA 2026 (h2hRecursive=false) applies the block once, then the
// outer cascade falls through to overall criteria.
function h2hBlock(
  cls: StandingsRow[],
  block: readonly TiebreakerKey[],
  ctx: RankContext,
): StandingsRow[][] {
  const ids = new Set(cls.map((row) => row.entrantId));
  const among = resultsAmong(ids, ctx.results ?? []);
  const miniRows = foldResults(
    cls.map((row) => row.entrantId),
    among,
  );
  const byId = new Map(cls.map((row) => [row.entrantId, row]));

  // Refine the mini-table one block key at a time so each split can be
  // attributed to the h2h key that caused it (tie-explanation trace).
  let miniClasses: StandingsRow[][] = [miniRows];
  for (const key of block) {
    const cmp = COMPARATORS[h2hToPlain(key)];
    // h2hToPlain maps onto points/diff/for, all registered — defensive only.
    /* v8 ignore next */
    if (cmp === undefined) continue;
    miniClasses = miniClasses.flatMap((mini) => {
      if (mini.length <= 1) return [mini];
      const groups = groupBySort(mini, cmp, ctx);
      if (groups.length > 1) {
        markTieBreak(
          mini.map((row) => byId.get(row.entrantId) as StandingsRow),
          key,
        );
      }
      return groups;
    });
    if (miniClasses.every((mini) => mini.length === 1)) break;
  }

  const ordered = miniClasses.map((mini) =>
    mini.map((row) => byId.get(row.entrantId) as StandingsRow),
  );

  if (ctx.h2hRecursive !== true) return ordered;
  return ordered.flatMap((sub) =>
    // Recurse only when the block *partially* split the group; a sub-tie the
    // same size as the input made no progress (guards against non-termination).
    sub.length > 1 && sub.length < cls.length ? h2hBlock(sub, block, ctx) : [sub],
  );
}

// Direct-encounter refinement among the tied set: half-points each entrant
// scored against the others (spec 05 §4.1). Uses the Swiss ledger when present
// (boardgame), else the pool results. Building a mini-league (not pairwise)
// keeps it transitive for 3+ tied entrants.
function directRefine(cls: StandingsRow[], ctx: RankContext): StandingsRow[][] {
  const ids = new Set(cls.map((row) => row.entrantId));
  const score = (id: EntrantId): number => {
    if (ctx.swiss) {
      const row = ctx.swiss.find((entry) => entry.entrant === id);
      if (row === undefined) return 0;
      return row.games.reduce(
        (sum, game) =>
          game.opponent !== null && !game.unplayed && ids.has(game.opponent)
            ? sum + game.scored
            : sum,
        0,
      );
    }
    const among = resultsAmong(ids, ctx.results ?? []);
    return among.reduce((sum, [home, away]) => {
      if (home.entrantId === id) return sum + home.points;
      if (away.entrantId === id) return sum + away.points;
      return sum;
    }, 0);
  };
  const cmp: Comparator = (a, b) => sgn(score(a.entrantId) - score(b.entrantId));
  return groupBySort(cls, cmp, ctx);
}

// The full cascade driver: refine one equivalence class through the cascade,
// consuming a maximal run of h2h keys as a single block.
function refine(
  classes: StandingsRow[][],
  cascade: readonly TiebreakerKey[],
  ctx: RankContext,
): StandingsRow[][] {
  let current = classes;
  let i = 0;
  while (i < cascade.length) {
    const key = cascade[i] as TiebreakerKey;
    // The cascade's first key is the primary ordering — a split there is not a
    // "tie" worth explaining. Every later key that splits a class is.
    const explain = i > 0;
    if (key === "lots") {
      i++;
      continue; // resolved after the cascade (rankStandings)
    }
    if (isH2HKey(key)) {
      const block: TiebreakerKey[] = [];
      while (i < cascade.length && isH2HKey(cascade[i] as TiebreakerKey)) {
        block.push(cascade[i] as TiebreakerKey);
        i++;
      }
      // h2hBlock writes its own per-key trace; suppress none — an h2h block at
      // cascade head still explains genuine ties within the mini-table.
      current = current.flatMap((cls) => (cls.length > 1 ? h2hBlock(cls, block, ctx) : [cls]));
    } else if (key === "direct") {
      current = current.flatMap((cls) => {
        if (cls.length <= 1) return [cls];
        const groups = directRefine(cls, ctx);
        if (explain && groups.length > 1) markTieBreak(cls, key);
        return groups;
      });
      i++;
    } else {
      const cmp = COMPARATORS[key];
      if (cmp !== undefined) {
        current = current.flatMap((cls) => {
          if (cls.length <= 1) return [cls];
          const groups = groupBySort(cls, cmp, ctx);
          if (explain && groups.length > 1) markTieBreak(cls, key);
          return groups;
        });
      }
      i++;
    }
    if (current.every((cls) => cls.length === 1)) break;
  }
  return current;
}

// FNV-1a fold of the division rngSeed and sorted tie-group ids → a stable
// 32-bit lot seed (spec 05 §4.4). Same seed + same ids ⇒ same draw.
function lotSeed(rngSeed: number, sortedIds: readonly EntrantId[]): number {
  let hash = rngSeed >>> 0;
  for (const id of sortedIds) {
    for (let k = 0; k < id.length; k++) {
      hash = Math.imul(hash ^ id.charCodeAt(k), 0x01000193) >>> 0;
    }
    hash = Math.imul(hash ^ 0x2c, 0x01000193) >>> 0; // separator between ids
  }
  return hash >>> 0;
}

function bySeedThenId(ctx: RankContext): (a: StandingsRow, b: StandingsRow) => number {
  return (a, b) => {
    const sa = ctx.seeds?.get(a.entrantId) ?? Number.MAX_SAFE_INTEGER;
    const sb = ctx.seeds?.get(b.entrantId) ?? Number.MAX_SAFE_INTEGER;
    if (sa !== sb) return sa - sb;
    return a.entrantId < b.entrantId ? -1 : a.entrantId > b.entrantId ? 1 : 0;
  };
}

// Rank a folded standings table by the cascade (spec 05 §4). Returns cloned
// rows in a total order with distinct 1..n ranks. A class the cascade cannot
// separate is broken by `lots` if the cascade lists it (marking the group for a
// rank_lock_required event), otherwise by seed→id — a deterministic fallback
// that never silently randomises (spec 05 §3).
export function rankStandings(rows: readonly StandingsRow[], ctx: RankContext): RankingResult {
  const clones = rows.map((row) => ({ ...row, metrics: { ...row.metrics } }));
  const classes = refine([clones], ctx.cascade, ctx);
  const hasLots = ctx.cascade.includes("lots");
  const rngSeed = ctx.rngSeed ?? 0;

  const order: StandingsRow[] = [];
  const lotsGroups: EntrantId[][] = [];
  for (const cls of classes) {
    if (cls.length === 1) {
      order.push(cls[0] as StandingsRow);
      continue;
    }
    if (hasLots) {
      const ids = cls.map((row) => row.entrantId).sort();
      const drawn = shuffle(lotSeed(rngSeed, ids), ids);
      const byId = new Map(cls.map((row) => [row.entrantId, row]));
      markTieBreak(cls, "lots");
      for (const id of drawn) {
        const row = byId.get(id) as StandingsRow;
        row.rankLocked = true;
        order.push(row);
      }
      lotsGroups.push(ids);
    } else {
      markTieBreak(cls, "seed");
      for (const row of [...cls].sort(bySeedThenId(ctx))) order.push(row);
    }
  }

  order.forEach((row, index) => {
    row.rank = index + 1;
  });

  // Swiss cascade metrics exist only at rank time (they need the assembled
  // ledger) — materialise the ones the cascade uses into row.metrics, in
  // DISPLAY points (buchholz half-points → points, SB quarter-points →
  // points), so the standings snapshot can render Buchholz/SB columns
  // (doc 09 §2) without re-assembling the ledger. Ordering never reads these.
  if (ctx.swiss) {
    for (const row of order) {
      if (ctx.cascade.includes("buchholz")) {
        row.metrics["buchholz"] = buchholz(ctx.swiss, row.entrantId) / 2;
      }
      if (ctx.cascade.includes("buchholz_cut1")) {
        row.metrics["buchholz_cut1"] = buchholzCut1(ctx.swiss, row.entrantId) / 2;
      }
      if (ctx.cascade.includes("sberger")) {
        row.metrics["sberger"] = sonnebornBerger(ctx.swiss, row.entrantId) / 4;
      }
    }
  }
  return { rows: order, lotsGroups };
}

// spec 05 §4.1 — reject cascade keys whose metrics the sport doesn't maintain
// (validated at division-config time). `swiss` marks a stage that assembles the
// Swiss ledger (buchholz/sberger/direct); the rest map to declared MetricSpecs.
export function validateCascade(
  cascade: readonly TiebreakerKey[],
  opts: { metrics: readonly MetricSpec[]; swiss?: boolean },
): void {
  const keys = new Set(opts.metrics.map((metric) => metric.key));
  const has = (...alts: string[]): boolean => alts.some((key) => keys.has(key));
  const reject = (key: TiebreakerKey, need: string): never => {
    throw new EngineError(
      "CONFIG_INVALID",
      `tiebreaker "${key}" needs ${need}, which this sport does not maintain`,
      { key },
    );
  };
  for (const key of cascade) {
    switch (key) {
      case "points":
      case "wins":
      case "h2h_points":
      case "seed":
      case "lots":
        break; // structural — always available
      case "diff":
      case "h2h_diff":
        if (!has(...DIFF_KEYS)) reject(key, "a goal/run difference metric");
        break;
      case "for":
      case "h2h_for":
        if (!has(...FOR_KEYS)) reject(key, "a goals/runs-for metric");
        break;
      case "fair_play":
        if (!has("fair_play")) reject(key, "a fair_play metric");
        break;
      case "nrr":
        if (!has("runs_for") || !has("balls_faced_eff") || !has("runs_against") || !has("balls_bowled_eff")) {
          reject(key, "the NRR ledger (runs/balls for & against)");
        }
        break;
      case "set_ratio":
        if (!has("sets_won") || !has("sets_lost")) reject(key, "sets won/lost");
        break;
      case "point_ratio":
        if (!has("points_won") || !has("points_lost")) reject(key, "points won/lost");
        break;
      case "buchholz":
      case "buchholz_cut1":
      case "sberger":
      case "direct":
        if (opts.swiss !== true) reject(key, "an assembled Swiss ledger");
        break;
    }
  }
}

// Assemble a SwissTable from decided fixture results for the buchholz/sberger/
// direct comparators (spec 05 §4.1, PROMPT-07 note). Each entrant's card is
// built from the fixtures it played; `scored` is read straight off the
// module's delta points (half-points for the boardgame module). Colour/byes
// aren't recoverable from deltas — pass richer cards directly when needed.
export function buildSwissTable(
  entrants: readonly EntrantId[],
  results: readonly FixtureResult[],
): SwissTable {
  const cards = new Map<EntrantId, SwissGame[]>();
  const scoreOf = new Map<EntrantId, number>();
  for (const id of entrants) {
    cards.set(id, []);
    scoreOf.set(id, 0);
  }
  const resultOf = (delta: FixtureResult[number]): GameResult =>
    delta.won > 0 ? "win" : delta.drawn > 0 ? "draw" : "loss";
  const push = (self: FixtureResult[number], opp: FixtureResult[number]): void => {
    const card = cards.get(self.entrantId);
    if (card === undefined) {
      throw new Error(`Swiss ledger built for entrant "${self.entrantId}" outside the entrant set`);
    }
    card.push({ opponent: opp.entrantId, result: resultOf(self), scored: self.points });
    scoreOf.set(self.entrantId, (scoreOf.get(self.entrantId) ?? 0) + self.points);
  };
  for (const [home, away] of results) {
    push(home, away);
    push(away, home);
  }
  return entrants.map((entrant) => ({
    entrant,
    score: scoreOf.get(entrant) ?? 0,
    games: cards.get(entrant) ?? [],
  }));
}
