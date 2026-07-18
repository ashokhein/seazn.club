// Nested scoring kernel — v6/00 §2 + v6/01 §1 (ITF Rules of Tennis 2026).
// Three-level fold: points → games → sets, with deuce/advantage, no-ad
// deciding points, tie-break games (entry at tiebreakAt-all), advantage sets
// (tiebreakAt: null), match tie-breaks replacing the deciding set (App VI) and
// slam-style deciding-set tie-breaks to 10. The set-based kernel folds points
// straight into sets and cannot express the game layer (v6/00 §2 "why not
// extend"), so this kernel is separate; padel lands here later as a preset.
//
// No coarsen hook: a point stream carries serve state that per-set summaries
// cannot reconstruct, so §9.6 summary-equality would fail by construction.
// Dual fidelity is per-set instead: tier-0 `*.set_summary` events fold into
// the same set ledger the rally path banks (mirrors setbased summary mode).
import { z } from "zod";
import { EngineError } from "../../core/errors.ts";
import type { CoreEv, EventEnvelope } from "../../core/events.ts";
import type { Rng } from "../../core/rng.ts";
import {
  EntrantId,
  type LineupPair,
  type MatchOutcome,
  type MetricSpec,
  type ScoreSummary,
  type StageKind,
  type StandingsDelta,
} from "../../core/types.ts";
import type { PositionCatalog } from "../../sport/catalog.ts";
import type {
  FidelityTier,
  ModuleEvent,
  SportModule,
  TiebreakerKey,
} from "../../sport/module.ts";
import type { EntrantModel } from "../../sport/entrant-model.ts";

// ---------------------------------------------------------------------------
// Cfg — v6/00 §2
// ---------------------------------------------------------------------------

export interface NestedSetCfg {
  gamesTo: number;
  winBy: number;
  tiebreakAt: number | null; // null = advantage set (win by 2, open-ended)
  tiebreakTo: number;
}

// The deciding set (reached at ⌈bestOf/2⌉−1 sets all):
//  • "same" — identical to every other set;
//  • { matchTiebreakTo } — an ITF App VI match tie-break REPLACES the set
//    (first to 7/10, win by 2; the doubles norm);
//  • { tiebreakTo } — the set plays out normally but its tie-break game runs
//    to this target (the slam rule: 10-point TB at 6–6 in the decider).
//    v6/00 §2 lists only the first two; this third form is added so the
//    grand-slam preset matches the real rule instead of approximating it —
//    documented as a spec deviation in the PR.
export type NestedFinalSet =
  | "same"
  | { matchTiebreakTo: number }
  | { tiebreakTo: number };

export interface NestedParams {
  bestOf: number;
  set: NestedSetCfg;
  finalSet: NestedFinalSet;
  game: { noAd: boolean };
  tiebreak: { winBy: number };
  points: { win: number; loss: number }; // per-match league points
}

export type NestedCfg = NestedParams;

// Builds a preset's config schema (defaults = its shipped/first variant).
export function makeNestedConfigSchema(defaults: NestedParams) {
  return z
    .object({
      bestOf: z.number().int().positive().default(defaults.bestOf),
      set: z
        .object({
          gamesTo: z.number().int().positive(),
          winBy: z.number().int().positive(),
          tiebreakAt: z.number().int().positive().nullable(),
          tiebreakTo: z.number().int().positive(),
        })
        .default(defaults.set),
      finalSet: z
        .union([
          z.literal("same"),
          z.strictObject({ matchTiebreakTo: z.number().int().positive() }),
          z.strictObject({ tiebreakTo: z.number().int().positive() }),
        ])
        .default(defaults.finalSet),
      game: z.object({ noAd: z.boolean() }).default(defaults.game),
      tiebreak: z.object({ winBy: z.number().int().positive() }).default(defaults.tiebreak),
      points: z
        .object({
          win: z.number().int().nonnegative(),
          loss: z.number().int().nonnegative(),
        })
        .default(defaults.points),
    })
    .refine((cfg) => cfg.bestOf % 2 === 1, {
      message: "bestOf must be odd (a decider must exist)",
    })
    .refine((cfg) => cfg.set.tiebreakAt === null || cfg.set.tiebreakAt <= cfg.set.gamesTo, {
      message: "tiebreakAt must be ≤ gamesTo",
    });
}

// ---------------------------------------------------------------------------
// Events — v6/00 §2
// ---------------------------------------------------------------------------

export const NestedPointMeta = z.strictObject({
  kind: z.enum(["ace", "double_fault", "winner", "ue"]).optional(),
  // ITF App VI no-ad deciding point: the receiver chooses the service side.
  // Recorded for the record; no fold effect.
  receiverSide: z.enum(["deuce", "ad"]).optional(),
});
export const NestedPoint = z.strictObject({
  by: EntrantId,
  meta: NestedPointMeta.optional(),
});
export type NestedPoint = z.infer<typeof NestedPoint>;

// Tier-0 per-set summary. `home`/`away` are games for a normal set (with `tb`
// carrying the tie-break points when the set ended 7–6 form), or the match
// tie-break points themselves when the deciding set is an MTB.
export const NestedSetSummary = z.strictObject({
  home: z.number().int().nonnegative(),
  away: z.number().int().nonnegative(),
  tb: z
    .strictObject({
      home: z.number().int().nonnegative(),
      away: z.number().int().nonnegative(),
    })
    .optional(),
});
export type NestedSetSummary = z.infer<typeof NestedSetSummary>;

export const NestedEv = z.union([NestedPoint, NestedSetSummary]);
export type NestedEv = z.infer<typeof NestedEv>;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

type Side = "home" | "away";

export type GamePoints =
  | { kind: "standard"; home: number; away: number; advantage: Side | null } // 0..3 = 0/15/30/40
  | { kind: "tiebreak"; home: number; away: number }
  | { kind: "matchTiebreak"; home: number; away: number };

export interface ClosedSet {
  home: number; // games (or MTB points when mtb)
  away: number;
  tb?: { home: number; away: number };
  mtb?: boolean;
}

export interface NestedState {
  cfg: NestedCfg;
  entrants: { home: string; away: string };
  phase: "pre" | "live" | "done" | "final" | "abandoned";
  sets: ClosedSet[];
  games: { home: number; away: number }; // current set
  points: GamePoints;
  setsWon: { home: number; away: number };
  // Serve tracking (rally fidelity only; summary sets leave it untouched).
  serving: Side;
  tbPointsPlayed: number; // serve rotation inside a TB/MTB (1 then 2-2)
  tbFirstServer: Side | null;
  // Rally/points tallies for the metrics ledger (rally-scored play + TBs).
  pointsWon: { home: number; away: number };
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

function sideOf(state: NestedState, entrantId: string): Side {
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

// ---------------------------------------------------------------------------
// Deciding-set resolution — which rules govern the set about to be played.
// ---------------------------------------------------------------------------

interface SetRules {
  gamesTo: number;
  winBy: number;
  tiebreakAt: number | null;
  tiebreakTo: number;
  mtbTo: number | null; // non-null = the set IS a match tie-break
}

function isDecidingSet(state: NestedState): boolean {
  const need = majority(state.cfg.bestOf) - 1;
  return state.setsWon.home === need && state.setsWon.away === need;
}

function rulesFor(state: NestedState): SetRules {
  const { set, finalSet } = state.cfg;
  const base: SetRules = { ...set, mtbTo: null };
  if (!isDecidingSet(state) || finalSet === "same") return base;
  if ("matchTiebreakTo" in finalSet) return { ...base, mtbTo: finalSet.matchTiebreakTo };
  return { ...base, tiebreakTo: finalSet.tiebreakTo };
}

// Terminal predicate for a TB/MTB score (first to `to`, win by `winBy`,
// open-ended) — also used for summary reachability.
function tbWinner(h: number, a: number, to: number, winBy: number): Side | null {
  const winner: Side | null = h > a ? "home" : a > h ? "away" : null;
  if (winner === null) return null;
  const hi = Math.max(h, a);
  const lo = Math.min(h, a);
  return hi >= to && hi - lo >= winBy ? winner : null;
}

function reachableTbScore(h: number, a: number, to: number, winBy: number): boolean {
  const winner = tbWinner(h, a, to, winBy);
  if (winner === null) return false;
  const prevH = winner === "home" ? h - 1 : h;
  const prevA = winner === "away" ? a - 1 : a;
  if (prevH < 0 || prevA < 0) return false;
  return tbWinner(prevH, prevA, to, winBy) === null;
}

// Winner of a set at a games score, or null while live. A tie-break set can
// only be won at tiebreakAt+1 via the TB (handled by the TB fold), so this
// predicate covers the games path: reach gamesTo with a winBy lead.
function setGamesWinner(h: number, a: number, rules: SetRules): Side | null {
  const winner: Side | null = h > a ? "home" : a > h ? "away" : null;
  if (winner === null) return null;
  const hi = Math.max(h, a);
  const lo = Math.min(h, a);
  if (hi >= rules.gamesTo && hi - lo >= rules.winBy) return winner;
  return null;
}

// ---------------------------------------------------------------------------
// Fold helpers
// ---------------------------------------------------------------------------

const FRESH_GAME: GamePoints = { kind: "standard", home: 0, away: 0, advantage: null };

function startTiebreak(state: NestedState): NestedState {
  // The TB is the next game, so its first server is whoever is due to serve.
  return {
    ...state,
    points: { kind: "tiebreak", home: 0, away: 0 },
    tbPointsPlayed: 0,
    tbFirstServer: state.serving,
  };
}

// Bank a closed set, decide the match at ⌈bestOf/2⌉, open the next set.
function bankSet(state: NestedState, winnerSide: Side, closed: ClosedSet): NestedState {
  const setsWon = { ...state.setsWon, [winnerSide]: state.setsWon[winnerSide] + 1 };
  let next: NestedState = {
    ...state,
    sets: [...state.sets, closed],
    setsWon,
    games: { home: 0, away: 0 },
    points: FRESH_GAME,
    tbPointsPlayed: 0,
    tbFirstServer: null,
  };
  if (setsWon[winnerSide] >= majority(state.cfg.bestOf)) {
    next = {
      ...next,
      phase: "done",
      outcome: {
        kind: "win",
        winner: next.entrants[winnerSide],
        loser: next.entrants[opponent(winnerSide)],
        method: "regulation",
      },
    };
    return next;
  }
  // Deciding set = an MTB? Open it as one (serve order simply continues —
  // ITF App VI: original service order carries into the match tie-break).
  const rules = rulesFor(next);
  if (rules.mtbTo !== null) {
    return {
      ...next,
      points: { kind: "matchTiebreak", home: 0, away: 0 },
      tbPointsPlayed: 0,
      tbFirstServer: next.serving,
    };
  }
  return next;
}

// A game has been won (standard game or TB): rotate serve. After a standard
// game the serve alternates; after a TB the first TB server RECEIVES the next
// set (ITF Rule 5b), i.e. the next server is their opponent.
function serveAfterGame(state: NestedState): Side {
  return opponent(state.serving);
}

// ---------------------------------------------------------------------------
// Point application
// ---------------------------------------------------------------------------

function winGame(state: NestedState, winnerSide: Side): NestedState {
  const games = { ...state.games, [winnerSide]: state.games[winnerSide] + 1 };
  const rules = rulesFor(state);
  let next: NestedState = {
    ...state,
    games,
    points: FRESH_GAME,
    serving: serveAfterGame(state),
  };
  // Tie-break entry at tiebreakAt-all takes precedence over the games win
  // predicate (they never overlap: at tiebreakAt-all no side has a lead).
  if (
    rules.tiebreakAt !== null &&
    games.home === rules.tiebreakAt &&
    games.away === rules.tiebreakAt
  ) {
    return startTiebreak(next);
  }
  const setWinner = setGamesWinner(games.home, games.away, rules);
  if (setWinner !== null) {
    return bankSet(next, setWinner, { home: games.home, away: games.away });
  }
  return next;
}

function applyStandardPoint(state: NestedState, side: Side): NestedState {
  const pts = state.points as Extract<GamePoints, { kind: "standard" }>;
  const opp = opponent(side);
  const tally = { home: state.pointsWon.home, away: state.pointsWon.away };
  tally[side] += 1;
  const scored = { ...state, pointsWon: tally };

  if (pts[side] === 3 && pts[opp] === 3) {
    // Deuce zone (40–40): no-ad = single deciding point; otherwise advantage.
    if (state.cfg.game.noAd) return winGame(scored, side);
    if (pts.advantage === side) return winGame(scored, side);
    if (pts.advantage === opp) {
      return { ...scored, points: { ...pts, advantage: null } }; // back to deuce
    }
    return { ...scored, points: { ...pts, advantage: side } };
  }
  if (pts[side] === 3) return winGame(scored, side); // 40 vs ≤30
  return { ...scored, points: { ...pts, [side]: pts[side] + 1 } };
}

function applyTbPoint(state: NestedState, side: Side, mtb: boolean): NestedState {
  const pts = state.points as Extract<GamePoints, { kind: "tiebreak" | "matchTiebreak" }>;
  const rules = rulesFor(state);
  const to = mtb ? (rules.mtbTo as number) : rules.tiebreakTo;
  const h = pts.home + (side === "home" ? 1 : 0);
  const a = pts.away + (side === "away" ? 1 : 0);
  const played = state.tbPointsPlayed + 1;
  // Serve rotation: 1 point by the due server, then 2 each (ITF Rule 5b) —
  // the server flips after point 1, 3, 5, … (odd totals).
  const serving = played % 2 === 1 ? opponent(state.serving) : state.serving;
  const tally = { ...state.pointsWon, [side]: state.pointsWon[side] + 1 };
  let next: NestedState = {
    ...state,
    points: { ...pts, home: h, away: a },
    tbPointsPlayed: played,
    serving,
    pointsWon: tally,
  };

  const winner = tbWinner(h, a, to, state.cfg.tiebreak.winBy);
  if (winner === null) return next;

  if (mtb) {
    // The MTB is the deciding set itself — banked as its points with the flag.
    return bankSet(next, winner, { home: h, away: a, mtb: true });
  }
  // TB set closes tiebreakAt+1 : tiebreakAt; the first TB server receives
  // first in the next set, so the next server is their opponent.
  const tbAt = rules.tiebreakAt as number;
  const games = { ...next.games, [winner]: next.games[winner] + 1 };
  next = {
    ...next,
    games,
    serving: opponent(next.tbFirstServer as Side),
  };
  return bankSet(next, winner, {
    home: games.home,
    away: games.away,
    tb: { home: h, away: a },
  });
}

function applyPoint(state: NestedState, payload: NestedPoint): NestedState {
  if (state.phase !== "live") wrongPhase(`point not allowed in phase "${state.phase}"`);
  const side = sideOf(state, payload.by);
  switch (state.points.kind) {
    case "standard":
      return applyStandardPoint(state, side);
    case "tiebreak":
      return applyTbPoint(state, side, false);
    case "matchTiebreak":
      return applyTbPoint(state, side, true);
  }
}

// ---------------------------------------------------------------------------
// Set-summary application (tier 0) — v6/00 §2, mirrors setbased summary mode.
// ---------------------------------------------------------------------------

function setInProgress(state: NestedState): boolean {
  if (state.games.home > 0 || state.games.away > 0) return true;
  const pts = state.points;
  return pts.home > 0 || pts.away > 0;
}

function applySetSummary(state: NestedState, payload: NestedSetSummary): NestedState {
  if (state.phase !== "live") wrongPhase(`set summary not allowed in phase "${state.phase}"`);
  if (setInProgress(state)) {
    invalid("this set is being scored point-by-point — a set summary is not allowed for it");
  }
  const rules = rulesFor(state);
  const { home, away } = payload;

  // Deciding set as a match tie-break: the summary carries the MTB points.
  if (rules.mtbTo !== null) {
    if (payload.tb !== undefined) {
      invalid("a match tie-break summary carries its points in home/away, not tb");
    }
    if (!reachableTbScore(home, away, rules.mtbTo, state.cfg.tiebreak.winBy)) {
      invalid("match tie-break summary is not a reachable final score", {
        home,
        away,
        to: rules.mtbTo,
      });
    }
    const winner: Side = home > away ? "home" : "away";
    const tally = { home: state.pointsWon.home + home, away: state.pointsWon.away + away };
    return bankSet({ ...state, pointsWon: tally }, winner, { home, away, mtb: true });
  }

  // Tie-break set score (tiebreakAt+1 : tiebreakAt) — tb block required.
  const isTbScore =
    rules.tiebreakAt !== null &&
    ((home === rules.tiebreakAt + 1 && away === rules.tiebreakAt) ||
      (away === rules.tiebreakAt + 1 && home === rules.tiebreakAt));
  if (isTbScore) {
    if (payload.tb === undefined) {
      invalid(`a ${home}–${away} set ends in a tie-break — include its points as tb`, {
        home,
        away,
      });
    }
    const winner: Side = home > away ? "home" : "away";
    const tbh = payload.tb.home;
    const tba = payload.tb.away;
    if (!reachableTbScore(tbh, tba, rules.tiebreakTo, state.cfg.tiebreak.winBy)) {
      invalid("tie-break summary is not a reachable final score", {
        tb: payload.tb,
        to: rules.tiebreakTo,
      });
    }
    const tbWinnerSide: Side = tbh > tba ? "home" : "away";
    if (tbWinnerSide !== winner) {
      invalid("tie-break winner must match the set winner", { home, away, tb: payload.tb });
    }
    const tally = { home: state.pointsWon.home + tbh, away: state.pointsWon.away + tba };
    return bankSet({ ...state, pointsWon: tally }, winner, {
      home,
      away,
      tb: { home: tbh, away: tba },
    });
  }

  // Plain games score: terminal under the set predicate, one game earlier not.
  if (payload.tb !== undefined) {
    invalid("tb points are only valid on a tie-break set score", { home, away });
  }
  const winner = setGamesWinner(home, away, rules);
  if (winner === null) {
    invalid("set summary is not a completed set score", { home, away, rules });
  }
  const prevH = winner === "home" ? home - 1 : home;
  const prevA = winner === "away" ? away - 1 : away;
  const wasLive =
    setGamesWinner(prevH, prevA, rules) === null &&
    !(rules.tiebreakAt !== null && prevH === rules.tiebreakAt && prevA === rules.tiebreakAt);
  if (prevH < 0 || prevA < 0 || !wasLive) {
    invalid("set summary is not a reachable final score", { home, away, rules });
  }
  return bankSet(state, winner, { home, away });
}

// ---------------------------------------------------------------------------
// Forfeit / abandon — mirror setbased.
// ---------------------------------------------------------------------------

function applyForfeit(state: NestedState, by: string): NestedState {
  if (state.phase === "done" || state.phase === "final" || state.phase === "abandoned") {
    wrongPhase("match already over");
  }
  const winnerSide = opponent(sideOf(state, by));
  return {
    ...state,
    phase: "done",
    outcome: { kind: "award", winner: state.entrants[winnerSide] },
  };
}

function applyAbandon(state: NestedState): NestedState {
  if (state.phase === "done" || state.phase === "final" || state.phase === "abandoned") {
    wrongPhase("match already over");
  }
  return { ...state, phase: "abandoned", replayFlagged: true };
}

// ---------------------------------------------------------------------------
// Display — spoken score + set strip (v6/00 §2).
// ---------------------------------------------------------------------------

const CALLS = ["0", "15", "30", "40"] as const;

export function gameScoreLine(points: GamePoints): string {
  switch (points.kind) {
    case "standard": {
      if (points.home === 3 && points.away === 3) {
        if (points.advantage === "home") return "Ad–40";
        if (points.advantage === "away") return "40–Ad";
        return "40–40";
      }
      return `${CALLS[points.home]}–${CALLS[points.away]}`;
    }
    case "tiebreak":
      return `TB ${points.home}–${points.away}`;
    case "matchTiebreak":
      return `MTB ${points.home}–${points.away}`;
  }
}

function closedSetLine(set: ClosedSet): string {
  if (set.mtb === true) return `[${set.home}–${set.away}]`; // ITF MTB bracket form
  if (set.tb !== undefined) {
    const loserTb = Math.min(set.tb.home, set.tb.away);
    return `${set.home}–${set.away}(${loserTb})`;
  }
  return `${set.home}–${set.away}`;
}

// ---------------------------------------------------------------------------
// Preset wiring
// ---------------------------------------------------------------------------

export interface NestedPreset {
  key: string; // 'tennis' (padel later)
  version: string;
  defaults: NestedParams;
  variants: Record<string, Partial<NestedParams>>;
  positions: PositionCatalog;
  defaultTiebreakers: TiebreakerKey[];
  officialLabel: { scorer: string };
  rallyEntitlement: string; // FeatureKey for tier-2/3 point-by-point scoring
  entrantModel?: EntrantModel;
}

const METRICS: MetricSpec[] = [
  { key: "sets_won", label: "Sets won", direction: "desc" },
  { key: "sets_lost", label: "Sets lost", direction: "asc" },
  { key: "games_won", label: "Games won", direction: "desc" },
  { key: "games_lost", label: "Games lost", direction: "asc" },
  { key: "points_won", label: "Points won", direction: "desc", display: false },
];

export function makeNestedModule(
  preset: NestedPreset,
): SportModule<NestedCfg, NestedEv, NestedState> {
  const configSchema = makeNestedConfigSchema(preset.defaults);
  const pointType = `${preset.key}.point`;
  const summaryType = `${preset.key}.set_summary`;

  const fidelityTiers: FidelityTier[] = [
    { tier: 0, eventTypes: [summaryType] },
    { tier: 1, eventTypes: [summaryType] },
    { tier: 2, eventTypes: [pointType], entitlement: preset.rallyEntitlement },
    { tier: 3, eventTypes: [pointType], entitlement: preset.rallyEntitlement },
  ];

  const sideMetrics = (state: NestedState, side: Side): Record<string, number> => {
    const opp = opponent(side);
    const gamesOf = (s: Side): number =>
      state.sets.reduce((sum, set) => sum + (set.mtb === true ? 0 : set[s]), 0) + state.games[s];
    return {
      sets_won: state.setsWon[side],
      sets_lost: state.setsWon[opp],
      games_won: gamesOf(side),
      games_lost: gamesOf(opp),
      points_won: state.pointsWon[side],
    };
  };

  return {
    key: preset.key,
    version: preset.version,
    configSchema,
    eventSchema: NestedEv,
    positions: preset.positions,
    variants: preset.variants,

    init(cfg, lineups: LineupPair): NestedState {
      return {
        cfg,
        entrants: { home: lineups.home.entrantId, away: lineups.away.entrantId },
        phase: "pre",
        sets: [],
        games: { home: 0, away: 0 },
        points: FRESH_GAME,
        setsWon: { home: 0, away: 0 },
        serving: "home", // convention: the toss is not modelled; home serves first
        tbPointsPlayed: 0,
        tbFirstServer: null,
        pointsWon: { home: 0, away: 0 },
        outcome: null,
        replayFlagged: false,
      };
    },

    apply(state, ev: EventEnvelope<NestedEv | CoreEv>): NestedState {
      switch (ev.type) {
        case "core.start":
          if (state.phase !== "pre") wrongPhase("already started");
          return { ...state, phase: "live" };
        case pointType:
          return applyPoint(state, parsePayload(NestedPoint, ev.payload, ev.type));
        case summaryType:
          return applySetSummary(state, parsePayload(NestedSetSummary, ev.payload, ev.type));
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

    // §9.5 — defined at every prefix. Headline speaks tennis: sets tally, the
    // closed-set strip (6–4 7–6(5) [10–7]), live games and the spoken game
    // score; serve state rides in detail for pads and scorebugs.
    summary(state): ScoreSummary {
      const strip = state.sets.map(closedSetLine).join(" ");
      const liveGames =
        state.phase === "live" && (setInProgress(state) || state.sets.length > 0)
          ? state.points.kind === "matchTiebreak"
            ? ` · ${gameScoreLine(state.points)}`
            : ` · ${state.games.home}–${state.games.away}` +
              (state.points.home > 0 ||
              state.points.away > 0 ||
              (state.points.kind === "standard" && state.points.advantage !== null)
                ? ` (${gameScoreLine(state.points)})`
                : "")
          : "";
      return {
        headline:
          `${state.setsWon.home} — ${state.setsWon.away}` +
          (strip === "" ? "" : ` · ${strip}`) +
          liveGames,
        perSide: [
          { entrantId: state.entrants.home, line: `${state.setsWon.home}` },
          { entrantId: state.entrants.away, line: `${state.setsWon.away}` },
        ],
        detail: {
          // Closed sets + (when play is under way) one open entry with the
          // live games — the same {home, away, closed} shape the setbased
          // kernel exposes, so the public set scoreboard renders tennis
          // without knowing the sport. The MTB live entry carries its points.
          sets: [
            ...state.sets.map((set) => ({ ...set, closed: true })),
            ...(state.phase === "live" && setInProgress(state)
              ? [
                  state.points.kind === "matchTiebreak"
                    ? { home: state.points.home, away: state.points.away, closed: false }
                    : { home: state.games.home, away: state.games.away, closed: false },
                ]
              : []),
          ],
          games: state.games,
          game: gameScoreLine(state.points),
          gameKind: state.points.kind,
          serving: state.phase === "live" ? state.serving : null,
          ...(state.replayFlagged ? { abandoned: true } : {}),
        },
      };
    },

    standingsDelta(outcome, cfg, _ctx, state): [StandingsDelta, StandingsDelta] {
      const build = (side: Side, w: number, l: number, pts: number): StandingsDelta => ({
        entrantId: state.entrants[side],
        played: 1,
        won: w,
        drawn: 0,
        lost: l,
        points: pts,
        metrics: sideMetrics(state, side),
      });
      switch (outcome.kind) {
        case "win":
        case "award": {
          const winnerSide = sideOf(state, outcome.winner);
          const winner = build(winnerSide, 1, 0, cfg.points.win);
          const loser = build(opponent(winnerSide), 0, 1, cfg.points.loss);
          return winnerSide === "home" ? [winner, loser] : [loser, winner];
        }
        default:
          invalid(`nested module cannot rank outcome "${outcome.kind}"`);
      }
    },

    metrics: METRICS,
    defaultTiebreakers: preset.defaultTiebreakers,

    supportsDraws(_cfg, _stage: StageKind) {
      return false; // v6/00 §4 — tennis never draws
    },

    declaredPointsSets(cfg) {
      return [cfg.points.win + cfg.points.loss];
    },

    fidelityTiers,
    officialLabel: preset.officialLabel,
    ...(preset.entrantModel === undefined ? {} : { entrantModel: preset.entrantModel }),

    // spec 03 §6 — deterministic generator. Summary-dominant so matches decide
    // within the conformance event budget; point bursts exercise the rally
    // path (deuce loops, TB entry) like setbased's rally bursts.
    arbitraryEvent(state, rng: Rng): ModuleEvent<NestedEv> | null {
      if (state.phase === "pre") return { type: "core.start", payload: {} };
      if (state.phase !== "live") return null;

      const randomEntrant = () => (rng() < 0.5 ? state.entrants.home : state.entrants.away);
      if (setInProgress(state)) {
        // A rally set is mid-flight — keep playing points to a finish.
        return { type: pointType, payload: { by: randomEntrant() } };
      }
      const roll = rng();
      if (roll < 0.02) {
        return { type: "core.forfeit", payload: { by: randomEntrant(), reason: "walkover" } };
      }
      if (roll < 0.04) return { type: "core.abandon", payload: { reason: "rain" } };
      if (roll < 0.14) return { type: pointType, payload: { by: randomEntrant() } };

      // Valid random set summary under the rules of the set about to start.
      const rules = rulesFor(state);
      const homeWins = rng() < 0.5;
      if (rules.mtbTo !== null) {
        const lo = Math.floor(rng() * Math.max(1, rules.mtbTo - state.cfg.tiebreak.winBy + 1));
        const hi = rules.mtbTo;
        return {
          type: summaryType,
          payload: { home: homeWins ? hi : lo, away: homeWins ? lo : hi },
        };
      }
      // ~30% tie-break sets when the set can have one.
      if (rules.tiebreakAt !== null && rng() < 0.3) {
        const tbLo = Math.floor(
          rng() * Math.max(1, rules.tiebreakTo - state.cfg.tiebreak.winBy + 1),
        );
        const tb = homeWins
          ? { home: rules.tiebreakTo, away: tbLo }
          : { home: tbLo, away: rules.tiebreakTo };
        const hi = rules.tiebreakAt + 1;
        const lo = rules.tiebreakAt;
        return {
          type: summaryType,
          payload: { home: homeWins ? hi : lo, away: homeWins ? lo : hi, tb },
        };
      }
      const lo = Math.floor(rng() * Math.max(1, rules.gamesTo - rules.winBy + 1));
      return {
        type: summaryType,
        payload: { home: homeWins ? rules.gamesTo : lo, away: homeWins ? lo : rules.gamesTo },
      };
    },
  };
}
