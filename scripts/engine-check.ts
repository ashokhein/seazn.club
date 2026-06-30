// Run with: node --experimental-strip-types scripts/engine-check.ts
import {
  knockoutFirstRound,
  recommendGroupRounds,
  roundRobinRounds,
  swissPairings,
} from "../src/lib/pairing.ts";
import { computeStandings, type ScoringConfig } from "../src/lib/standings.ts";

let failures = 0;
function check(label: string, cond: boolean) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
}

const CHESS: ScoringConfig = {
  points_win: 1,
  points_draw: 0,
  points_loss: 0,
  use_progress_score: true,
};
const LEAGUE: ScoringConfig = {
  points_win: 3,
  points_draw: 1,
  points_loss: 0,
  use_progress_score: false,
};

// ---- Progress score (PDF examples) ----------------------------------------
type P = {
  id: string;
  tournament_id: string;
  name: string;
  seed: number;
  checked_in: boolean;
};
const mkPlayers = (names: string[]): P[] =>
  names.map((n, i) => ({
    id: n,
    tournament_id: "t",
    name: n,
    seed: i + 1,
    checked_in: true,
  }));

function groupRound(n: number) {
  return {
    id: `r${n}`,
    tournament_id: "t",
    round_number: n,
    stage: "group" as const,
    name: `Round ${n}`,
    status: "completed" as const,
  };
}
function match(
  round: number,
  p1: string,
  p2: string | null,
  winner: string | null,
  opts: { s1?: number; s2?: number; draw?: boolean; bye?: boolean } = {},
) {
  return {
    id: `m${round}-${p1}-${p2 ?? "bye"}`,
    tournament_id: "t",
    round_id: `r${round}`,
    board_number: 1,
    player1_id: p1,
    player2_id: p2,
    winner_id: winner,
    loser_id: winner && p2 ? (winner === p1 ? p2 : p1) : null,
    player1_score: opts.s1 ?? null,
    player2_score: opts.s2 ?? null,
    is_draw: opts.draw ?? false,
    next_match_id: null,
    next_slot: null,
    is_bye: opts.bye ?? p2 === null,
    status: "completed" as const,
    label: null,
  };
}

// Win, Win, Loss => progress 3
{
  const players = mkPlayers(["A", "B"]);
  const rounds = [groupRound(1), groupRound(2), groupRound(3)];
  const matches = [
    match(1, "A", "B", "A"),
    match(2, "A", "B", "A"),
    match(3, "A", "B", "B"),
  ];
  const s = computeStandings(players, rounds, matches, CHESS);
  const a = s.find((r) => r.player.id === "A")!;
  check("progress W,W,L = 3", a.progressScore === 3);
  check("points W,W,L = 2", a.points === 2);
}

// Single loss: 0 league points
{
  const players = mkPlayers(["A", "B"]);
  const rounds = [groupRound(1)];
  const matches = [match(1, "A", "B", "A")];
  const s = computeStandings(players, rounds, matches, CHESS);
  const b = s.find((r) => r.player.id === "B")!;
  check("loser after one loss has 0 pts", b.points === 0);
  check("loser after one loss has 0 progress", b.progressScore === 0);
}

// Bye / rest gives no league points
{
  const players = mkPlayers(["A", "B", "C"]);
  const rounds = [groupRound(1)];
  const matches = [
    match(1, "A", "B", "A"),
    match(1, "C", null, "C"),
  ];
  const s = computeStandings(players, rounds, matches, CHESS);
  const c = s.find((r) => r.player.id === "C")!;
  check("bye rest: 0 points", c.points === 0);
  check("bye rest: 0 wins", c.wins === 0);
  check("bye rest: 0 progress", c.progressScore === 0);
}

// Win, Loss, Win => progress 2
{
  const players = mkPlayers(["A", "B"]);
  const rounds = [groupRound(1), groupRound(2), groupRound(3)];
  const matches = [
    match(1, "A", "B", "A"),
    match(2, "A", "B", "B"),
    match(3, "A", "B", "A"),
  ];
  const s = computeStandings(players, rounds, matches, CHESS);
  const a = s.find((r) => r.player.id === "A")!;
  check("progress W,L,W = 2", a.progressScore === 2);
}

// ---- Score + draw league standings ----------------------------------------
{
  const players = mkPlayers(["A", "B", "C"]);
  const rounds = [groupRound(1), groupRound(2)];
  const matches = [
    match(1, "A", "B", "A", { s1: 2, s2: 1 }), // A win
    match(2, "A", "C", null, { s1: 0, s2: 0, draw: true }), // draw
  ];
  const s = computeStandings(players, rounds, matches, LEAGUE);
  const a = s.find((r) => r.player.id === "A")!;
  check("league A points 3+1 = 4", a.points === 4);
  check("league A goal diff = +1", a.scoreDiff === 1);
  check("league A W/D/L = 1/1/0", a.wins === 1 && a.draws === 1 && a.losses === 0);
}

// ---- Swiss pairing --------------------------------------------------------
{
  const pairings = swissPairings(["a", "b", "c", "d"], new Set(), new Set());
  check("4 players -> 2 boards", pairings.length === 2);
  check("no byes for even", pairings.every((p) => p.player2 !== null));
}
{
  const pairings = swissPairings(["a", "b", "c", "d", "e"], new Set(), new Set());
  const byes = pairings.filter((p) => p.player2 === null);
  check("5 players -> exactly one bye", byes.length === 1);
}

// ---- Round robin ----------------------------------------------------------
{
  const rr = roundRobinRounds(["a", "b", "c", "d"]);
  check("4 players -> 3 RR rounds", rr.length === 3);
  check("each RR round has 2 matches", rr.every((r) => r.length === 2));
  const total = rr.flat().length;
  check("4 players -> 6 total fixtures", total === 6);
}
{
  const rr = roundRobinRounds(["a", "b", "c"]);
  check("3 players -> 3 RR rounds (with byes)", rr.length === 3);
  const byes = rr.flat().filter((p) => p.player2 === null);
  check("3 players -> one bye per round", byes.length === 3);
}

// ---- Knockout bracket -----------------------------------------------------
{
  const r1 = knockoutFirstRound(["1", "2", "3", "4", "5", "6", "7", "8"]);
  check("8 players -> 4 first-round matches", r1.length === 4);
  check("seed1 vs seed8", r1[0].player1 === "1" && r1[0].player2 === "8");
}

// ---- Recommendation -------------------------------------------------------
{
  const rec = recommendGroupRounds(8);
  check("8 players -> knockout top 4", rec.knockoutSize === 4);
  check("8 players -> >=3 group rounds", rec.groupRounds >= 3);
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
