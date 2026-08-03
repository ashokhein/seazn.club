// Football SportModule — spec 04 §1 + engine/sports/football.md (PROMPT-04).
// Timed periods, draws league-only, ET/shootout sub-machines, FIFA fair play,
// two official tiebreaker presets (fifa2026 H2H-first / classic GD-first).
import { z } from "zod";
import { EngineError } from "../../core/errors.ts";
import { resolveVoids, type CoreEv, type EventEnvelope } from "../../core/events.ts";
import type { Rng } from "../../core/rng.ts";
import {
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
  // period in minutes, used when a `football.sinbin` event omits its own.
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

export const FootballGoal = z.strictObject({
  by: EntrantId, // ownGoal: the side whose player struck it (credits opponent)
  scorer: PersonId.optional(),
  assist: PersonId.optional(), // Jul3/07 §3 — optional everywhere (own goals etc.)
  minute: z.number().int().nonnegative().optional(), // optional everywhere: coarse scoring
  ownGoal: z.boolean().optional(),
  penalty: z.boolean().optional(), // in-play penalty kick, not a shootout kick
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
  minute: z.number().int().nonnegative().optional(),
  reason: CardReason.optional(), // W4 — optional everywhere: coarse scoring
});
export const FootballSub = z.strictObject({
  by: EntrantId,
  off: PersonId,
  on: PersonId,
  minute: z.number().int().nonnegative().optional(),
});
export const FootballPeriod = z.strictObject({
  phase: z.enum(["HT", "FT", "ET_HT", "ET_FT"]),
  // W4 (Law 7 §3, allowance for time lost) — minutes added to the period this
  // marker CLOSES. A match report writes "90+3"; a bare integer `minute`
  // cannot tell that apart from the 93rd minute of extra time.
  addedMinutes: z.number().int().nonnegative().optional(),
});
export const FootballShootoutKick = z.strictObject({
  by: EntrantId,
  person: PersonId.optional(),
  scored: z.boolean(),
});

// W4 (Law 14) — a penalty kick awarded IN OPEN PLAY that did not produce a
// goal. A converted penalty stays `football.goal { penalty: true }` so no
// pre-W4 stream changes meaning; this branch exists purely for the kicks a
// scorebook otherwise loses. `outcome` is required, which is also what keeps
// the branch structurally distinct inside the union.
export const PenaltyOutcome = z.enum(["saved", "missed", "post"]);
export const FootballPenalty = z.strictObject({
  by: EntrantId, // the side awarded the kick
  taker: PersonId.optional(),
  keeper: PersonId.optional(), // the DEFENDING keeper who faced it
  outcome: PenaltyOutcome,
  minute: z.number().int().nonnegative().optional(),
});

// W4 (Law 12 addendum) — a temporary dismissal ("sin bin"). The FA operates
// them below the National League System and across youth football; futsal and
// most small-sided codes use a time penalty of the same shape. One branch
// carries both halves of the fact: the dismissal, and — with `returned` — the
// player's return to the pitch, which no existing branch could express
// (football.card's non-yellow path removes a player permanently).
export const FootballSinBin = z.strictObject({
  by: EntrantId,
  person: PersonId.optional(),
  minutes: z.number().int().positive().optional(), // defaults to cfg.sinBinMinutes
  minute: z.number().int().nonnegative().optional(),
  reason: CardReason.optional(),
  returned: z.boolean().optional(), // true = the return-to-play record
});

export const FootballEv = z.union([
  FootballGoal,
  FootballCard,
  FootballSub,
  FootballPeriod,
  FootballShootoutKick,
  FootballPenalty,
  FootballSinBin,
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
}

interface SquadState {
  onPitch: string[];
  bench: string[];
  offUsed: string[]; // substituted off — may not return
  sentOff: string[]; // red / second yellow — may not return or be subbed for
  // W4 — currently serving a temporary dismissal. Absent until the first sin
  // bin of the match, so `init` serialises exactly as it did before W4.
  sinBin?: SinBinRecord[];
}

interface CardRecord {
  side: Side;
  person?: string;
  color: z.infer<typeof CardColor>;
  minute?: number;
  reason?: z.infer<typeof CardReason>; // W4 — Law 12 offence category
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
}

interface PenaltyRecord {
  side: Side;
  outcome: z.infer<typeof PenaltyOutcome>;
  taker?: string;
  keeper?: string;
  minute?: number;
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
      ...state,
      phase: "done",
      outcome: {
        kind: "win",
        winner: state.entrants[winnerSide],
        loser: state.entrants[opponent(winnerSide)],
        method: after === "FT" ? "regulation" : "extra_time",
      },
    };
  }
  if (after === "FT" && state.cfg.extraTime.enabled) return pushPeriod(state, "ET_H1");
  if (state.cfg.shootout) return { ...state, phase: "SHOOTOUT", shootout: { kicks: [] } };
  return { ...state, phase: "done", outcome: { kind: "draw" } };
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
  const onPitch = [...squad.onPitch.filter((id) => id !== payload.off), payload.on];
  const next: SquadState = rolling
    ? // Repeat substitution: the player who came off rejoins the bench and may
      // re-enter, so nothing lands in offUsed.
      { ...squad, onPitch, bench: [...squad.bench.filter((id) => id !== payload.on), payload.off] }
    : {
        ...squad,
        onPitch,
        bench: squad.bench.filter((id) => id !== payload.on),
        offUsed: [...squad.offUsed, payload.off],
      };
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

// W4 (Law 12 addendum) — a temporary dismissal, or the return that ends one.
function applySinBin(state: FootballState, payload: z.infer<typeof FootballSinBin>): FootballState {
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

  if (payload.returned === true) {
    // An anonymous return closes the oldest anonymous dismissal — the only
    // entry it could possibly be about.
    const index = bin.findIndex((entry) => entry.person === payload.person);
    if (index < 0) {
      invalid(
        payload.person === undefined
          ? `"${payload.by}" has no anonymous sin bin to end`
          : `"${payload.person}" is not serving a sin bin`,
        { by: payload.by, ...(payload.person === undefined ? {} : { person: payload.person }) },
      );
    }
    const entry = bin[index] as SinBinRecord;
    return withSquad({
      ...squad,
      onPitch: entry.person === undefined ? squad.onPitch : [...squad.onPitch, entry.person],
      sinBin: bin.filter((_, i) => i !== index),
    });
  }

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
  const minutes = payload.minutes ?? state.cfg.sinBinMinutes;
  const record: SinBinRecord = {
    ...(payload.person === undefined ? {} : { person: payload.person }),
    ...(minutes === undefined ? {} : { minutes }),
    ...(payload.reason === undefined ? {} : { reason: payload.reason }),
    ...(payload.minute === undefined ? {} : { minute: payload.minute }),
  };
  return withSquad({
    ...squad,
    onPitch:
      payload.person === undefined
        ? squad.onPitch
        : squad.onPitch.filter((id) => id !== payload.person),
    sinBin: [...bin, record],
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
  // The keeper facing the kick belongs to the DEFENDING side.
  if (
    payload.keeper !== undefined &&
    !state.squads[opponent(side)].onPitch.includes(payload.keeper)
  ) {
    invalid(`keeper "${payload.keeper}" is not on the pitch for the defending side`, {
      keeper: payload.keeper,
    });
  }
  const record: PenaltyRecord = {
    side,
    outcome: payload.outcome,
    ...(payload.taker === undefined ? {} : { taker: payload.taker }),
    ...(payload.keeper === undefined ? {} : { keeper: payload.keeper }),
    ...(payload.minute === undefined ? {} : { minute: payload.minute }),
  };
  return { ...state, penalties: [...(state.penalties ?? []), record] };
}

function applyPeriod(state: FootballState, payload: z.infer<typeof FootballPeriod>): FootballState {
  const marker = payload.phase;
  switch (marker) {
    case "HT":
      if (state.phase !== "H1") wrongPhase(`HT marker in phase "${state.phase}"`);
      return pushPeriod(stampAddedMinutes(state, payload.addedMinutes), "H2");
    case "FT":
      if (state.phase !== "H2") wrongPhase(`FT marker in phase "${state.phase}"`);
      return resolveFullTime(stampAddedMinutes(state, payload.addedMinutes), "FT");
    case "ET_HT":
      if (state.phase !== "ET_H1") wrongPhase(`ET_HT marker in phase "${state.phase}"`);
      return pushPeriod(stampAddedMinutes(state, payload.addedMinutes), "ET_H2");
    case "ET_FT":
      if (state.phase !== "ET_H2") wrongPhase(`ET_FT marker in phase "${state.phase}"`);
      return resolveFullTime(stampAddedMinutes(state, payload.addedMinutes), "ET_FT");
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
    ...state,
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
    ...state,
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
  if (home === away) return { ...state, phase: "done", outcome: { kind: "no_result" } };
  const winnerSide: Side = home > away ? "home" : "away";
  return {
    ...state,
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

  apply(state, ev: EventEnvelope<FootballEv | CoreEv>): FootballState {
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
      case "football.sinbin":
        return applySinBin(state, parsePayload(FootballSinBin, ev.payload, ev.type));
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
        "football.sinbin",
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
        "football.sinbin",
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
      {
        key: "sin_bins", label: "Sin bins", from: "football.sinbin", field: "person",
        agg: "count", when: (p) => p.returned !== true,
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
    ],
    extractCards(ledger): DisciplineCard[] {
      const cards: DisciplineCard[] = [];
      for (const ev of resolveVoids(ledger)) {
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

    if (state.phase === "pre") {
      // Pre-kickoff card (football.md §9) — at most one, to a clean player.
      if (rng() >= 0.9 && state.cards.length === 0) {
        const side = randomSide();
        const person = state.squads[side].onPitch[0];
        if (person !== undefined) {
          return { type: "football.card", payload: { by: sideId(side), person, color: "yellow" } };
        }
      }
      return { type: "core.start", payload: {} };
    }

    if (state.phase === "SHOOTOUT" && state.shootout) {
      const expected = expectedKicker(state.shootout.kicks) ?? randomSide();
      return {
        type: "football.shootout.kick",
        payload: { by: sideId(expected), scored: rng() < 0.75 },
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
        return { type: "football.card", payload: { by: sideId(side), color: "yellow" } };
      }
      const color = rng() < 0.85 ? "yellow" : "red";
      return { type: "football.card", payload: { by: sideId(side), person, color } };
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
          type: "football.sinbin",
          payload: {
            by: sideId(side),
            ...(serving.person === undefined ? {} : { person: serving.person }),
            returned: true,
          },
        };
      }
      const binned = new Set(bin.map((entry) => entry.person));
      const eligible = state.squads[side].onPitch.filter((person) => !binned.has(person));
      const person = eligible[Math.floor(rng() * eligible.length)];
      if (person !== undefined && eligible.length > 7) {
        return {
          type: "football.sinbin",
          payload: { by: sideId(side), person, reason: "dissent" },
        };
      }
      // Anonymous (coarse) dismissal — never moves the pitch, so cap how many
      // can pile up; otherwise fall through to the next branch.
      if (bin.length < 2) return { type: "football.sinbin", payload: { by: sideId(side) } };
    }
    if (roll < 0.17) {
      // W4 (Law 14) — an open-play penalty that was not converted. The keeper
      // is the defending side's first player still on the pitch, which is the
      // catalog's GK slot in the conformance lineups.
      const side = randomSide();
      const taker = state.squads[side].onPitch[Math.floor(rng() * state.squads[side].onPitch.length)];
      const keeper = rng() < 0.5 ? state.squads[opponent(side)].onPitch[0] : undefined;
      const outcomes = PenaltyOutcome.options;
      const outcome = outcomes[Math.floor(rng() * outcomes.length)] ?? "saved";
      return {
        type: "football.penalty",
        payload: {
          by: sideId(side),
          ...(taker === undefined ? {} : { taker }),
          ...(keeper === undefined ? {} : { keeper }),
          outcome,
        },
      };
    }
    if (roll < 0.19) {
      const side = randomSide();
      const squad = state.squads[side];
      const on = squad.bench[Math.floor(rng() * squad.bench.length)];
      const off = squad.onPitch[Math.floor(rng() * squad.onPitch.length)];
      if (on !== undefined && off !== undefined) {
        return { type: "football.sub", payload: { by: sideId(side), off, on } };
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
        },
      };
    }
    // Advance the clock.
    const marker =
      state.phase === "H1" ? "HT" : state.phase === "H2" ? "FT" : state.phase === "ET_H1" ? "ET_HT" : "ET_FT";
    return { type: "football.period", payload: { phase: marker } };
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
        case "football.sinbin":
          break; // no score effect — dropped at coarse fidelity
        default:
          out.push({ type: event.type, payload: event.payload });
      }
    }
    return out;
  },
};
