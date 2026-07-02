import type { Match, Player, Round, TournamentState } from "@/lib/types";

/** Compute the clock window for a round given the tournament start time. */
export function roundWindow(
  startsAt: string | null,
  roundMinutes: number,
  roundIndex: number, // 0-based position among all rounds
): { start: Date; end: Date } | null {
  if (!startsAt) return null;
  const base = new Date(startsAt);
  if (Number.isNaN(base.getTime())) return null;
  const start = new Date(base.getTime() + roundIndex * roundMinutes * 60_000);
  const end = new Date(start.getTime() + roundMinutes * 60_000);
  return { start, end };
}

export function fmtTime(d: Date): string {
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function csvCell(value: string | number): string {
  const s = String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Build a CSV export with standings and every match result. */
export function buildCsv(state: TournamentState): string {
  const { tournament: t, players, rounds, matches, standings } = state;
  const nameOf = (id: string | null) =>
    id ? (players.find((p) => p.id === id)?.name ?? "") : "";
  const roundName = (id: string) =>
    rounds.find((r) => r.id === id)?.name ?? "";

  const lines: string[] = [];
  lines.push(`Tournament,${csvCell(t.name)}`);
  lines.push(`Sport,${csvCell(t.sport)}`);
  lines.push("");

  lines.push("STANDINGS");
  lines.push(
    ["Rank", "Name", "Played", "W", "D", "L", "Points", "Progress", "Buchholz", "For", "Against", "Diff"]
      .map(csvCell)
      .join(","),
  );
  for (const s of standings) {
    lines.push(
      [
        s.rank,
        s.player.name,
        s.played,
        s.wins,
        s.draws,
        s.losses,
        s.points,
        s.progressScore,
        s.buchholz,
        s.scoreFor,
        s.scoreAgainst,
        s.scoreDiff,
      ]
        .map(csvCell)
        .join(","),
    );
  }

  lines.push("");
  lines.push("RESULTS");
  lines.push(
    ["Round", "Board", "Player 1", "Player 2", "Score", "Result"]
      .map(csvCell)
      .join(","),
  );
  for (const m of [...matches].sort((a, b) =>
    roundName(a.round_id).localeCompare(roundName(b.round_id)),
  )) {
    const score =
      m.player1_score != null && m.player2_score != null
        ? `${m.player1_score}-${m.player2_score}`
        : "";
    const result = m.is_bye
      ? "bye"
      : m.is_draw
        ? "draw"
        : m.winner_id
          ? `${nameOf(m.winner_id)} won`
          : "";
    lines.push(
      [
        roundName(m.round_id),
        m.board_number,
        nameOf(m.player1_id),
        nameOf(m.player2_id),
        score,
        result,
      ]
        .map(csvCell)
        .join(","),
    );
  }

  return lines.join("\n");
}

/** Matches currently playable (both players present, not finished). */
export function activeMatches(matches: Match[]): Match[] {
  return matches.filter(
    (m) =>
      m.status !== "completed" &&
      !m.is_bye &&
      m.player1_id != null &&
      m.player2_id != null,
  );
}

export function playerName(players: Player[], id: string | null): string {
  if (!id) return "TBD";
  return players.find((p) => p.id === id)?.name ?? "?";
}

export function sortedGroupRounds(rounds: Round[]): Round[] {
  return rounds
    .filter((r) => r.stage === "group")
    .sort((a, b) => a.round_number - b.round_number);
}

export function sortedKoRounds(rounds: Round[]): Round[] {
  return rounds
    .filter((r) => r.stage !== "group")
    .sort((a, b) => a.round_number - b.round_number);
}

/** Completed final match, if the tournament has a final round. */
export function finalMatch(state: TournamentState): Match | null {
  const finalRound = state.rounds.find((r) => r.stage === "final");
  if (!finalRound) return null;
  return (
    state.matches.find(
      (m) =>
        m.round_id === finalRound.id &&
        m.status === "completed" &&
        m.winner_id,
    ) ?? null
  );
}

/**
 * Champion player: the final-match winner when a final exists, otherwise the
 * standings leader (e.g. round robin with no knockout final).
 */
export function findChampionPlayer(state: TournamentState): Player | null {
  const fm = finalMatch(state);
  if (fm?.winner_id) {
    return state.players.find((p) => p.id === fm.winner_id) ?? null;
  }
  return state.standings[0]?.player ?? null;
}

/** Runner-up: final-match loser when a final exists, else standings #2. */
export function findRunnerUpPlayer(state: TournamentState): Player | null {
  const fm = finalMatch(state);
  if (fm?.winner_id) {
    const loserId =
      fm.loser_id ??
      (fm.player1_id === fm.winner_id ? fm.player2_id : fm.player1_id);
    if (loserId) return state.players.find((p) => p.id === loserId) ?? null;
  }
  return state.standings[1]?.player ?? null;
}

/** Third place for podium/champion slides, excluding champ and runner-up. */
export function findThirdPlacePlayer(state: TournamentState): Player | null {
  const skip = new Set(
    [findChampionPlayer(state)?.id, findRunnerUpPlayer(state)?.id].filter(
      Boolean,
    ) as string[],
  );
  for (const row of state.standings) {
    if (!skip.has(row.player.id)) return row.player;
  }
  return null;
}
