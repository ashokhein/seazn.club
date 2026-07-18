// Carrom SportModule — engine/sports/carrom.md (PROMPT-16), verified against
// the ICF "Laws of Carrom" (law numbers cited inline; carrom.md §1–7 carries
// the full citations). Points-race grammar: a match is best-of `bestOf` games
// (Law 57), a game is first-to-`gameTo` points or the leader after `maxBoards`
// boards (Law 56a), a board banks the winner's points in one `board.summary`
// event — strike-by-strike fidelity is reserved (carrom.md §6, Pro key
// `scoring.strike_by_strike`), see CarromStrike below.
import { z } from "zod";
import { EngineError } from "../../core/errors.ts";
import type { CoreEv, EventEnvelope } from "../../core/events.ts";
import type { Rng } from "../../core/rng.ts";
import {
  EntrantId,
  type LineupPair,
  type MatchOutcome,
  type ScoreSummary,
  type StageKind,
  type StandingsDelta,
} from "../../core/types.ts";
import type { PositionCatalog } from "../../sport/catalog.ts";
import type { ModuleEvent, SportModule, TiebreakerKey } from "../../sport/module.ts";

// ---------------------------------------------------------------------------
// Cfg — carrom.md §1 (ICF Laws 52, 54, 56, 57)
// ---------------------------------------------------------------------------

export const CarromPoints = z.object({
  win: z.number().int().nonnegative().default(2),
  loss: z.number().int().nonnegative().default(0),
  draw: z.number().int().nonnegative().default(1),
});

export const CarromCfg = z
  .object({
    gameTo: z.number().int().positive().default(25), // Law 56a
    maxBoards: z.number().int().positive().default(8), // Law 56a
    bestOf: z.number().int().positive().default(3), // Law 57
    queenPoints: z.number().int().nonnegative().default(3), // Law 52(b)(i)
    // Queen scores only while the winner's PRE-board score is < queenCapAt:
    // "3 points up to and including 21 points" (Law 52(b)(i)), lost "once he
    // has reached the score of 22 points" (Law 54). Board coin points never
    // feed their own board's queen check — carrom.md §2.
    queenCapAt: z.number().int().positive().default(22),
    pointsPerCoin: z.number().int().positive().default(1), // Law 52(b)(ii)
    // Law 53(b)/(c): the queen is credited only to the player who covered her
    // AND won the board; a loser-covered queen scores for nobody. true = house
    // rule crediting the board winner regardless of who covered.
    queenFollowsBoard: z.boolean().default(false),
    // Game tied after maxBoards: 'extra' = sudden-death board(s) (Law 56b),
    // 'draw' = the game is drawn (house rule; enables drawn matches).
    tieBoard: z.enum(["extra", "draw"]).default("extra"),
    points: CarromPoints.default({ win: 2, loss: 0, draw: 1 }), // competition points
  })
  .refine((cfg) => cfg.bestOf % 2 === 1, {
    message: "bestOf must be odd (a decider must exist)",
  })
  .refine((cfg) => cfg.queenCapAt <= cfg.gameTo, {
    message: "queenCapAt must not exceed gameTo",
  });
export type CarromCfg = z.infer<typeof CarromCfg>;

// ---------------------------------------------------------------------------
// Ev — carrom.md §2. Board-level fidelity is the shipping default.
// ---------------------------------------------------------------------------

// Toss winner's choice of first break (Law 39/42; breaker takes white, Law 43).
// Deviation from PROMPT-16's `core.start {firstBreak}`: core payloads are
// kernel-owned strict-empty (spec 03 §2), so the toss is a sport event before
// core.start — the cricket.toss precedent. Absent a toss, home breaks first.
export const CarromToss = z.strictObject({ firstBreak: EntrantId });
export type CarromToss = z.infer<typeof CarromToss>;

export const CarromBoardSummary = z.strictObject({
  winner: EntrantId,
  opponentCoinsLeft: z.number().int().min(0).max(9), // winner's coin points ×pointsPerCoin (Law 53a)
  queenTo: EntrantId.nullable(), // who pocketed AND covered the queen (null = board lost with queen on… impossible, or untracked)
});
export type CarromBoardSummary = z.infer<typeof CarromBoardSummary>;

// Umpire penalty/adjustment to the current game score (Laws 51/55 write-offs
// and penalties surface here at board fidelity).
export const CarromGameAdjust = z.strictObject({
  entrantId: EntrantId,
  delta: z
    .number()
    .int()
    .refine((delta) => delta !== 0, { message: "delta must be non-zero" }),
  reason: z.string().min(1),
});
export type CarromGameAdjust = z.infer<typeof CarromGameAdjust>;

// RESERVED — Pro strike-by-strike fidelity (carrom.md §6, entitlement key
// `scoring.strike_by_strike`, doc 10). Typed placeholder only: apply()
// rejects `carrom.strike` until the fine-fidelity prompt lands, and the
// fidelity ladder declares no tier for it.
export const CarromStrike = z.strictObject({
  striker: EntrantId,
  pocketed: z.array(z.enum(["white", "black", "queen"])),
  foul: z.boolean().optional(),
  due: z.boolean().optional(),
});
export type CarromStrike = z.infer<typeof CarromStrike>;

export const CarromEv = z.union([CarromToss, CarromBoardSummary, CarromGameAdjust]);
export type CarromEv = z.infer<typeof CarromEv>;

// ---------------------------------------------------------------------------
// State — carrom.md §3
// ---------------------------------------------------------------------------

type Side = "home" | "away";

export interface CarromBoardRecord {
  winner: Side;
  points: number; // coin points + queen bonus banked by the winner
  queenTo: Side | null;
  queenScored: boolean; // queen bonus actually credited (cap + Law 53 rules)
  breaker: Side; // who broke this board (display / fine fidelity later)
}

export interface CarromGameState {
  boards: CarromBoardRecord[];
  score: { home: number; away: number };
  winner: Side | "draw" | null; // null = game open
}

export interface CarromState {
  cfg: CarromCfg;
  entrants: { home: string; away: string };
  phase: "pre" | "live" | "done" | "final" | "abandoned";
  tossTaken: boolean;
  firstBreak: Side; // first break of game 1 (toss; Law 42)
  games: CarromGameState[]; // last entry is the open game while live
  gamesWon: { home: number; away: number };
  gamesDrawn: number;
  outcome: MatchOutcome | null;
}

function opponent(side: Side): Side {
  return side === "home" ? "away" : "home";
}

function invalid(message: string, data?: unknown): never {
  throw new EngineError("INVALID_EVENT", message, data);
}

function wrongPhase(message: string, data?: unknown): never {
  throw new EngineError("WRONG_PHASE", message, data);
}

function sideOf(state: CarromState, entrantId: string): Side {
  if (entrantId === state.entrants.home) return "home";
  if (entrantId === state.entrants.away) return "away";
  invalid(`unknown entrant "${entrantId}"`, { entrantId });
}

function parsePayload<T>(schema: z.ZodType<T>, payload: unknown, type: string): T {
  const parsed = schema.safeParse(payload);
  if (!parsed.success) invalid(`invalid ${type} payload`, { issues: parsed.error.issues });
  return parsed.data;
}

const majority = (bestOf: number): number => Math.ceil(bestOf / 2);

function openGame(state: CarromState): { game: CarromGameState; index: number } {
  const index = state.games.length - 1;
  const game = state.games[index];
  if (game === undefined || game.winner !== null) {
    // Unreachable while live — a new game opens the moment the previous one
    // decides and the match is still undecided.
    wrongPhase("no open game");
  }
  return { game, index };
}

// Law 49(a): the first break of game 1 goes to the toss winner, the turn to
// break alternates each board within a game, and each game's first break
// alternates between the players (game 2 → the other player, game 3 → back).
// Law 56b's extra-board toss is not modelled (no mid-match toss event); the
// alternation simply continues — carrom.md §3.
function breakerOf(firstBreak: Side, gameIndex: number, boardIndex: number): Side {
  return (gameIndex + boardIndex) % 2 === 0 ? firstBreak : opponent(firstBreak);
}

// ---------------------------------------------------------------------------
// Decisions — carrom.md §2 fold
// ---------------------------------------------------------------------------

// Game decision after a score change (Law 56): first to gameTo, or the leader
// once maxBoards boards are done; tied after maxBoards → tieBoard policy
// ('extra' keeps playing sudden-death boards, 'draw' closes the game drawn).
function decideGame(game: CarromGameState, cfg: CarromCfg): Side | "draw" | null {
  const { home, away } = game.score;
  const leader: Side | null = home > away ? "home" : away > home ? "away" : null;
  if (leader !== null && game.score[leader] >= cfg.gameTo) return leader;
  if (game.boards.length >= cfg.maxBoards) {
    if (leader !== null) return leader;
    return cfg.tieBoard === "draw" ? "draw" : null;
  }
  return null;
}

// Banks a decided game and decides the match at ⌈bestOf/2⌉ game wins (Law 57),
// or by games-won comparison once all bestOf games are played (drawn games
// under tieBoard 'draw' consume a slot without producing a winner).
function bankGame(state: CarromState, gameIndex: number, result: Side | "draw"): CarromState {
  const games = state.games.map((game, i) =>
    i === gameIndex ? { ...game, winner: result } : game,
  );
  const gamesWon = { ...state.gamesWon };
  let gamesDrawn = state.gamesDrawn;
  if (result === "draw") gamesDrawn += 1;
  else gamesWon[result] += 1;

  let next: CarromState = { ...state, games, gamesWon, gamesDrawn };
  const decideMatch = (winnerSide: Side): CarromState => ({
    ...next,
    phase: "done",
    outcome: {
      kind: "win",
      winner: next.entrants[winnerSide],
      loser: next.entrants[opponent(winnerSide)],
      method: "regulation",
    },
  });

  if (gamesWon.home >= majority(state.cfg.bestOf)) return decideMatch("home");
  if (gamesWon.away >= majority(state.cfg.bestOf)) return decideMatch("away");
  if (games.length >= state.cfg.bestOf) {
    if (gamesWon.home > gamesWon.away) return decideMatch("home");
    if (gamesWon.away > gamesWon.home) return decideMatch("away");
    return { ...next, phase: "done", outcome: { kind: "draw" } };
  }
  // Match still open — open the next game.
  next = {
    ...next,
    games: [...games, { boards: [], score: { home: 0, away: 0 }, winner: null }],
  };
  return next;
}

// Re-evaluates the open game after a score change and cascades into the match
// decision when the game closes.
function settle(state: CarromState, gameIndex: number): CarromState {
  const game = state.games[gameIndex] as CarromGameState;
  const result = decideGame(game, state.cfg);
  return result === null ? state : bankGame(state, gameIndex, result);
}

// ---------------------------------------------------------------------------
// Event application
// ---------------------------------------------------------------------------

function applyToss(state: CarromState, payload: CarromToss): CarromState {
  if (state.phase !== "pre") wrongPhase("toss must precede core.start");
  if (state.tossTaken) invalid("toss already recorded");
  return { ...state, tossTaken: true, firstBreak: sideOf(state, payload.firstBreak) };
}

function applyBoard(state: CarromState, payload: CarromBoardSummary): CarromState {
  if (state.phase !== "live") wrongPhase(`board summary not allowed in phase "${state.phase}"`);
  const winnerSide = sideOf(state, payload.winner);
  const queenSide = payload.queenTo === null ? null : sideOf(state, payload.queenTo);
  const { game, index } = openGame(state);

  const preBoardScore = game.score[winnerSide];
  const coinPoints = payload.opponentCoinsLeft * state.cfg.pointsPerCoin;
  // Law 53(b)/(c): queen credit needs the coverer to win the board — unless
  // the queenFollowsBoard house rule hands her to the board winner anyway.
  const queenCredited =
    queenSide === winnerSide || (state.cfg.queenFollowsBoard && queenSide !== null);
  // Law 52(b)(i)/54: the bonus is checked against the PRE-board score — coin
  // points of this board never lift the winner past the cap for its own queen.
  const queenScored = queenCredited && preBoardScore < state.cfg.queenCapAt;
  const boardPoints = coinPoints + (queenScored ? state.cfg.queenPoints : 0);

  const board: CarromBoardRecord = {
    winner: winnerSide,
    points: boardPoints,
    queenTo: queenSide,
    queenScored,
    breaker: breakerOf(state.firstBreak, index, game.boards.length),
  };
  const updated: CarromGameState = {
    ...game,
    boards: [...game.boards, board],
    score: { ...game.score, [winnerSide]: preBoardScore + boardPoints },
  };
  const next = {
    ...state,
    games: state.games.map((entry, i) => (i === index ? updated : entry)),
  };
  return settle(next, index);
}

function applyAdjust(state: CarromState, payload: CarromGameAdjust): CarromState {
  if (state.phase !== "live") wrongPhase(`adjustment not allowed in phase "${state.phase}"`);
  const side = sideOf(state, payload.entrantId);
  const { game, index } = openGame(state);
  const score = game.score[side] + payload.delta;
  if (score < 0) invalid("adjustment would take the game score below zero", { score });
  const updated: CarromGameState = { ...game, score: { ...game.score, [side]: score } };
  const next = {
    ...state,
    games: state.games.map((entry, i) => (i === index ? updated : entry)),
  };
  return settle(next, index);
}

// Walkover — carrom.md §7: the match is awarded to the opponent; completed
// games stand in the ledger.
function applyForfeit(state: CarromState, by: string): CarromState {
  const winnerSide = opponent(sideOf(state, by));
  if (state.phase === "done" || state.phase === "final" || state.phase === "abandoned") {
    wrongPhase("match already over");
  }
  return {
    ...state,
    phase: "done",
    outcome: { kind: "award", winner: state.entrants[winnerSide] },
  };
}

// Abandonment — PROMPT-16 §4: `no_result`, with completed games recorded (the
// ledger metrics keep whatever was actually played).
function applyAbandon(state: CarromState): CarromState {
  if (state.phase === "done" || state.phase === "final" || state.phase === "abandoned") {
    wrongPhase("match already over");
  }
  return { ...state, phase: "abandoned", outcome: { kind: "no_result" } };
}

// ---------------------------------------------------------------------------
// Ledger — carrom.md §4. Comparator-registry keys: games ride the sets_won/
// sets_lost keys (set_ratio, the badminton "games" precedent), board points
// ride points_won/points_lost (point_ratio); boards_won/boards_lost feed the
// carrom-specific board_ratio key. Integers only (spec 04 §9.4).
// ---------------------------------------------------------------------------

function sideLedger(state: CarromState, side: Side): Record<string, number> {
  let boardsWon = 0;
  let boardsLost = 0;
  let pointsFor = 0;
  let pointsAgainst = 0;
  for (const game of state.games) {
    for (const board of game.boards) {
      if (board.winner === side) {
        boardsWon += 1;
        pointsFor += board.points;
      } else {
        boardsLost += 1;
        pointsAgainst += board.points;
      }
    }
  }
  return {
    sets_won: state.gamesWon[side],
    sets_lost: state.gamesWon[opponent(side)],
    boards_won: boardsWon,
    boards_lost: boardsLost,
    points_won: pointsFor,
    points_lost: pointsAgainst,
  };
}

// ---------------------------------------------------------------------------
// Positions — carrom.md §5: catalog empty (doubles = pair entrant).
// ---------------------------------------------------------------------------

const positions: PositionCatalog = {
  groups: [],
  lineup: { size: 1, benchMax: 0 },
};

// carrom.md §4 — house-standard cascade (no universal federation cascade):
// points → matches won → game ratio → board ratio → point ratio → h2h → lots.
export const CARROM_TIEBREAKERS: TiebreakerKey[] = [
  "points",
  "wins",
  "set_ratio",
  "board_ratio",
  "point_ratio",
  "h2h_points",
  "lots",
];

// ---------------------------------------------------------------------------
// Module
// ---------------------------------------------------------------------------

export const carrom: SportModule<CarromCfg, CarromEv, CarromState> = {
  key: "carrom",
  version: "1.0.0",
  configSchema: CarromCfg,
  eventSchema: CarromEv,
  positions,
  entrantModel: { kinds: ["individual", "pair"], defaultKind: "individual" },
  variants: {
    // ICF Laws of Carrom (Laws 52–57) — the system default.
    icf: {},
    // Documented club/family rules (mastersofgames.com "Rules of Carrom"):
    // game to 29, queen worth 5, no queen benefit at 24+ — carrom.md §1.
    "club-29": { gameTo: 29, queenPoints: 5, queenCapAt: 24 },
  },

  init(cfg, lineups: LineupPair): CarromState {
    return {
      cfg,
      entrants: { home: lineups.home.entrantId, away: lineups.away.entrantId },
      phase: "pre",
      tossTaken: false,
      firstBreak: "home",
      games: [],
      gamesWon: { home: 0, away: 0 },
      gamesDrawn: 0,
      outcome: null,
    };
  },

  apply(state, ev: EventEnvelope<CarromEv | CoreEv>): CarromState {
    switch (ev.type) {
      case "core.start":
        if (state.phase !== "pre") wrongPhase("already started");
        return {
          ...state,
          phase: "live",
          games: [{ boards: [], score: { home: 0, away: 0 }, winner: null }],
        };
      case "carrom.toss":
        return applyToss(state, parsePayload(CarromToss, ev.payload, ev.type));
      case "carrom.board.summary":
        return applyBoard(state, parsePayload(CarromBoardSummary, ev.payload, ev.type));
      case "carrom.game.adjust":
        return applyAdjust(state, parsePayload(CarromGameAdjust, ev.payload, ev.type));
      case "carrom.strike":
        // Reserved fine fidelity — carrom.md §6, key `scoring.strike_by_strike`.
        return invalid("carrom.strike is reserved and not yet implemented");
      case "core.forfeit":
        return applyForfeit(state, (ev.payload as { by: string }).by);
      case "core.abandon":
        return applyAbandon(state);
      case "core.finalize":
        if (state.outcome === null) wrongPhase("cannot finalize an undecided fixture");
        return { ...state, phase: "final" };
      case "core.note":
      case "core.award":
        return state;
      default:
        invalid(`unknown event type "${ev.type}"`);
    }
  },

  outcome: (state) => state.outcome,

  // §9.5 — defined at every prefix; boards render like sets (carrom.md §6).
  summary(state): ScoreSummary {
    const current = state.games.find((game) => game.winner === null);
    const line = (side: Side): string => {
      const games = `${state.gamesWon[side]}`;
      return current === undefined ? games : `${games} (${current.score[side]})`;
    };
    const breaker =
      state.phase === "live" && current !== undefined
        ? state.entrants[
            breakerOf(state.firstBreak, state.games.length - 1, current.boards.length)
          ]
        : null;
    return {
      headline: `${state.gamesWon.home} — ${state.gamesWon.away}`,
      perSide: [
        { entrantId: state.entrants.home, line: line("home") },
        { entrantId: state.entrants.away, line: line("away") },
      ],
      detail: {
        games: state.games.map((game) => ({
          score: { ...game.score },
          winner: game.winner === null || game.winner === "draw"
            ? game.winner
            : state.entrants[game.winner],
          boards: game.boards.map((board) => ({
            winner: state.entrants[board.winner],
            points: board.points,
            queenTo: board.queenTo === null ? null : state.entrants[board.queenTo],
            queenScored: board.queenScored,
            breaker: state.entrants[board.breaker],
          })),
        })),
        firstBreak: state.entrants[state.firstBreak],
        ...(breaker === null ? {} : { breaker }),
        ...(state.phase === "abandoned" ? { abandoned: true } : {}),
      },
    };
  },

  standingsDelta(outcome, cfg, _ctx, state): [StandingsDelta, StandingsDelta] {
    const build = (
      side: Side,
      w: number,
      d: number,
      l: number,
      pts: number,
    ): StandingsDelta => ({
      entrantId: state.entrants[side],
      played: 1,
      won: w,
      drawn: d,
      lost: l,
      points: pts,
      metrics: sideLedger(state, side),
    });

    switch (outcome.kind) {
      case "win": {
        const winnerSide = sideOf(state, outcome.winner);
        const winner = build(winnerSide, 1, 0, 0, cfg.points.win);
        const loser = build(opponent(winnerSide), 0, 0, 1, cfg.points.loss);
        return winnerSide === "home" ? [winner, loser] : [loser, winner];
      }
      case "draw":
        return [
          build("home", 0, 1, 0, cfg.points.draw),
          build("away", 0, 1, 0, cfg.points.draw),
        ];
      case "award": {
        // Walkover — carrom.md §7: match points as a win; the ledger keeps
        // only what was actually played (no phantom boards).
        const winnerSide = sideOf(state, outcome.winner);
        const winner = build(winnerSide, 1, 0, 0, cfg.points.win);
        const loser = build(opponent(winnerSide), 0, 0, 1, cfg.points.loss);
        return winnerSide === "home" ? [winner, loser] : [loser, winner];
      }
      case "no_result":
        // Abandonment — PROMPT-16 §4: shared (draw) points, completed games
        // recorded in the ledger.
        return [
          build("home", 0, 0, 0, cfg.points.draw),
          build("away", 0, 0, 0, cfg.points.draw),
        ];
      default:
        invalid(`carrom module cannot rank outcome "${outcome.kind}"`);
    }
  },

  metrics: [
    // doc 09 §2: games won/lost as columns; boards and raw points are
    // ledger-only ratio operands (carrom.md §4).
    { key: "sets_won", label: "Games won", direction: "desc" },
    { key: "sets_lost", label: "Games lost", direction: "asc" },
    { key: "boards_won", label: "Boards won", direction: "desc", display: false },
    { key: "boards_lost", label: "Boards lost", direction: "asc", display: false },
    { key: "points_won", label: "Points for", direction: "desc", display: false },
    { key: "points_lost", label: "Points against", direction: "asc", display: false },
  ],
  defaultTiebreakers: CARROM_TIEBREAKERS,

  // Drawn matches exist only under the tieBoard 'draw' house rule, and only in
  // table stages — ICF play ('extra') always produces a winner.
  supportsDraws(cfg, stage: StageKind) {
    return (
      cfg.tieBoard === "draw" &&
      (stage === "league" || stage === "group" || stage === "swiss")
    );
  },

  // §9.3 — {win+loss (win & walkover), 2·draw (drawn match & no_result)}.
  declaredPointsSets(cfg) {
    return [...new Set([cfg.points.win + cfg.points.loss, cfg.points.draw * 2])];
  },

  // carrom.md §6 — board-level fidelity ships; strike-by-strike is reserved
  // (`scoring.strike_by_strike`) and gets tiers 2/3 when it lands.
  fidelityTiers: [
    { tier: 0, eventTypes: ["carrom.board.summary"] },
    { tier: 1, eventTypes: ["carrom.board.summary", "carrom.toss", "carrom.game.adjust"] },
  ],
  officialLabel: { scorer: "Umpire" }, // ICF laws officiate through an Umpire

  // spec 03 §6 — deterministic generator: optional toss, start, then boards
  // with occasional umpire adjustments, forfeits and abandonments.
  arbitraryEvent(state, rng: Rng): ModuleEvent<CarromEv> | null {
    const randomEntrant = () => (rng() < 0.5 ? state.entrants.home : state.entrants.away);
    if (state.phase === "pre") {
      if (!state.tossTaken && rng() < 0.5) {
        return { type: "carrom.toss", payload: { firstBreak: randomEntrant() } };
      }
      return { type: "core.start", payload: {} };
    }
    if (state.phase !== "live") return null;

    const roll = rng();
    if (roll < 0.02) {
      return { type: "core.forfeit", payload: { by: randomEntrant(), reason: "no-show" } };
    }
    if (roll < 0.04) {
      return { type: "core.abandon", payload: { reason: "venue closed" } };
    }
    if (roll < 0.09) {
      const current = state.games.find((game) => game.winner === null);
      const side: Side = rng() < 0.5 ? "home" : "away";
      const score = current?.score[side] ?? 0;
      // Negative deltas only where the score can absorb them.
      const delta = score > 0 && rng() < 0.5 ? -1 : 1;
      return {
        type: "carrom.game.adjust",
        payload: { entrantId: state.entrants[side], delta, reason: "umpire penalty" },
      };
    }
    const winner = randomEntrant();
    const loser = winner === state.entrants.home ? state.entrants.away : state.entrants.home;
    const queenRoll = rng();
    const queenTo = queenRoll < 0.55 ? winner : queenRoll < 0.75 ? loser : null;
    const opponentCoinsLeft = 1 + Math.floor(rng() * 9); // 1..9
    return {
      type: "carrom.board.summary",
      payload: { winner, opponentCoinsLeft, queenTo },
    };
  },
};
