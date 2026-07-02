import type { Match, Player, Round, StandingRow } from "@/lib/types";

export interface ScoringConfig {
  points_win: number;
  points_draw: number;
  points_loss: number;
  use_progress_score: boolean;
}

/**
 * Compute standings for the group / round-robin stage.
 *
 * Supports both win/loss sports (chess, carrom) and score sports (football,
 * cricket, volleyball) with draws. Ranking keys, in order:
 *   1. points         (points_win / draw / loss per the tournament config)
 *   2. progress score (chess only — round-by-round win streak; loss/draw reset streak)
 *   3. score diff     (e.g. goal difference) when scores are recorded
 *   4. Buchholz       (sum of opponents' points)
 *   5. head-to-head
 *   6. seed / name
 */
export function computeStandings(
  players: Player[],
  rounds: Round[],
  matches: Match[],
  cfg: ScoringConfig,
): StandingRow[] {
  const active = players.filter((p) => p.checked_in);
  const stat = new Map<
    string,
    {
      played: number;
      wins: number;
      draws: number;
      losses: number;
      points: number;
      progressScore: number;
      streak: number;
      scoreFor: number;
      scoreAgainst: number;
      opponents: string[];
    }
  >();
  for (const p of active) {
    stat.set(p.id, {
      played: 0,
      wins: 0,
      draws: 0,
      losses: 0,
      points: 0,
      progressScore: 0,
      streak: 0,
      scoreFor: 0,
      scoreAgainst: 0,
      opponents: [],
    });
  }

  const groupRoundIds = new Set(
    rounds.filter((r) => r.stage === "group").map((r) => r.id),
  );
  const roundNumber = new Map(rounds.map((r) => [r.id, r.round_number]));

  const groupMatches = matches
    .filter((m) => groupRoundIds.has(m.round_id) && m.status === "completed")
    .sort(
      (a, b) =>
        (roundNumber.get(a.round_id) ?? 0) -
          (roundNumber.get(b.round_id) ?? 0) || a.board_number - b.board_number,
    );

  const h2h = new Set<string>();

  for (const m of groupMatches) {
    const s1 = m.player1_id ? stat.get(m.player1_id) : undefined;
    const s2 = m.player2_id ? stat.get(m.player2_id) : undefined;

    // accumulate scores when present
    if (m.player1_score != null && m.player2_score != null) {
      if (s1) {
        s1.scoreFor += m.player1_score;
        s1.scoreAgainst += m.player2_score;
      }
      if (s2) {
        s2.scoreFor += m.player2_score;
        s2.scoreAgainst += m.player1_score;
      }
    }

    if (m.is_bye && s1) {
      // Rest / bye: sit out this round — no league points, no wins, streak unchanged.
      continue;
    }

    // Single-player rows without is_bye set (legacy data): treat as rest too.
    if (!m.player2_id && m.player1_id) {
      continue;
    }

    if (m.is_draw) {
      if (s1) {
        s1.draws += 1;
        s1.points += cfg.points_draw;
        s1.played += 1;
        s1.streak = 0;
        if (m.player2_id) s1.opponents.push(m.player2_id);
      }
      if (s2) {
        s2.draws += 1;
        s2.points += cfg.points_draw;
        s2.played += 1;
        s2.streak = 0;
        if (m.player1_id) s2.opponents.push(m.player1_id);
      }
      continue;
    }

    if (!m.winner_id) continue;
    const winner = m.winner_id;
    const loser =
      m.loser_id ?? (m.player1_id === winner ? m.player2_id : m.player1_id);

    const ws = stat.get(winner);
    if (ws) {
      ws.wins += 1;
      ws.points += cfg.points_win;
      ws.played += 1;
      ws.streak += 1;
      if (cfg.use_progress_score) ws.progressScore += ws.streak;
      if (loser) ws.opponents.push(loser);
    }
    if (loser) {
      const ls = stat.get(loser);
      if (ls) {
        ls.losses += 1;
        ls.points += cfg.points_loss;
        ls.played += 1;
        ls.streak = 0;
        ls.opponents.push(winner);
      }
      h2h.add(`${winner}|${loser}`);
    }
  }

  const rows: StandingRow[] = active.map((p) => {
    const s = stat.get(p.id)!;
    const buchholz = s.opponents.reduce(
      (sum, oppId) => sum + (stat.get(oppId)?.points ?? 0),
      0,
    );
    return {
      player: p,
      played: s.played,
      wins: s.wins,
      draws: s.draws,
      losses: s.losses,
      points: s.points,
      progressScore: s.progressScore,
      buchholz,
      scoreFor: s.scoreFor,
      scoreAgainst: s.scoreAgainst,
      scoreDiff: s.scoreFor - s.scoreAgainst,
      rank: 0,
    };
  });

  rows.sort((a, b) => {
    if (b.points !== a.points) return b.points - a.points;
    if (cfg.use_progress_score && b.progressScore !== a.progressScore)
      return b.progressScore - a.progressScore;
    if (b.scoreDiff !== a.scoreDiff) return b.scoreDiff - a.scoreDiff;
    if (b.scoreFor !== a.scoreFor) return b.scoreFor - a.scoreFor;
    if (b.buchholz !== a.buchholz) return b.buchholz - a.buchholz;
    if (h2h.has(`${a.player.id}|${b.player.id}`)) return -1;
    if (h2h.has(`${b.player.id}|${a.player.id}`)) return 1;
    if (a.player.seed !== b.player.seed) return a.player.seed - b.player.seed;
    return a.player.name.localeCompare(b.player.name);
  });

  rows.forEach((r, i) => (r.rank = i + 1));
  return rows;
}
