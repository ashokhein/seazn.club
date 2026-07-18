// Set-based scoring kernel — spec 04 §3–5 + engine/sports/{volleyball,badminton,
// table-tennis}.md (PROMPT-06). ONE parametric engine parameterised by
// {bestOf, setTo, finalSetTo, winBy, cap, pointsMap}; volleyball, badminton and
// table tennis are three thin presets — this file owns every line of set logic,
// the presets add only catalog/metrics/labels. Dual fidelity (spec 04 §9.6):
// fine `rally {wonBy}` and coarse `*.summary` fold to identical set totals and
// outcomes, and all result math reads only the folded set ledger.
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
import type { EntrantModel } from "../../sport/entrant-model.ts";
import type {
  FidelityTier,
  ModuleEvent,
  SportModule,
  TiebreakerKey,
} from "../../sport/module.ts";

// ---------------------------------------------------------------------------
// Kernel parameters & config — spec 04 §3.1 / §4 / §5
// ---------------------------------------------------------------------------

// A completed-set score maps to [winnerPoints, loserPoints] keyed by the
// winner's set tally "W-L" (FIVB 3-2 → [2,1]); "*" is the fall-through for
// every other (clean-win) score. Integers only — spec 04 §9.3.
export const PointsPair = z.tuple([
  z.number().int().nonnegative(),
  z.number().int().nonnegative(),
]);
export type PointsPair = z.infer<typeof PointsPair>;

export interface SetBasedParams {
  bestOf: number;
  setTo: number;
  finalSetTo: number;
  winBy: number;
  cap: number | null;
  pointsMap: Record<string, PointsPair>;
}

// Builds a preset's config schema (defaults = its shipped/first variant).
// Refinements are the kernel's hard invariants: odd bestOf (so ⌈bestOf/2⌉ has a
// unique decider) and cap ≥ target.
function makeConfigSchema(defaults: SetBasedParams) {
  return z
    .object({
      bestOf: z.number().int().positive().default(defaults.bestOf),
      setTo: z.number().int().positive().default(defaults.setTo),
      finalSetTo: z.number().int().positive().default(defaults.finalSetTo),
      winBy: z.number().int().positive().default(defaults.winBy),
      cap: z.number().int().positive().nullable().default(defaults.cap),
      pointsMap: z.record(z.string().min(1), PointsPair).default(defaults.pointsMap),
    })
    .refine((cfg) => cfg.bestOf % 2 === 1, { message: "bestOf must be odd (a decider must exist)" })
    .refine((cfg) => cfg.cap === null || cfg.cap >= Math.max(cfg.setTo, cfg.finalSetTo), {
      message: "cap must be ≥ the set target",
    })
    .refine((cfg) => Object.keys(cfg.pointsMap).length > 0, {
      message: "pointsMap needs at least one entry",
    });
}

export type SetBasedCfg = SetBasedParams;

// ---------------------------------------------------------------------------
// Events — spec 04 §3.2 / §4 / §5
// ---------------------------------------------------------------------------

export const SetBasedRally = z.strictObject({ wonBy: EntrantId });
export type SetBasedRally = z.infer<typeof SetBasedRally>;

// Coarse fidelity. Two accepted shapes fold identically:
//  • positional `{home, away}` — the scorer form (spec 04 §3.2 `set.summary`);
//  • entrant-keyed `{by, forBy, forOpp}` — the fidelity bridge coarsen emits,
//    position-independent so coarsen needs no lineup context (`by` scored
//    `forBy`, the opponent `forOpp`).
// `partial: true` = an in-progress (non-terminal) snapshot — the coarse analogue
// of an unfinished rally set, so a stream stopped mid-set renders the same live
// score after coarsening (spec 04 §9.6).
export const SetSummaryPositional = z.strictObject({
  home: z.number().int().nonnegative(),
  away: z.number().int().nonnegative(),
  partial: z.boolean().optional(),
});
export const SetSummaryByEntrant = z.strictObject({
  by: EntrantId,
  forBy: z.number().int().nonnegative(),
  forOpp: z.number().int().nonnegative(),
  partial: z.boolean().optional(),
});
export const SetBasedSummary = z.union([SetSummaryPositional, SetSummaryByEntrant]);
export type SetBasedSummary = z.infer<typeof SetBasedSummary>;

export const SetBasedEv = z.union([SetBasedRally, SetBasedSummary]);
export type SetBasedEv = z.infer<typeof SetBasedEv>;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

type Side = "home" | "away";

export interface SetState {
  home: number;
  away: number;
  closed: boolean;
}

export interface SetBasedState {
  cfg: SetBasedCfg;
  entrants: { home: string; away: string };
  phase: "pre" | "live" | "done" | "final" | "abandoned";
  sets: SetState[]; // closed sets in order + at most one trailing open set
  setsWon: { home: number; away: number };
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

function sideOf(state: SetBasedState, entrantId: string): Side {
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
// Set-win predicate & reachability — spec 04 §3.3 (single source of truth for
// both fidelities and coarsen)
// ---------------------------------------------------------------------------

const majority = (bestOf: number): number => Math.ceil(bestOf / 2);

// The deciding set is the last possible one (index bestOf−1, reached only at
// ⌈bestOf/2⌉−1 sets each) and uses finalSetTo (spec 04 §3.3).
function setTarget(params: SetBasedParams, setIndex: number): number {
  return setIndex === params.bestOf - 1 ? params.finalSetTo : params.setTo;
}

// Winner of a set at score (h,a), or null while it is still live. `cap` is the
// hard golden-point ceiling (badminton 30-29); cap=null = uncapped win-by-two
// endgame (volleyball 32-30). spec 04 §3.3.
function setWinner(
  h: number,
  a: number,
  target: number,
  winBy: number,
  cap: number | null,
): Side | null {
  const winner: Side | null = h > a ? "home" : a > h ? "away" : null;
  if (winner === null) return null;
  const hi = Math.max(h, a);
  const lo = Math.min(h, a);
  if (cap !== null && hi >= cap) return winner;
  if (hi >= target && hi - lo >= winBy) return winner;
  return null;
}

// A summary score is *reachable* iff it is terminal and the score one point
// earlier (winner one lower) was still live — rejecting 25-24 (winBy 2, no cap)
// and 22-19 / 31-30 (already decided earlier), accepting 26-24, 30-29 (cap),
// 32-30 (spec 04 §3.3; badminton/TT §3 corners).
function reachableSetScore(
  h: number,
  a: number,
  target: number,
  winBy: number,
  cap: number | null,
): boolean {
  // The set ends *at* the cap, so no score can exceed it (rejects 31-30).
  if (cap !== null && Math.max(h, a) > cap) return false;
  const winner = setWinner(h, a, target, winBy, cap);
  if (winner === null) return false;
  const prevH = winner === "home" ? h - 1 : h;
  const prevA = winner === "away" ? a - 1 : a;
  if (prevH < 0 || prevA < 0) return false;
  return setWinner(prevH, prevA, target, winBy, cap) === null;
}

// ---------------------------------------------------------------------------
// Fold helpers
// ---------------------------------------------------------------------------

function openSet(state: SetBasedState): { set: SetState; index: number } | null {
  const index = state.sets.length - 1;
  const set = state.sets[index];
  if (set === undefined || set.closed) return null;
  return { set, index };
}

function replaceSet(state: SetBasedState, index: number, set: SetState): SetBasedState {
  return { ...state, sets: state.sets.map((entry, i) => (i === index ? set : entry)) };
}

function totalPoints(state: SetBasedState, side: Side): number {
  return state.sets.reduce((sum, set) => sum + set[side], 0);
}

// Closes the set at `index` for `winnerSide`, banks the set win and decides the
// match when a side reaches ⌈bestOf/2⌉ sets (spec 04 §3.3). No draws, ever.
function bankSet(state: SetBasedState, index: number, winnerSide: Side): SetBasedState {
  const closed: SetState = { ...(state.sets[index] as SetState), closed: true };
  const setsWon = { ...state.setsWon, [winnerSide]: state.setsWon[winnerSide] + 1 };
  let next: SetBasedState = { ...replaceSet(state, index, closed), setsWon };
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
  }
  return next;
}

// ---------------------------------------------------------------------------
// Event application
// ---------------------------------------------------------------------------

function applyRally(state: SetBasedState, payload: SetBasedRally): SetBasedState {
  if (state.phase !== "live") wrongPhase(`rally not allowed in phase "${state.phase}"`);
  const side = sideOf(state, payload.wonBy);

  let next = state;
  let open = openSet(next);
  if (open === null) {
    next = { ...next, sets: [...next.sets, { home: 0, away: 0, closed: false }] };
    open = openSet(next) as { set: SetState; index: number };
  }
  const scored: SetState = { ...open.set, [side]: open.set[side] + 1 };
  const target = setTarget(next.cfg, open.index);
  const winner = setWinner(scored.home, scored.away, target, next.cfg.winBy, next.cfg.cap);
  next = replaceSet(next, open.index, scored);
  return winner === null ? next : bankSet(next, open.index, winner);
}

// Resolves either summary shape to positional home/away.
function normalizeSummary(
  state: SetBasedState,
  payload: SetBasedSummary,
): { home: number; away: number; partial: boolean } {
  if ("by" in payload) {
    const side = sideOf(state, payload.by);
    const home = side === "home" ? payload.forBy : payload.forOpp;
    const away = side === "home" ? payload.forOpp : payload.forBy;
    return { home, away, partial: payload.partial === true };
  }
  return { home: payload.home, away: payload.away, partial: payload.partial === true };
}

function applySummary(state: SetBasedState, payload: SetBasedSummary): SetBasedState {
  if (state.phase !== "live") wrongPhase(`set summary not allowed in phase "${state.phase}"`);
  const params = state.cfg;
  const { home, away, partial } = normalizeSummary(state, payload);

  if (partial) {
    // In-progress snapshot: create/refresh an open set; must not already be
    // terminal (a finished set arrives as a non-partial summary).
    const open = openSet(state);
    const index = open?.index ?? state.sets.length;
    const target = setTarget(params, index);
    if (setWinner(home, away, target, params.winBy, params.cap) !== null) {
      invalid("a partial set summary must not be a completed set score", { home, away });
    }
    if (open === null) {
      return { ...state, sets: [...state.sets, { home, away, closed: false }] };
    }
    if (home < open.set.home || away < open.set.away) {
      invalid("a partial set summary may not decrease the score");
    }
    return replaceSet(state, index, { ...open.set, home, away });
  }

  // Completed-set summary: no rally set may be mid-flight (dual fidelity is
  // per-set, not per-point).
  const open = openSet(state);
  if (open !== null && (open.set.home > 0 || open.set.away > 0)) {
    invalid("this set is being scored rally-by-rally — a set summary is not allowed for it");
  }
  const index = open === null ? state.sets.length : open.index;
  const target = setTarget(params, index);
  const winner = setWinner(home, away, target, params.winBy, params.cap);
  if (winner === null || !reachableSetScore(home, away, target, params.winBy, params.cap)) {
    invalid("set summary is not a reachable final score under the set predicate", {
      home,
      away,
      target,
      winBy: params.winBy,
      cap: params.cap,
    });
  }
  const set: SetState = { home, away, closed: false };
  const withSet =
    open === null ? { ...state, sets: [...state.sets, set] } : replaceSet(state, index, set);
  return bankSet(withSet, index, winner);
}

// Forfeit — spec 04 §3 / volleyball.md §7: award the match to the opponent;
// completed sets already stand in the ledger.
function applyForfeit(state: SetBasedState, by: string): SetBasedState {
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

// Abandon — leave the fixture undecided and flagged for regeneration (mirrors
// football's replay policy; a gym closure is re-scheduled, not awarded).
function applyAbandon(state: SetBasedState): SetBasedState {
  if (state.phase === "done" || state.phase === "final" || state.phase === "abandoned") {
    wrongPhase("match already over");
  }
  return { ...state, phase: "abandoned", replayFlagged: true };
}

// ---------------------------------------------------------------------------
// Generator helper — a reachable completed-set score for the given target.
// ---------------------------------------------------------------------------

function generateSetScore(
  target: number,
  winBy: number,
  cap: number | null,
  rng: Rng,
): [hi: number, lo: number] {
  // ~25% deuce/cap endings, else a clean win to the target.
  if (rng() < 0.25) {
    const ceiling = cap ?? target + winBy + 4;
    // Winner lands on hi with the loser winBy behind, or exactly at the cap.
    let hi = target + 1 + Math.floor(rng() * Math.max(1, ceiling - target - 1));
    if (cap !== null && rng() < 0.4) hi = cap;
    hi = Math.min(hi, cap ?? hi);
    const lo = cap !== null && hi === cap ? hi - 1 : hi - winBy;
    if (reachableSetScore(hi, lo, target, winBy, cap)) return [hi, Math.max(0, lo)];
  }
  const lo = Math.floor(rng() * Math.max(1, target - winBy + 1));
  return [target, lo];
}

// ---------------------------------------------------------------------------
// Preset wiring — the parts that differ between the three sports
// ---------------------------------------------------------------------------

export interface SetBasedPreset {
  key: string; // 'volleyball' | 'badminton' | 'tabletennis'
  version: string;
  defaults: SetBasedParams; // shipped variant (also what coarsen segments under)
  variants: Record<string, Partial<SetBasedParams>>;
  positions: PositionCatalog;
  // Metric labels differ (Sets vs Games); keys stay set_ratio/point_ratio so the
  // shared comparator registry (PROMPT-08) resolves them uniformly.
  unitLabel: { one: string; many: string };
  defaultTiebreakers: TiebreakerKey[];
  officialLabel: { scorer: string };
  coarseEventType: "set.summary" | "game.summary";
  rallyEntitlement: string; // doc 10 FeatureKey for Tier-2/3 rally scoring
  entrantModel?: EntrantModel;
}

function makeMetrics(unit: { one: string; many: string }): MetricSpec[] {
  // doc 09 §2: the public table shows sets won/lost plus the cascade-derived
  // set/point ratios (engine competition/display.ts); raw point tallies are
  // ledger-only ratio operands.
  return [
    { key: "sets_won", label: `${unit.many} won`, direction: "desc" },
    { key: "sets_lost", label: `${unit.many} lost`, direction: "asc" },
    { key: "points_won", label: "Points won", direction: "desc", display: false },
    { key: "points_lost", label: "Points lost", direction: "asc", display: false },
  ];
}

// ---------------------------------------------------------------------------
// Module factory
// ---------------------------------------------------------------------------

export function makeSetBasedModule(
  preset: SetBasedPreset,
): SportModule<SetBasedCfg, SetBasedEv, SetBasedState> {
  const configSchema = makeConfigSchema(preset.defaults);
  const rallyType = `${preset.key}.rally`;
  const summaryType = `${preset.key}.${preset.coarseEventType}`;
  const coarsenParams = preset.defaults; // spec 04 §9.6 conformance runs at default cfg

  const fidelityTiers: FidelityTier[] = [
    { tier: 0, eventTypes: [summaryType] },
    { tier: 1, eventTypes: [summaryType] },
    { tier: 2, eventTypes: [rallyType], entitlement: preset.rallyEntitlement },
    { tier: 3, eventTypes: [rallyType], entitlement: preset.rallyEntitlement },
  ];

  // Award/forfeit points = a clean-sweep win pair: "*" (or the first entry).
  const cleanSweepPair = (cfg: SetBasedCfg): PointsPair =>
    cfg.pointsMap["*"] ?? (Object.values(cfg.pointsMap)[0] as PointsPair | undefined) ?? [1, 0];

  // pointsMap lookup for a decided match: exact "W-L", else "*".
  const matchPoints = (cfg: SetBasedCfg, winnerSets: number, loserSets: number): PointsPair => {
    const exact = cfg.pointsMap[`${winnerSets}-${loserSets}`];
    if (exact !== undefined) return exact;
    const wildcard = cfg.pointsMap["*"];
    if (wildcard !== undefined) return wildcard;
    invalid(`no pointsMap entry for set score ${winnerSets}-${loserSets}`);
  };

  const sideMetrics = (state: SetBasedState, side: Side): Record<string, number> => ({
    sets_won: state.setsWon[side],
    sets_lost: state.setsWon[opponent(side)],
    points_won: totalPoints(state, side),
    points_lost: totalPoints(state, opponent(side)),
  });

  return {
    key: preset.key,
    version: preset.version,
    configSchema,
    eventSchema: SetBasedEv,
    positions: preset.positions,
    variants: preset.variants,
    ...(preset.entrantModel === undefined ? {} : { entrantModel: preset.entrantModel }),

    init(cfg, lineups: LineupPair): SetBasedState {
      return {
        cfg,
        entrants: { home: lineups.home.entrantId, away: lineups.away.entrantId },
        phase: "pre",
        sets: [],
        setsWon: { home: 0, away: 0 },
        outcome: null,
        replayFlagged: false,
      };
    },

    apply(state, ev: EventEnvelope<SetBasedEv | CoreEv>): SetBasedState {
      switch (ev.type) {
        case "core.start":
          if (state.phase !== "pre") wrongPhase("already started");
          return { ...state, phase: "live" };
        case rallyType:
          return applyRally(state, parsePayload(SetBasedRally, ev.payload, ev.type));
        case summaryType:
          return applySummary(state, parsePayload(SetBasedSummary, ev.payload, ev.type));
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

    // §9.5 — defined at every prefix; reads only the folded set ledger so
    // coarse and fine folds render identically (§9.6). The headline carries the
    // per-set points, racquet-scoreline style ("2 — 0 · 21–15, 21–18"): a
    // just-entered set summary must be visible in the top score (v3/09 §1a —
    // "chosen score not reflected in top score").
    summary(state): ScoreSummary {
      const points = { home: totalPoints(state, "home"), away: totalPoints(state, "away") };
      const closedSets = state.sets.filter((set) => set.closed);
      const setLine =
        closedSets.length === 0
          ? ""
          : ` · ${closedSets.map((set) => `${set.home}–${set.away}`).join(", ")}`;
      // While a set is mid-flight, surface its live points next to the set
      // tally ("1 — 0 · 21–15 (14–11)") so rally scoring is visible too.
      const open = openSet(state);
      const inSet = open === null ? "" : ` (${open.set.home}–${open.set.away})`;
      return {
        headline: `${state.setsWon.home} — ${state.setsWon.away}${setLine}${inSet}`,
        perSide: [
          { entrantId: state.entrants.home, line: `${state.setsWon.home}` },
          { entrantId: state.entrants.away, line: `${state.setsWon.away}` },
        ],
        detail: {
          sets: state.sets.map((set) => ({ home: set.home, away: set.away, closed: set.closed })),
          points,
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
        case "win": {
          const winnerSide = sideOf(state, outcome.winner);
          const [wp, lp] = matchPoints(
            cfg,
            state.setsWon[winnerSide],
            state.setsWon[opponent(winnerSide)],
          );
          const winner = build(winnerSide, 1, 0, wp);
          const loser = build(opponent(winnerSide), 0, 1, lp);
          return winnerSide === "home" ? [winner, loser] : [loser, winner];
        }
        case "award": {
          // Forfeit: clean-sweep pair to keep the total inside declaredPointsSets.
          const winnerSide = sideOf(state, outcome.winner);
          const [wp, lp] = cleanSweepPair(cfg);
          const winner = build(winnerSide, 1, 0, wp);
          const loser = build(opponent(winnerSide), 0, 1, lp);
          return winnerSide === "home" ? [winner, loser] : [loser, winner];
        }
        // Set-based sports always produce a winner (§3.3 supportsDraws = false);
        // abandon leaves the outcome null, so no draw/tie/no_result reaches here.
        default:
          invalid(`set-based module cannot rank outcome "${outcome.kind}"`);
      }
    },

    metrics: makeMetrics(preset.unitLabel),
    defaultTiebreakers: preset.defaultTiebreakers,

    supportsDraws(_cfg, _stage: StageKind) {
      return false;
    },

    // §9.3 — every decided fixture pays a pointsMap value-sum (award reuses the
    // clean-sweep pair, whose sum is already present).
    declaredPointsSets(cfg) {
      return [...new Set(Object.values(cfg.pointsMap).map(([w, l]) => w + l))];
    },

    fidelityTiers,
    officialLabel: preset.officialLabel,

    // spec 03 §6 — deterministic generator. Summary-dominant so best-of-N
    // matches decide within the conformance event budget; rally bursts exercise
    // the point-by-point path and coarsen (§9.6).
    arbitraryEvent(state, rng: Rng): ModuleEvent<SetBasedEv> | null {
      if (state.phase === "pre") return { type: "core.start", payload: {} };
      if (state.phase !== "live") return null;

      const randomEntrant = () => (rng() < 0.5 ? state.entrants.home : state.entrants.away);
      const open = openSet(state);
      if (open !== null) {
        // A rally set is mid-flight — keep rallying it to a finish.
        return { type: rallyType, payload: { wonBy: randomEntrant() } };
      }
      const roll = rng();
      if (roll < 0.02) {
        return { type: "core.forfeit", payload: { by: randomEntrant(), reason: "walkover" } };
      }
      if (roll < 0.04) return { type: "core.abandon", payload: { reason: "venue closed" } };
      if (roll < 0.14) return { type: rallyType, payload: { wonBy: randomEntrant() } };
      const target = setTarget(state.cfg, state.sets.length);
      const [hi, lo] = generateSetScore(target, state.cfg.winBy, state.cfg.cap, rng);
      const homeWins = rng() < 0.5;
      return {
        type: summaryType,
        payload: { home: homeWins ? hi : lo, away: homeWins ? lo : hi },
      };
    },

    // §9.6 — collapse a rally stream into per-set summaries. Completed sets emit
    // a non-partial entrant-keyed summary; a trailing open set emits a `partial`
    // snapshot. Segmentation is position-independent: it tracks the two entrant
    // ids in local slots and asks setWinner which slot won, so no lineup context
    // is needed. core/positional-summary events flush the open set, then pass
    // through. Uses the preset default params (coarsenParams; §9.6 runs at the
    // default cfg — the shipped variant).
    coarsen(events): ModuleEvent<SetBasedEv>[] {
      const out: ModuleEvent<SetBasedEv>[] = [];
      let setsPlayed = 0;
      // Local slot A = first id seen this set, B = the other.
      let idA: string | null = null;
      let idB: string | null = null;
      let a = 0;
      let b = 0;

      const resetSet = () => {
        idA = null;
        idB = null;
        a = 0;
        b = 0;
      };
      const flushPartial = () => {
        if (a === 0 && b === 0) return;
        // Slot A always fills first, so idA is set whenever any point exists.
        out.push({
          type: summaryType,
          payload: { by: idA as string, forBy: a, forOpp: b, partial: true },
        });
        resetSet();
      };

      for (const event of events) {
        if (event.type === rallyType) {
          const { wonBy } = event.payload as SetBasedRally;
          if (idA === null || wonBy === idA) {
            idA = wonBy;
            a += 1;
          } else {
            idB = wonBy;
            b += 1;
          }
          const target = setTarget(coarsenParams, setsPlayed);
          const winner = setWinner(a, b, target, coarsenParams.winBy, coarsenParams.cap);
          if (winner !== null) {
            const winnerId = (winner === "home" ? idA : idB) as string;
            out.push({
              type: summaryType,
              payload: {
                by: winnerId,
                forBy: winner === "home" ? a : b,
                forOpp: winner === "home" ? b : a,
              },
            });
            setsPlayed += 1;
            resetSet();
          }
          continue;
        }
        // Non-rally: flush the open set, then pass through. A completed
        // (non-partial) summary already occupies a set slot, so advance the set
        // index — otherwise a later rally set (e.g. the decider) would segment
        // under the wrong target (spec 04 §3.3).
        flushPartial();
        out.push({ type: event.type, payload: event.payload });
        if (event.type === summaryType && (event.payload as { partial?: boolean }).partial !== true) {
          setsPlayed += 1;
        }
      }
      flushPartial();
      return out;
    },
  };
}
