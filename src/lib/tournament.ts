import "server-only";
import { randomUUID } from "crypto";
import type postgres from "postgres";
import { sql, withTenant } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { computeStandings, type ScoringConfig } from "@/lib/standings";
import {
  diffState,
  engineFromBundle,
  recordResult as engineRecordResult,
  start as engineStart,
  type EngineDiff,
} from "@/lib/engine";
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
// Round / match persistence
//
// All progression logic (pairings, brackets, stepladder, byes) lives in the
// pure engine (src/lib/engine.ts) so production and the test suite run the exact
// same rules. This module only loads the DB bundle, runs the engine, and
// persists the resulting diff.
// ---------------------------------------------------------------------------

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

/**
 * Persist the difference between the pre-mutation DB state and the state the
 * engine produced: insert new rounds/matches, update rounds whose status
 * changed, and update matches whose mutable fields changed. next_match_id /
 * next_slot are fixed at creation, so they only ride along on new matches.
 */
async function persistEngineDiff(
  tx: Tx,
  tournamentId: string,
  diff: EngineDiff,
) {
  await insertRounds(tx, tournamentId, diff.newRounds);
  for (const r of diff.updatedRounds) {
    await tx`update rounds set status = ${r.status} where id = ${r.id}`;
  }
  await insertMatches(tx, tournamentId, diff.newMatches);
  for (const m of diff.updatedMatches) {
    await tx`update matches set
        player1_id = ${m.player1_id},
        player2_id = ${m.player2_id},
        winner_id = ${m.winner_id},
        loser_id = ${m.loser_id},
        player1_score = ${m.player1_score},
        player2_score = ${m.player2_score},
        is_draw = ${m.is_draw},
        is_bye = ${m.is_bye},
        status = ${m.status}
      where id = ${m.id}`;
  }
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

export async function startTournament(
  tournamentId: string,
  orgId: string,
  actor: string | null = null,
): Promise<void> {
  await withTenant(orgId, async (tx) => {
    const [t] = await tx<Tournament[]>`
      select * from tournaments where id = ${tournamentId} for update`;
    if (!t) throw new HttpError(404, "Tournament not found");
    if (t.status !== "setup") throw new HttpError(409, "Tournament already started");

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
    // Delegate all bracket/pairing construction to the pure engine, then
    // persist what it produced.
    const state = engineFromBundle(
      { tournament: t, players, rounds: [], matches: [] },
      randomUUID,
    );
    engineStart(state);
    await persistEngineDiff(
      tx,
      tournamentId,
      diffState({ rounds: [], matches: [] }, state),
    );
    await tx`update tournaments set status = ${state.status} where id = ${tournamentId}`;
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
  orgId: string,
  matchId: string,
  input: ResultInput,
  actor: string | null = null,
): Promise<void> {
  await withTenant(orgId, async (tx) => {
    const [t] = await tx<Tournament[]>`
      select * from tournaments where id = ${tournamentId} for update`;
    if (!t) throw new HttpError(404, "Tournament not found");

    const bundle = await loadForCompute(tx, tournamentId);
    const m = bundle.matches.find((x) => x.id === matchId);
    if (!m) throw new HttpError(404, "Match not found");
    if (m.status === "completed") throw new HttpError(409, "Match already decided");

    // Run the recording + all downstream progression in the pure engine. It
    // validates the outcome (both players present, no draws in knockout, winner
    // is a participant) and throws with the same messages as before on bad
    // input, so nothing is persisted for an invalid request.
    const before = { rounds: bundle.rounds, matches: bundle.matches };
    const state = engineFromBundle(
      { tournament: t, players: bundle.players, rounds: bundle.rounds, matches: bundle.matches },
      randomUUID,
    );
    engineRecordResult(state, matchId, input);

    await takeSnapshot(tx, tournamentId, "record_result");
    await refreshUndoBudget(tx, tournamentId);
    await persistEngineDiff(tx, tournamentId, diffState(before, state));
    await tx`update tournaments set status = ${state.status} where id = ${tournamentId}`;

    // Audit entry with readable player names, read from the decided match.
    const rm = state.matches.find((x) => x.id === matchId)!;
    const round = bundle.rounds.find((r) => r.id === m.round_id);
    const nameOf = (pid: string | null) =>
      bundle.players.find((p) => p.id === pid)?.name ?? "?";
    const stageLabel = round?.name ? `${round.name}: ` : "";
    let summary: string;
    if (rm.is_draw) {
      summary = `${stageLabel}${nameOf(m.player1_id)} drew with ${nameOf(m.player2_id)}`;
    } else if (rm.player1_score != null && rm.player2_score != null) {
      summary = `${stageLabel}${nameOf(m.player1_id)} ${rm.player1_score}–${rm.player2_score} ${nameOf(m.player2_id)}`;
    } else {
      summary = `${stageLabel}${nameOf(rm.winner_id)} beat ${nameOf(rm.loser_id)}`;
    }
    await writeAudit(tx, tournamentId, actor, "record_result", summary, {
      match_id: matchId,
      round: round?.name ?? null,
      winner_id: rm.winner_id,
      loser_id: rm.loser_id,
      is_draw: rm.is_draw,
      player1_score: rm.player1_score,
      player2_score: rm.player2_score,
    });
  });
}

// ---------------------------------------------------------------------------
// Check-in
// ---------------------------------------------------------------------------

export async function setCheckIn(
  tournamentId: string,
  orgId: string,
  playerId: string,
  checkedIn: boolean,
  actor: string | null = null,
): Promise<void> {
  await withTenant(orgId, async (tx) => {
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
  orgId: string,
  inputs: PlayerInput[],
  actor: string | null = null,
): Promise<Player[]> {
  if (inputs.length === 0) throw new Error("Add at least one player");

  return withTenant(orgId, async (tx) => {
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
      "create",
      `Added ${label}`,
      { player_ids: added.map((p) => p.id) },
    );
    return added;
  });
}

/** Remove a player while the tournament is still in setup (min 2 remain). */
export async function removePlayer(
  tournamentId: string,
  orgId: string,
  playerId: string,
  actor: string | null = null,
): Promise<void> {
  await withTenant(orgId, async (tx) => {
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
    if (!removed) throw new HttpError(404, "Player not found");

    await writeAudit(
      tx,
      tournamentId,
      actor,
      "reset",
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
  orgId: string,
  actor: string | null = null,
): Promise<void> {
  await withTenant(orgId, async (tx) => {
    const [t] = await tx<Tournament[]>`
      select * from tournaments where id = ${tournamentId} for update`;
    if (!t) throw new HttpError(404, "Tournament not found");
    if (t.undo_remaining <= 0)
      throw new HttpError(409, "Undo limit reached (max 3 steps).");

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
    if (!evt) throw new HttpError(409, "Nothing to undo.");

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
  orgId: string,
  actor: string | null = null,
): Promise<void> {
  await withTenant(orgId, async (tx) => {
    const [t] = await tx<{ status: string }[]>`
      select status from tournaments where id = ${tournamentId} for update`;
    if (!t) throw new HttpError(404, "Tournament not found");
    if (t.status === "completed")
      throw new HttpError(409, "This tournament is finished — reset is disabled.");
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
export async function deleteTournament(
  tournamentId: string,
  orgId: string,
): Promise<void> {
  await withTenant(orgId, async (tx) => {
    const [t] = await tx<{ status: string }[]>`
      select status from tournaments where id = ${tournamentId} for update`;
    if (!t) throw new HttpError(404, "Tournament not found");
    if (t.status !== "setup")
      throw new HttpError(409, "Only tournaments that have not started can be deleted");
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
