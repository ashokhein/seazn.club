/**
 * Pure, in-memory tournament engine — the canonical rules for every format
 * (knockout, round_robin, swiss_knockout, progress_stepladder) and any scoring
 * config (win/loss, league points, draws, progress score, custom points).
 *
 * This module has NO database access. It is a faithful port of the lifecycle
 * orchestration in `tournament.ts`, extracted so the engine can be exercised
 * exhaustively without Postgres (per development/12 §6.3). The DB layer and this
 * engine share the pure primitives in `pairing.ts` / `standings.ts`; the
 * progression rules here are the single documented source of truth.
 *
 * Determinism: ids are assigned from a monotonic counter carried in state, so
 * simulations are reproducible (no randomUUID, no Date.now()).
 */
import { computeStandings, type ScoringConfig } from "@/lib/standings";
import {
  knockoutFirstRound,
  nextPowerOfTwo,
  pairKey,
  roundRobinRounds,
  swissPairings,
} from "@/lib/pairing";
import type {
  Match,
  Player,
  ResultMode,
  Round,
  TournamentFormat,
  TournamentStatus,
} from "@/lib/types";

export interface EngineConfig {
  format: TournamentFormat;
  num_group_rounds: number;
  knockout_size: number;
  result_mode: ResultMode;
  points_win: number;
  points_draw: number;
  points_loss: number;
  allow_draws: boolean;
  use_progress_score: boolean;
}

export interface EngineState {
  config: EngineConfig;
  players: Player[];
  rounds: Round[];
  matches: Match[];
  status: TournamentStatus;
  /** monotonic id source */
  _seq: number;
}

export interface ResultInput {
  winner_id?: string | null;
  player1_score?: number | null;
  player2_score?: number | null;
  is_draw?: boolean;
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: EngineConfig = {
  format: "swiss_knockout",
  num_group_rounds: 3,
  knockout_size: 4,
  result_mode: "win_loss",
  points_win: 1,
  points_draw: 0,
  points_loss: 0,
  allow_draws: false,
  use_progress_score: true,
};

export function createEngine(
  config: Partial<EngineConfig>,
  playerNames: string[],
): EngineState {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const players: Player[] = playerNames.map((name, i) => ({
    id: `p${i + 1}`,
    tournament_id: "t",
    name,
    seed: i + 1,
    checked_in: true,
    image_url: null,
    image_storage_path: null,
  }));
  return {
    config: cfg,
    players,
    rounds: [],
    matches: [],
    status: "setup",
    _seq: 0,
  };
}

function cfgOf(config: EngineConfig): ScoringConfig {
  return {
    points_win: config.points_win,
    points_draw: config.points_draw,
    points_loss: config.points_loss,
    use_progress_score: config.use_progress_score,
  };
}

function nextId(state: EngineState, prefix: string): string {
  state._seq += 1;
  return `${prefix}-${state._seq}`;
}

export function standings(state: EngineState) {
  return computeStandings(
    state.players.filter((p) => p.checked_in),
    state.rounds,
    state.matches,
    cfgOf(state.config),
  );
}

/** Matches an operator can currently enter a result for. */
export function playableMatches(state: EngineState): Match[] {
  return state.matches.filter(
    (m) =>
      m.status === "ready" && m.player1_id != null && m.player2_id != null,
  );
}

// ---------------------------------------------------------------------------
// Builders (mirrors of tournament.ts, but pure / deterministic)
// ---------------------------------------------------------------------------

function knockoutRoundName(matchCount: number): string {
  if (matchCount === 1) return "Final";
  if (matchCount === 2) return "Semi-final";
  if (matchCount === 4) return "Quarter-final";
  return `Round of ${matchCount * 2}`;
}

function blankMatch(state: EngineState, roundId: string, board: number): Match {
  return {
    id: nextId(state, "m"),
    tournament_id: "t",
    round_id: roundId,
    board_number: board,
    player1_id: null,
    player2_id: null,
    winner_id: null,
    loser_id: null,
    player1_score: null,
    player2_score: null,
    is_draw: false,
    next_match_id: null,
    next_slot: null,
    is_bye: false,
    status: "ready",
    label: null,
  };
}

function addRound(
  state: EngineState,
  round_number: number,
  stage: Round["stage"],
  name: string,
  status: Round["status"],
): Round {
  const r: Round = {
    id: nextId(state, "r"),
    tournament_id: "t",
    round_number,
    stage,
    name,
    status,
  };
  state.rounds.push(r);
  return r;
}

function groupMatchesFromPairings(
  state: EngineState,
  roundId: string,
  pairings: { player1: string; player2: string | null }[],
): Match[] {
  return pairings.map((p, i) => {
    const m = blankMatch(state, roundId, i + 1);
    m.player1_id = p.player1;
    m.player2_id = p.player2;
    if (!p.player2) {
      m.is_bye = true;
      m.winner_id = p.player1;
      m.status = "completed";
    }
    return m;
  });
}

function buildKnockoutPlan(
  state: EngineState,
  rankedIds: string[],
  startRoundNumber: number,
): void {
  const size = nextPowerOfTwo(Math.max(2, rankedIds.length));
  const numRounds = Math.log2(size);
  const rounds: Round[] = [];
  const matchIdsByRound: string[][] = [];

  for (let r = 0; r < numRounds; r++) {
    const matchCount = size / Math.pow(2, r + 1);
    matchIdsByRound.push(
      Array.from({ length: matchCount }, () => nextId(state, "m")),
    );
    rounds.push(
      addRound(
        state,
        startRoundNumber + r,
        matchCount === 1 ? "final" : "knockout",
        knockoutRoundName(matchCount),
        "active",
      ),
    );
  }

  const firstRound = knockoutFirstRound(rankedIds);
  for (let r = 0; r < numRounds; r++) {
    const ids = matchIdsByRound[r];
    const round = rounds[r];
    for (let i = 0; i < ids.length; i++) {
      const next =
        r < numRounds - 1
          ? { id: matchIdsByRound[r + 1][Math.floor(i / 2)], slot: (i % 2) + 1 }
          : null;
      const base = blankMatch(state, round.id, i + 1);
      base.id = ids[i];
      base.next_match_id = next?.id ?? null;
      base.next_slot = next?.slot ?? null;
      base.status = r === 0 ? "ready" : "pending";
      base.label = `${round.name} ${ids.length > 1 ? i + 1 : ""}`.trim();
      if (r === 0) {
        const p = firstRound[i];
        base.player1_id = p.player1 || null;
        base.player2_id = p.player2;
        base.is_bye = !!base.player1_id && !base.player2_id;
      }
      state.matches.push(base);
    }
  }
}

function buildStepladderPlan(
  state: EngineState,
  seedIds: string[],
  startRoundNumber: number,
): void {
  const n = seedIds.length;
  if (n < 2) return;

  if (n === 2) {
    const fr = addRound(state, startRoundNumber, "final", "Final", "active");
    const f = blankMatch(state, fr.id, 1);
    f.player1_id = seedIds[0];
    f.player2_id = seedIds[1];
    f.status = "ready";
    f.label = "Final";
    state.matches.push(f);
    return;
  }

  const hasElim = n >= 4;
  const finalRoundNumber = startRoundNumber + (hasElim ? 2 : 1);
  const sfRoundNumber = startRoundNumber + (hasElim ? 1 : 0);

  const finalRound = addRound(state, finalRoundNumber, "final", "Final", "active");
  const finalMatch = blankMatch(state, finalRound.id, 1);
  finalMatch.label = "Final";
  finalMatch.player1_id = seedIds[0];
  finalMatch.status = "pending";

  const sfRound = addRound(state, sfRoundNumber, "knockout", "Semi-final", "active");
  const sfMatch = blankMatch(state, sfRound.id, 1);
  sfMatch.label = "Semi-final";
  sfMatch.next_match_id = finalMatch.id;
  sfMatch.next_slot = 2;

  if (hasElim) {
    const elimRound = addRound(state, startRoundNumber, "knockout", "Eliminator", "active");
    const elim = blankMatch(state, elimRound.id, 1);
    elim.label = "Eliminator (3rd v 4th)";
    elim.player1_id = seedIds[2];
    elim.player2_id = seedIds[3];
    elim.status = "ready";
    elim.next_match_id = sfMatch.id;
    elim.next_slot = 2;

    sfMatch.player1_id = seedIds[1];
    sfMatch.player2_id = null;
    sfMatch.status = "pending";

    state.matches.push(elim, sfMatch, finalMatch);
  } else {
    sfMatch.player1_id = seedIds[1];
    sfMatch.player2_id = seedIds[2];
    sfMatch.status = "ready";
    state.matches.push(sfMatch, finalMatch);
  }
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

export function start(state: EngineState): EngineState {
  if (state.status !== "setup") throw new Error("Tournament already started");
  const active = state.players.filter((p) => p.checked_in);
  if (active.length < 2) throw new Error("Need at least 2 checked-in players");
  const ids = active.map((p) => p.id);
  const t = state.config;

  if (t.format === "knockout") {
    buildKnockoutPlan(state, ids, 1);
    state.status = "knockout";
    resolveByes(state);
  } else if (t.format === "round_robin") {
    const schedule = roundRobinRounds(ids);
    schedule.forEach((pairs, idx) => {
      const round = addRound(state, idx + 1, "group", `Round ${idx + 1}`, "active");
      state.matches.push(...groupMatchesFromPairings(state, round.id, pairs));
    });
    state.status = "group";
  } else {
    // swiss_knockout / progress_stepladder: first group round by seed order.
    const pairings = swissPairings(ids, new Set(), new Set());
    const round = addRound(state, 1, "group", "Round 1", "active");
    state.matches.push(...groupMatchesFromPairings(state, round.id, pairings));
    state.status = "group";
  }
  return state;
}

// ---------------------------------------------------------------------------
// Record result
// ---------------------------------------------------------------------------

export function recordResult(
  state: EngineState,
  matchId: string,
  input: ResultInput,
): EngineState {
  const m = state.matches.find((x) => x.id === matchId);
  if (!m) throw new Error("Match not found");
  if (m.status === "completed") throw new Error("Match already decided");
  if (!m.player1_id || !m.player2_id)
    throw new Error("Both players must be present");

  const round = state.rounds.find((r) => r.id === m.round_id)!;
  const isKnockout = round.stage !== "group";

  let winnerId: string | null = null;
  let loserId: string | null = null;
  let isDraw = false;
  const p1 = input.player1_score ?? null;
  const p2 = input.player2_score ?? null;

  if (p1 != null && p2 != null) {
    if (p1 === p2) {
      if (isKnockout || !state.config.allow_draws)
        throw new Error("This match needs a winner (no draws allowed).");
      isDraw = true;
    } else {
      winnerId = p1 > p2 ? m.player1_id : m.player2_id;
      loserId = p1 > p2 ? m.player2_id : m.player1_id;
    }
  } else if (input.is_draw) {
    if (isKnockout || !state.config.allow_draws)
      throw new Error("This match needs a winner (no draws allowed).");
    isDraw = true;
  } else if (input.winner_id) {
    if (input.winner_id !== m.player1_id && input.winner_id !== m.player2_id)
      throw new Error("Winner must be one of the two players");
    winnerId = input.winner_id;
    loserId = winnerId === m.player1_id ? m.player2_id : m.player1_id;
  } else {
    throw new Error("Provide a winner, a draw, or both scores");
  }

  m.winner_id = winnerId;
  m.loser_id = loserId;
  m.is_draw = isDraw;
  m.player1_score = p1;
  m.player2_score = p2;
  m.status = "completed";

  if (round.stage === "group") {
    maybeAdvanceGroup(state, round);
  } else if (round.stage === "playoff") {
    resolveSeedingPlayoff(state, matchId);
  } else {
    propagateKnockout(state, matchId);
  }
  return state;
}

// ---------------------------------------------------------------------------
// Progression
// ---------------------------------------------------------------------------

function roundPending(state: EngineState, roundId: string): boolean {
  return state.matches.some(
    (m) => m.round_id === roundId && m.status !== "completed",
  );
}

function groupStagePending(state: EngineState): boolean {
  const groupRoundIds = new Set(
    state.rounds.filter((r) => r.stage === "group").map((r) => r.id),
  );
  return state.matches.some(
    (m) => groupRoundIds.has(m.round_id) && m.status !== "completed",
  );
}

function completeRound(state: EngineState, roundId: string) {
  const r = state.rounds.find((x) => x.id === roundId);
  if (r) r.status = "completed";
}

function maxRoundNumber(state: EngineState): number {
  return state.rounds.reduce((mx, r) => Math.max(mx, r.round_number), 0);
}

function maybeAdvanceGroup(state: EngineState, round: Round) {
  const t = state.config;
  if (t.format === "round_robin") {
    if (!roundPending(state, round.id)) completeRound(state, round.id);
    if (groupStagePending(state)) return;
    buildKnockoutFromStandings(state, 0);
    return;
  }

  // swiss_knockout / progress_stepladder
  if (roundPending(state, round.id)) return;
  completeRound(state, round.id);

  if (round.round_number < t.num_group_rounds) {
    generateNextGroupRound(state, round.round_number + 1);
  } else if (t.format === "progress_stepladder") {
    buildStepladderFromStandings(state, round.round_number + 1);
  } else {
    buildKnockoutFromStandings(state, round.round_number + 1);
  }
}

function generateNextGroupRound(state: EngineState, roundNumber: number) {
  const rankedIds = standings(state).map((s) => s.player.id);
  const playedKeys = new Set<string>();
  const hadBye = new Set<string>();
  for (const m of state.matches) {
    if (m.is_bye && m.player1_id) hadBye.add(m.player1_id);
    if (m.player1_id && m.player2_id)
      playedKeys.add(pairKey(m.player1_id, m.player2_id));
  }
  const pairings = swissPairings(rankedIds, playedKeys, hadBye);
  const round = addRound(state, roundNumber, "group", `Round ${roundNumber}`, "active");
  state.matches.push(...groupMatchesFromPairings(state, round.id, pairings));
}

function buildKnockoutFromStandings(state: EngineState, startRoundNumber: number) {
  const start = Math.max(startRoundNumber, maxRoundNumber(state) + 1);
  const rows = standings(state);
  const k = Math.min(state.config.knockout_size || 0, rows.length);
  if (k < 2) {
    state.status = "completed";
    return;
  }
  const seeded = rows.slice(0, k).map((s) => s.player.id);
  buildKnockoutPlan(state, seeded, start);
  state.status = "knockout";
  resolveByes(state);
}

function buildStepladderFromStandings(state: EngineState, startRoundNumber: number) {
  const start = Math.max(startRoundNumber, maxRoundNumber(state) + 1);
  const rows = standings(state);
  const desired = state.config.knockout_size >= 4 ? 4 : 3;
  const k = Math.min(desired, rows.length);
  if (k < 2) {
    state.status = "completed";
    return;
  }

  // A seeding play-off is only sound for a 3-seed ladder, where it cleanly
  // REPLACES the semi-final (play-off winner goes straight to the Final, loser
  // is out). For a 4-seed ladder it would re-pair the play-off opponents in the
  // Semi-final (see development/12 §2, P6), so we instead resolve the 2nd/3rd
  // order by the existing standings tiebreakers — no extra match, no rematch.
  if (k === 3 && rows[1].points === rows[2].points) {
    buildSeedingPlayoff(state, start, rows[1].player.id, rows[2].player.id);
    return;
  }

  const seeds = rows.slice(0, k).map((s) => s.player.id);
  buildStepladderPlan(state, seeds, start);
  state.status = "knockout";
}

function buildSeedingPlayoff(
  state: EngineState,
  startRoundNumber: number,
  aId: string,
  bId: string,
) {
  const round = addRound(state, startRoundNumber, "playoff", "Seeding play-off", "active");
  const m = blankMatch(state, round.id, 1);
  m.player1_id = aId;
  m.player2_id = bId;
  m.status = "ready";
  m.label = "Seeding play-off (2nd v 3rd)";
  state.matches.push(m);
  state.status = "knockout";
}

function resolveSeedingPlayoff(state: EngineState, matchId: string) {
  const m = state.matches.find((x) => x.id === matchId)!;
  if (!m.winner_id) return;
  completeRound(state, m.round_id);

  const rows = standings(state);
  const s1 = rows[0].player.id;
  const maxRound = maxRoundNumber(state);

  // A seeding play-off is only ever created for a 3-seed ladder (see
  // buildStepladderFromStandings), so the play-off winner goes straight to the
  // Final vs the 1st seed — the loser is out, with no Semi-final rematch.
  const finalRound = addRound(state, maxRound + 1, "final", "Final", "active");
  const finalMatch = blankMatch(state, finalRound.id, 1);
  finalMatch.label = "Final";
  finalMatch.player1_id = s1;
  finalMatch.player2_id = m.winner_id;
  finalMatch.status = "ready";
  state.matches.push(finalMatch);
}

function propagateKnockout(state: EngineState, matchId: string) {
  const m = state.matches.find((x) => x.id === matchId)!;
  if (!m.winner_id) return;

  if (!m.next_match_id) {
    completeRound(state, m.round_id);
    state.status = "completed";
    return;
  }

  const next = state.matches.find((x) => x.id === m.next_match_id)!;
  if (m.next_slot === 1) next.player1_id = m.winner_id;
  else next.player2_id = m.winner_id;

  if (!roundPending(state, m.round_id)) completeRound(state, m.round_id);

  if (next.player1_id && next.player2_id && next.status === "pending")
    next.status = "ready";
}

function resolveByes(state: EngineState) {
  for (let guard = 0; guard < 256; guard++) {
    const m = state.matches.find(
      (x) =>
        x.status !== "completed" &&
        x.player1_id != null &&
        x.player2_id == null &&
        x.next_slot != null,
    );
    if (!m) break;
    m.winner_id = m.player1_id;
    m.status = "completed";
    m.is_bye = true;
    propagateKnockout(state, m.id);
  }
}

// ---------------------------------------------------------------------------
// Convenience for tests / simulation
// ---------------------------------------------------------------------------

/** The resolved champion once completed, else null. */
export function champion(state: EngineState): string | null {
  if (state.status !== "completed") return null;
  const finals = state.matches
    .filter((m) => m.status === "completed" && m.winner_id && !m.next_match_id)
    .filter((m) => {
      const r = state.rounds.find((x) => x.id === m.round_id);
      return r && r.stage !== "group";
    });
  if (finals.length) return finals[finals.length - 1].winner_id;
  const rows = standings(state);
  return rows.length ? rows[0].player.id : null;
}
