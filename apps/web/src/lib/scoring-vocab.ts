// Locale-aware display labels for scoring domain vocab whose STORED form stays
// English (DB sport_key, event-ledger payload kinds, palette hex→name). Every
// vocab here is a closed enum, so each helper indexes a typed
// Record<Enum, MessageKey> map: the Record forces every member to be mapped, and
// the MessageKey value forces every key to exist in ui.json — both nets hold at
// compile time, and there are no dynamic key strings. Unknown runtime values
// (payloads are `string`) fall back to a humanized token, never throw.
import type { MessageKey } from "@/lib/messages";
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

/** Bound translator: client `useMsg()` or server `(k)=>msgFor(locale,k)`. */
export type MsgFn = (key: MessageKey) => string;

const title = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

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

/** Every MessageKey this module can emit — used by the exhaustiveness test. */
export const SCORING_VOCAB_KEYS: readonly MessageKey[] = [
  ...Object.values(WICKET_KEY), ...Object.values(EXTRA_KEY),
  ...Object.values(SPORT_KEY), ...Object.values(SWATCH_KEY),
];
