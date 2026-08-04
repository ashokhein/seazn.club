// Football SportModule — spec 04 §1 + engine/sports/football.md (PROMPT-04).
// Timed periods, draws league-only, ET/shootout sub-machines, FIFA fair play,
// two official tiebreaker presets (fifa2026 H2H-first / classic GD-first).
import { z } from "zod";
import { EngineError } from "../../core/errors.ts";
import { isStrictFold, resolveVoids, type CoreEv, type EventEnvelope } from "../../core/events.ts";
import type { Rng } from "../../core/rng.ts";
import { GameTime, addDuration, compareGameTime, gameTimeOf } from "../../core/time.ts";
import { periodClockPosition, type MatchPosition } from "../../core/position.ts";
import {
  AttemptOutcome,
  EntrantId,
  type DisciplineCard,
  type LineupPair,
  type MatchOutcome,
  type ScoreSummary,
  type StageCtx,
  type StageKind,
  type StandingsDelta,
} from "../../core/types.ts";
import type { PositionCatalog } from "../../sport/catalog.ts";
import type { ModuleEvent, SportModule, TiebreakerKey } from "../../sport/module.ts";
import { expectedKicker, shootoutDecision } from "../period/shootout.ts";

// ---------------------------------------------------------------------------
// Cfg — spec 04 §1.1
// ---------------------------------------------------------------------------

export const FootballCfg = z.object({
  halfMinutes: z.number().int().positive().default(45),
  // W4a (#425) §3.2, as amended 2026-08-04 — the OVERRIDE the unserved-remainder
  // carry reads, and only for what the required scalars cannot express.
  //
  // `halfMinutes` is required and fixes BOTH halves; `extraTime.halfMinutes`
  // fixes both extra-time halves. Those are where the carry gets its lengths,
  // which is why this wave needed no new required config at all. What a single
  // scalar per group cannot say is that the two halves of a group are of
  // UNEQUAL length, and that is the entire remaining job of this map.
  //
  // A map giving every half in a group the SAME value therefore states nothing
  // the scalar does not — duplicated authority, not a refinement — so where the
  // two disagree the required scalar WINS and the uniform map is IGNORED.
  //
  // Ignored rather than refused, deliberately: cfg is read live from
  // `division.config` on every fold, a correct length is always in hand, and a
  // CONFIG_INVALID raised on the replay path would let one later admin edit make
  // every already-scored fixture in the division permanently unviewable.
  //
  // Optional with NO default — a defaulted key lands in the cfg serialised into
  // every frozen golden state string.
  periodSeconds: z.record(z.string().min(1), z.number().int().positive()).optional(),
  // The state machine models exactly two halves (spec 04 §1.3); halves is
  // config-as-data for forward compatibility but only 2 is valid today.
  halves: z.literal(2).default(2),
  extraTime: z
    .object({
      enabled: z.boolean(),
      halfMinutes: z.number().int().positive(),
    })
    .default({ enabled: false, halfMinutes: 15 }), // knockout only
  shootout: z.boolean().default(false), // knockout only
  points: z
    .object({
      win: z.number().int().nonnegative().default(3),
      draw: z.number().int().nonnegative().default(1),
      loss: z.number().int().nonnegative().default(0),
      // spec 04 §1.4 — optional split for group-stage shootouts
      // (youth-cup convention: SO win 2, SO loss 1).
      shootoutWin: z.number().int().nonnegative().optional(),
      shootoutLoss: z.number().int().nonnegative().optional(),
    })
    .default({ win: 3, draw: 1, loss: 0 }),
  awardScore: z.object({ goals: z.number().int().positive() }).default({ goals: 3 }),
  fairPlay: z.boolean().default(true), // track cards for FIFA fair-play TB
  // W4 (Law 3) — return ("rolling"/"flying") substitutions. 11-a-side under the
  // Laws forbids a substituted player from returning; FA youth football and
  // every small-sided/futsal code permits repeat substitutions. Optional with
  // no default: absent ≡ the pre-W4 behaviour (returns forbidden).
  rollingSubs: z.boolean().optional(),
  // W4 (Law 3) — competition cap on substitutions per side (5 in senior
  // 11-a-side since 2020; unlimited under rollingSubs). Absent = uncapped,
  // which is what every stream recorded before W4 assumed.
  maxSubs: z.number().int().nonnegative().optional(),
  // W4 (Law 12 addendum, temporary dismissals) — the competition's sin-bin
  // period in minutes, used when a `football.sinbin.start` event omits its own.
  // The FA runs 10 minutes in 90-minute football and reduces it pro rata for
  // shorter formats, so this is a competition setting, not a Law constant.
  sinBinMinutes: z.number().int().positive().optional(),
  // W4 (Law 3 §1, "a match is played by two teams, each of not more than
  // eleven players") — the number of players a side fields. The Laws set 11 for
  // the senior game; FA Mini-Soccer and the small-sided/futsal codes run 5, 7
  // or 9 a side, and a competition may lower the minimum. Drives the resolved
  // PositionCatalog (`positionsFor`) rather than the fold: positions are lineup
  // data and never touch scoring math. Optional with no default — absent ≡ 11,
  // which is what every stream recorded before W4 assumed.
  teamSize: z.number().int().min(2).max(11).optional(),
  // W4a (#425) §5.2 (Law 3) — the competition's allowance of substitution
  // WINDOWS, which is a different bound from `maxSubs` and applies alongside it:
  // senior 11-a-side permits five substitutions taken in three windows, so a
  // side that uses all five one at a time has broken the Law while never
  // reaching the cap. A window is the set of substitutions sharing one `at` —
  // the stoppage, not the player. Optional with NO default: absent = unlimited
  // windows, which is what every stream recorded before this wave assumed, and
  // a default would land in the cfg serialised into every frozen golden state.
  subWindows: z.number().int().nonnegative().optional(),
  // engine/sports/football.md §8 — core.abandon policy: `replay` leaves the
  // fixture undecided (flagged for regeneration), `award` decides for the
  // current leader (level score ⇒ no_result).
  abandonPolicy: z.enum(["replay", "award"]).default("replay"),
});
export type FootballCfg = z.infer<typeof FootballCfg>;

// ---------------------------------------------------------------------------
// Ev — spec 04 §1.2
// ---------------------------------------------------------------------------

const PersonId = z.string().min(1);

// W4a (#425) §5.2 — `at` beside the deprecated `minute`, on every payload a
// scorer times.
//
// THE TWO ARE DIFFERENT UNITS, and that is the whole hazard: `minute` is
// MINUTES of the match as a match report prints them, `GameTime.elapsed` is
// SECONDS counted up from the start of the named period. `minute: 90` and
// `at: { period: "H2", elapsed: 90 }` are three quarters of a match apart.
// Nothing in this file converts between them — `core/time.ts`'s `parseElapsed`
// deliberately refuses a bare number for exactly this reason, because football's
// legacy field is literally called `minute` and a pad wiring a minute box to a
// seconds helper records 1:30 as 90:00.
//
// WHERE BOTH ARE PRESENT, `at` WINS. It is the only one the fold derives
// anything from (sin-bin expiry, §3.1; substitution windows, §5.2); `minute` is
// kept verbatim as the display integer the scorer wrote and is never read by
// the fold, never converted, and never overwritten. Two disagreeing values are
// a question for the match report, not for the reducer.
//
// `minute` is NOT removed: removing it would break every frozen golden and the
// additive-only tripwire that proves this wave is additive. It stays,
// deprecated in comment, exactly as the period kernel keeps `clockRef`.
//
// Every `at` below is the `GameTime` schema VERBATIM (§8), never a hand-rolled
// `z.object({ period, elapsed })` that looks like it. The kernel is fail-OPEN on
// a malformed stamp — `gameTimeOf` safe-parses, so `{ period: "H1", elapsed: -1 }`
// reads as UNSTAMPED rather than being rejected — which makes the payload's own
// schema the only thing between a corrupt stamp and the ledger. Only the real
// `GameTime` carries all four guards: non-negative, integer, non-empty period
// label, and strict.

export const FootballGoal = z.strictObject({
  by: EntrantId, // ownGoal: the side whose player struck it (credits opponent)
  scorer: PersonId.optional(),
  assist: PersonId.optional(), // Jul3/07 §3 — optional everywhere (own goals etc.)
  /** @deprecated W4a §5.2 — MINUTES, display only. Prefer `at` (seconds). */
  minute: z.number().int().nonnegative().optional(), // optional everywhere: coarse scoring
  ownGoal: z.boolean().optional(),
  penalty: z.boolean().optional(), // in-play penalty kick, not a shootout kick
  at: GameTime.optional(), // W4a §5.2 — elapsed-at-event; sweeps expired sin bins
});
export const CardColor = z.enum(["yellow", "red", "second_yellow"]);
// W4 (Law 12 §3 cautions, §4 sending-off offences) — the offence category a
// referee's match record names next to the card. The discipline usecase's
// suspension tariff is a function of THIS, not of the colour: violent conduct
// and a second caution are both red cards and carry different bans.
export const CardReason = z.enum([
  // Law 12.3 — cautionable offences.
  "unsporting_behaviour",
  "dissent",
  "persistent_offences",
  "delaying_restart",
  "failure_to_respect_distance",
  "entering_or_leaving_without_permission",
  // Law 12.4 — sending-off offences.
  "serious_foul_play",
  "violent_conduct",
  "spitting",
  "denying_goal_by_handball",
  "denying_obvious_goalscoring_opportunity",
  "offensive_language",
  "second_caution",
]);
export const FootballCard = z.strictObject({
  by: EntrantId,
  person: PersonId.optional(),
  color: CardColor,
  /** @deprecated W4a §5.2 — MINUTES, display only. Prefer `at` (seconds). */
  minute: z.number().int().nonnegative().optional(),
  reason: CardReason.optional(), // W4 — optional everywhere: coarse scoring
  at: GameTime.optional(), // W4a §5.2 — retained on State.cards[].at
});
export const FootballSub = z.strictObject({
  by: EntrantId,
  off: PersonId,
  on: PersonId,
  /** @deprecated W4a §5.2 — MINUTES, display only. Prefer `at` (seconds). */
  minute: z.number().int().nonnegative().optional(),
  // W4a §5.2 — the stamp that identifies the substitution WINDOW. Substitutions
  // sharing one `at` are one window (`Cfg.subWindows`); an UNSTAMPED
  // substitution is in no window and consumes none.
  at: GameTime.optional(),
});
export const FootballPeriod = z.strictObject({
  phase: z.enum(["HT", "FT", "ET_HT", "ET_FT"]),
  // W4 (Law 7 §3, allowance for time lost) — minutes added to the period this
  // marker CLOSES. A match report writes "90+3"; a bare integer `minute`
  // cannot tell that apart from the 93rd minute of extra time.
  addedMinutes: z.number().int().nonnegative().optional(),
  // W4a §5.2 — the whistle's own stamp. This marker IS the natural clock
  // reading of a football match ("45+2"), and it is the event that closes a
  // phase, so it is also the boundary sweep's trigger. Leaving it unstampable
  // meant the one event a scorer always times could not carry a time.
  at: GameTime.optional(),
});
export const FootballShootoutKick = z.strictObject({
  by: EntrantId,
  person: PersonId.optional(),
  scored: z.boolean(),
  // W4a §5.2 — `playPhases` lists SHOOTOUT, so a card shown during the kicks
  // was already stampable while no shoot-out payload could carry a stamp:
  // `State.asOf` froze at the last stamped card for the whole decider, and a
  // consumer reading "as of when is this true" got an instant from before the
  // shoot-out began.
  at: GameTime.optional(),
});

// W4 (Law 14) — a penalty kick awarded IN OPEN PLAY that did not produce a
// goal. A converted penalty stays `football.goal { penalty: true }` so no
// pre-W4 stream changes meaning; this branch exists purely for the kicks a
// scorebook otherwise loses. `outcome` is required, which is also what keeps
// the branch structurally distinct inside the union.
//
// W4 review item 2 — the tokens are the SHARED attempt vocabulary minus
// `scored`, derived rather than re-typed so the two can never drift apart. A
// scored penalty is the goal event, and accepting it here would let one kick
// be counted twice.
export const PenaltyOutcome = AttemptOutcome.exclude(["scored"]);
export const FootballPenalty = z.strictObject({
  by: EntrantId, // the side awarded the kick
  taker: PersonId.optional(),
  // W4 review item 1 — the DEFENDING keeper who faced it. `goalkeeper` is the
  // shared name: the period kernel's shoot-out attempt and set piece already
  // used it, and it matches the position groups the catalogs declare (FIH
  // "GK", IIHF "G"). One fact, one key, one pad control.
  goalkeeper: PersonId.optional(),
  outcome: PenaltyOutcome,
  /** @deprecated W4a §5.2 — MINUTES, display only. Prefer `at` (seconds). */
  minute: z.number().int().nonnegative().optional(),
  // W4a §5.2 — a `strictObject` with no `at` does not merely LACK the field, it
  // rejects the key: a stamped penalty was unrecordable, could never advance the
  // monotonic guard's high-water mark (so a card recorded before it was
  // accepted), and `PenaltyRecord` kept only the display `minute`.
  at: GameTime.optional(),
});

// W4 (Law 12 addendum) — a temporary dismissal ("sin bin"). The FA operates
// them below the National League System and across youth football; futsal and
// most small-sided codes use a time penalty of the same shape. No existing
// branch could express it: football.card's non-yellow path removes a player
// permanently.
//
// W4 review item 3 — the dismissal and the return are TWO events, which is the
// shape the period kernel already ships (`*.suspension.start` / `.end`). A
// sin bin genuinely IS two scorer moments minutes apart, and folding them into
// one branch behind a `returned: boolean` gave the pad one control with a
// hidden mode. The sanction LADDER stays football's own (`sin_bin`,
// `cfg.sinBinMinutes`); only the shape is shared.
export const FootballSinBinStart = z.strictObject({
  by: EntrantId,
  person: PersonId.optional(),
  minutes: z.number().int().positive().optional(), // defaults to cfg.sinBinMinutes
  /** @deprecated W4a §5.2 — MINUTES, display only. Prefer `at` (seconds). */
  minute: z.number().int().nonnegative().optional(),
  reason: CardReason.optional(),
  // W4a §5.2 — with a length (payload `minutes`, else `Cfg.sinBinMinutes`) this
  // turns the dismissal into a TIMED suspension: the fold derives `expiresAt`
  // and sweeps it at the next stamped event (§3.1). Without it — or without a
  // length — the bin ends only on an explicit `football.sinbin.end`, exactly as
  // it did before this wave.
  at: GameTime.optional(),
});
export const FootballSinBinEnd = z.strictObject({
  by: EntrantId,
  person: PersonId.optional(), // absent = the oldest anonymous dismissal
  /** @deprecated W4a §5.2 — MINUTES, display only. Prefer `at` (seconds). */
  minute: z.number().int().nonnegative().optional(),
  at: GameTime.optional(), // W4a §5.2 — the return's own stamp
});

export const FootballEv = z.union([
  FootballGoal,
  FootballCard,
  FootballSub,
  FootballPeriod,
  FootballShootoutKick,
  FootballPenalty,
  FootballSinBinStart,
  FootballSinBinEnd,
]);
export type FootballEv = z.infer<typeof FootballEv>;

// ---------------------------------------------------------------------------
// State — spec 04 §1.3
// ---------------------------------------------------------------------------

type Side = "home" | "away";
type PlayPhase = "H1" | "H2" | "ET_H1" | "ET_H2";
type Phase = "pre" | PlayPhase | "SHOOTOUT" | "done" | "final" | "abandoned";

// W4 — a live temporary dismissal. Anonymous entries (coarse scoring) are
// recorded but never move the pitch, the same discipline anonymous cards get.
interface SinBinRecord {
  person?: string;
  minutes?: number;
  reason?: z.infer<typeof CardReason>;
  minute?: number;
  // W4a (#425) §3.1 — present only when the dismissal was stamped. `expiresAt`
  // additionally needs a length, so a stamped bin in a competition that has
  // declared none carries `startedAt` alone and still ends only on an explicit
  // return. Both absent until something populates them, so a pre-W4a stream
  // serialises byte-identically.
  startedAt?: GameTime;
  expiresAt?: GameTime;
}

interface SquadState {
  onPitch: string[];
  bench: string[];
  offUsed: string[]; // substituted off — may not return
  sentOff: string[]; // red / second yellow — may not return or be subbed for
  // W4 — currently serving a temporary dismissal. Absent until the first sin
  // bin of the match, so `init` serialises exactly as it did before W4.
  sinBin?: SinBinRecord[];
  // W4a (#425) §5.2 — the DISTINCT stamps at which this side has substituted,
  // in order. One entry per window, however many players went on at it. Absent
  // until the first STAMPED substitution: an unstamped one is in no window and
  // must add nothing, or every stream recorded before this wave grows a field.
  subWindows?: GameTime[];
  // W4a (#425) review — every TIMED dismissal this side has been shown, kept
  // whether or not it is still being served. The scoresheet row prints both
  // stamps, and this is the ONLY record left once the sweep removes the entry
  // from `sinBin` — which is exactly when the question "had this bin in fact run
  // out by the stamp on that release?" first arises (`alreadyRunOut`). The
  // period kernel's `cardLog` is the same idea; football simply had none.
  //
  // TIMED ONLY, and that gate is what keeps the frozen goldens byte-identical:
  // an unstamped bin, or one in a competition that declared no length, derives
  // no expiry, is never logged here, and the key stays absent — matching the
  // `sinBin` / `penalties` precedent.
  sinBinLog?: SinBinRecord[];
}

interface CardRecord {
  side: Side;
  person?: string;
  color: z.infer<typeof CardColor>;
  minute?: number;
  reason?: z.infer<typeof CardReason>; // W4 — Law 12 offence category
  at?: GameTime; // W4a §5.2 — the stamp, when the pad recorded one
}

// W4 — a period entry gains Law 7 added time. Optional so that every stream
// recorded before W4 serialises byte-identically.
interface PeriodRecord {
  phase: PlayPhase;
  home: number;
  away: number;
  addedMinutes?: number;
}

export interface FootballState {
  cfg: FootballCfg;
  entrants: { home: string; away: string };
  phase: Phase;
  goals: { home: number; away: number }; // regulation + ET (shootout excluded)
  // Per-period breakdown, in play order — the coarse "period summaries" view
  // (PROMPT-04 §9) and the summary.detail payload.
  periods: PeriodRecord[];
  cards: CardRecord[];
  squads: { home: SquadState; away: SquadState };
  shootout: { kicks: { side: Side; scored: boolean }[] } | null;
  outcome: MatchOutcome | null;
  replayFlagged: boolean; // abandonPolicy 'replay' — fixture to regenerate
  // W4 (Law 14) — unconverted open-play penalties, in play order. Absent until
  // the first one is recorded: `init` must keep serialising exactly as it did
  // before W4 or every frozen golden stream reds.
  penalties?: PenaltyRecord[];
  /**
   * W4a (#425) §6 obligation 3 — AS OF WHEN everything above is true. Absent
   * until the first stamped event, matching the `penalties` / `sinBin`
   * precedent, so a pre-wave state serialises exactly as it did.
   *
   * It exists because lazy expiry (§3.1) means the pad and the fold
   * legitimately disagree between an expiry and the next event: a pad drawing a
   * strength chip needs to say what instant that chip is true as of, or a
   * scorer reads the stale chip as a bug. Without it, §6 obligation 3 was
   * unimplementable for football and W5's ONE universal renderer would have met
   * two different state shapes across the eleven sports.
   */
  asOf?: GameTime;
}

interface PenaltyRecord {
  side: Side;
  outcome: z.infer<typeof PenaltyOutcome>;
  taker?: string;
  goalkeeper?: string;
  minute?: number;
  at?: GameTime; // W4a §5.2 — the stamp, when the pad recorded one
}

const PLAY_PHASES: readonly Phase[] = ["H1", "H2", "ET_H1", "ET_H2"];

function opponent(side: Side): Side {
  return side === "home" ? "away" : "home";
}

function invalid(message: string, data?: unknown): never {
  throw new EngineError("INVALID_EVENT", message, data);
}

function wrongPhase(message: string, data?: unknown): never {
  throw new EngineError("WRONG_PHASE", message, data);
}

function sideOf(state: FootballState, entrantId: string): Side {
  if (entrantId === state.entrants.home) return "home";
  if (entrantId === state.entrants.away) return "away";
  invalid(`unknown entrant "${entrantId}"`, { entrantId });
}

function parsePayload<T>(schema: z.ZodType<T>, payload: unknown, type: string): T {
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    invalid(`invalid ${type} payload`, { issues: parsed.error.issues });
  }
  return parsed.data;
}

function isPlayPhase(phase: Phase): phase is PlayPhase {
  return PLAY_PHASES.includes(phase);
}

/**
 * THE phase order for this cfg — W4a (#425) §7. Every phase in which a STAMPED
 * event may legally occur, in the order they occur, and nothing else.
 *
 * One function, two consumers, by contract: the fold kernel's monotonic guard
 * reads it via `SportModule.playPhases`, and every `compareGameTime` call this
 * module makes inside `apply()` passes this same function's result. Two lists
 * that merely agree today is the defect this exists to prevent — an event the
 * guard accepts is backwards one layer down, and the lazy sin-bin sweep (§3.1)
 * runs against an order nothing agrees on. `football.time.test.ts` asserts the
 * module holds this exact function reference, so a copy fails there.
 *
 * WIDER than `PLAY_PHASES`, and that is the point:
 *  - "pre" — a card before the opening whistle is legal (`applyCard`, and
 *    football.md §9 names a pre-kickoff red explicitly), so a stamped one has
 *    to be orderable.
 *  - "SHOOTOUT" — cards are legal there too, and it sorts LAST, after any extra
 *    time, because that is when it happens.
 *  - "done" / "final" / "abandoned" are excluded: nothing stamped is accepted
 *    once the match is over.
 *
 * ET and the shootout are listed only when this cfg can actually REACH them —
 * `resolveFullTime` enters `ET_H1` only under `cfg.extraTime.enabled` and
 * `SHOOTOUT` only under `cfg.shootout` — so a scorer stamping `ET_H1` in a
 * league fixture gets a fixable INVALID_EVENT naming the phases this sport has.
 *
 * Exhaustive by OBLIGATION, not by construction: the fold treats a period
 * outside this list as a bad payload field, so anything omitted here is an event
 * the scorer cannot record.
 */
export function playPhases(cfg: FootballCfg): string[] {
  return [
    "pre",
    "H1",
    "H2",
    ...(cfg.extraTime.enabled ? ["ET_H1", "ET_H2"] : []),
    ...(cfg.shootout ? ["SHOOTOUT"] : []),
  ];
}

/**
 * The phases in which the MATCH CLOCK runs, in play order — where penalty time
 * can be served. Deliberately NOT `playPhases`: "pre" and "SHOOTOUT" are phases
 * of the match without being phases of play, and the carry must never spill
 * into a shoot-out, where there is no match clock at all.
 *
 * Listed only where this cfg can reach them, so a league fixture's carry stops
 * at the end of the second half rather than rolling into an extra time the
 * competition does not play.
 */
/**
 * W4a (#425) T6b — "H2 · 48:12", the cross-sport position axis.
 *
 * DELEGATES to `periodClockPosition`, the same core function the period kernel
 * uses. Football and the period kernel have different state types and so cannot
 * share a module member the way hockey and ice hockey do, and this wave has
 * already paid for that gap once: football hand-rolled the period kernel's time
 * model and diverged from it in five places. The shared derivation is the fix
 * available here, and `position.conformance.test.ts` holds both to producing an
 * identical SHAPE for the same instant, because W8 draws one chip for all four
 * period sports.
 *
 * `PLAY_PHASES` is deliberately not consulted: `playPhases` is the wider list
 * the fold's monotonic guard orders against, and it is the one an event's
 * `at.period` is validated against, so it is the one a position must rank in.
 */
function footballPosition(state: FootballState): MatchPosition {
  return periodClockPosition({
    phaseOrder: playPhases(state.cfg),
    evidence: [
      state.phase,
      state.asOf?.period,
      state.periods[state.periods.length - 1]?.phase,
      state.shootout === null ? undefined : "SHOOTOUT",
    ],
    asOf: state.asOf,
  });
}

function clockPhases(cfg: FootballCfg): string[] {
  return ["H1", "H2", ...(cfg.extraTime.enabled ? ["ET_H1", "ET_H2"] : [])];
}

/**
 * The nominal length of every clock phase, in seconds — the one authority the
 * carry counts against (§3.2, amended).
 *
 * It comes from the cfg's own REQUIRED scalars: `halfMinutes` fixes both halves
 * and `extraTime.halfMinutes` both extra-time halves. That is what removed the
 * old "the engine holds no period length, so the bin is under-served across the
 * whistle" limitation — it was never a missing FACT, only a field nobody wired.
 *
 * `cfg.periodSeconds` survives as an override for the ONE thing those scalars
 * cannot express: halves of UNEQUAL length. A map giving both halves of a group
 * the SAME value states nothing the scalar does not, so where the two disagree
 * the required scalar wins and the uniform map is IGNORED — never refused. See
 * the schema comment for why refusing would be the dangerous direction.
 */
function phaseLengths(cfg: FootballCfg): Record<string, number> {
  const overrides = cfg.periodSeconds;
  const lengths: Record<string, number> = {};
  const fill = (labels: readonly string[], scalarSeconds: number): void => {
    const supplied = labels.map((label) => overrides?.[label]);
    const uniform =
      labels.length > 0 && supplied.every((value) => value !== undefined && value === supplied[0]);
    labels.forEach((label, i) => {
      const override = supplied[i];
      lengths[label] = uniform || override === undefined ? scalarSeconds : override;
    });
  };
  fill(["H1", "H2"], cfg.halfMinutes * 60);
  if (cfg.extraTime.enabled) fill(["ET_H1", "ET_H2"], cfg.extraTime.halfMinutes * 60);
  return lengths;
}

/**
 * W4a (#425) §3.1 — when a dismissal stamped at `startedAt` runs out.
 *
 * THE UNSERVED REMAINDER CARRIES (§3.2, amended 2026-08-04). This file used to
 * say the opposite, and both halves of that reasoning were wrong: IFAB's
 * temporary-dismissal protocol carries the remainder of a sin bin into the next
 * half exactly as IIHF carries a penalty, and the half length was never
 * missing — `Cfg.halfMinutes` is a required positive integer.
 *
 * Leaving the expiry in-period is not a harmless approximation, it is ACTIVELY
 * wrong under lazy expiry: `{H1, 3200}` sorts before every H2 stamp, so the
 * first stamped event of the second half sweeps a bin that still has 500
 * seconds to run — under-serving the player, silently, in the offending side's
 * favour. `addDuration` itself is unchanged: it is a primitive over one period
 * and never rolls forward; the carry lives here, walking `clockPhases`.
 *
 * The nominal length is what cfg holds, so a half that actually ran 48 minutes
 * still carries against 45. Stated rather than hidden, and the same
 * approximation the period kernel makes.
 *
 * Returns `undefined` where no expiry can exist: no length was declared at all
 * (payload `minutes`, else `Cfg.sinBinMinutes`), which leaves the bin ending
 * only on an explicit `football.sinbin.end`, exactly as before this wave.
 */
function expiryOf(
  cfg: FootballCfg,
  startedAt: GameTime,
  minutes: number | undefined,
): GameTime | undefined {
  if (minutes === undefined || !Number.isFinite(minutes) || minutes <= 0) return undefined;
  const play = clockPhases(cfg);
  // A stamp naming a phase with no match clock ("pre", "SHOOTOUT"). Unreachable
  // through `applySinBinStart`, which only admits a dismissal while play is
  // running, but it must not fall through to `undefined`: an expiry that does
  // not exist is a dismissal that runs to the end of the FIXTURE, so "no clock
  // here" would silently become "for the rest of the match" and the final state
  // would read a side short. With no clock to serve against it serves zero.
  if (!play.includes(startedAt.period)) return startedAt;
  const lengths = phaseLengths(cfg);
  let { period, elapsed } = addDuration(startedAt, minutes * 60);
  for (;;) {
    const length = lengths[period];
    if (length === undefined || elapsed <= length) return { period, elapsed };
    const index = play.indexOf(period);
    const next = index < 0 ? undefined : play[index + 1];
    // No more play to carry into — the named fallback (§3.2): the expiry stays
    // in-period, past the nominal length, and the bin ends on the explicit
    // release or at the final whistle.
    if (next === undefined) return { period, elapsed };
    elapsed -= length;
    period = next;
  }
}

/**
 * Release every dismissal `isOver` says has finished, returning each named
 * player to the pitch. The one place the three sweeps below share.
 *
 * An anonymous bin (coarse scoring) closes without returning anybody — it never
 * moved the pitch when it opened, which is the same discipline `applySinBinEnd`
 * and anonymous cards already get. Returns the SAME state object when nothing
 * moves, so a stream that expires nothing serialises byte-identically.
 */
function releaseBins(
  state: FootballState,
  isOver: (entry: SinBinRecord) => boolean,
): FootballState {
  let squads = state.squads;
  for (const side of ["home", "away"] as const) {
    const squad = squads[side];
    const bin = squad.sinBin;
    if (bin === undefined || bin.length === 0) continue;
    const over = bin.filter(isOver);
    if (over.length === 0) continue;
    const returning = over
      .map((entry) => entry.person)
      .filter((person): person is string => person !== undefined);
    squads = {
      ...squads,
      [side]: {
        ...squad,
        onPitch: [...squad.onPitch, ...returning],
        sinBin: bin.filter((entry) => !isOver(entry)),
      },
    };
  }
  return squads === state.squads ? state : { ...state, squads };
}

/**
 * W4a (#425) §3.1 — expiry is LAZY, swept at the next stamped event.
 *
 * The fold's state is only ever observed at event boundaries, so sweeping there
 * is sufficient; between events the pad renders the countdown from `expiresAt`
 * itself. The pad and the fold therefore DISAGREE in the window between an
 * expiry and the next stamped event. That is by design (§6 obligation 3 makes
 * showing the fold's `asOf` a pad requirement), not a bug.
 *
 * An UNSTAMPED event sweeps nothing: it carries no clock reading, so it cannot
 * be the moment the fold catches up. That is also what keeps every stream
 * recorded before this wave folding unchanged.
 *
 * NEVER THROWS `UNKNOWN_PHASE`, and that is a correctness requirement rather
 * than defensiveness: cfg is read LIVE from `division.config` at fold time, so
 * dropping extra time or renaming a phase AFTER a match was scored makes a
 * recorded phase label unrecognisable. A throwing sweep would make that fixture
 * permanently UNVIEWABLE, not merely stale. An unorderable phase reads as
 * "cannot be ordered, so does not expire" — the conservative direction: a bin
 * that outlives its time is visible and correctable, one silently erased is
 * neither.
 */
function sweepExpired(state: FootballState, now: GameTime): FootballState {
  const phases = playPhases(state.cfg);
  if (!phases.includes(now.period)) return state;
  return releaseBins(state, (entry) => {
    const expiresAt = entry.expiresAt;
    if (expiresAt === undefined) return false;
    if (!phases.includes(expiresAt.period)) return false;
    return compareGameTime(expiresAt, now, phases) <= 0;
  });
}

/**
 * THE WHISTLE SWEEPS TOO — a bin whose expiry falls inside the phase being left
 * is over, whether or not another stamped event ever arrived.
 *
 * Without this, a dismissal that ran out late in a half with nothing stamped
 * after it survives into the FINAL state and every consumer reads the side a
 * player short at full time. Ordered by phase INDEX rather than by
 * `compareGameTime`, because "the end of the first half" is not a stamp the
 * fold has: an expiry anywhere in a completed phase is in the past once that
 * phase closes, whatever its elapsed. Same unknown-phase tolerance as above.
 */
function sweepThroughPhase(state: FootballState, leaving: Phase): FootballState {
  const phases = playPhases(state.cfg);
  const closing = phases.indexOf(leaving);
  if (closing < 0) return state;
  return releaseBins(state, (entry) => {
    const expiresAt = entry.expiresAt;
    if (expiresAt === undefined) return false;
    const index = phases.indexOf(expiresAt.period);
    return index >= 0 && index <= closing;
  });
}

/**
 * THE MATCH IS OVER — every TIMED dismissal has run out, whatever phase its
 * expiry names.
 *
 * The phase sweep is not enough on its own, and the gap it leaves is exactly
 * the bug both sweeps exist to prevent: a bin opened at 40:00 of the second
 * half carries into ET_H1, and if the score is not level the full-time whistle
 * decides the match in regulation, extra time is never played, and an expiry
 * indexed PAST the closing phase survives into `done` — a side a player short
 * AT FULL TIME, in the state every summary and match report reads. One call
 * site therefore covers the full-time whistle, a shoot-out decision, a forfeit
 * and an awarded abandonment.
 *
 * TIMED only, and that is what keeps this additive: a bin with no derived
 * expiry was never given a duration to run out (unstamped, or a competition
 * that declared no sin-bin length), and it is RIGHT that it keeps the side
 * short to the final whistle. Every one of the frozen goldens is made entirely
 * of those, so none of them can be touched by this.
 */
function sweepEndOfMatch(state: FootballState): FootballState {
  return releaseBins(state, (entry) => entry.expiresAt !== undefined);
}

// ---------------------------------------------------------------------------
// Fold helpers
// ---------------------------------------------------------------------------

function pushPeriod(state: FootballState, phase: PlayPhase): FootballState {
  return { ...state, phase, periods: [...state.periods, { phase, home: 0, away: 0 }] };
}

function creditGoal(state: FootballState, credited: Side): FootballState {
  const periods = state.periods.map((period, i) =>
    i === state.periods.length - 1
      ? { ...period, [credited]: period[credited] + 1 }
      : period,
  );
  return {
    ...state,
    goals: { ...state.goals, [credited]: state.goals[credited] + 1 },
    periods,
  };
}

// Level-score resolution at FT / ET_FT — spec 04 §1.3: the knockout config
// (ET/shootout) keeps the outcome null until the deciders run; without them a
// level score is a draw (league semantics; the engine refuses to finalize a
// drawn knockout fixture via supportsDraws).
function resolveFullTime(state: FootballState, after: "FT" | "ET_FT"): FootballState {
  const { home, away } = state.goals;
  if (home !== away) {
    const winnerSide: Side = home > away ? "home" : "away";
    return {
      // W4a — the final whistle. A bin carried into an extra time this match
      // never plays is indexed past the phase the whistle closes, so only this
      // can end it.
      ...sweepEndOfMatch(state),
      phase: "done",
      outcome: {
        kind: "win",
        winner: state.entrants[winnerSide],
        loser: state.entrants[opponent(winnerSide)],
        method: after === "FT" ? "regulation" : "extra_time",
      },
    };
  }
  // Play continues into extra time or the kicks, so nothing is over yet. The
  // carry never spills into "SHOOTOUT" (no match clock there), so the phase
  // sweep has already cleared everything it could reach.
  if (after === "FT" && state.cfg.extraTime.enabled) return pushPeriod(state, "ET_H1");
  if (state.cfg.shootout) return { ...state, phase: "SHOOTOUT", shootout: { kicks: [] } };
  return { ...sweepEndOfMatch(state), phase: "done", outcome: { kind: "draw" } };
}

// spec 04 §1.4 — best-of-5 alternating, early decision when lead exceeds the
// opponent's remaining kicks, then sudden-death pairs. Extracted to the
// shared shootout primitive (v6/00 §3): football pens, IIHF GWS and the FIH
// shoot-out are one shape — `shootoutDecision`/`expectedKicker` now come from
// ../period/shootout.ts; byte-identical behavior locked by
// football.golden.test.ts, so module_version stays 1.0.0 (v6/00 §6.2).

// FIFA fair-play scale (spec 04 §1.5): yellow −1, second yellow (indirect
// red) −3, direct red −4, yellow + direct red −5 — one deduction per person,
// worst applicable category. Anonymous cards (coarse) deduct independently.
function fairPlayPoints(cards: readonly CardRecord[], side: Side): number {
  let total = 0;
  const byPerson = new Map<string, CardRecord[]>();
  for (const card of cards) {
    if (card.side !== side) continue;
    if (card.person === undefined) {
      total += card.color === "yellow" ? -1 : card.color === "second_yellow" ? -3 : -4;
      continue;
    }
    byPerson.set(card.person, [...(byPerson.get(card.person) ?? []), card]);
  }
  for (const personCards of byPerson.values()) {
    const hasYellow = personCards.some((card) => card.color === "yellow");
    const hasSecondYellow = personCards.some((card) => card.color === "second_yellow");
    const hasDirectRed = personCards.some((card) => card.color === "red");
    if (hasYellow && hasDirectRed) total += -5;
    else if (hasDirectRed) total += -4;
    else if (hasSecondYellow) total += -3;
    else if (hasYellow) total += -1;
  }
  return total;
}

function cardCounts(cards: readonly CardRecord[], side: Side): { yellow: number; red: number } {
  let yellow = 0;
  let red = 0;
  for (const card of cards) {
    if (card.side !== side) continue;
    if (card.color === "yellow" || card.color === "second_yellow") yellow++;
    if (card.color === "red" || card.color === "second_yellow") red++;
  }
  return { yellow, red };
}

function removeFromPitch(squad: SquadState, person: string, sentOff: boolean): SquadState {
  return {
    ...squad,
    onPitch: squad.onPitch.filter((id) => id !== person),
    sentOff: sentOff ? [...squad.sentOff, person] : squad.sentOff,
    // W4 — a permanent dismissal ends any temporary one already being served.
    ...(squad.sinBin === undefined
      ? {}
      : { sinBin: squad.sinBin.filter((entry) => entry.person !== person) }),
  };
}

// ---------------------------------------------------------------------------
// Event application
// ---------------------------------------------------------------------------

function applyGoal(state: FootballState, payload: z.infer<typeof FootballGoal>): FootballState {
  if (!isPlayPhase(state.phase)) {
    wrongPhase(`goal not allowed in phase "${state.phase}"`, { phase: state.phase });
  }
  const by = sideOf(state, payload.by);
  if (payload.scorer !== undefined) {
    // The scorer belongs to the striking side (`by`), also for own goals.
    const squad = state.squads[by];
    if (!squad.onPitch.includes(payload.scorer)) {
      invalid(`scorer "${payload.scorer}" is not on the pitch for "${payload.by}"`, {
        scorer: payload.scorer,
      });
    }
  }
  // spec 04 §1.3 — own-goal credits the opponent.
  return creditGoal(state, payload.ownGoal === true ? opponent(by) : by);
}

function applyCard(state: FootballState, payload: z.infer<typeof FootballCard>): FootballState {
  // Cards valid pre-kickoff (red before kickoff — football.md §9), during
  // play and during a shootout; never once the match is decided.
  if (state.phase === "done" || state.phase === "final" || state.phase === "abandoned") {
    wrongPhase(`card not allowed in phase "${state.phase}"`);
  }
  const side = sideOf(state, payload.by);
  let squads = state.squads;
  if (payload.person !== undefined) {
    const person = payload.person;
    const squad = state.squads[side];
    const inLineup =
      squad.onPitch.includes(person) ||
      squad.bench.includes(person) ||
      squad.offUsed.includes(person) ||
      // W4 — a player serving a temporary dismissal is off the pitch but very
      // much still cardable (a sin bin is frequently followed by a red).
      (squad.sinBin ?? []).some((entry) => entry.person === person);
    if (squad.sentOff.includes(person)) {
      invalid(`"${person}" was already sent off`, { person });
    }
    if (!inLineup) {
      invalid(`"${person}" is not in the lineup for "${payload.by}"`, { person });
    }
    const priorYellow = state.cards.some(
      (card) => card.person === person && card.color === "yellow",
    );
    if (payload.color === "yellow" && priorYellow) {
      invalid(`second yellow for "${person}" must be recorded as second_yellow`, { person });
    }
    if (payload.color === "second_yellow" && !priorYellow) {
      invalid(`second_yellow for "${person}" without a prior yellow`, { person });
    }
    if (payload.color !== "yellow") {
      squads = { ...squads, [side]: removeFromPitch(squad, person, true) };
    }
  }
  const record: CardRecord = {
    side,
    ...(payload.person === undefined ? {} : { person: payload.person }),
    color: payload.color,
    ...(payload.minute === undefined ? {} : { minute: payload.minute }),
    ...(payload.reason === undefined ? {} : { reason: payload.reason }),
    ...(payload.at === undefined ? {} : { at: payload.at }),
  };
  return { ...state, cards: [...state.cards, record], squads };
}

function applySub(state: FootballState, payload: z.infer<typeof FootballSub>): FootballState {
  if (!isPlayPhase(state.phase)) {
    wrongPhase(`substitution not allowed in phase "${state.phase}"`);
  }
  const side = sideOf(state, payload.by);
  const squad = state.squads[side];
  const rolling = state.cfg.rollingSubs === true;
  if (!squad.onPitch.includes(payload.off)) {
    invalid(`"${payload.off}" is not on the pitch`, { off: payload.off });
  }
  if (!squad.bench.includes(payload.on)) {
    invalid(`"${payload.on}" is not an available bench player`, { on: payload.on });
  }
  // W4 (Law 3) — the cap counts substitutions made, which is exactly the
  // length of offUsed. Rolling substitutions are uncapped by definition, so
  // the cap only bites on the return-forbidden path.
  if (!rolling && state.cfg.maxSubs !== undefined && squad.offUsed.length >= state.cfg.maxSubs) {
    invalid(`"${payload.by}" has used all ${state.cfg.maxSubs} substitutions`, {
      by: payload.by,
      maxSubs: state.cfg.maxSubs,
    });
  }
  // W4a (#425) §5.2 (Law 3) — substitution WINDOWS. The Law counts the
  // stoppages a side substitutes at, not the players it substitutes: five subs
  // taken in three windows is legal, the same five taken one at a time is not,
  // and `maxSubs` alone cannot tell those apart. A window is the set of
  // substitutions sharing one `at`, so a side sending three on at one stoppage
  // spends one window.
  //
  // AN UNSTAMPED SUBSTITUTION IS IN NO WINDOW AND CONSUMES NONE. It has no `at`
  // to share, and reading "no stamp" as "one shared window" was the trap: every
  // unstamped sub in a match would have collapsed into a single window, which
  // reads as legal — until a one-window allowance rejects the second one and
  // every stream recorded before this wave becomes unfoldable. Recording them as
  // a window EACH is the mirror of the same bug. Consuming nothing is the only
  // reading under which an unstamped stream folds exactly as it does today.
  //
  // The bound applies ALONGSIDE `maxSubs`, never instead of it, and only when
  // the competition declared one.
  let subWindows = squad.subWindows;
  if (payload.at !== undefined) {
    const stamp = payload.at;
    const windows = squad.subWindows ?? [];
    // Same window = the same stamp, exactly. The monotonic guard means only the
    // newest window can still be joined, but matching on the value keeps that a
    // consequence rather than an assumption.
    const known = windows.some(
      (window) => window.period === stamp.period && window.elapsed === stamp.elapsed,
    );
    if (!known) {
      if (state.cfg.subWindows !== undefined && windows.length >= state.cfg.subWindows) {
        throw new EngineError(
          "SUB_WINDOW_EXCEEDED",
          `"${payload.by}" has used all ${state.cfg.subWindows} substitution windows`,
          { by: payload.by, subWindows: state.cfg.subWindows, at: stamp, used: [...windows] },
        );
      }
      subWindows = [...windows, stamp];
    }
  }
  const onPitch = [...squad.onPitch.filter((id) => id !== payload.off), payload.on];
  const base: SquadState = rolling
    ? // Repeat substitution: the player who came off rejoins the bench and may
      // re-enter, so nothing lands in offUsed.
      { ...squad, onPitch, bench: [...squad.bench.filter((id) => id !== payload.on), payload.off] }
    : {
        ...squad,
        onPitch,
        bench: squad.bench.filter((id) => id !== payload.on),
        offUsed: [...squad.offUsed, payload.off],
      };
  // Absent until the first STAMPED substitution — `base` already carries the
  // key when the squad had one, so an unstamped stream never grows it.
  const next: SquadState = subWindows === undefined ? base : { ...base, subWindows };
  return { ...state, squads: { ...state.squads, [side]: next } };
}

// W4 (Law 7) — stamp the marker's added time on the period it CLOSES, i.e. the
// last entry in play order. Absent added time leaves the entry untouched, so
// every pre-W4 stream serialises exactly as before.
function stampAddedMinutes(state: FootballState, addedMinutes: number | undefined): FootballState {
  if (addedMinutes === undefined || state.periods.length === 0) return state;
  const last = state.periods.length - 1;
  return {
    ...state,
    periods: state.periods.map((period, i) => (i === last ? { ...period, addedMinutes } : period)),
  };
}

/**
 * W4a (#425) review — had a dismissal answering this release's description in
 * fact run out by `at`?
 *
 * Read off `squad.sinBinLog`, which keeps every TIMED dismissal with the times
 * it was stamped with. `squad.sinBin` cannot answer it, because the whole
 * question only arises once the sweep has removed the entry from there.
 *
 * A player the fold SENT OFF answers "no", whatever the log says. A red card
 * drops the bin entry (`removeFromPitch`) precisely so they cannot return, and
 * honouring a release off the log alone would put a sent-off player back on the
 * pitch. An expiry that cannot be ordered against this cfg also answers "no".
 */
function alreadyRunOut(
  state: FootballState,
  side: Side,
  payload: z.infer<typeof FootballSinBinEnd>,
  at: GameTime,
): boolean {
  const squad = state.squads[side];
  if (payload.person !== undefined && squad.sentOff.includes(payload.person)) return false;
  const phases = playPhases(state.cfg);
  return (squad.sinBinLog ?? []).some((entry) => {
    if (entry.person !== payload.person) return false;
    const expiresAt = entry.expiresAt;
    if (expiresAt === undefined || !phases.includes(expiresAt.period)) return false;
    return compareGameTime(expiresAt, at, phases) <= 0;
  });
}

// W4 (Law 12 addendum) — the return that ends a temporary dismissal.
function applySinBinEnd(
  state: FootballState,
  payload: z.infer<typeof FootballSinBinEnd>,
): FootballState {
  if (!isPlayPhase(state.phase)) {
    wrongPhase(`sin bin not allowed in phase "${state.phase}"`, { phase: state.phase });
  }
  const side = sideOf(state, payload.by);
  const squad = state.squads[side];
  const bin = squad.sinBin ?? [];
  // An anonymous return closes the oldest anonymous dismissal — the only entry
  // it could possibly be about.
  const index = bin.findIndex((entry) => entry.person === payload.person);
  if (index < 0) {
    // W4a review — INVERTED. The whole premise of lazy expiry (§3.1) is that the
    // pad and the fold legitimately disagree between an expiry and the next
    // event: the pad is counting down, the fold is a record of facts. A scorer
    // who then records the release explicitly is being RIGHT, and refusing the
    // event punishes them for the fold's own laziness. So it is a NO-OP.
    //
    // Narrow on purpose, and `alreadyRunOut` is where the narrowness lives: only
    // where the log shows the named dismissal had in fact run out by this stamp.
    // A release of something that never existed, one still running, and one for
    // a player the fold sent off all keep their rejection — those are
    // contradictory records, not a scorer the fold got ahead of.
    if (payload.at !== undefined && alreadyRunOut(state, side, payload, payload.at)) return state;
    invalid(
      payload.person === undefined
        ? `"${payload.by}" has no anonymous sin bin to end`
        : `"${payload.person}" is not serving a sin bin`,
      { by: payload.by, ...(payload.person === undefined ? {} : { person: payload.person }) },
    );
  }
  const entry = bin[index] as SinBinRecord;
  return {
    ...state,
    squads: {
      ...state.squads,
      [side]: {
        ...squad,
        onPitch: entry.person === undefined ? squad.onPitch : [...squad.onPitch, entry.person],
        sinBin: bin.filter((_, i) => i !== index),
      },
    },
  };
}

// W4 (Law 12 addendum) — a temporary dismissal begins.
function applySinBinStart(
  state: FootballState,
  payload: z.infer<typeof FootballSinBinStart>,
): FootballState {
  if (!isPlayPhase(state.phase)) {
    wrongPhase(`sin bin not allowed in phase "${state.phase}"`, { phase: state.phase });
  }
  const side = sideOf(state, payload.by);
  const squad = state.squads[side];
  const bin = squad.sinBin ?? [];
  const withSquad = (next: SquadState): FootballState => ({
    ...state,
    squads: { ...state.squads, [side]: next },
  });

  if (payload.person !== undefined) {
    const person = payload.person;
    if (squad.sentOff.includes(person)) {
      invalid(`"${person}" was already sent off`, { person });
    }
    if (bin.some((entry) => entry.person === person)) {
      invalid(`"${person}" is already serving a sin bin`, { person });
    }
    if (!squad.onPitch.includes(person)) {
      invalid(`"${person}" is not on the pitch for "${payload.by}"`, { person });
    }
  }
  // The AWARDED duration: the payload's `minutes` where the referee gave one,
  // else the competition's `Cfg.sinBinMinutes`.
  //
  // `minutes` is the LENGTH; the adjacent `minute` is the display clock. Same
  // type, one letter apart, and reading the wrong one is the shape that
  // produced the `DisciplineCard.entrantSide` bug — so `minute` appears nowhere
  // in this arithmetic. It is a different unit measured from a different origin
  // (§5.2) and the fold never converts it.
  const minutes = payload.minutes ?? state.cfg.sinBinMinutes;
  // W4a (#425) §3.1 — a stamped dismissal of a known length becomes a TIMED
  // suspension: the fold derives when it runs out and sweeps it at the next
  // stamped event. BOTH halves are required, and the gate is deliberate — it is
  // what keeps the eleven frozen goldens byte-identical, since no recorded
  // stream carries `at` and nothing therefore expires that did not expire
  // before. `minutes` is MINUTES; `elapsed` is SECONDS, hence the ×60 inside
  // `expiryOf`, which also walks the cross-half carry (§3.2).
  const startedAt = payload.at;
  const expiresAt =
    startedAt === undefined ? undefined : expiryOf(state.cfg, startedAt, minutes);
  const record: SinBinRecord = {
    ...(payload.person === undefined ? {} : { person: payload.person }),
    ...(minutes === undefined ? {} : { minutes }),
    ...(payload.reason === undefined ? {} : { reason: payload.reason }),
    ...(payload.minute === undefined ? {} : { minute: payload.minute }),
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(expiresAt === undefined ? {} : { expiresAt }),
  };
  return withSquad({
    ...squad,
    onPitch:
      payload.person === undefined
        ? squad.onPitch
        : squad.onPitch.filter((id) => id !== payload.person),
    sinBin: [...bin, record],
    // W4a review — the log keeps the same two stamps. Once the sweep removes
    // the entry from `sinBin` this is the ONLY record that can answer "had that
    // bin in fact run out by the stamp on this release?" (`alreadyRunOut`).
    // TIMED only, so an unstamped bin never grows the key and a pre-wave squad
    // serialises byte-identically.
    ...(expiresAt === undefined ? {} : { sinBinLog: [...(squad.sinBinLog ?? []), record] }),
  });
}

// W4 (Law 14) — an open-play penalty that was not converted. The score is
// untouched by construction; the record is what a match report needs.
function applyPenalty(state: FootballState, payload: z.infer<typeof FootballPenalty>): FootballState {
  if (!isPlayPhase(state.phase)) {
    wrongPhase(`penalty not allowed in phase "${state.phase}"`, { phase: state.phase });
  }
  const side = sideOf(state, payload.by);
  if (payload.taker !== undefined && !state.squads[side].onPitch.includes(payload.taker)) {
    invalid(`taker "${payload.taker}" is not on the pitch for "${payload.by}"`, {
      taker: payload.taker,
    });
  }
  // The goalkeeper facing the kick belongs to the DEFENDING side.
  if (
    payload.goalkeeper !== undefined &&
    !state.squads[opponent(side)].onPitch.includes(payload.goalkeeper)
  ) {
    invalid(`goalkeeper "${payload.goalkeeper}" is not on the pitch for the defending side`, {
      goalkeeper: payload.goalkeeper,
    });
  }
  const record: PenaltyRecord = {
    side,
    outcome: payload.outcome,
    ...(payload.taker === undefined ? {} : { taker: payload.taker }),
    ...(payload.goalkeeper === undefined ? {} : { goalkeeper: payload.goalkeeper }),
    ...(payload.minute === undefined ? {} : { minute: payload.minute }),
    // W4a §5.2 — the stamp rides beside the display integer, absent when the
    // pad recorded none, so a pre-wave penalty record is byte-identical.
    ...(payload.at === undefined ? {} : { at: payload.at }),
  };
  return { ...state, penalties: [...(state.penalties ?? []), record] };
}

function applyPeriod(state: FootballState, payload: z.infer<typeof FootballPeriod>): FootballState {
  const marker = payload.phase;
  // W4a — the whistle CLOSES this phase, so anything whose expiry fell inside
  // it is over even if no stamped event ever arrived to sweep it. Runs on the
  // full-time marker too, or a side reads a player short in the FINAL state.
  const close = (): FootballState =>
    sweepThroughPhase(stampAddedMinutes(state, payload.addedMinutes), state.phase);
  switch (marker) {
    case "HT":
      if (state.phase !== "H1") wrongPhase(`HT marker in phase "${state.phase}"`);
      return pushPeriod(close(), "H2");
    case "FT":
      if (state.phase !== "H2") wrongPhase(`FT marker in phase "${state.phase}"`);
      return resolveFullTime(close(), "FT");
    case "ET_HT":
      if (state.phase !== "ET_H1") wrongPhase(`ET_HT marker in phase "${state.phase}"`);
      return pushPeriod(close(), "ET_H2");
    case "ET_FT":
      if (state.phase !== "ET_H2") wrongPhase(`ET_FT marker in phase "${state.phase}"`);
      return resolveFullTime(close(), "ET_FT");
  }
}

function applyShootoutKick(
  state: FootballState,
  payload: z.infer<typeof FootballShootoutKick>,
): FootballState {
  if (state.phase !== "SHOOTOUT" || state.shootout === null) {
    wrongPhase(`shootout kick in phase "${state.phase}"`);
  }
  const side = sideOf(state, payload.by);
  const expected = expectedKicker(state.shootout.kicks);
  if (expected !== null && side !== expected) {
    invalid(`kicks must alternate: expected "${state.entrants[expected]}"`, {
      expected: state.entrants[expected],
    });
  }
  if (payload.person !== undefined) {
    const squad = state.squads[side];
    if (!squad.onPitch.includes(payload.person)) {
      invalid(`kicker "${payload.person}" is not on the pitch`, { person: payload.person });
    }
  }
  const kicks = [...state.shootout.kicks, { side, scored: payload.scored }];
  const winnerSide = shootoutDecision(kicks);
  if (winnerSide === null) return { ...state, shootout: { kicks } };
  return {
    ...sweepEndOfMatch(state), // W4a — the decider ends every timed dismissal
    shootout: { kicks },
    phase: "done",
    outcome: {
      kind: "win",
      winner: state.entrants[winnerSide],
      loser: state.entrants[opponent(winnerSide)],
      method: "shootout",
    },
  };
}

function applyForfeit(state: FootballState, by: string): FootballState {
  if (state.phase === "done" || state.phase === "final" || state.phase === "abandoned") {
    wrongPhase("match already over");
  }
  const winnerSide = opponent(sideOf(state, by));
  const goals =
    winnerSide === "home"
      ? { home: state.cfg.awardScore.goals, away: 0 }
      : { home: 0, away: state.cfg.awardScore.goals };
  // spec 04 §1 / PROMPT-04 §7 — forfeit ⇒ award with cfg.awardScore goals.
  return {
    ...sweepEndOfMatch(state), // W4a — the match is over, whatever phase it was in
    phase: "done",
    goals,
    outcome: { kind: "award", winner: state.entrants[winnerSide], score: goals },
  };
}

function applyAbandon(state: FootballState): FootballState {
  if (state.phase === "done" || state.phase === "final" || state.phase === "abandoned") {
    wrongPhase("match already over");
  }
  if (state.cfg.abandonPolicy === "replay") {
    // No outcome; fixture flagged for regeneration (PROMPT-04 §7). finalize
    // is refused because the outcome stays null.
    return { ...state, phase: "abandoned", replayFlagged: true };
  }
  const { home, away } = state.goals;
  // W4a — an AWARDED abandonment decides the match, so it is the final whistle.
  // The `replay` branch above deliberately does not sweep: that fixture is not
  // over, it is to be regenerated.
  if (home === away) {
    return { ...sweepEndOfMatch(state), phase: "done", outcome: { kind: "no_result" } };
  }
  const winnerSide: Side = home > away ? "home" : "away";
  return {
    ...sweepEndOfMatch(state),
    phase: "done",
    outcome: {
      kind: "award",
      winner: state.entrants[winnerSide],
      score: { home, away },
    },
  };
}

// ---------------------------------------------------------------------------
// Standings — spec 04 §1.5
// ---------------------------------------------------------------------------

function sideMetrics(state: FootballState, side: Side, zero: boolean): Record<string, number> {
  const counts = cardCounts(state.cards, side);
  const gf = zero ? 0 : state.goals[side];
  const ga = zero ? 0 : state.goals[opponent(side)];
  return {
    gf,
    ga,
    gd: gf - ga,
    yellow: counts.yellow,
    red: counts.red,
    fair_play: state.cfg.fairPlay ? fairPlayPoints(state.cards, side) : 0,
  };
}

// ---------------------------------------------------------------------------
// Tiebreaker presets — spec 04 §1.6 (verified against the FIFA 2026 source,
// engine/11-sources.md: H2H-first cascade aligned with UEFA for 2026).
// ---------------------------------------------------------------------------

export const FOOTBALL_TIEBREAKERS: Record<"fifa2026" | "classic", TiebreakerKey[]> = {
  // points → H2H points → H2H GD → H2H goals → overall GD → overall GF →
  // fair play → drawing of lots.
  fifa2026: ["points", "h2h_points", "h2h_diff", "h2h_for", "diff", "for", "fair_play", "lots"],
  // pre-2026 WC: points → overall GD → overall GF → H2H block → fair play → lots.
  classic: ["points", "diff", "for", "h2h_points", "h2h_diff", "h2h_for", "fair_play", "lots"],
};

// ---------------------------------------------------------------------------
// Positions — spec 04 §1 / PROMPT-04 §8
// ---------------------------------------------------------------------------

const positions: PositionCatalog = {
  groups: [
    { key: "GK", name: "Goalkeeper", min: 1, max: 1 },
    { key: "DF", name: "Defender" },
    { key: "MF", name: "Midfielder" },
    { key: "FW", name: "Forward" },
    // Child keys (display granularity below the four groups).
    { key: "CB", name: "Centre back" },
    { key: "LB", name: "Left back" },
    { key: "RB", name: "Right back" },
    { key: "CM", name: "Centre midfield" },
    { key: "DM", name: "Defensive midfield" },
    { key: "AM", name: "Attacking midfield" },
    { key: "LW", name: "Left wing" },
    { key: "RW", name: "Right wing" },
    { key: "ST", name: "Striker" },
  ],
  roles: [{ key: "captain", name: "Captain", unique: true }],
  lineup: { size: 11, benchMax: 12 },
};

// W4 (#407) — the catalog for a resolved config. Only the starting size moves:
// every small-sided code still fields exactly one goalkeeper (FA Mini-Soccer
// Rule 3, Futsal Law 3), and the position vocabulary is the same game.
function positionsFor(cfg: FootballCfg): PositionCatalog {
  if (cfg.teamSize === undefined || cfg.teamSize === positions.lineup.size) return positions;
  return { ...positions, lineup: { ...positions.lineup, size: cfg.teamSize } };
}

// ---------------------------------------------------------------------------
// Module
// ---------------------------------------------------------------------------

function squadFromLineup(lineup: LineupPair["home"]): SquadState {
  const starting = lineup.slots
    .filter((slot) => slot.slot === "starting")
    .sort((a, b) => a.orderNo - b.orderNo)
    .map((slot) => slot.personId);
  const bench = lineup.slots
    .filter((slot) => slot.slot === "bench")
    .sort((a, b) => a.orderNo - b.orderNo)
    .map((slot) => slot.personId);
  return { onPitch: starting, bench, offUsed: [], sentOff: [] };
}

// The event dispatch, unchanged since W4. It is lifted out of `apply` so that
// `apply` can wrap it in the game-time frame — validate the stamp, sweep,
// dispatch, sweep again for the one release case, record `asOf` — rather than
// threading a stamp through every branch. The switch returning directly is what
// made post-processing impossible before.
function applyEvent(state: FootballState, ev: EventEnvelope<FootballEv | CoreEv>): FootballState {
  switch (ev.type) {
    case "core.start":
      if (state.phase !== "pre") wrongPhase("already started");
      return pushPeriod(state, "H1");
    case "football.goal":
      return applyGoal(state, parsePayload(FootballGoal, ev.payload, ev.type));
    case "football.card":
      return applyCard(state, parsePayload(FootballCard, ev.payload, ev.type));
    case "football.sub":
      return applySub(state, parsePayload(FootballSub, ev.payload, ev.type));
    case "football.period":
      return applyPeriod(state, parsePayload(FootballPeriod, ev.payload, ev.type));
    case "football.shootout.kick":
      return applyShootoutKick(state, parsePayload(FootballShootoutKick, ev.payload, ev.type));
    case "football.penalty":
      return applyPenalty(state, parsePayload(FootballPenalty, ev.payload, ev.type));
    case "football.sinbin.start":
      return applySinBinStart(state, parsePayload(FootballSinBinStart, ev.payload, ev.type));
    case "football.sinbin.end":
      return applySinBinEnd(state, parsePayload(FootballSinBinEnd, ev.payload, ev.type));
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
}

export const football: SportModule<FootballCfg, FootballEv, FootballState> = {
  key: "football",
  version: "1.0.0",
  configSchema: FootballCfg,
  eventSchema: FootballEv,
  positions,
  positionsFor,
  entrantModel: { kinds: ["team"], defaultKind: "team", team: { squadNumbers: true, captain: true } },
  variants: {
    // spec 04 §1.1
    "11-a-side": {},
    // W4 — FA youth football and every small-sided/futsal code use repeat
    // substitutions (Law 3 / FA Mini-Soccer + SSG rules); 11-a-side does not.
    youth: { halfMinutes: 30, rollingSubs: true },
    // W4 — the FA's Small-Sided Games run 5v5 (U7–U8), 7v7 (U9–U10) and 9v9
    // (U11–U12); 7 is the middle rung and the one this preset names. A
    // competition on another rung sets `teamSize` itself. Before W4 this
    // variant declared no size at all, so it inherited the eleven-slot catalog
    // and could not hold a legal lineup.
    "small-sided": { halfMinutes: 20, halves: 2, rollingSubs: true, teamSize: 7 },
  },

  init(cfg, lineups: LineupPair): FootballState {
    return {
      cfg,
      entrants: { home: lineups.home.entrantId, away: lineups.away.entrantId },
      phase: "pre",
      goals: { home: 0, away: 0 },
      periods: [],
      cards: [],
      squads: { home: squadFromLineup(lineups.home), away: squadFromLineup(lineups.away) },
      shootout: null,
      outcome: null,
      replayFlagged: false,
    };
  },

  // W4a (#425) §7 — the SAME function the fold kernel's monotonic guard reads,
  // handed over directly rather than as a copy of its output. `sweepExpired`
  // calls it too, so the guard and this module order against one list.
  playPhases,

  apply(state, ev: EventEnvelope<FootballEv | CoreEv>, ctx): FootballState {
    // W4a (#425) §3 — the game-time frame around every event.
    //
    // `gameTimeOf` is the same structural safe-parse the fold kernel's monotonic
    // guard uses, so the module and the guard read one stamp rather than two
    // interpretations of one payload.
    const at = gameTimeOf(ev.payload);
    if (at !== null && isStrictFold(ctx)) {
      // §7, module half. The fold guard already refuses an undeclared period,
      // but `apply` must not DEPEND on having been called through it: the same
      // list, the same error code, and a message that names the phases so a
      // scorer can retype rather than a 500 that pages the on-call.
      //
      // STRICT ONLY (§3.3 seam). `playPhases` is derived from cfg — turning off
      // `extraTime.enabled` or `shootout` deletes three phases at once — and cfg
      // is read live at fold time, so on replay this same check says "an
      // organiser edited the division, therefore no scored fixture in it can be
      // read again". There is no event to void; the stamp was legal when it was
      // recorded. Nothing downstream needs the refusal either: `sweepExpired`
      // and every comparison below go through `orderable`, which returns null
      // for an unlisted phase rather than raising.
      const order = playPhases(state.cfg);
      if (!order.includes(at.period)) {
        invalid(
          `event "${ev.type}" is stamped in period "${at.period}", which this sport does not have — expected one of ${order.join(", ")}`,
          { period: at.period, phaseOrder: order },
        );
      }
    }
    // Sweep BEFORE applying, so an event at 20:00 sees the pitch as it was at
    // 20:00. The one exception is an explicit release: sweeping first would
    // remove the very bin the end event names, and the fold would then have to
    // reconcile a scorer who correctly recorded both the expiry and the release
    // — so that one applies first and sweeps after.
    const sweepsFirst = at !== null && ev.type !== "football.sinbin.end";
    const base = sweepsFirst ? sweepExpired(state, at as GameTime) : state;
    const applied = applyEvent(base, ev);
    if (at === null) return applied;
    const swept = ev.type === "football.sinbin.end" ? sweepExpired(applied, at) : applied;
    // §6 obligation 3 — as of when everything above is true.
    return { ...swept, asOf: at };
  },

  outcome: (state) => state.outcome,

  // W4a (#425) T6b — the cross-sport position axis, via the SAME core
  // derivation the period kernel uses (see `footballPosition`).
  position: footballPosition,

  // §9.5 — defined at every prefix.
  summary(state): ScoreSummary {
    const { home, away } = state.goals;
    const shootout = state.shootout
      ? state.shootout.kicks.reduce(
          (tally, kick) => {
            if (kick.scored) tally[kick.side]++;
            return tally;
          },
          { home: 0, away: 0 },
        )
      : null;
    const suffix = shootout ? ` (${shootout.home}–${shootout.away} pens)` : "";
    return {
      headline: `${home} — ${away}${suffix}`,
      perSide: [
        { entrantId: state.entrants.home, line: `${home}${shootout ? ` (${shootout.home}p)` : ""}` },
        { entrantId: state.entrants.away, line: `${away}${shootout ? ` (${shootout.away}p)` : ""}` },
      ],
      detail: {
        periods: state.periods,
        ...(shootout === null ? {} : { shootout }),
        // W4: unconverted penalties and sin bins deliberately do NOT appear
        // here. §9.6 requires summary(coarse) === summary(fine), and coarsen
        // drops every event with no score effect — same reason `cards` has
        // never been in the summary. They live in State and in the ledger,
        // which is what the match report reads.
        ...(state.replayFlagged ? { abandoned: true } : {}),
      },
    };
  },

  standingsDelta(outcome, cfg, _ctx: StageCtx, state): [StandingsDelta, StandingsDelta] {
    const build = (
      side: Side,
      w: number,
      d: number,
      l: number,
      pts: number,
      zeroGoals = false,
    ): StandingsDelta => ({
      entrantId: state.entrants[side],
      played: 1,
      won: w,
      drawn: d,
      lost: l,
      points: pts,
      metrics: sideMetrics(state, side, zeroGoals),
    });

    switch (outcome.kind) {
      case "win":
      case "award": {
        const winnerSide = sideOf(state, outcome.winner);
        // spec 04 §1.4 — optional shootout points split (group-stage SO).
        const split =
          outcome.kind === "win" &&
          outcome.method === "shootout" &&
          cfg.points.shootoutWin !== undefined &&
          cfg.points.shootoutLoss !== undefined;
        const winnerPts = split ? (cfg.points.shootoutWin as number) : cfg.points.win;
        const loserPts = split ? (cfg.points.shootoutLoss as number) : cfg.points.loss;
        const winner = build(winnerSide, 1, 0, 0, winnerPts);
        const loser = build(opponent(winnerSide), 0, 0, 1, loserPts);
        return winnerSide === "home" ? [winner, loser] : [loser, winner];
      }
      case "draw":
      case "tie":
        return [build("home", 0, 1, 0, cfg.points.draw), build("away", 0, 1, 0, cfg.points.draw)];
      case "no_result":
        // Abandoned level match under the 'award' policy: share draw points,
        // no draw counted, no goal metrics (mirrors the generic module).
        return [
          build("home", 0, 0, 0, cfg.points.draw, true),
          build("away", 0, 0, 0, cfg.points.draw, true),
        ];
    }
  },

  metrics: [
    // doc 09 §2: the public table shows P W D L GF GA GD Pts — card counts and
    // fair-play stay ledger-only (display: false).
    { key: "gf", label: "GF", direction: "desc" },
    { key: "ga", label: "GA", direction: "asc" },
    { key: "gd", label: "GD", direction: "desc" },
    { key: "yellow", label: "Yellow cards", direction: "asc", display: false },
    { key: "red", label: "Red cards", direction: "asc", display: false },
    { key: "fair_play", label: "Fair play points", direction: "desc", display: false },
  ],
  // Module default = fifa2026 (spec 04 §1.6); `classic` selectable by the
  // organiser via FOOTBALL_TIEBREAKERS.
  defaultTiebreakers: FOOTBALL_TIEBREAKERS.fifa2026,

  // spec 04 §1.3 — draws are league/group results only.
  supportsDraws(_cfg, stage: StageKind) {
    return stage === "league" || stage === "group" || stage === "swiss";
  },

  // §9.3 — {win+loss, 2·draw} plus the optional shootout split total.
  declaredPointsSets(cfg) {
    const totals = [cfg.points.win + cfg.points.loss, cfg.points.draw * 2];
    if (cfg.points.shootoutWin !== undefined && cfg.points.shootoutLoss !== undefined) {
      totals.push(cfg.points.shootoutWin + cfg.points.shootoutLoss);
    }
    return [...new Set(totals)];
  },

  // doc 14 §2 — Tier 1 = bare goals/periods (final score); Tier 2/3 = the
  // attributed timeline (scorers, minutes, cards, subs), Pro-gated.
  fidelityTiers: [
    { tier: 0, eventTypes: ["football.goal", "football.period", "football.shootout.kick"] },
    { tier: 1, eventTypes: ["football.goal", "football.period", "football.shootout.kick"] },
    {
      tier: 2,
      eventTypes: [
        "football.goal",
        "football.card",
        "football.sub",
        "football.period",
        "football.shootout.kick",
        // W4 — neither moves the score, so both stay out of tiers 0/1.
        "football.penalty",
        "football.sinbin.start",
        "football.sinbin.end",
      ],
      entitlement: "scoring.match_timeline",
    },
    {
      tier: 3,
      eventTypes: [
        "football.goal",
        "football.card",
        "football.sub",
        "football.period",
        "football.shootout.kick",
        "football.penalty",
        "football.sinbin.start",
        "football.sinbin.end",
      ],
      entitlement: "scoring.match_timeline",
    },
  ],
  officialLabel: { scorer: "Referee" }, // doc 13 §1
  // Jul3/07 §3 — goals/assists auto (16 Apr), points = goals + assists
  // (hockey-style), cards. Own goals never credit the striker.
  playerStats: {
    metrics: [
      {
        key: "goals", label: "Goals", from: "football.goal", field: "scorer", agg: "count",
        when: (p) => p.ownGoal !== true,
      },
      { key: "assists", label: "Assists", from: "football.goal", field: "assist", agg: "count" },
      {
        key: "yellow_cards", label: "Yellow cards", from: "football.card", field: "person",
        agg: "count", when: (p) => p.color === "yellow" || p.color === "second_yellow",
      },
      {
        key: "red_cards", label: "Red cards", from: "football.card", field: "person",
        agg: "count", when: (p) => p.color === "red" || p.color === "second_yellow",
      },
      // W4 — the facts the new branches make countable. `penalty_goals` is a
      // subset of `goals`, so `points` (goals + assists) is unchanged.
      {
        key: "penalty_goals", label: "Penalty goals", from: "football.goal", field: "scorer",
        agg: "count", when: (p) => p.penalty === true && p.ownGoal !== true,
      },
      {
        key: "penalties_missed", label: "Penalties missed", from: "football.penalty",
        field: "taker", agg: "count",
      },
      // The personal column only — the goal itself was already credited to the
      // opponent by the fold, so `points` (goals + assists) is unchanged.
      {
        key: "own_goals", label: "Own goals", from: "football.goal", field: "scorer",
        agg: "count", when: (p) => p.ownGoal === true,
      },
      {
        // The START event alone: the end is the player coming back, not a
        // second sanction. The pair makes that structural — no `when` guard.
        key: "sin_bins", label: "Sin bins", from: "football.sinbin.start", field: "person",
        agg: "count",
      },
    ],
    derived: [
      { key: "points", label: "Points", derive: (s) => (s.goals ?? 0) + (s.assists ?? 0) },
    ],
    awards: [{ key: "motm", label: "Man of the Match" }],
  },

  // SPEC-1 — read-only card projection over the ledger (voids un-count, spec
  // 03 §2). Colours are the FA card grades; the discipline usecase folds these
  // into per-division suspensions. Zero effect on the reducer or golden files.
  discipline: {
    colors: [
      { key: "yellow", label: "Yellow card" },
      { key: "second_yellow", label: "Second yellow" },
      { key: "red", label: "Red card" },
      // W4 — a temporary dismissal is a sanction, not a card grade, but the
      // projection has exactly one axis and the rules editor prices sanctions
      // off it. The period kernel already does this: its "colours" are the
      // suspension CLASS keys (minor/major/misconduct), not card colours.
      { key: "sin_bin", label: "Sin bin" },
    ],
    extractCards(ledger): DisciplineCard[] {
      const cards: DisciplineCard[] = [];
      for (const ev of resolveVoids(ledger)) {
        // W4 review item 6 — a sin bin removes a player from the pitch and
        // carries the same Law 12 `reason` a card does, so an accumulation
        // rule ("three dissents in a season") has to see it. Filtering on
        // `football.card` alone made it invisible to the discipline usecase,
        // while every period-kernel sport projected its own suspension.
        if (ev.type === "football.sinbin.start") {
          const parsed = FootballSinBinStart.safeParse(ev.payload);
          // Only the START: the end event is the player coming back, not a
          // second sanction — projecting it would double every bin.
          if (!parsed.success) continue;
          const bin = parsed.data;
          cards.push({
            ...(bin.person === undefined ? {} : { personId: bin.person }),
            entrantSide: bin.by,
            color: "sin_bin",
            eventId: ev.id,
            ...(bin.reason === undefined ? {} : { reason: bin.reason }),
          });
          continue;
        }
        if (ev.type !== "football.card") continue;
        const parsed = FootballCard.safeParse(ev.payload);
        if (!parsed.success) continue;
        const card = parsed.data;
        cards.push({
          ...(card.person === undefined ? {} : { personId: card.person }),
          entrantSide: card.by,
          color: card.color,
          eventId: ev.id,
          // W4 — the Law 12 offence, when the referee recorded one. Football
          // has no bench penalties, so no card is ever served by a substitute:
          // `servedBy` stays absent for this sport.
          ...(card.reason === undefined ? {} : { reason: card.reason }),
        });
      }
      return cards;
    },
  },

  // spec 03 §6 — deterministic valid-event generator.
  arbitraryEvent(state, rng: Rng): ModuleEvent<FootballEv> | null {
    const sideId = (side: Side) => state.entrants[side];
    const randomSide = (): Side => (rng() < 0.5 ? "home" : "away");

    // W4a review — the generator STAMPS what it emits, so the conformance,
    // chaos, undo-sweep and (once extended) golden streams actually exercise
    // this wave's path: stamped payloads, the lazy sweep, the carry, the
    // boundary sweeps and `asOf`. Without it §9.6's coarse-equals-fine and every
    // appended stream stayed on the pre-wave path, and "the goldens are
    // byte-identical" was guaranteed by the generator's blind spot rather than
    // by the change being additive.
    //
    // The claimed reason for leaving it out — that an extra rng draw would shift
    // every generated stream — does not hold: `testkit/golden.ts` records the
    // corpus as actual `{type, payload}` objects and replays THOSE
    // (`recomputeStream` never calls this function), and `extendCorpus` copies
    // existing streams through untouched and only appends.
    //
    // Derived from `state.asOf`, never drawn. Two reasons, both load-bearing: a
    // draw would perturb every existing generated walk for no benefit, and the
    // stamp MUST be monotonic or the fold kernel's guard reds the run with
    // NON_MONOTONIC_TIME for entirely the wrong reason. One minute of game time
    // per event, restarting at the top of each phase — the phase index carries
    // the ordering across every boundary.
    const stamp = (phase: string): GameTime => ({
      period: phase,
      elapsed: (state.asOf?.period === phase ? state.asOf.elapsed : 0) + 60,
    });

    if (state.phase === "pre") {
      // Pre-kickoff card (football.md §9) — at most one, to a clean player.
      if (rng() >= 0.9 && state.cards.length === 0) {
        const side = randomSide();
        const person = state.squads[side].onPitch[0];
        if (person !== undefined) {
          return {
            type: "football.card",
            payload: { by: sideId(side), person, color: "yellow", at: stamp("pre") },
          };
        }
      }
      return { type: "core.start", payload: {} };
    }

    if (state.phase === "SHOOTOUT" && state.shootout) {
      const expected = expectedKicker(state.shootout.kicks) ?? randomSide();
      return {
        type: "football.shootout.kick",
        payload: { by: sideId(expected), scored: rng() < 0.75, at: stamp("SHOOTOUT") },
      };
    }

    if (!isPlayPhase(state.phase)) return null; // done / final / abandoned

    const roll = rng();
    if (roll < 0.02) {
      return { type: "core.forfeit", payload: { by: sideId(randomSide()), reason: "walkover" } };
    }
    if (roll < 0.04) return { type: "core.abandon", payload: { reason: "weather" } };
    if (roll < 0.14) {
      // Card to a random on-pitch player without a prior yellow (or anonymous).
      const side = randomSide();
      const squad = state.squads[side];
      const carded = new Set(
        state.cards.filter((card) => card.person !== undefined).map((card) => card.person),
      );
      const eligible = squad.onPitch.filter((person) => !carded.has(person));
      const person = eligible[Math.floor(rng() * eligible.length)];
      if (person === undefined || rng() < 0.3) {
        return {
          type: "football.card",
          payload: { by: sideId(side), color: "yellow", at: stamp(state.phase) },
        };
      }
      const color = rng() < 0.85 ? "yellow" : "red";
      return {
        type: "football.card",
        payload: { by: sideId(side), person, color, at: stamp(state.phase) },
      };
    }
    if (roll < 0.155) {
      // W4 (Law 12 addendum) — a temporary dismissal, or the return that ends
      // one. Returning is preferred whenever anybody is serving, so the pitch
      // does not drain over a long generated stream.
      const side = randomSide();
      const bin = state.squads[side].sinBin ?? [];
      const serving = bin[Math.floor(rng() * bin.length)];
      if (serving !== undefined && rng() < 0.6) {
        return {
          type: "football.sinbin.end",
          payload: {
            by: sideId(side),
            ...(serving.person === undefined ? {} : { person: serving.person }),
            at: stamp(state.phase),
          },
        };
      }
      const binned = new Set(bin.map((entry) => entry.person));
      const eligible = state.squads[side].onPitch.filter((person) => !binned.has(person));
      const person = eligible[Math.floor(rng() * eligible.length)];
      // `minutes` is carried explicitly rather than left to `Cfg.sinBinMinutes`,
      // which the golden and conformance configs do not set: without a declared
      // length nothing derives an expiry, and the generated streams would stamp
      // payloads while never once reaching the sweep or the carry.
      if (person !== undefined && eligible.length > 7) {
        return {
          type: "football.sinbin.start",
          payload: {
            by: sideId(side),
            person,
            reason: "dissent",
            minutes: 10,
            at: stamp(state.phase),
          },
        };
      }
      // Anonymous (coarse) dismissal — never moves the pitch, so cap how many
      // can pile up; otherwise fall through to the next branch.
      if (bin.length < 2) {
        return {
          type: "football.sinbin.start",
          payload: { by: sideId(side), minutes: 10, at: stamp(state.phase) },
        };
      }
    }
    if (roll < 0.17) {
      // W4 (Law 14) — an open-play penalty that was not converted. The
      // goalkeeper is the defending side's first player still on the pitch,
      // which is the catalog's GK slot in the conformance lineups.
      const side = randomSide();
      const taker = state.squads[side].onPitch[Math.floor(rng() * state.squads[side].onPitch.length)];
      const goalkeeper = rng() < 0.5 ? state.squads[opponent(side)].onPitch[0] : undefined;
      const outcomes = PenaltyOutcome.options;
      const outcome = outcomes[Math.floor(rng() * outcomes.length)] ?? "saved";
      return {
        type: "football.penalty",
        payload: {
          by: sideId(side),
          ...(taker === undefined ? {} : { taker }),
          ...(goalkeeper === undefined ? {} : { goalkeeper }),
          outcome,
          at: stamp(state.phase),
        },
      };
    }
    if (roll < 0.19) {
      const side = randomSide();
      const squad = state.squads[side];
      const on = squad.bench[Math.floor(rng() * squad.bench.length)];
      const off = squad.onPitch[Math.floor(rng() * squad.onPitch.length)];
      if (on !== undefined && off !== undefined) {
        return {
          type: "football.sub",
          payload: { by: sideId(side), off, on, at: stamp(state.phase) },
        };
      }
      // No bench (conformance lineups) — fall through to a goal instead.
    }
    if (roll < 0.72) {
      const side = randomSide();
      const ownGoal = rng() < 0.05;
      const squad = state.squads[side];
      const scorer =
        rng() < 0.5 ? squad.onPitch[Math.floor(rng() * squad.onPitch.length)] : undefined;
      const minute = rng() < 0.5 ? Math.floor(rng() * 130) : undefined;
      return {
        type: "football.goal",
        payload: {
          by: sideId(side),
          ...(scorer === undefined ? {} : { scorer }),
          ...(minute === undefined ? {} : { minute }),
          ...(ownGoal ? { ownGoal: true } : {}),
          at: stamp(state.phase),
        },
      };
    }
    // Advance the clock.
    const marker =
      state.phase === "H1" ? "HT" : state.phase === "H2" ? "FT" : state.phase === "ET_H1" ? "ET_HT" : "ET_FT";
    return { type: "football.period", payload: { phase: marker, at: stamp(state.phase) } };
  },

  // §9.6 / PROMPT-04 §9 — timeline → period summaries: strip attribution
  // (scorers, minutes, kick takers) keeping only what moves the score, drop
  // cards/subs (no score effect). Core events pass through.
  coarsen(events): ModuleEvent<FootballEv>[] {
    const out: ModuleEvent<FootballEv>[] = [];
    for (const event of events) {
      switch (event.type) {
        case "football.goal": {
          const payload = event.payload as z.infer<typeof FootballGoal>;
          out.push({
            type: "football.goal",
            payload: {
              by: payload.by,
              ...(payload.ownGoal === undefined ? {} : { ownGoal: payload.ownGoal }),
            },
          });
          break;
        }
        case "football.period":
          out.push({ type: "football.period", payload: event.payload });
          break;
        case "football.shootout.kick": {
          const payload = event.payload as z.infer<typeof FootballShootoutKick>;
          out.push({
            type: "football.shootout.kick",
            payload: { by: payload.by, scored: payload.scored },
          });
          break;
        }
        case "football.card":
        case "football.sub":
        case "football.penalty":
        case "football.sinbin.start":
        case "football.sinbin.end":
          break; // no score effect — dropped at coarse fidelity
        default:
          out.push({ type: event.type, payload: event.payload });
      }
    }
    return out;
  },
};
