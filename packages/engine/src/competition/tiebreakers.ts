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
// NOTE — the comparator *registry* (TiebreakerKey → comparator, antisymmetry/
// transitivity property tests, h2h partition refinement) lands in PROMPT-08;
// this file provides the metric functions those comparators call.
import type { EntrantId } from "../core/types.ts";

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
