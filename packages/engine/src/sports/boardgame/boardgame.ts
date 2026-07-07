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
  clock: z
    .object({ base: z.number().int().nonnegative(), increment: z.number().int().nonnegative() })
    .optional(),
});
export type BoardgameCfg = z.infer<typeof BoardgameCfg>;

// ---------------------------------------------------------------------------
// Ev — spec 04 §6.2 (a single terminal event; undo = void it)
// ---------------------------------------------------------------------------

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
]);
export type BoardgameMethod = z.infer<typeof BoardgameMethod>;

// winner: entrantId to decide; null = draw (or, with method double_forfeit, a
// no-result double default — chess.md §7).
export const BoardgameResult = z.strictObject({
  winner: EntrantId.nullable(),
  method: BoardgameMethod.optional(),
});
export type BoardgameResult = z.infer<typeof BoardgameResult>;

export const BoardgameEv = BoardgameResult;
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
): BoardgameState {
  if (state.phase !== "live") wrongPhase(`result not allowed in phase "${state.phase}"`);
  const forfeited = method === "forfeit" || method === "double_forfeit";
  const base = {
    ...state,
    phase: "done" as const,
    method: method ?? null,
    forfeited,
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
        return decideResult(state, payload.winner, payload.method);
      }
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
    { tier: 1, eventTypes: ["boardgame.result"] },
  ],
  officialLabel: { scorer: "Arbiter" }, // doc 13 §1

  // spec 03 §6 — deterministic generator: start, then a single result
  // (win/draw/forfeit) that decides the fixture.
  arbitraryEvent(state, rng: Rng): ModuleEvent<BoardgameEv> | null {
    if (state.phase === "pre") return { type: "core.start", payload: {} };
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
    const winner = state.entrants[rng() < 0.5 ? "home" : "away"];
    const method = rng() < 0.5 ? "checkmate" : "resign";
    return { type: "boardgame.result", payload: { winner, method } };
  },
};
