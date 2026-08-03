// Board-game SportModule — spec 04 §6 + engine/sports/chess.md (PROMPT-07).
// Chess, draughts, go, carrom and every generic 1-v-1 win/draw/loss sport. The
// match itself is trivial (one terminal `result` event); the module exists to
// carry the metrics and pairing metadata the Swiss competition engine needs.
//
// Half-point integers, never floats: 1 / ½ / 0 are stored as 2 / 1 / 0
// throughout (points, byeScore, the Swiss ledger) and divided by two only for
// display — spec 04 §6.1, chess.md §2. This keeps the ledger exact (spec 04
// §9.4) and Buchholz/Sonneborn-Berger integer arithmetic (competition/
// tiebreakers.ts).
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
// Cfg — spec 04 §6.1
// ---------------------------------------------------------------------------

// Points are HALF-POINTS (×2): a win is 2 (= 1.0), a draw 1 (= 0.5), a loss 0.
export const BoardgameScoring = z.object({
  win: z.number().int().nonnegative().default(2),
  draw: z.number().int().nonnegative().default(1),
  loss: z.number().int().nonnegative().default(0),
});

export const BoardgameCfg = z.object({
  scoring: BoardgameScoring.default({ win: 2, draw: 1, loss: 0 }),
  colors: z.boolean().default(true), // home = White (chess.md §2)
  // Half-points a bye is worth (FIDE full-point bye = 2, half-point bye = 1).
  // Byes are a competition-level concept; this value is read by the Swiss
  // engine, not folded here.
  byeScore: z.number().int().nonnegative().default(2),
  // Clock family — metadata only, no scoring effect (chess.md §2).
  variant: z.enum(["classical", "rapid", "blitz"]).default("classical"),
  // Time control. Still metadata only: the board game has no clock in the fold,
  // the engine never reads a clock inside a fold, and none of these fields
  // changes any fold behaviour. What they record is WHICH control was in force,
  // so a pad can drive the right countdown (W4a §5.5).
  //
  // `increment` and `delay` are two DIFFERENT clocks, and they are independent
  // knobs — a control may carry both, either, or neither:
  //
  //   increment  Fischer. When the move is completed, `increment` is ADDED to
  //              that player's clock. Time not used on the move is BANKED and
  //              accumulates over the game. ("90+30")
  //   delay      Bronstein / simple (US) delay. The clock is WITHHELD for
  //              `delay` at the start of the move and only starts running once
  //              it elapses. Unused delay is NOT banked — it does not carry to
  //              the next move, so the base time can only ever go down. ("G/5 d3")
  //   neither    Sudden death: `base` for the whole game.
  //
  // `increment` and `delay` are in the same unit as `base`. Both optional with
  // NO default — cfg is serialised into the frozen golden state strings (§8).
  // `increment` was widened to optional to record INTENT: an absent increment
  // is behaviourally identical to `increment: 0` (adding zero after each move
  // IS sudden death), so this buys nothing a pad can act on — it only lets a
  // sudden-death or delay-only control say so, instead of writing a zero that
  // reads as a deliberate Fischer setting.
  clock: z
    .object({
      base: z.number().int().nonnegative(),
      increment: z.number().int().nonnegative().optional(),
      delay: z.number().int().nonnegative().optional(),
    })
    .optional(),
});
export type BoardgameCfg = z.infer<typeof BoardgameCfg>;

// ---------------------------------------------------------------------------
// Ev — spec 04 §6.2 (a single terminal event; undo = void it)
// ---------------------------------------------------------------------------

const PersonId = z.string().min(1);

// W4 domain audit — the FIDE result vocabulary a scoresheet/arbiter report
// distinguishes. The first nine are PROMPT-07's; the tail is additive (FIDE
// Laws of Chess 2023 Art. 5.2, 7.5.5, 9.2/9.3/9.6):
//   repetition    — threefold/fivefold repetition (Art. 9.2 / 9.6.1)
//   fifty_move    — the 50-move claim / 75-move automatic draw (9.3 / 9.6.2)
//   dead_position — no legal sequence of moves can mate (5.2.2); wider than
//                   `insufficient`, which is the flag-fall material rule (6.9)
//   illegal_move  — the loss an arbiter awards for a repeated illegal move
//                   (7.5.5; immediate in blitz, Appendix B.3.2)
export const BoardgameMethod = z.enum([
  "checkmate",
  "resign",
  "time",
  "agreement",
  "stalemate",
  "insufficient",
  "forfeit",
  "adjudication",
  "double_forfeit",
  "repetition",
  "fifty_move",
  "dead_position",
  "illegal_move",
]);
export type BoardgameMethod = z.infer<typeof BoardgameMethod>;

// winner: entrantId to decide; null = draw (or, with method double_forfeit, a
// no-result double default — chess.md §7).
export const BoardgameResult = z.strictObject({
  winner: EntrantId.nullable(),
  method: BoardgameMethod.optional(),
  // W4: move number the scoresheet finished on (Art. 8.1 — each player records
  // every move). The game length, not the moves themselves; per-ply recording
  // is deliberately out of scope (see DOMAIN.md).
  moves: z.number().int().nonnegative().optional(),
  // W4: the player who won the board. In an individual event the entrant IS
  // the player; in a team match (board order, chess.md §5) the entrant is the
  // club and the person is what a stat model needs. Always optional.
  winnerPerson: PersonId.optional(),
});
export type BoardgameResult = z.infer<typeof BoardgameResult>;

// W4: the arbiter's pairing card — the facts a scoresheet header carries and
// the module could not previously hold. `white` is the entrant with White
// (Swiss alternates colours, so home is NOT always White); homePerson /
// awayPerson name who actually sat down; board is the board number in a team
// match. Every field optional, at least one required.
export const BoardgamePairing = z
  .strictObject({
    white: EntrantId.optional(),
    homePerson: PersonId.optional(),
    awayPerson: PersonId.optional(),
    board: z.number().int().positive().optional(),
  })
  .refine((card) => Object.values(card).some((value) => value !== undefined), {
    message: "a pairing card must record at least one fact",
  });
export type BoardgamePairing = z.infer<typeof BoardgamePairing>;

// Branches are told apart structurally (spec 03 §2): a result always carries
// `winner`, which the strict pairing branch rejects, and vice versa.
export const BoardgameEv = z.union([BoardgameResult, BoardgamePairing]);
export type BoardgameEv = z.infer<typeof BoardgameEv>;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

type Side = "home" | "away";
type Color = "W" | "B";

export interface BoardgameState {
  cfg: BoardgameCfg;
  entrants: { home: string; away: string };
  phase: "pre" | "live" | "done" | "final" | "abandoned";
  colorOfHome: Color | null; // null = colours disabled (go/generic)
  method: BoardgameMethod | null;
  // Forfeits score like a win but are excluded from colour history (chess.md §7).
  forfeited: boolean;
  outcome: MatchOutcome | null;
  replayFlagged: boolean;
  // W4 pairing-card facts — absent until a boardgame.pairing event records
  // them, so a stream that never pairs folds to exactly the state it always
  // did (the golden corpus is byte-identical).
  players?: { home?: string; away?: string };
  board?: number;
  // W4 result facts — absent unless the result event carried them.
  moves?: number;
  winnerPerson?: string;
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

function sideOf(state: BoardgameState, entrantId: string): Side {
  if (entrantId === state.entrants.home) return "home";
  if (entrantId === state.entrants.away) return "away";
  invalid(`unknown entrant "${entrantId}"`, { entrantId });
}

function parsePayload<T>(schema: z.ZodType<T>, payload: unknown, type: string): T {
  const parsed = schema.safeParse(payload);
  if (!parsed.success) invalid(`invalid ${type} payload`, { issues: parsed.error.issues });
  return parsed.data;
}

// ---------------------------------------------------------------------------
// Result application
// ---------------------------------------------------------------------------

function decideResult(
  state: BoardgameState,
  winner: string | null,
  method: BoardgameMethod | undefined,
  extra: { moves?: number; winnerPerson?: string } = {},
): BoardgameState {
  if (state.phase !== "live") wrongPhase(`result not allowed in phase "${state.phase}"`);
  // A person can only be credited with a decisive board — a draw credits both
  // players a half point, which is a stats-model join, not a result field.
  if (extra.winnerPerson !== undefined && winner === null) {
    invalid("winnerPerson requires a decisive winner", { winnerPerson: extra.winnerPerson });
  }
  const forfeited = method === "forfeit" || method === "double_forfeit";
  const base = {
    ...state,
    phase: "done" as const,
    method: method ?? null,
    forfeited,
    ...(extra.moves === undefined ? {} : { moves: extra.moves }),
    ...(extra.winnerPerson === undefined ? {} : { winnerPerson: extra.winnerPerson }),
  };
  if (winner === null) {
    // Double forfeit ⇒ no result (both default); otherwise an ordinary draw.
    if (method === "double_forfeit") return { ...base, outcome: { kind: "no_result" } };
    return { ...base, outcome: { kind: "draw" } };
  }
  const winnerSide = sideOf(state, winner);
  return {
    ...base,
    outcome: {
      kind: "win",
      winner: state.entrants[winnerSide],
      loser: state.entrants[opponent(winnerSide)],
      method: method ?? "regulation",
    },
  };
}

// W4 — the arbiter's pairing card. Recordable before or during the game (an
// arbiter corrects a mis-set board); refused once the game is over.
function applyPairing(state: BoardgameState, card: BoardgamePairing): BoardgameState {
  if (state.phase !== "pre" && state.phase !== "live") {
    wrongPhase(`pairing not allowed in phase "${state.phase}"`);
  }
  let colorOfHome = state.colorOfHome;
  if (card.white !== undefined) {
    if (state.cfg.colors === false) {
      invalid("this division plays without colours", { white: card.white });
    }
    colorOfHome = sideOf(state, card.white) === "home" ? "W" : "B";
  }
  const players = {
    ...state.players,
    ...(card.homePerson === undefined ? {} : { home: card.homePerson }),
    ...(card.awayPerson === undefined ? {} : { away: card.awayPerson }),
  };
  return {
    ...state,
    colorOfHome,
    ...(Object.keys(players).length === 0 ? {} : { players }),
    ...(card.board === undefined ? {} : { board: card.board }),
  };
}

// ---------------------------------------------------------------------------
// Colour / ledger helpers — the Swiss inputs (spec 04 §6.3, chess.md §3–4)
// ---------------------------------------------------------------------------

function colorOf(state: BoardgameState, side: Side): Color | null {
  if (state.colorOfHome === null || state.forfeited) return null; // excluded
  return side === "home" ? state.colorOfHome : state.colorOfHome === "W" ? "B" : "W";
}

// Per-side ledger row: `wins` for the cascade tail, `white`/`black` = the colour
// this entrant held (both 0 when colours are off or the game was forfeited — a
// forfeit is excluded from colour history). Integers only (spec 04 §9.4).
function sideMetrics(state: BoardgameState, side: Side, won: boolean): Record<string, number> {
  const color = colorOf(state, side);
  return {
    wins: won ? 1 : 0,
    white: color === "W" ? 1 : 0,
    black: color === "B" ? 1 : 0,
  };
}

// ---------------------------------------------------------------------------
// Positions — spec 04 §6 / chess.md §5 (team chess uses board order later)
// ---------------------------------------------------------------------------

const positions: PositionCatalog = {
  groups: [], // 1-v-1: no positions
  lineup: { size: 1, benchMax: 0 },
};

// ---------------------------------------------------------------------------
// Tiebreakers — spec 04 §6.3 / chess.md §4 (score = the standings points key).
// ---------------------------------------------------------------------------

export const BOARDGAME_TIEBREAKERS: TiebreakerKey[] = [
  "points",
  "buchholz_cut1",
  "buchholz",
  "sberger",
  "direct",
  "wins",
  "lots",
];

// ---------------------------------------------------------------------------
// Display — half-points → points string (2 → "1", 1 → "½", 3 → "1½").
// ---------------------------------------------------------------------------

function pointsText(halfPoints: number): string {
  const whole = Math.floor(halfPoints / 2);
  const half = halfPoints % 2 === 1 ? "½" : "";
  if (whole === 0) return half === "" ? "0" : "½";
  return `${whole}${half}`;
}

// ---------------------------------------------------------------------------
// Module
// ---------------------------------------------------------------------------

export const boardgame: SportModule<BoardgameCfg, BoardgameEv, BoardgameState> = {
  key: "boardgame",
  version: "1.0.0",
  configSchema: BoardgameCfg,
  eventSchema: BoardgameEv,
  positions,
  entrantModel: { kinds: ["individual"], defaultKind: "individual" },
  variants: {
    // Clock family only — the scoring is identical (chess.md §2).
    classical: { variant: "classical" },
    rapid: { variant: "rapid" },
    blitz: { variant: "blitz" },
  },

  init(cfg, lineups: LineupPair): BoardgameState {
    return {
      cfg,
      entrants: { home: lineups.home.entrantId, away: lineups.away.entrantId },
      phase: "pre",
      colorOfHome: cfg.colors ? "W" : null,
      method: null,
      forfeited: false,
      outcome: null,
      replayFlagged: false,
    };
  },

  apply(state, ev: EventEnvelope<BoardgameEv | CoreEv>): BoardgameState {
    switch (ev.type) {
      case "core.start":
        if (state.phase !== "pre") wrongPhase("already started");
        return { ...state, phase: "live" };
      case "boardgame.result": {
        const payload = parsePayload(BoardgameResult, ev.payload, ev.type);
        return decideResult(state, payload.winner, payload.method, {
          ...(payload.moves === undefined ? {} : { moves: payload.moves }),
          ...(payload.winnerPerson === undefined ? {} : { winnerPerson: payload.winnerPerson }),
        });
      }
      case "boardgame.pairing":
        return applyPairing(state, parsePayload(BoardgamePairing, ev.payload, ev.type));
      case "core.forfeit": {
        if (state.phase !== "live") wrongPhase(`forfeit not allowed in phase "${state.phase}"`);
        const by = (ev.payload as { by: string }).by;
        return decideResult(state, state.entrants[opponent(sideOf(state, by))], "forfeit");
      }
      case "core.abandon":
        if (state.phase === "done" || state.phase === "final" || state.phase === "abandoned") {
          wrongPhase("match already over");
        }
        // Rare for a board game; leave undecided and flag for regeneration.
        return { ...state, phase: "abandoned", replayFlagged: true };
      case "core.finalize":
        if (state.outcome === null) wrongPhase("cannot finalize an undecided fixture");
        return { ...state, phase: "final" };
      case "core.note":
      case "core.award":
        return state; // PGN/move upload rides here (chess.md §6) — no state effect
      default:
        invalid(`unknown event type "${ev.type}"`);
    }
  },

  outcome: (state) => state.outcome,

  // §9.5 — defined at every prefix; displays points, not half-points.
  summary(state): ScoreSummary {
    const { win, draw, loss } = state.cfg.scoring;
    let home = 0;
    let away = 0;
    const outcome = state.outcome;
    if (outcome?.kind === "win") {
      const winnerHome = outcome.winner === state.entrants.home;
      home = winnerHome ? win : loss;
      away = winnerHome ? loss : win;
    } else if (outcome?.kind === "draw") {
      home = draw;
      away = draw;
    }
    const decided = outcome !== null;
    return {
      headline: decided ? `${pointsText(home)} — ${pointsText(away)}` : "vs",
      perSide: [
        { entrantId: state.entrants.home, line: decided ? pointsText(home) : "" },
        { entrantId: state.entrants.away, line: decided ? pointsText(away) : "" },
      ],
      detail: {
        ...(state.method === null ? {} : { method: state.method }),
        ...(state.colorOfHome === null ? {} : { colorOfHome: state.colorOfHome }),
        ...(state.replayFlagged ? { abandoned: true } : {}),
        // W4 pairing/result facts — only when recorded, so a stream that never
        // used them summarises exactly as it always did.
        ...(state.players === undefined ? {} : { players: state.players }),
        ...(state.board === undefined ? {} : { board: state.board }),
        ...(state.moves === undefined ? {} : { moves: state.moves }),
        ...(state.winnerPerson === undefined ? {} : { winnerPerson: state.winnerPerson }),
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
      won: boolean,
    ): StandingsDelta => ({
      entrantId: state.entrants[side],
      played: 1,
      won: w,
      drawn: d,
      lost: l,
      points: pts, // half-points — integer (spec 04 §9.4)
      metrics: sideMetrics(state, side, won),
    });

    switch (outcome.kind) {
      case "win": {
        const winnerSide = sideOf(state, outcome.winner);
        const winner = build(winnerSide, 1, 0, 0, cfg.scoring.win, true);
        const loser = build(opponent(winnerSide), 0, 0, 1, cfg.scoring.loss, false);
        return winnerSide === "home" ? [winner, loser] : [loser, winner];
      }
      case "draw":
        return [
          build("home", 0, 1, 0, cfg.scoring.draw, false),
          build("away", 0, 1, 0, cfg.scoring.draw, false),
        ];
      case "no_result":
        // Double forfeit — both default to a zero score (chess.md §7).
        return [
          build("home", 0, 0, 0, 0, false),
          build("away", 0, 0, 0, 0, false),
        ];
      default:
        invalid(`board-game module cannot rank outcome "${outcome.kind}"`);
    }
  },

  metrics: [
    // doc 09 §2: chess shows Score, Buchholz Cut-1, SB (cascade-derived
    // columns, engine competition/display.ts) — colour tallies are pairing
    // metadata, not table columns.
    { key: "wins", label: "Wins", direction: "desc" },
    { key: "white", label: "Games as White", direction: "desc", display: false },
    { key: "black", label: "Games as Black", direction: "desc", display: false },
  ],
  defaultTiebreakers: BOARDGAME_TIEBREAKERS,

  // spec 04 §6 / chess.md §2 — draws always allowed, even in knockout (KO chess
  // resolves ties via multi-game mini-matches, modelled at the fixture layer).
  supportsDraws(_cfg, _stage: StageKind) {
    return true;
  },

  // §9.3 — {win+loss, 2·draw, 0 (double forfeit)}.
  declaredPointsSets(cfg) {
    return [
      ...new Set([cfg.scoring.win + cfg.scoring.loss, cfg.scoring.draw * 2, 0]),
    ];
  },

  // chess.md §6 — single-event sport: no coarse/fine split (Pro depth is PGN
  // upload + exports, not extra event granularity).
  fidelityTiers: [
    { tier: 0, eventTypes: ["boardgame.result"] },
    // W4: tier 1 adds the arbiter's pairing card (colours, players, board no.).
    { tier: 1, eventTypes: ["boardgame.result", "boardgame.pairing"] },
  ],
  officialLabel: { scorer: "Arbiter" }, // doc 13 §1

  // W4 — person credit. `games` fires once per named player on the pairing
  // card (the two fields never name the same person), `wins` off the result.
  // Per-person half points for a draw need a pairing↔result join that
  // aggregatePlayerStats cannot express — see DOMAIN.md "downstream owed".
  playerStats: {
    metrics: [
      { key: "games", label: "Games", from: "boardgame.pairing", field: "homePerson", agg: "count" },
      { key: "games", label: "Games", from: "boardgame.pairing", field: "awayPerson", agg: "count" },
      { key: "wins", label: "Wins", from: "boardgame.result", field: "winnerPerson", agg: "count" },
    ],
  },

  // spec 03 §6 — deterministic generator: start, then a single result
  // (win/draw/forfeit) that decides the fixture.
  arbitraryEvent(state, rng: Rng): ModuleEvent<BoardgameEv> | null {
    // Person ids follow the testkit lineup convention (`<entrantId>-p1`) —
    // the module holds no roster, so the generator synthesises them.
    const personOf = (side: Side) => `${state.entrants[side]}-p1`;
    if (state.phase === "pre") {
      // W4 — the arbiter's pairing card, once, before the clocks start.
      if (state.players === undefined && rng() < 0.5) {
        return {
          type: "boardgame.pairing",
          payload: {
            ...(state.cfg.colors
              ? { white: state.entrants[rng() < 0.5 ? "home" : "away"] }
              : {}),
            homePerson: personOf("home"),
            awayPerson: personOf("away"),
            board: 1,
          },
        };
      }
      return { type: "core.start", payload: {} };
    }
    if (state.phase !== "live") return null;
    const roll = rng();
    if (roll < 0.05) {
      return { type: "core.forfeit", payload: { by: state.entrants[rng() < 0.5 ? "home" : "away"], reason: "no-show" } };
    }
    if (roll < 0.1) {
      return { type: "boardgame.result", payload: { winner: null, method: "double_forfeit" } };
    }
    if (roll < 0.4) {
      return { type: "boardgame.result", payload: { winner: null, method: "agreement" } };
    }
    if (roll < 0.45) {
      // W4 — the widened drawing vocabulary (repetition / 50-move / dead).
      const drawn = ["repetition", "fifty_move", "dead_position"] as const;
      const method = drawn[Math.min(2, Math.floor(rng() * 3))] as BoardgameMethod;
      return { type: "boardgame.result", payload: { winner: null, method, moves: 40 } };
    }
    const winnerSide: Side = rng() < 0.5 ? "home" : "away";
    const winner = state.entrants[winnerSide];
    const method = rng() < 0.5 ? "checkmate" : "resign";
    return {
      type: "boardgame.result",
      payload: {
        winner,
        method,
        moves: 20 + Math.floor(rng() * 40),
        // Credit the player when the pairing card named one.
        ...(state.players === undefined ? {} : { winnerPerson: personOf(winnerSide) }),
      },
    };
  },
};
