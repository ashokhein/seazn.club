// Generic fallback module ≈ v1 behaviour — spec 04 §8. Reproduces v1
// semantics (win_loss / score result modes) so existing users lose nothing on
// cutover; the migration target for all v1 tournaments (PROMPT-15). First
// real module on the contract — proves PROMPT-03.
import { z } from "zod";
import { EngineError } from "../../core/errors.ts";
import type { CoreEv, EventEnvelope } from "../../core/events.ts";
import type { Rng } from "../../core/rng.ts";
import {
  EntrantId,
  type LineupPair,
  type MatchOutcome,
  type ScoreSummary,
  type StageCtx,
  type StageKind,
  type StandingsDelta,
} from "../../core/types.ts";
import type { ModuleEvent, SportModule } from "../../sport/module.ts";

// spec 04 §8 Cfg
export const GenericCfg = z.object({
  resultMode: z.enum(["win_loss", "score"]),
  allowDraws: z.boolean(),
  points: z.object({
    w: z.number().int().nonnegative(),
    d: z.number().int().nonnegative(),
    l: z.number().int().nonnegative(),
  }),
  // v1 stepladder progress-score carry; stored for the PROMPT-15 cutover,
  // no scoring effect inside the module.
  progressScore: z.boolean(),
});
export type GenericCfg = z.infer<typeof GenericCfg>;

// spec 04 §8 Ev — single terminal event; p1 = home, p2 = away (v1 naming).
export const GenericResult = z.strictObject({
  winnerId: EntrantId.optional(),
  p1Score: z.number().int().nonnegative().optional(),
  p2Score: z.number().int().nonnegative().optional(),
  isDraw: z.boolean().optional(),
});
export type GenericEv = z.infer<typeof GenericResult>;

export interface GenericState {
  phase: "pre" | "live" | "done" | "final";
  cfg: GenericCfg;
  entrants: { home: string; away: string };
  score: { home: number; away: number } | null;
  outcome: MatchOutcome | null;
}

type Side = "home" | "away";

function opponent(side: Side): Side {
  return side === "home" ? "away" : "home";
}

function sideOf(state: GenericState, entrantId: string): Side {
  if (entrantId === state.entrants.home) return "home";
  if (entrantId === state.entrants.away) return "away";
  throw new EngineError("INVALID_EVENT", `unknown entrant "${entrantId}"`, { entrantId });
}

function invalid(message: string, data?: unknown): never {
  throw new EngineError("INVALID_EVENT", message, data);
}

// Cross-checks a generic.result payload against the config mode and returns
// the decided state pieces. spec 04 §8; consistency rules mirror v1: a card
// that contradicts itself (winnerId vs scores vs isDraw) is rejected.
function applyResult(state: GenericState, payload: GenericEv): GenericState {
  const { resultMode, allowDraws } = state.cfg;
  const hasP1 = payload.p1Score !== undefined;
  const hasP2 = payload.p2Score !== undefined;
  if (hasP1 !== hasP2) invalid("p1Score and p2Score must be given together");
  const score = hasP1
    ? { home: payload.p1Score as number, away: payload.p2Score as number }
    : null;

  let winnerSide: Side | null; // null = draw
  if (resultMode === "score") {
    if (!score) invalid("score mode requires p1Score and p2Score");
    winnerSide = score.home === score.away ? null : score.home > score.away ? "home" : "away";
    if (winnerSide === null && !allowDraws) {
      invalid("draws are not allowed in this division", { score });
    }
  } else {
    const declaredDraw = payload.isDraw === true;
    if (declaredDraw && payload.winnerId !== undefined) {
      invalid("isDraw and winnerId are mutually exclusive");
    }
    if (!declaredDraw && payload.winnerId === undefined) {
      invalid("win_loss mode requires winnerId or isDraw");
    }
    if (declaredDraw && !allowDraws) invalid("draws are not allowed in this division");
    winnerSide = declaredDraw ? null : sideOf(state, payload.winnerId as string);
  }

  // Redundant fields must agree with the derived result.
  if (payload.winnerId !== undefined && winnerSide !== sideOf(state, payload.winnerId)) {
    invalid("winnerId contradicts the scores", { payload });
  }
  if (payload.isDraw !== undefined && payload.isDraw !== (winnerSide === null)) {
    invalid("isDraw contradicts the result", { payload });
  }
  if (score && winnerSide !== null && score[winnerSide] <= score[opponent(winnerSide)]) {
    invalid("winnerId contradicts the scores", { payload });
  }
  if (score && winnerSide === null && score.home !== score.away) {
    invalid("isDraw contradicts the scores", { payload });
  }

  const outcome: MatchOutcome =
    winnerSide === null
      ? { kind: "draw" }
      : {
          kind: "win",
          winner: state.entrants[winnerSide],
          loser: state.entrants[opponent(winnerSide)],
          method: "regulation",
        };
  return { ...state, phase: "done", score, outcome };
}

function sideLine(state: GenericState, side: Side): string {
  if (state.score) return String(state.score[side]);
  const outcome = state.outcome;
  if (!outcome) return "—";
  switch (outcome.kind) {
    case "win":
      return outcome.winner === state.entrants[side] ? "W" : "L";
    case "draw":
    case "tie":
      return "D";
    case "no_result":
      return "N/R";
    case "award":
      return outcome.winner === state.entrants[side] ? "W/O" : "L";
  }
}

function zeroMetrics(): Record<string, number> {
  return { for: 0, against: 0, diff: 0 };
}

function sideMetrics(state: GenericState, side: Side): Record<string, number> {
  if (!state.score) return zeroMetrics();
  const forScore = state.score[side];
  const against = state.score[opponent(side)];
  return { for: forScore, against, diff: forScore - against };
}

export const generic: SportModule<GenericCfg, GenericEv, GenericState> = {
  key: "generic",
  version: "1.0.0",
  configSchema: GenericCfg,
  eventSchema: GenericResult,
  // spec 04 §8 / doc 02 §3 — generic tracks entrants, not people; adapters
  // pass a single placeholder slot per side (like chess: lineup size 1).
  positions: { groups: [], lineup: { size: 1, benchMax: 0 } },
  variants: {
    win_loss: { resultMode: "win_loss", allowDraws: false },
    score: { resultMode: "score", allowDraws: true },
  },

  init(cfg, lineups: LineupPair): GenericState {
    return {
      phase: "pre",
      cfg,
      entrants: { home: lineups.home.entrantId, away: lineups.away.entrantId },
      score: null,
      outcome: null,
    };
  },

  apply(state, ev: EventEnvelope<GenericEv | CoreEv>): GenericState {
    switch (ev.type) {
      case "core.start": {
        if (state.phase !== "pre") throw new EngineError("WRONG_PHASE", "already started");
        return { ...state, phase: "live" };
      }
      case "generic.result": {
        if (state.phase !== "pre" && state.phase !== "live") {
          throw new EngineError("WRONG_PHASE", "result already recorded");
        }
        const parsed = GenericResult.safeParse(ev.payload);
        if (!parsed.success) {
          invalid("invalid generic.result payload", { issues: parsed.error.issues });
        }
        return applyResult(state, parsed.data);
      }
      case "core.forfeit": {
        if (state.phase !== "pre" && state.phase !== "live") {
          throw new EngineError("WRONG_PHASE", "match already over");
        }
        const by = (ev.payload as { by: string }).by;
        const winner = state.entrants[opponent(sideOf(state, by))];
        return { ...state, phase: "done", outcome: { kind: "award", winner } };
      }
      case "core.abandon": {
        if (state.phase !== "pre" && state.phase !== "live") {
          throw new EngineError("WRONG_PHASE", "match already over");
        }
        return { ...state, phase: "done", outcome: { kind: "no_result" } };
      }
      case "core.finalize": {
        if (state.phase !== "done") throw new EngineError("WRONG_PHASE", "not decided");
        return { ...state, phase: "final" };
      }
      case "core.note":
      case "core.award":
        return state; // annotation only, no state effect (spec 03 §2)
      default:
        invalid(`unknown event type "${ev.type}"`);
    }
  },

  outcome: (state) => state.outcome,

  // §9.5 — defined at every prefix; before any result the headline is "—".
  summary(state): ScoreSummary {
    const home = sideLine(state, "home");
    const away = sideLine(state, "away");
    return {
      headline: `${home} — ${away}`,
      perSide: [
        { entrantId: state.entrants.home, line: home },
        { entrantId: state.entrants.away, line: away },
      ],
    };
  },

  // Pair returned [home, away]. v1 semantics: no_result shares draw points
  // without counting a draw; award pays full win/loss points on zero metrics.
  standingsDelta(outcome, cfg, _ctx: StageCtx, state): [StandingsDelta, StandingsDelta] {
    const points = cfg.points;
    const build = (
      side: Side,
      w: number,
      d: number,
      l: number,
      pts: number,
      metrics: Record<string, number>,
    ): StandingsDelta => ({
      entrantId: state.entrants[side],
      played: 1,
      won: w,
      drawn: d,
      lost: l,
      points: pts,
      metrics,
    });

    switch (outcome.kind) {
      case "win":
      case "award": {
        const winnerSide = sideOf(state, outcome.winner);
        const loserSide = opponent(winnerSide);
        const winner = build(winnerSide, 1, 0, 0, points.w, sideMetrics(state, winnerSide));
        const loser = build(loserSide, 0, 0, 1, points.l, sideMetrics(state, loserSide));
        return winnerSide === "home" ? [winner, loser] : [loser, winner];
      }
      case "draw":
      case "tie":
        return [
          build("home", 0, 1, 0, points.d, sideMetrics(state, "home")),
          build("away", 0, 1, 0, points.d, sideMetrics(state, "away")),
        ];
      case "no_result":
        return [
          build("home", 0, 0, 0, points.d, zeroMetrics()),
          build("away", 0, 0, 0, points.d, zeroMetrics()),
        ];
    }
  },

  metrics: [
    { key: "for", label: "For", direction: "desc" },
    { key: "against", label: "Against", direction: "asc" },
    { key: "diff", label: "Difference", direction: "desc" },
  ],
  defaultTiebreakers: ["points", "diff", "for", "h2h_points", "lots"],

  // Draws only where the format can absorb them — never in eliminations.
  supportsDraws(cfg, stage: StageKind) {
    return (
      cfg.allowDraws && stage !== "knockout" && stage !== "double_elim" && stage !== "stepladder"
    );
  },

  // §9.3 — decisive total w+l; shared total 2d (draw/tie/no_result — abandon
  // can produce no_result even when allowDraws is false).
  declaredPointsSets(cfg) {
    return [...new Set([cfg.points.w + cfg.points.l, cfg.points.d * 2])];
  },

  // doc 14 §2 — generic tops out at Tier 1 (p1/p2 score); no Tier 2/3.
  fidelityTiers: [
    { tier: 0, eventTypes: ["generic.result"] },
    { tier: 1, eventTypes: ["generic.result"] },
  ],
  officialLabel: { scorer: "Scorer" }, // doc 13 §1

  // spec 03 §6 — valid-event generator for the conformance kit.
  arbitraryEvent(state, rng: Rng): ModuleEvent<GenericEv> | null {
    if (state.phase === "done" || state.phase === "final") return null;
    if (state.phase === "pre" && rng() < 0.3) return { type: "core.start", payload: {} };
    const roll = rng();
    if (roll < 0.08) {
      const by = rng() < 0.5 ? state.entrants.home : state.entrants.away;
      return { type: "core.forfeit", payload: { by, reason: "walkover" } };
    }
    if (roll < 0.15) return { type: "core.abandon", payload: { reason: "rain" } };
    if (state.cfg.resultMode === "score") {
      const p1 = Math.floor(rng() * 6);
      let p2 = Math.floor(rng() * 6);
      if (!state.cfg.allowDraws && p1 === p2) p2 += 1;
      return { type: "generic.result", payload: { p1Score: p1, p2Score: p2 } };
    }
    if (state.cfg.allowDraws && rng() < 0.25) {
      return { type: "generic.result", payload: { isDraw: true } };
    }
    const winnerId = rng() < 0.5 ? state.entrants.home : state.entrants.away;
    return { type: "generic.result", payload: { winnerId } };
  },
};
