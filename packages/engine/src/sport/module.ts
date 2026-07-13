// SportModule contract — spec 03 §3, extended by doc 14 §2 (fidelityTiers),
// doc 13 §1 (officialLabel) and the conformance kit's needs (PROMPT-03 §4:
// declaredPointsSets; arbitraryEvent/coarsen hooks from spec 03 §6 + §9.6).
import { z } from "zod";
import type { CoreEv, EventEnvelope, FoldableModule } from "../core/events.ts";
import type { Rng } from "../core/rng.ts";
import type {
  LineupPair,
  MatchOutcome,
  MetricSpec,
  ScoreSummary,
  StageCtx,
  StageKind,
  StandingsDelta,
} from "../core/types.ts";
import type { PositionCatalog } from "./catalog.ts";
import type { DocSection } from "../exports/types.ts";
import type { PlayerStatsModel } from "../stats/stats.ts";

// Jul3/06 §3 — what a print fragment gets to work with (display labels only;
// TBD feeds arrive pre-rendered as "Winner of QF1").
export interface ScoresheetInput {
  home: string;
  away: string;
  homeColor?: string;
  awayColor?: string;
  at?: string;
  court?: string;
  stageName?: string;
  /** Blank scoresheet for manual filling (Jul3/06 §7). */
  blank?: boolean;
}

// doc 05 §4.1 — comparator keys resolved by the competition engine's
// tiebreaker registry (lands in PROMPT-08); modules declare their official
// cascade with these.
export type TiebreakerKey =
  | "points"
  | "wins"
  | "h2h_points"
  | "h2h_diff"
  | "h2h_for"
  | "diff"
  | "for"
  | "nrr"
  | "set_ratio"
  | "game_ratio"
  | "board_ratio"
  | "point_ratio"
  | "buchholz"
  | "buchholz_cut1"
  | "sberger"
  | "direct"
  | "fair_play"
  | "seed"
  | "lots";

// doc 14 §1–2 — the four-tier granularity ladder. The scoring UI, the
// entitlement gate (PROMPT-13) and API docs all derive from this declaration.
export const FidelityTier = z.object({
  tier: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]),
  eventTypes: z.array(z.string().min(1)).min(1),
  entitlement: z.string().min(1).optional(), // FeatureKey, doc 10
});
export type FidelityTier = z.infer<typeof FidelityTier>;

// A type + payload pair before persistence stamps the envelope fields
// (id/seq/recordedAt) — what generators and coarsen produce.
export interface ModuleEvent<Ev = unknown> {
  type: string;
  payload: Ev | CoreEv;
}

// spec 03 §3. Extends the kernel's FoldableModule (spec 03 §2) so every
// SportModule folds through foldMatch unchanged.
export interface SportModule<Cfg, Ev, State> extends FoldableModule<Cfg, State> {
  key: string; // 'cricket'
  version: string; // semver; persisted on every division at creation
  configSchema: z.ZodType<Cfg>; // variant config (overs, setTo, halfMinutes…)
  eventSchema: z.ZodType<Ev>; // union of the sport's event payloads
  positions: PositionCatalog; // spec 02 §3
  variants: Record<string, Partial<Cfg>>; // named presets: t20, odi, beach, blitz…

  // Jul3/06 §3 — optional print-template fragments. Sport-neutral kinds
  // (timetable, standings, roster, participants) live in engine/exports; a
  // sport contributes only what needs its match grammar (a volleyball
  // scoresheet's per-set point columns, a football report's goal lines).
  exportTemplates?: {
    scoresheet?(input: ScoresheetInput, cfg: Cfg): DocSection[];
    matchReport?(input: ScoresheetInput, cfg: Cfg): DocSection[];
  };

  // Jul3/07 §3 — which fine events feed which player metrics. The engine
  // folds; scoring math stays here. Sports without person-attributed events
  // simply omit it (leaderboards then say "requires detailed scoring").
  playerStats?: PlayerStatsModel;

  init(cfg: Cfg, lineups: LineupPair): State;
  apply(state: State, ev: EventEnvelope<Ev | CoreEv>): State; // pure; throws EngineError
  outcome(state: State): MatchOutcome | null; // null = still live
  summary(state: State): ScoreSummary; // display-ready at every prefix (§9.5)

  // PROMPT-03 deviation from spec 03 §3: `state` appended to the signature —
  // ledger metrics (gf/ga, NRR integer ledger…) live in the folded state, not
  // in the outcome; the adapter has MatchState at hand when a fixture decides.
  // Returned pair is [home, away] in lineup order.
  standingsDelta(
    outcome: MatchOutcome,
    cfg: Cfg,
    ctx: StageCtx,
    state: State,
  ): [StandingsDelta, StandingsDelta];
  metrics: MetricSpec[]; // ledger fields this sport maintains (gd, nrr, set_ratio…)
  defaultTiebreakers: TiebreakerKey[]; // sport's official cascade (doc 05 §4)
  supportsDraws(cfg: Cfg, stage: StageKind): boolean; // knockout football: no

  // §9.3 — allowed per-fixture point totals under cfg (football {3, 2}, …);
  // the conformance kit checks Σ points of both deltas is in this set.
  declaredPointsSets(cfg: Cfg): readonly number[];

  fidelityTiers: FidelityTier[]; // doc 14 §2
  officialLabel: { scorer: string }; // doc 13 §1 — 'Umpire'/'Referee'/'Arbiter'

  // spec 03 §6 — deterministic valid-event generator for property tests.
  // Deviation: rng-injected instead of a fast-check Arbitrary so the engine
  // keeps zero runtime deps; the testkit adapts it. null = no valid event can
  // follow this state (match decided/finalized).
  arbitraryEvent?(state: State, rng: Rng): ModuleEvent<Ev> | null;

  // §9.6 dual-fidelity hook (opt-in): collapse a fine (void-resolved) stream
  // into coarse events that fold to identical totals and outcome.
  coarsen?(events: readonly EventEnvelope<Ev | CoreEv>[]): ModuleEvent<Ev>[];
}

// Registry-facing view — the generics are the module author's business.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnySportModule = SportModule<any, any, any>;
