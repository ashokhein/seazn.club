// Locale-aware display labels for scoring domain vocab whose STORED form stays
// English (DB sport_key, event-ledger payload kinds, palette hex→name). Every
// vocab here is a closed enum, so each helper indexes a typed
// Record<Enum, MessageKey> map: the Record forces every member to be mapped, and
// the MessageKey value forces every key to exist in ui.json — both nets hold at
// compile time, and there are no dynamic key strings. Unknown runtime values
// (payloads are `string`) fall back to a humanized token, never throw.
//
// #427 adds three more layers on top of the closed enums below: `EVENT_KEY`
// (every event type the shipped sport modules declare), `ENUM_VOCAB` (every
// enum member those modules' payload schemas can carry, keyed by the FIELD the
// enum sits on — payloads carry no type discriminator, so the field name is the
// only stable handle) and `ENGINE_ERROR_KEY`. Those three sets are open-ended —
// they grow whenever the engine grows — so the compiler cannot force them.
// `__tests__/scoring-vocab.test.ts` does instead, by DERIVING the expected sets
// from the engine's own declarations at test time.
import type { MessageKey } from "@/lib/messages";
import type { EngineErrorCode } from "@seazn/engine/core";
import { swatchName } from "@/lib/brand-palette";

export type WicketKind =
  | "bowled" | "caught" | "lbw" | "runout" | "stumped"
  | "hitwicket" | "retired" | "obstructed" | "timedout";
export type ExtraKind = "wide" | "noball" | "bye" | "legbye" | "penalty";
export type SportKey =
  | "badminton" | "boardgame" | "carrom" | "cricket" | "football" | "generic"
  | "hockey" | "icehockey" | "tabletennis" | "tennis" | "volleyball";

const WICKET_KEY: Record<WicketKind, MessageKey> = {
  bowled: "wicket.bowled", caught: "wicket.caught", lbw: "wicket.lbw",
  runout: "wicket.runout", stumped: "wicket.stumped", hitwicket: "wicket.hitwicket",
  retired: "wicket.retired", obstructed: "wicket.obstructed", timedout: "wicket.timedout",
};
const EXTRA_KEY: Record<ExtraKind, MessageKey> = {
  wide: "extra.wide", noball: "extra.noball", bye: "extra.bye",
  legbye: "extra.legbye", penalty: "extra.penalty",
};
const SPORT_KEY: Record<SportKey, MessageKey> = {
  badminton: "sport.badminton", boardgame: "sport.boardgame", carrom: "sport.carrom",
  cricket: "sport.cricket", football: "sport.football", generic: "sport.generic",
  hockey: "sport.hockey", icehockey: "sport.icehockey", tabletennis: "sport.tabletennis",
  tennis: "sport.tennis", volleyball: "sport.volleyball",
};
const SWATCH_KEY: Record<string, MessageKey> = {
  Teal: "swatch.Teal", Ocean: "swatch.Ocean", Cobalt: "swatch.Cobalt",
  Midnight: "swatch.Midnight", Forest: "swatch.Forest", Ember: "swatch.Ember",
  Bronze: "swatch.Bronze", Crimson: "swatch.Crimson", Magenta: "swatch.Magenta",
  Graphite: "swatch.Graphite",
};

/** Every event type the shipped sport modules declare, plus the core ledger. */
export const EVENT_KEY: Record<string, MessageKey> = {
  "core.start": "event.core.start", "core.void": "event.core.void",
  "core.forfeit": "event.core.forfeit", "core.abandon": "event.core.abandon",
  "core.finalize": "event.core.finalize", "core.note": "event.core.note",
  "core.award": "event.core.award", "core.suspend": "event.core.suspend",
  "core.resume": "event.core.resume",

  "badminton.game.summary": "event.badminton.game.summary",
  "badminton.rally": "event.badminton.rally",
  "badminton.sanction": "event.badminton.sanction",

  "boardgame.pairing": "event.boardgame.pairing",
  "boardgame.result": "event.boardgame.result",

  "carrom.board.summary": "event.carrom.board.summary",
  "carrom.game.adjust": "event.carrom.game.adjust",
  "carrom.toss": "event.carrom.toss",

  "cricket.ball": "event.cricket.ball",
  "cricket.followon": "event.cricket.followon",
  "cricket.innings.close": "event.cricket.innings.close",
  "cricket.innings.declare": "event.cricket.innings.declare",
  "cricket.innings.summary": "event.cricket.innings.summary",
  "cricket.interruption": "event.cricket.interruption",
  "cricket.match.close": "event.cricket.match.close",
  "cricket.newball": "event.cricket.newball",
  "cricket.player.line": "event.cricket.player.line",
  "cricket.powerplay": "event.cricket.powerplay",
  "cricket.retire": "event.cricket.retire",
  "cricket.review": "event.cricket.review",
  "cricket.revise": "event.cricket.revise",
  "cricket.superover.ball": "event.cricket.superover.ball",
  "cricket.toss": "event.cricket.toss",

  "football.card": "event.football.card",
  "football.goal": "event.football.goal",
  "football.penalty": "event.football.penalty",
  "football.period": "event.football.period",
  "football.shootout.kick": "event.football.shootout.kick",
  "football.sinbin.start": "event.football.sinbin.start",
  "football.sinbin.end": "event.football.sinbin.end",
  "football.sub": "event.football.sub",

  "generic.result": "event.generic.result",
  "generic.score": "event.generic.score",

  "hockey.goal": "event.hockey.goal",
  "hockey.period.advance": "event.hockey.period.advance",
  "hockey.set_piece": "event.hockey.set_piece",
  "hockey.shootout.attempt": "event.hockey.shootout.attempt",
  "hockey.suspension.start": "event.hockey.suspension.start",
  "hockey.suspension.end": "event.hockey.suspension.end",

  "icehockey.goal": "event.icehockey.goal",
  "icehockey.period.advance": "event.icehockey.period.advance",
  "icehockey.set_piece": "event.icehockey.set_piece",
  "icehockey.shootout.attempt": "event.icehockey.shootout.attempt",
  "icehockey.suspension.start": "event.icehockey.suspension.start",
  "icehockey.suspension.end": "event.icehockey.suspension.end",

  "tabletennis.expedite.start": "event.tabletennis.expedite.start",
  "tabletennis.game.summary": "event.tabletennis.game.summary",
  "tabletennis.rally": "event.tabletennis.rally",
  "tabletennis.sanction": "event.tabletennis.sanction",
  "tabletennis.timeout": "event.tabletennis.timeout",

  "tennis.interruption": "event.tennis.interruption",
  "tennis.point": "event.tennis.point",
  "tennis.sanction": "event.tennis.sanction",
  "tennis.set_summary": "event.tennis.set_summary",

  "volleyball.rally": "event.volleyball.rally",
  "volleyball.sanction": "event.volleyball.sanction",
  "volleyball.set.summary": "event.volleyball.set.summary",
  "volleyball.sub": "event.volleyball.sub",
  "volleyball.timeout": "event.volleyball.timeout",
};

/**
 * The cross-sport match-position axis (W4a, `@seazn/engine/core` position.ts):
 * one `key` per ordered segment — "Set 2 · 30–15", "Innings 1 · Over 12.3",
 * "P2 · 12:41" — that a single renderer draws for all eleven sports.
 *
 * The engine emits `key` as the stable token and writes no locale copy; its
 * optional `label` is an English fallback, present only where a value needs a
 * noun to read. The three label-less keys (`period`, `clock`, `points`) are
 * mapped anyway: a value that names itself inline still needs a noun the
 * moment a surface heads a column with it or an assistive reader announces it,
 * and a gap there is a hardcoded English string waiting to happen.
 *
 * Derived, never hand-listed — `__tests__/scoring-vocab.test.ts` folds real
 * streams for the nine projecting sports and reds on any key missing here.
 */
export const POSITION_KEY: Record<string, MessageKey> = {
  set: "scoring.position.set",
  game: "scoring.position.game",
  innings: "scoring.position.innings",
  over: "scoring.position.over",
  board: "scoring.position.board",
  points: "scoring.position.points",
  period: "scoring.position.period",
  clock: "scoring.position.clock",
};

/**
 * Match awards, shared by two surfaces that used to name them independently:
 * the player-stat rows below (`*_awards`) and the fixture console's `core.award`
 * line. One key per award, so "Man of the Match" is translated once.
 */
const AWARD_KEY: Record<string, MessageKey> = {
  motm: "award.motm", mvp: "award.mvp", potm: "award.potm",
};

/**
 * Player-stat row labels, keyed `<sportKey>.<rowKey>` — the row key is the one
 * a snapshot carries, so awards appear here with their `_awards` suffix.
 *
 * PER-SPORT BY NECESSITY, not by taste. Five metric keys are declared by more
 * than one sport with DIFFERENT English: `sanctions` is "Sanctions" in
 * volleyball and "Cards" in badminton and table tennis; `points` is "Points won"
 * in tennis; `so_attempts` / `so_goals` / `so_saves` are the IIHF's "GWS *" on
 * ice and the FIH's "SO *" on grass. A flat `stat.sanctions` would force one
 * sport's wording onto another in four languages, and nothing on screen would
 * show it — the engine's English `label` always renders something plausible.
 * `__tests__/player-stat-vocab.test.ts` derives that collision set from the
 * engine and reds if any locale collapses two of them into one word.
 *
 * The three award rows point at `AWARD_KEY` rather than minting `stat.*` copy,
 * because the console names the same awards.
 */
export const PLAYER_STAT_KEY: Record<string, MessageKey> = {
  "football.goals": "stat.football.goals",
  "football.assists": "stat.football.assists",
  "football.yellow_cards": "stat.football.yellow_cards",
  "football.red_cards": "stat.football.red_cards",
  "football.penalty_goals": "stat.football.penalty_goals",
  "football.penalties_missed": "stat.football.penalties_missed",
  "football.own_goals": "stat.football.own_goals",
  "football.sin_bins": "stat.football.sin_bins",
  "football.points": "stat.football.points",
  "football.motm_awards": AWARD_KEY.motm,

  "cricket.runs": "stat.cricket.runs",
  "cricket.balls_faced": "stat.cricket.balls_faced",
  "cricket.balls_bowled": "stat.cricket.balls_bowled",
  "cricket.runs_conceded": "stat.cricket.runs_conceded",
  "cricket.wickets": "stat.cricket.wickets",
  "cricket.catches": "stat.cricket.catches",
  "cricket.stumpings": "stat.cricket.stumpings",
  "cricket.run_outs": "stat.cricket.run_outs",

  "boardgame.games": "stat.boardgame.games",
  "boardgame.wins": "stat.boardgame.wins",

  "carrom.breaks": "stat.carrom.breaks",
  "carrom.queens": "stat.carrom.queens",
  "carrom.penalties": "stat.carrom.penalties",

  "generic.points": "stat.generic.points",
  "generic.scores": "stat.generic.scores",

  "volleyball.points": "stat.volleyball.points",
  "volleyball.serves": "stat.volleyball.serves",
  "volleyball.sanctions": "stat.volleyball.sanctions",

  "badminton.points": "stat.badminton.points",
  "badminton.serves": "stat.badminton.serves",
  "badminton.sanctions": "stat.badminton.sanctions",

  "tabletennis.points": "stat.tabletennis.points",
  "tabletennis.serves": "stat.tabletennis.serves",
  "tabletennis.sanctions": "stat.tabletennis.sanctions",

  "tennis.points": "stat.tennis.points",
  "tennis.service_points": "stat.tennis.service_points",
  "tennis.aces": "stat.tennis.aces",
  "tennis.double_faults": "stat.tennis.double_faults",
  "tennis.violations": "stat.tennis.violations",
  "tennis.medical_timeouts": "stat.tennis.medical_timeouts",

  "icehockey.goals": "stat.icehockey.goals",
  "icehockey.assists": "stat.icehockey.assists",
  "icehockey.pen_minor": "stat.icehockey.pen_minor",
  "icehockey.pen_double": "stat.icehockey.pen_double",
  "icehockey.pen_major": "stat.icehockey.pen_major",
  "icehockey.pen_misc": "stat.icehockey.pen_misc",
  "icehockey.pen_gm": "stat.icehockey.pen_gm",
  "icehockey.pen_match": "stat.icehockey.pen_match",
  "icehockey.goals_pp": "stat.icehockey.goals_pp",
  "icehockey.goals_sh": "stat.icehockey.goals_sh",
  "icehockey.goals_ps": "stat.icehockey.goals_ps",
  "icehockey.goals_en": "stat.icehockey.goals_en",
  "icehockey.ps_taken": "stat.icehockey.ps_taken",
  "icehockey.so_attempts": "stat.icehockey.so_attempts",
  "icehockey.so_goals": "stat.icehockey.so_goals",
  "icehockey.so_saves": "stat.icehockey.so_saves",
  "icehockey.pen_served": "stat.icehockey.pen_served",
  "icehockey.points": "stat.icehockey.points",
  "icehockey.pim": "stat.icehockey.pim",
  "icehockey.mvp_awards": AWARD_KEY.mvp,

  "hockey.goals": "stat.hockey.goals",
  "hockey.green_cards": "stat.hockey.green_cards",
  "hockey.yellow_cards": "stat.hockey.yellow_cards",
  "hockey.red_cards": "stat.hockey.red_cards",
  "hockey.goals_pc": "stat.hockey.goals_pc",
  "hockey.goals_stroke": "stat.hockey.goals_stroke",
  "hockey.goals_en": "stat.hockey.goals_en",
  "hockey.strokes_taken": "stat.hockey.strokes_taken",
  "hockey.pc_taken": "stat.hockey.pc_taken",
  "hockey.so_attempts": "stat.hockey.so_attempts",
  "hockey.so_goals": "stat.hockey.so_goals",
  "hockey.so_saves": "stat.hockey.so_saves",
  "hockey.cards_served": "stat.hockey.cards_served",
  "hockey.potm_awards": AWARD_KEY.potm,
};

const CARD_COLOR_KEY: Record<string, MessageKey> = {
  yellow: "cardColor.yellow", red: "cardColor.red",
  second_yellow: "cardColor.second_yellow",
};
// Football's 13 CardReason members plus cricket's innings-close / retire reasons.
const REASON_KEY: Record<string, MessageKey> = {
  delaying_restart: "reason.delaying_restart",
  denying_goal_by_handball: "reason.denying_goal_by_handball",
  denying_obvious_goalscoring_opportunity: "reason.denying_obvious_goalscoring_opportunity",
  dissent: "reason.dissent",
  entering_or_leaving_without_permission: "reason.entering_or_leaving_without_permission",
  failure_to_respect_distance: "reason.failure_to_respect_distance",
  offensive_language: "reason.offensive_language",
  persistent_offences: "reason.persistent_offences",
  second_caution: "reason.second_caution",
  serious_foul_play: "reason.serious_foul_play",
  spitting: "reason.spitting",
  unsporting_behaviour: "reason.unsporting_behaviour",
  violent_conduct: "reason.violent_conduct",
  all_out: "reason.all_out", overs_complete: "reason.overs_complete",
  target_reached: "reason.target_reached", forfeited: "reason.forfeited",
  hurt: "reason.hurt", out: "reason.out", time: "reason.time",
  weather: "reason.weather", other: "reason.other",
};
// ET_H1/ET_H2 arrive from `football.period` payloads. They were absent here
// until #427's second pass, because `event-copy.ts` carried its own PERIOD_LABEL
// table and nothing forced the two to agree — the exact drift a single
// vocabulary exists to prevent.
const PHASE_KEY: Record<string, MessageKey> = {
  start: "matchPhase.start", end: "matchPhase.end",
  HT: "matchPhase.HT", FT: "matchPhase.FT",
  ET_H1: "matchPhase.ET_H1", ET_HT: "matchPhase.ET_HT",
  ET_H2: "matchPhase.ET_H2", ET_FT: "matchPhase.ET_FT",
};
// Penalty / shoot-out outcomes and cricket's review outcomes share the field.
const OUTCOME_KEY: Record<string, MessageKey> = {
  scored: "outcome.scored", missed: "outcome.missed", saved: "outcome.saved",
  post: "outcome.post", upheld: "outcome.upheld",
  struck_down: "outcome.struck_down", umpires_call: "outcome.umpires_call",
};
// `kind` beyond the dismissal and extra vocabularies already mapped above:
// tennis point kinds and interruption kinds, cricket breaks and powerplays.
const KIND_KEY: Record<string, MessageKey> = {
  ace: "kind.ace", double_fault: "kind.double_fault", winner: "kind.winner",
  ue: "kind.ue", medical: "kind.medical", toilet: "kind.toilet",
  heat: "kind.heat", other: "kind.other", rain: "kind.rain",
  light: "kind.light", player: "kind.player", umpire: "kind.umpire",
  batting: "kind.batting", bowling: "kind.bowling", mandatory: "kind.mandatory",
  hitballtwice: "kind.hitballtwice",
};
const TOSS_KEY: Record<string, MessageKey> = {
  bat: "toss.bat", bowl: "toss.bowl",
};
const METHOD_KEY: Record<string, MessageKey> = {
  checkmate: "method.checkmate", resign: "method.resign", time: "method.time",
  stalemate: "method.stalemate", agreement: "method.agreement",
  insufficient: "method.insufficient", adjudication: "method.adjudication",
  forfeit: "method.forfeit", double_forfeit: "method.double_forfeit",
  repetition: "method.repetition", fifty_move: "method.fifty_move",
  dead_position: "method.dead_position", illegal_move: "method.illegal_move",
};
const SANCTION_KEY: Record<string, MessageKey> = {
  warning: "sanction.warning", penalty: "sanction.penalty",
  point_penalty: "sanction.point_penalty", game_penalty: "sanction.game_penalty",
  default: "sanction.default", expulsion: "sanction.expulsion",
  disqualification: "sanction.disqualification",
};
const COURT_KEY: Record<string, MessageKey> = {
  deuce: "court.deuce", ad: "court.ad",
};

/**
 * Enum field name → the vocabularies that can label its members. A field maps
 * to SEVERAL maps where an existing closed enum already covers part of it:
 * cricket's `kind` spans dismissals (WICKET_KEY), extras (EXTRA_KEY) and the
 * break/powerplay vocabulary (KIND_KEY), and re-keying those would duplicate
 * copy that already ships in four locales.
 */
export const ENUM_VOCAB: Record<string, readonly Record<string, MessageKey>[]> = {
  color: [CARD_COLOR_KEY],
  reason: [REASON_KEY],
  phase: [PHASE_KEY],
  outcome: [OUTCOME_KEY],
  kind: [WICKET_KEY, EXTRA_KEY, KIND_KEY],
  elected: [TOSS_KEY],
  method: [METHOD_KEY],
  level: [SANCTION_KEY],
  receiverSide: [COURT_KEY],
};

/**
 * Engine refusal copy. `EngineError.message` is serialised into the /api/v1
 * error envelope and the scoring surfaces render it verbatim
 * (`device-score-pad.tsx`, `fixture-console.tsx` both do
 * `setError(err.message)`), so without this map an engine string reaches the
 * scorer in English on every locale. Typed by `EngineErrorCode`, so adding a
 * code to the engine fails this file's typecheck until copy exists.
 */
export const ENGINE_ERROR_KEY: Record<EngineErrorCode, MessageKey> = {
  INVALID_EVENT: "engineError.INVALID_EVENT",
  WRONG_PHASE: "engineError.WRONG_PHASE",
  ALREADY_DECIDED: "engineError.ALREADY_DECIDED",
  LINEUP_INVALID: "engineError.LINEUP_INVALID",
  CONFIG_INVALID: "engineError.CONFIG_INVALID",
  SEQ_CONFLICT: "engineError.SEQ_CONFLICT",
  STAGE_NOT_READY: "engineError.STAGE_NOT_READY",
  SCHEDULE_CONFLICT: "engineError.SCHEDULE_CONFLICT",
  DRAW_NOT_ALLOWED: "engineError.DRAW_NOT_ALLOWED",
  QUALIFICATION_INVALID: "engineError.QUALIFICATION_INVALID",
  ELIGIBILITY: "engineError.ELIGIBILITY",
  MODULE_NOT_FOUND: "engineError.MODULE_NOT_FOUND",
  MODULE_DUPLICATE: "engineError.MODULE_DUPLICATE",
  NON_MONOTONIC_TIME: "engineError.NON_MONOTONIC_TIME",
  UNKNOWN_PHASE: "engineError.UNKNOWN_PHASE",
  EXPEDITE_WRONG_WINNER: "engineError.EXPEDITE_WRONG_WINNER",
  SUB_WINDOW_EXCEEDED: "engineError.SUB_WINDOW_EXCEEDED",
};

/** Bound translator: client `useMsg()` or server `(k)=>msgFor(locale,k)`. */
export type MsgFn = (key: MessageKey) => string;

const title = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
/** "second_yellow" → "Second yellow" */
const humanize = (s: string) => title(s.replace(/_/g, " "));
/** "volleyball.set.summary" → "Set summary" */
const prettify = (type: string) =>
  humanize(type.split(".").slice(1).join(" ").trim() || type);

export const wicketLabel = (k: string, m: MsgFn): string =>
  k in WICKET_KEY ? m(WICKET_KEY[k as WicketKind]) : title(k);
export const extraLabel = (k: string, m: MsgFn): string =>
  k in EXTRA_KEY ? m(EXTRA_KEY[k as ExtraKind]) : title(k);
export const sportLabel = (k: string, m: MsgFn): string =>
  k in SPORT_KEY ? m(SPORT_KEY[k as SportKey]) : title(k);

/** Localized palette-swatch name for a stored hex; null when hex isn't a swatch. */
export function swatchLabel(hex: string | null | undefined, m: MsgFn): string | null {
  const name = swatchName(hex);
  if (!name) return null;
  return name in SWATCH_KEY ? m(SWATCH_KEY[name]) : name;
}

/** Localized name for a ledger event type, e.g. "tabletennis.expedite.start". */
export const eventLabel = (type: string, m: MsgFn): string =>
  type in EVENT_KEY ? m(EVENT_KEY[type]) : prettify(type);

/**
 * Localized name for an enum member, disambiguated by the payload field it sits
 * on — `kind.other` (an interruption) and `reason.other` (a retirement) are
 * different words in three of the four locales.
 */
export const enumLabel = (field: string, value: string, m: MsgFn): string => {
  for (const map of ENUM_VOCAB[field] ?? []) if (value in map) return m(map[value]);
  return humanize(value);
};

/**
 * Localized noun for a position segment, keyed by the engine's stable `key`.
 * `engineLabel` is that segment's own `label` — the engine's English, used
 * only for a key this app has no copy for yet, which is strictly better than
 * a humanized token ("Frame" beats "Frame" only by accident; "Half inning"
 * would lose to a real one).
 */
export const positionLabel = (key: string, m: MsgFn, engineLabel?: string): string =>
  key in POSITION_KEY ? m(POSITION_KEY[key]) : (engineLabel ?? humanize(key));

/**
 * Localized label for one player-stat row, scoped by sport (see
 * `PLAYER_STAT_KEY`). `engineLabel` is the module's own declared English, used
 * only for a row this app has no copy for yet: a sport can ship a metric a
 * release before its dictionary entry lands, and the engine's word beats a
 * humanized token ("PIM" survives, "Pim" would not).
 */
export const playerStatLabel = (
  sportKey: string, statKey: string, m: MsgFn, engineLabel?: string,
): string => {
  const key = `${sportKey}.${statKey}`;
  return key in PLAYER_STAT_KEY ? m(PLAYER_STAT_KEY[key]) : (engineLabel ?? humanize(statKey));
};

/** Localized name for a match award (`core.award`'s payload `key`), or null. */
export const awardLabel = (key: string, m: MsgFn): string | null =>
  key in AWARD_KEY ? m(AWARD_KEY[key]) : null;

/** Localized copy for an engine refusal; null when the code isn't an engine one. */
export const engineErrorLabel = (code: string, m: MsgFn): string | null =>
  code in ENGINE_ERROR_KEY ? m(ENGINE_ERROR_KEY[code as EngineErrorCode]) : null;

/**
 * What a scoring surface should show when a write is refused. An engine code
 * wins, because its `message` is the engine's own English and is rendered
 * verbatim otherwise; anything else keeps the raw message (HTTP/auth failures
 * already carry localized or user-authored text), and an empty one falls back.
 */
export function scoringErrorText(
  code: string | null | undefined,
  rawMessage: string | null | undefined,
  m: MsgFn,
  fallback: MessageKey,
): string {
  const engine = code ? engineErrorLabel(code, m) : null;
  return engine ?? (rawMessage || m(fallback));
}

/** Every MessageKey this module can emit — used by the exhaustiveness test. */
export const SCORING_VOCAB_KEYS: readonly MessageKey[] = [
  ...Object.values(WICKET_KEY), ...Object.values(EXTRA_KEY),
  ...Object.values(SPORT_KEY), ...Object.values(SWATCH_KEY),
  ...Object.values(EVENT_KEY), ...Object.values(ENGINE_ERROR_KEY),
  ...Object.values(POSITION_KEY), ...Object.values(PLAYER_STAT_KEY),
  ...Object.values(AWARD_KEY),
  ...Object.values(ENUM_VOCAB).flatMap((maps) => maps.flatMap((m) => Object.values(m))),
];
