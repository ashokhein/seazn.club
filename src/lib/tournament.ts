import "server-only";
import { randomUUID } from "crypto";
import type postgres from "postgres";
import { sql } from "@/lib/db";
import { computeStandings, type ScoringConfig } from "@/lib/standings";
import {
  knockoutFirstRound,
  nextPowerOfTwo,
  pairKey,
  roundRobinRounds,
  swissPairings,
} from "@/lib/pairing";
import type { Match, Player, PlayerInput, Round, Tournament } from "@/lib/types";

// A transaction handle (the `sql` passed into sql.begin's callback).
type Tx = postgres.TransactionSql;

export interface TournamentBundle {
  tournament: Tournament;
  players: Player[];
  rounds: Round[];
  matches: Match[];
}

const ROUND_COLS = [
  "id",
  "tournament_id",
  "round_number",
  "stage",
  "name",
  "status",
] as const;

const MATCH_COLS = [
  "id",
  "tournament_id",
  "round_id",
  "board_number",
  "player1_id",
  "player2_id",
  "winner_id",
  "loser_id",
  "player1_score",
  "player2_score",
  "is_draw",
  "next_match_id",
  "next_slot",
  "is_bye",
  "status",
  "label",
] as const;

const PLAYER_COLS = [
  "id",
  "tournament_id",
  "name",
  "seed",
  "checked_in",
  "image_url",
] as const;

function cfgOf(t: Tournament): ScoringConfig {
  return {
    points_win: t.points_win,
    points_draw: t.points_draw,
    points_loss: t.points_loss,
    use_progress_score: t.use_progress_score,
  };
}

// ---------------------------------------------------------------------------
// Loaders
// ---------------------------------------------------------------------------

/** Full state used by the live view / slideshow (bundle + computed standings). */
export async function loadState(tournamentId: string) {
  const bundle = await loadBundle(tournamentId);
  if (!bundle) return null;
  const standings = computeStandings(
    bundle.players,
    bundle.rounds,
    bundle.matches,
    cfgOf(bundle.tournament),
  );
  return { ...bundle, standings };
}

export async function loadBundle(
  tournamentId: string,
): Promise<TournamentBundle | null> {
  const [t] = await sql<Tournament[]>`
    select * from tournaments where id = ${tournamentId} limit 1`;
  if (!t) return null;
  const players = await sql<Player[]>`
    select ${sql(PLAYER_COLS as unknown as string[])} from players
    where tournament_id = ${tournamentId} order by seed asc, name asc`;
  const rounds = await sql<Round[]>`
    select ${sql(ROUND_COLS as unknown as string[])} from rounds
    where tournament_id = ${tournamentId} order by round_number asc`;
  const matches = await sql<Match[]>`
    select ${sql(MATCH_COLS as unknown as string[])} from matches
    where tournament_id = ${tournamentId} order by board_number asc`;
  return { tournament: t, players, rounds, matches };
}

// ---------------------------------------------------------------------------
// Snapshots (undo support)
// ---------------------------------------------------------------------------

async function takeSnapshot(tx: Tx, tournamentId: string, action: string) {
  const [t] = await tx`select status from tournaments where id = ${tournamentId}`;
  const rounds = await tx`
    select ${tx(ROUND_COLS as unknown as string[])} from rounds
    where tournament_id = ${tournamentId}`;
  const matches = await tx`
    select ${tx(MATCH_COLS as unknown as string[])} from matches
    where tournament_id = ${tournamentId}`;
  const [{ seq }] = await tx`
    select coalesce(max(seq), 0) + 1 as seq from match_events
    where tournament_id = ${tournamentId}`;
  await tx`
    insert into match_events (tournament_id, seq, action, before_state)
    values (${tournamentId}, ${seq}, ${action},
      ${tx.json({ status: t.status, rounds, matches })})`;
}

async function refreshUndoBudget(tx: Tx, tournamentId: string) {
  await tx`update tournaments set undo_remaining = 3 where id = ${tournamentId}`;
}

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

/** Append a human-readable audit entry. Safe to call inside a transaction. */
export async function writeAudit(
  db: Tx,
  tournamentId: string | null,
  actor: string | null,
  action: string,
  summary: string,
  detail?: Record<string, unknown>,
): Promise<void> {
  await db`
    insert into audit_log (tournament_id, actor, action, summary, detail)
    values (${tournamentId}, ${actor ?? null}, ${action}, ${summary},
      ${db.json((detail ?? {}) as never)})`;
}

// ---------------------------------------------------------------------------
// Round / match builders
// ---------------------------------------------------------------------------

function knockoutRoundName(matchCount: number): string {
  if (matchCount === 1) return "Final";
  if (matchCount === 2) return "Semi-final";
  if (matchCount === 4) return "Quarter-final";
  return `Round of ${matchCount * 2}`;
}

interface NewRound {
  id: string;
  round_number: number;
  stage: Round["stage"];
  name: string;
  status: Round["status"];
}

interface NewMatch {
  id: string;
  round_id: string;
  board_number: number;
  player1_id: string | null;
  player2_id: string | null;
  winner_id: string | null;
  loser_id: string | null;
  player1_score: number | null;
  player2_score: number | null;
  is_draw: boolean;
  next_match_id: string | null;
  next_slot: number | null;
  is_bye: boolean;
  status: Match["status"];
  label: string | null;
}

function blankMatch(round_id: string, board: number): NewMatch {
  return {
    id: randomUUID(),
    round_id,
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

async function insertRounds(tx: Tx, tournamentId: string, rounds: NewRound[]) {
  if (!rounds.length) return;
  await tx`insert into rounds ${tx(
    rounds.map((r) => ({ ...r, tournament_id: tournamentId })),
    "id",
    "tournament_id",
    "round_number",
    "stage",
    "name",
    "status",
  )}`;
}

const MATCH_INSERT_COLS = [
  "id",
  "tournament_id",
  "round_id",
  "board_number",
  "player1_id",
  "player2_id",
  "winner_id",
  "loser_id",
  "player1_score",
  "player2_score",
  "is_draw",
  "next_match_id",
  "next_slot",
  "is_bye",
  "status",
  "label",
] as const;

async function insertMatches(tx: Tx, tournamentId: string, matches: NewMatch[]) {
  if (!matches.length) return;
  await tx`insert into matches ${tx(
    matches.map((m) => ({
      id: m.id,
      tournament_id: tournamentId,
      round_id: m.round_id,
      board_number: m.board_number,
      player1_id: m.player1_id,
      player2_id: m.player2_id,
      winner_id: m.winner_id,
      loser_id: m.loser_id,
      player1_score: m.player1_score,
      player2_score: m.player2_score,
      is_draw: m.is_draw,
      next_match_id: null, // wired up in phase 2
      next_slot: m.next_slot,
      is_bye: m.is_bye,
      status: m.status,
      label: m.label,
    })),
    ...MATCH_INSERT_COLS,
  )}`;
  for (const m of matches) {
    if (m.next_match_id) {
      await tx`update matches set next_match_id = ${m.next_match_id}
        where id = ${m.id}`;
    }
  }
}

function buildKnockoutPlan(
  rankedIds: string[],
  startRoundNumber: number,
): { rounds: NewRound[]; matches: NewMatch[] } {
  const size = nextPowerOfTwo(Math.max(2, rankedIds.length));
  const numRounds = Math.log2(size);
  const rounds: NewRound[] = [];
  const matchIdsByRound: string[][] = [];

  for (let r = 0; r < numRounds; r++) {
    const matchCount = size / Math.pow(2, r + 1);
    matchIdsByRound.push(Array.from({ length: matchCount }, () => randomUUID()));
    rounds.push({
      id: randomUUID(),
      round_number: startRoundNumber + r,
      stage: matchCount === 1 ? "final" : "knockout",
      name: knockoutRoundName(matchCount),
      status: "active",
    });
  }

  const matches: NewMatch[] = [];
  const firstRound = knockoutFirstRound(rankedIds);
  for (let r = 0; r < numRounds; r++) {
    const ids = matchIdsByRound[r];
    const round = rounds[r];
    for (let i = 0; i < ids.length; i++) {
      const next =
        r < numRounds - 1
          ? { id: matchIdsByRound[r + 1][Math.floor(i / 2)], slot: (i % 2) + 1 }
          : null;
      const base = blankMatch(round.id, i + 1);
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
      matches.push(base);
    }
  }
  return { rounds, matches };
}

function groupMatchesFromPairings(
  roundId: string,
  pairings: { player1: string; player2: string | null }[],
): NewMatch[] {
  return pairings.map((p, i) => {
    const m = blankMatch(roundId, i + 1);
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

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

export async function startTournament(
  tournamentId: string,
  actor: string | null = null,
): Promise<void> {
  await sql.begin(async (tx) => {
    const [t] = await tx<Tournament[]>`
      select * from tournaments where id = ${tournamentId} for update`;
    if (!t) throw new Error("Tournament not found");
    if (t.status !== "setup") throw new Error("Tournament already started");

    const players = await tx<Player[]>`
      select ${tx(PLAYER_COLS as unknown as string[])} from players
      where tournament_id = ${tournamentId} and checked_in = true
      order by seed asc, name asc`;
    if (players.length < 2)
      throw new Error("Need at least 2 checked-in players");

    await takeSnapshot(tx, tournamentId, "start");
    await writeAudit(
      tx,
      tournamentId,
      actor,
      "start",
      `Started the tournament with ${players.length} ${
        players.length === 1 ? "entrant" : "entrants"
      }`,
      { players: players.length, format: t.format },
    );
    const ids = players.map((p) => p.id);

    if (t.format === "knockout") {
      const plan = buildKnockoutPlan(ids, 1);
      await insertRounds(tx, tournamentId, plan.rounds);
      await insertMatches(tx, tournamentId, plan.matches);
      await tx`update tournaments set status = 'knockout' where id = ${tournamentId}`;
      await resolveByes(tx, tournamentId);
    } else if (t.format === "round_robin") {
      const schedule = roundRobinRounds(ids);
      const newRounds: NewRound[] = [];
      const newMatches: NewMatch[] = [];
      schedule.forEach((pairs, idx) => {
        const roundId = randomUUID();
        newRounds.push({
          id: roundId,
          round_number: idx + 1,
          stage: "group",
          name: `Round ${idx + 1}`,
          status: "active",
        });
        newMatches.push(...groupMatchesFromPairings(roundId, pairs));
      });
      await insertRounds(tx, tournamentId, newRounds);
      await insertMatches(tx, tournamentId, newMatches);
      await tx`update tournaments set status = 'group' where id = ${tournamentId}`;
    } else {
      // swiss_knockout: first progress round by seed order.
      const pairings = swissPairings(ids, new Set(), new Set());
      const roundId = randomUUID();
      await insertRounds(tx, tournamentId, [
        {
          id: roundId,
          round_number: 1,
          stage: "group",
          name: "Round 1",
          status: "active",
        },
      ]);
      await insertMatches(
        tx,
        tournamentId,
        groupMatchesFromPairings(roundId, pairings),
      );
      await tx`update tournaments set status = 'group' where id = ${tournamentId}`;
    }
    await refreshUndoBudget(tx, tournamentId);
  });
}

// ---------------------------------------------------------------------------
// Record result (winner tap OR scores OR draw)
// ---------------------------------------------------------------------------

export interface ResultInput {
  winner_id?: string | null;
  player1_score?: number | null;
  player2_score?: number | null;
  is_draw?: boolean;
}

export async function recordResult(
  tournamentId: string,
  matchId: string,
  input: ResultInput,
  actor: string | null = null,
): Promise<void> {
  await sql.begin(async (tx) => {
    const [t] = await tx<Tournament[]>`
      select * from tournaments where id = ${tournamentId} for update`;
    if (!t) throw new Error("Tournament not found");

    const [m] = await tx<Match[]>`
      select ${tx(MATCH_COLS as unknown as string[])} from matches
      where id = ${matchId} and tournament_id = ${tournamentId}`;
    if (!m) throw new Error("Match not found");
    if (m.status === "completed") throw new Error("Match already decided");
    if (!m.player1_id || !m.player2_id)
      throw new Error("Both players must be present");

    const [round] = await tx<Round[]>`
      select ${tx(ROUND_COLS as unknown as string[])} from rounds
      where id = ${m.round_id}`;
    const isKnockout = round.stage !== "group";

    // Resolve the outcome.
    let winnerId: string | null = null;
    let loserId: string | null = null;
    let isDraw = false;
    const p1 = input.player1_score ?? null;
    const p2 = input.player2_score ?? null;

    if (p1 != null && p2 != null) {
      if (p1 === p2) {
        if (isKnockout || !t.allow_draws)
          throw new Error("This match needs a winner (no draws allowed).");
        isDraw = true;
      } else {
        winnerId = p1 > p2 ? m.player1_id : m.player2_id;
        loserId = p1 > p2 ? m.player2_id : m.player1_id;
      }
    } else if (input.is_draw) {
      if (isKnockout || !t.allow_draws)
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

    await takeSnapshot(tx, tournamentId, "record_result");
    await refreshUndoBudget(tx, tournamentId);

    await tx`update matches set
        winner_id = ${winnerId}, loser_id = ${loserId}, is_draw = ${isDraw},
        player1_score = ${p1}, player2_score = ${p2}, status = 'completed'
      where id = ${matchId}`;

    // Audit entry with readable player names.
    const names = await tx<{ id: string; name: string }[]>`
      select id, name from players
      where id in (${m.player1_id}, ${m.player2_id})`;
    const nameOf = (pid: string | null) =>
      names.find((n) => n.id === pid)?.name ?? "?";
    const stageLabel = round?.name ? `${round.name}: ` : "";
    let summary: string;
    if (isDraw) {
      summary = `${stageLabel}${nameOf(m.player1_id)} drew with ${nameOf(m.player2_id)}`;
    } else if (p1 != null && p2 != null) {
      summary = `${stageLabel}${nameOf(m.player1_id)} ${p1}–${p2} ${nameOf(m.player2_id)}`;
    } else {
      summary = `${stageLabel}${nameOf(winnerId)} beat ${nameOf(loserId)}`;
    }
    await writeAudit(tx, tournamentId, actor, "record_result", summary, {
      match_id: matchId,
      round: round?.name ?? null,
      winner_id: winnerId,
      loser_id: loserId,
      is_draw: isDraw,
      player1_score: p1,
      player2_score: p2,
    });

    if (round.stage === "group") {
      await maybeAdvanceGroup(tx, t, round);
    } else if (round.stage === "playoff") {
      await resolveSeedingPlayoff(tx, t, matchId);
    } else {
      await propagateKnockout(tx, tournamentId, matchId);
    }
  });
}

/** Group / round-robin progression. */
async function maybeAdvanceGroup(tx: Tx, t: Tournament, round: Round) {
  if (t.format === "round_robin") {
    // mark this round complete (cosmetic) if done
    const roundPending = await tx`
      select 1 from matches where round_id = ${round.id}
      and status <> 'completed' limit 1`;
    if (!roundPending.length)
      await tx`update rounds set status = 'completed' where id = ${round.id}`;

    const anyPending = await tx`
      select 1 from matches m join rounds r on r.id = m.round_id
      where r.tournament_id = ${t.id} and r.stage = 'group'
        and m.status <> 'completed' limit 1`;
    if (anyPending.length) return;
    await buildKnockoutFromStandings(tx, t, 0);
    return;
  }

  // swiss_knockout
  const pending = await tx`
    select 1 from matches where round_id = ${round.id}
    and status <> 'completed' limit 1`;
  if (pending.length) return;
  await tx`update rounds set status = 'completed' where id = ${round.id}`;

  if (round.round_number < t.num_group_rounds) {
    await generateNextGroupRound(tx, t, round.round_number + 1);
  } else if (t.format === "progress_stepladder") {
    await buildStepladderFromStandings(tx, t, round.round_number + 1);
  } else {
    await buildKnockoutFromStandings(tx, t, round.round_number + 1);
  }
}

async function generateNextGroupRound(tx: Tx, t: Tournament, roundNumber: number) {
  const { players, rounds, matches } = await loadForCompute(tx, t.id);
  const standings = computeStandings(players, rounds, matches, cfgOf(t));
  const rankedIds = standings.map((s) => s.player.id);

  const playedKeys = new Set<string>();
  const hadBye = new Set<string>();
  for (const m of matches) {
    if (m.is_bye && m.player1_id) hadBye.add(m.player1_id);
    if (m.player1_id && m.player2_id)
      playedKeys.add(pairKey(m.player1_id, m.player2_id));
  }

  const pairings = swissPairings(rankedIds, playedKeys, hadBye);
  const roundId = randomUUID();
  await insertRounds(tx, t.id, [
    {
      id: roundId,
      round_number: roundNumber,
      stage: "group",
      name: `Round ${roundNumber}`,
      status: "active",
    },
  ]);
  await insertMatches(tx, t.id, groupMatchesFromPairings(roundId, pairings));
}

async function buildKnockoutFromStandings(
  tx: Tx,
  t: Tournament,
  startRoundNumber: number,
) {
  const { players, rounds, matches } = await loadForCompute(tx, t.id);
  // Knockout rounds continue after the last existing round number.
  const maxRound = rounds.reduce((mx, r) => Math.max(mx, r.round_number), 0);
  const start = Math.max(startRoundNumber, maxRound + 1);

  const standings = computeStandings(players, rounds, matches, cfgOf(t));
  const k = Math.min(t.knockout_size || 0, standings.length);
  if (k < 2) {
    await tx`update tournaments set status = 'completed' where id = ${t.id}`;
    return;
  }
  const seeded = standings.slice(0, k).map((s) => s.player.id);
  const plan = buildKnockoutPlan(seeded, start);
  await insertRounds(tx, t.id, plan.rounds);
  await insertMatches(tx, t.id, plan.matches);
  await tx`update tournaments set status = 'knockout' where id = ${t.id}`;
  await resolveByes(tx, t.id);
}

// ---------------------------------------------------------------------------
// Stepladder finals (Top 3 / Top 4)
//   Top 4: Eliminator (3v4) -> Semi-final (2 vs winner) -> Final (1 vs winner)
//   Top 3:                     Semi-final (2v3)         -> Final (1 vs winner)
//   1st gets a bye straight to the Final; 2nd waits in the Semi-final.
//   If 2nd and 3rd are level on points, a one-match seeding play-off decides
//   who takes the 2nd seed before the ladder is built.
// ---------------------------------------------------------------------------

function buildStepladderPlan(
  seedIds: string[],
  startRoundNumber: number,
): { rounds: NewRound[]; matches: NewMatch[] } {
  const rounds: NewRound[] = [];
  const matches: NewMatch[] = [];
  const n = seedIds.length;
  if (n < 2) return { rounds, matches };

  // Only two qualifiers: a single Final.
  if (n === 2) {
    const fr: NewRound = {
      id: randomUUID(),
      round_number: startRoundNumber,
      stage: "final",
      name: "Final",
      status: "active",
    };
    const f = blankMatch(fr.id, 1);
    f.player1_id = seedIds[0];
    f.player2_id = seedIds[1];
    f.status = "ready";
    f.label = "Final";
    return { rounds: [fr], matches: [f] };
  }

  const hasElim = n >= 4;
  const finalRoundNumber = startRoundNumber + (hasElim ? 2 : 1);
  const sfRoundNumber = startRoundNumber + (hasElim ? 1 : 0);

  const finalRound: NewRound = {
    id: randomUUID(),
    round_number: finalRoundNumber,
    stage: "final",
    name: "Final",
    status: "active",
  };
  const finalMatch = blankMatch(finalRound.id, 1);
  finalMatch.label = "Final";
  finalMatch.player1_id = seedIds[0]; // top seed waits in the Final
  finalMatch.status = "pending";

  const sfRound: NewRound = {
    id: randomUUID(),
    round_number: sfRoundNumber,
    stage: "knockout",
    name: "Semi-final",
    status: "active",
  };
  const sfMatch = blankMatch(sfRound.id, 1);
  sfMatch.label = "Semi-final";
  sfMatch.next_match_id = finalMatch.id;
  sfMatch.next_slot = 2;

  if (hasElim) {
    const elimRound: NewRound = {
      id: randomUUID(),
      round_number: startRoundNumber,
      stage: "knockout",
      name: "Eliminator",
      status: "active",
    };
    const elim = blankMatch(elimRound.id, 1);
    elim.label = "Eliminator (3rd v 4th)";
    elim.player1_id = seedIds[2];
    elim.player2_id = seedIds[3];
    elim.status = "ready";
    elim.next_match_id = sfMatch.id;
    elim.next_slot = 2;

    sfMatch.player1_id = seedIds[1]; // 2nd seed waits in the Semi-final
    sfMatch.player2_id = null;
    sfMatch.status = "pending";

    rounds.push(elimRound, sfRound, finalRound);
    matches.push(elim, sfMatch, finalMatch);
  } else {
    sfMatch.player1_id = seedIds[1];
    sfMatch.player2_id = seedIds[2];
    sfMatch.status = "ready";
    rounds.push(sfRound, finalRound);
    matches.push(sfMatch, finalMatch);
  }

  return { rounds, matches };
}

async function buildStepladderFromStandings(
  tx: Tx,
  t: Tournament,
  startRoundNumber: number,
) {
  const { players, rounds, matches } = await loadForCompute(tx, t.id);
  const maxRound = rounds.reduce((mx, r) => Math.max(mx, r.round_number), 0);
  const start = Math.max(startRoundNumber, maxRound + 1);

  const standings = computeStandings(players, rounds, matches, cfgOf(t));
  // Ladder size is 3 or 4 (from knockout_size), clamped to the field size.
  const desired = t.knockout_size >= 4 ? 4 : 3;
  const k = Math.min(desired, standings.length);
  if (k < 2) {
    await tx`update tournaments set status = 'completed' where id = ${t.id}`;
    return;
  }

  // Tiebreak: if 2nd and 3rd are level on points, settle the 2nd seed first.
  if (k >= 3 && standings[1].points === standings[2].points) {
    await buildSeedingPlayoff(
      tx,
      t,
      start,
      standings[1].player.id,
      standings[2].player.id,
    );
    return;
  }

  const seeds = standings.slice(0, k).map((s) => s.player.id);
  const plan = buildStepladderPlan(seeds, start);
  await insertRounds(tx, t.id, plan.rounds);
  await insertMatches(tx, t.id, plan.matches);
  await tx`update tournaments set status = 'knockout' where id = ${t.id}`;
}

async function buildSeedingPlayoff(
  tx: Tx,
  t: Tournament,
  startRoundNumber: number,
  aId: string,
  bId: string,
) {
  const roundId = randomUUID();
  await insertRounds(tx, t.id, [
    {
      id: roundId,
      round_number: startRoundNumber,
      stage: "playoff",
      name: "Seeding play-off",
      status: "active",
    },
  ]);
  const m = blankMatch(roundId, 1);
  m.player1_id = aId;
  m.player2_id = bId;
  m.status = "ready";
  m.label = "Seeding play-off (2nd v 3rd)";
  await insertMatches(tx, t.id, [m]);
  await tx`update tournaments set status = 'knockout' where id = ${t.id}`;
}

async function resolveSeedingPlayoff(tx: Tx, t: Tournament, matchId: string) {
  const [m] = await tx<Match[]>`
    select ${tx(MATCH_COLS as unknown as string[])} from matches
    where id = ${matchId}`;
  if (!m?.winner_id) return;
  const loser = m.player1_id === m.winner_id ? m.player2_id : m.player1_id;
  await tx`update rounds set status = 'completed' where id = ${m.round_id}`;

  const { players, rounds, matches } = await loadForCompute(tx, t.id);
  const standings = computeStandings(players, rounds, matches, cfgOf(t));
  const desired = t.knockout_size >= 4 ? 4 : 3;
  const k = Math.min(desired, standings.length);
  const s1 = standings[0].player.id;
  const maxRound = rounds.reduce((mx, r) => Math.max(mx, r.round_number), 0);

  if (k < 4) {
    // With only three players the play-off already settled 2nd v 3rd — the
    // winner goes straight to the Final vs 1st; no Semi-final rematch.
    const finalRound: NewRound = {
      id: randomUUID(),
      round_number: maxRound + 1,
      stage: "final",
      name: "Final",
      status: "active",
    };
    const finalMatch = blankMatch(finalRound.id, 1);
    finalMatch.label = "Final";
    finalMatch.player1_id = s1;
    finalMatch.player2_id = m.winner_id;
    finalMatch.status = "ready";
    await insertRounds(tx, t.id, [finalRound]);
    await insertMatches(tx, t.id, [finalMatch]);
    return;
  }

  const seeds = [s1, m.winner_id, loser as string, standings[3].player.id];
  const plan = buildStepladderPlan(seeds, maxRound + 1);
  await insertRounds(tx, t.id, plan.rounds);
  await insertMatches(tx, t.id, plan.matches);
}

// ---------------------------------------------------------------------------
// Knockout propagation
// ---------------------------------------------------------------------------

async function propagateKnockout(tx: Tx, tournamentId: string, matchId: string) {
  const [m] = await tx<Match[]>`
    select ${tx(MATCH_COLS as unknown as string[])} from matches
    where id = ${matchId}`;
  if (!m?.winner_id) return;

  if (!m.next_match_id) {
    await tx`update rounds set status = 'completed' where id = ${m.round_id}`;
    await tx`update tournaments set status = 'completed' where id = ${tournamentId}`;
    return;
  }

  const slotCol = m.next_slot === 1 ? "player1_id" : "player2_id";
  await tx`update matches set ${tx(slotCol)} = ${m.winner_id}
    where id = ${m.next_match_id}`;

  const remaining = await tx`
    select 1 from matches where round_id = ${m.round_id}
    and status <> 'completed' limit 1`;
  if (!remaining.length)
    await tx`update rounds set status = 'completed' where id = ${m.round_id}`;

  const [next] = await tx<Match[]>`
    select ${tx(MATCH_COLS as unknown as string[])} from matches
    where id = ${m.next_match_id}`;
  if (next && next.player1_id && next.player2_id && next.status === "pending")
    await tx`update matches set status = 'ready' where id = ${next.id}`;
}

async function resolveByes(tx: Tx, tournamentId: string) {
  for (let guard = 0; guard < 64; guard++) {
    const byes = await tx<Match[]>`
      select ${tx(MATCH_COLS as unknown as string[])} from matches
      where tournament_id = ${tournamentId}
        and status <> 'completed'
        and player1_id is not null and player2_id is null
        and next_slot is not null limit 1`;
    if (!byes.length) break;
    const m = byes[0];
    await tx`update matches
      set winner_id = ${m.player1_id}, status = 'completed', is_bye = true
      where id = ${m.id}`;
    await propagateKnockout(tx, tournamentId, m.id);
  }
}

// ---------------------------------------------------------------------------
// Check-in
// ---------------------------------------------------------------------------

export async function setCheckIn(
  tournamentId: string,
  playerId: string,
  checkedIn: boolean,
  actor: string | null = null,
): Promise<void> {
  await sql.begin(async (tx) => {
    const [t] = await tx<Tournament[]>`
      select status from tournaments where id = ${tournamentId}`;
    if (!t) throw new Error("Tournament not found");
    if (t.status !== "setup")
      throw new Error("Check-in can only change before the tournament starts");
    const [p] = await tx<{ name: string }[]>`
      update players set checked_in = ${checkedIn}
      where id = ${playerId} and tournament_id = ${tournamentId}
      returning name`;
    if (p) {
      await writeAudit(
        tx,
        tournamentId,
        actor,
        "checkin",
        `${checkedIn ? "Checked in" : "Checked out"} ${p.name}`,
        { player_id: playerId, checked_in: checkedIn },
      );
    }
  });
}

const MAX_TOURNAMENT_PLAYERS = 128;

/**
 * Add one or more players while the tournament is still in setup.
 * Skips duplicate names (case-insensitive). Returns the rows inserted.
 */
export async function addPlayers(
  tournamentId: string,
  inputs: PlayerInput[],
  actor: string | null = null,
): Promise<Player[]> {
  if (inputs.length === 0) throw new Error("Add at least one player");

  return sql.begin(async (tx) => {
    const [t] = await tx<Tournament[]>`
      select status from tournaments where id = ${tournamentId}`;
    if (!t) throw new Error("Tournament not found");
    if (t.status !== "setup")
      throw new Error("Players can only be added before the tournament starts");

    const existing = await tx<Player[]>`
      select ${tx(PLAYER_COLS as unknown as string[])} from players
      where tournament_id = ${tournamentId}
      order by seed asc`;

    if (existing.length + inputs.length > MAX_TOURNAMENT_PLAYERS) {
      throw new Error(`Maximum ${MAX_TOURNAMENT_PLAYERS} players per tournament`);
    }

    const names = new Set(existing.map((p) => p.name.toLowerCase()));
    const pending: { name: string; image_url: string | null }[] = [];
    for (const input of inputs) {
      const name = (typeof input === "string" ? input : input.name).trim();
      if (!name) continue;
      const key = name.toLowerCase();
      if (names.has(key)) continue;
      names.add(key);
      const image =
        typeof input === "string" ? null : (input.image_url?.trim() ?? null);
      pending.push({ name, image_url: image || null });
    }
    if (pending.length === 0) {
      throw new Error("No new players to add (empty or duplicate names)");
    }

    let seed = existing.reduce((max, p) => Math.max(max, p.seed), 0);
    const rows = pending.map((p) => ({
      tournament_id: tournamentId,
      name: p.name,
      seed: ++seed,
      image_url: p.image_url,
    }));

    await tx`insert into players ${tx(
      rows,
      "tournament_id",
      "name",
      "seed",
      "image_url",
    )}`;

    const inserted = await tx<Player[]>`
      select id, tournament_id, name, seed, checked_in, image_url
      from players
      where tournament_id = ${tournamentId}
      order by seed desc
      limit ${pending.length}`;

    const added = [...inserted].reverse();

    const label =
      added.length === 1
        ? added[0].name
        : `${added.length} players (${added.map((p) => p.name).join(", ")})`;
    await writeAudit(
      tx,
      tournamentId,
      actor,
      "checkin",
      `Added ${label}`,
      { player_ids: added.map((p) => p.id) },
    );
    return added;
  });
}

/** Remove a player while the tournament is still in setup (min 2 remain). */
export async function removePlayer(
  tournamentId: string,
  playerId: string,
  actor: string | null = null,
): Promise<void> {
  await sql.begin(async (tx) => {
    const [t] = await tx<Tournament[]>`
      select status from tournaments where id = ${tournamentId}`;
    if (!t) throw new Error("Tournament not found");
    if (t.status !== "setup") {
      throw new Error("Players can only be removed before the tournament starts");
    }

    const [{ count }] = await tx<{ count: string }[]>`
      select count(*)::text as count from players where tournament_id = ${tournamentId}`;
    if (Number(count) <= 2) {
      throw new Error("Need at least 2 players in the tournament");
    }

    const [removed] = await tx<{ name: string }[]>`
      delete from players
      where id = ${playerId} and tournament_id = ${tournamentId}
      returning name`;
    if (!removed) throw new Error("Player not found");

    await writeAudit(
      tx,
      tournamentId,
      actor,
      "checkin",
      `Removed ${removed.name}`,
      { player_id: playerId },
    );
  });
}

// ---------------------------------------------------------------------------
// Undo / Reset
// ---------------------------------------------------------------------------

export async function undoLast(
  tournamentId: string,
  actor: string | null = null,
): Promise<void> {
  await sql.begin(async (tx) => {
    const [t] = await tx<Tournament[]>`
      select * from tournaments where id = ${tournamentId} for update`;
    if (!t) throw new Error("Tournament not found");
    if (t.undo_remaining <= 0)
      throw new Error("Undo limit reached (max 3 steps).");

    const [evt] = await tx<
      {
        id: string;
        action: string;
        before_state: { status: string; rounds: NewRound[]; matches: NewMatch[] };
      }[]
    >`
      select id, action, before_state from match_events
      where tournament_id = ${tournamentId} and undone = false
      order by seq desc limit 1`;
    if (!evt) throw new Error("Nothing to undo.");

    await restoreSnapshot(tx, tournamentId, evt.before_state);
    await tx`update match_events set undone = true where id = ${evt.id}`;
    await tx`update tournaments
      set undo_remaining = undo_remaining - 1, status = ${evt.before_state.status}
      where id = ${tournamentId}`;
    await writeAudit(
      tx,
      tournamentId,
      actor,
      "undo",
      `Undid the last action (${evt.action.replace(/_/g, " ")})`,
      { undone_action: evt.action },
    );
  });
}

async function restoreSnapshot(
  tx: Tx,
  tournamentId: string,
  state: { rounds: NewRound[]; matches: NewMatch[] },
) {
  await tx`delete from matches where tournament_id = ${tournamentId}`;
  await tx`delete from rounds where tournament_id = ${tournamentId}`;
  if (state.rounds.length) {
    await tx`insert into rounds ${tx(
      state.rounds.map((r) => ({ ...r, tournament_id: tournamentId })),
      "id",
      "tournament_id",
      "round_number",
      "stage",
      "name",
      "status",
    )}`;
  }
  const ms = state.matches;
  if (ms.length) {
    await tx`insert into matches ${tx(
      ms.map((m) => ({
        id: m.id,
        tournament_id: tournamentId,
        round_id: m.round_id,
        board_number: m.board_number,
        player1_id: m.player1_id,
        player2_id: m.player2_id,
        winner_id: m.winner_id,
        loser_id: m.loser_id,
        player1_score: m.player1_score ?? null,
        player2_score: m.player2_score ?? null,
        is_draw: m.is_draw ?? false,
        next_match_id: null,
        next_slot: m.next_slot,
        is_bye: m.is_bye,
        status: m.status,
        label: m.label,
      })),
      ...MATCH_INSERT_COLS,
    )}`;
    for (const m of ms) {
      if (m.next_match_id) {
        await tx`update matches set next_match_id = ${m.next_match_id}
          where id = ${m.id}`;
      }
    }
  }
}

export async function resetTournament(
  tournamentId: string,
  actor: string | null = null,
): Promise<void> {
  await sql.begin(async (tx) => {
    const [t] = await tx<{ status: string }[]>`
      select status from tournaments where id = ${tournamentId} for update`;
    if (!t) throw new Error("Tournament not found");
    if (t.status === "completed")
      throw new Error("This tournament is finished — reset is disabled.");
    await tx`delete from matches where tournament_id = ${tournamentId}`;
    await tx`delete from rounds where tournament_id = ${tournamentId}`;
    await tx`delete from match_events where tournament_id = ${tournamentId}`;
    await tx`update tournaments set status = 'setup', undo_remaining = 3
      where id = ${tournamentId}`;
    // Audit log is intentionally preserved across resets.
    await writeAudit(
      tx,
      tournamentId,
      actor,
      "reset",
      "Reset the tournament back to setup",
    );
  });
}

/** Permanently remove a tournament that has not been started yet. */
export async function deleteTournament(tournamentId: string): Promise<void> {
  await sql.begin(async (tx) => {
    const [t] = await tx<{ status: string }[]>`
      select status from tournaments where id = ${tournamentId} for update`;
    if (!t) throw new Error("Tournament not found");
    if (t.status !== "setup") {
      throw new Error("Only tournaments that have not started can be deleted");
    }
    await tx`delete from tournaments where id = ${tournamentId}`;
  });
}

// ---------------------------------------------------------------------------
// Internal helper
// ---------------------------------------------------------------------------

async function loadForCompute(tx: Tx, tournamentId: string) {
  const players = await tx<Player[]>`
    select ${tx(PLAYER_COLS as unknown as string[])} from players
    where tournament_id = ${tournamentId} order by seed asc, name asc`;
  const rounds = await tx<Round[]>`
    select ${tx(ROUND_COLS as unknown as string[])} from rounds
    where tournament_id = ${tournamentId} order by round_number asc`;
  const matches = await tx<Match[]>`
    select ${tx(MATCH_COLS as unknown as string[])} from matches
    where tournament_id = ${tournamentId} order by board_number asc`;
  return { players, rounds, matches };
}
