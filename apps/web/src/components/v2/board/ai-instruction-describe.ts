// W5 (#400) Task 6 — reading a compiled hard constraint back to the organiser.
//
// The preview card is a receipt: the organiser typed a sentence, and before a
// credit is spent we show them the rules the referee will actually check. This
// module is the translation layer between the engine's `HardConstraint` union
// and that sentence. It is deliberately React-free so the six readings can be
// unit-tested without a DOM, and so the joint console (Task 7) reads the same
// words from the same place.
//
// TWO RULES HOLD THIS FILE TOGETHER:
//
// 1. `describeHardConstraint` is an exhaustive switch with a `never` default.
//    A seventh `HardConstraint` variant must fail to COMPILE, not render a
//    blank ledger row — the same discipline `RULE_BY_REASON` uses for
//    `ConflictReason`. A blank row in a card whose whole job is "here is what
//    will be enforced" is worse than no card at all.
//
// 2. Every word comes from the dictionary via `msg`/`plural`. Nothing here
//    concatenates an English sentence: an organiser reading the French app must
//    not meet English rules on the one screen that tells them what they are
//    paying for.
//
// The TOKENS are the exception, and on purpose. `REST`, `MAX/DAY`, `≥ TIME` …
// are the engine's own six constraint kinds rendered as a code, in the same
// register as the `CAP` rule chips and the `FN`/`JR` markers already on this
// board — a short stable vocabulary that means the same thing in every locale
// and comes back verbatim when a conflict later cites the rule. Translating
// them would give the same rule four names. Rule CODES (H2/H4/H8) are NOT used
// here: every compiled instruction rule verifies as H8, so that chip would
// print the same character on every row and say nothing.
//
// That defence only holds for a SYMBOL or an ABBREVIATION. #400 Task 6b: the
// first four tokens shipped as English words — `PER DAY`, `WEEKDAY`,
// `NOT BEFORE`, `NOT AFTER` — which the `CAP`/`FN`/`JR` precedent does not
// cover, and a French organiser met four of them on the signature element of
// the screen that tells them what they are paying for. The forms below are the
// shortest stable codes the six kinds can carry: a comparison glyph for the two
// that were phrases, and single abbreviations for the rest — a code to be
// learned once, not an English sentence fragment to be read. Adding a seventh
// kind means picking a token that survives the same reading.
import type { ConstraintScope, HardConstraint, FixtureSelector } from "@seazn/engine/scheduling";
import type { MessageKey } from "@/lib/messages";

export type Msg = (key: MessageKey, vars?: Record<string, string | number>) => string;
export type Plural = (key: string, count: number, vars?: Record<string, string | number>) => string;

/** Resolve a narrowed scope to a name the organiser recognises — a division
 *  title, a pool, an entrant. Returns null when the caller does not know it:
 *  the reading then says the rule is narrowed WITHOUT naming anything, because
 *  a guessed division name on a rules receipt is worse than an honest gap. */
export type NameLookup = (scope: ConstraintScope) => string | null;

/**
 * Everything a reading needs. An object rather than positional arguments
 * because two of the four are not optional decoration: `plural` is what keeps
 * "at most 1 match a day" from reading "1 matches", and `locale` is what keeps
 * a date out of the server runtime's default format (see `lib/day-label.ts`,
 * which pins the same thing for the board's day tabs).
 */
export interface DescribeCtx {
  msg: Msg;
  plural: Plural;
  names: NameLookup;
  /** BCP-47. Defaults to en-GB — plain "en" formats US-style ("Aug 7, 2026"). */
  locale?: string;
}

const DEFAULT_LOCALE = "en-GB";

/** A stable, locale-independent code for the ledger spine. See the file header
 *  for why this one string is not translated. */
export function constraintToken(c: HardConstraint): string {
  switch (c.type) {
    case "min_rest_minutes":
      return "REST";
    case "max_fixtures_per_day":
      return "MAX/DAY";
    case "fixture_on_weekday":
      return "DAY";
    case "fixture_on_date":
      return "DATE";
    case "not_before":
      return "≥ TIME";
    case "not_after":
      return "≤ TIME";
    default: {
      const _never: never = c;
      return _never;
    }
  }
}

/** Sunday-first reference week, so a `WeekdayCode` becomes a localized weekday
 *  name through Intl rather than through seven dictionary keys per locale that
 *  would then have to be kept in step with the engine's enum. */
const WEEKDAY_ANCHOR: Record<string, number> = {
  SUN: 7,
  MON: 8,
  TUE: 9,
  WED: 10,
  THU: 11,
  FRI: 12,
  SAT: 13,
};

function weekdayName(code: string, locale: string): string {
  const day = WEEKDAY_ANCHOR[code];
  if (day === undefined) return code;
  return new Date(Date.UTC(2024, 0, day, 12)).toLocaleDateString(locale, {
    weekday: "long",
    timeZone: "UTC",
  });
}

/** YYYY-MM-DD → "7 Aug 2026". Noon-anchored so the label never slides a day in
 *  a negative-offset runtime; the value is a wall-clock date in the org zone,
 *  not an instant. */
function dateLabel(ymd: string, locale: string): string {
  const d = new Date(`${ymd}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return ymd;
  return d.toLocaleDateString(locale, {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** What the rule points at. An `id` selector names no id: a UUID on a receipt
 *  tells the organiser nothing and looks like a leak. */
function describeSelector(sel: FixtureSelector, msg: Msg): string {
  switch (sel.kind) {
    case "terminal":
      return msg("board.ai.preview.selector.terminal");
    case "ext_key":
      return msg("board.ai.preview.selector.extKey", { key: sel.extKey });
    case "id":
      return msg("board.ai.preview.selector.match");
    default: {
      const _never: never = sel;
      return _never;
    }
  }
}

/**
 * The clause that keeps a narrowed rule from reading as a board-wide one.
 * `describeHardConstraint` appends it itself, so the reading is one string with
 * one renderer and the name can never be printed twice.
 *
 * NOT exported (#400 Task 6b). It shipped exported for a caller that wanted to
 * tell "this rule is scoped" without re-parsing the sentence, and no such
 * caller exists — an exported seam with no consumer is an invitation to build
 * the second renderer this function exists to prevent. Export it again when
 * something actually needs it.
 */
function constraintScopeClause(
  scope: ConstraintScope,
  msg: Msg,
  names: NameLookup,
): string | null {
  if (scope.kind === "competition") return null;
  const name = names(scope);
  if (!name) return msg("board.ai.preview.scope.partial");
  // A division or a pool is a place on the board; an entrant or a person is
  // somebody the rule follows around. Same clause would misread one of them.
  return scope.kind === "division" || scope.kind === "pool"
    ? msg("board.ai.preview.scope.in", { name })
    : msg("board.ai.preview.scope.for", { name });
}

/** The plain-English (or -Spanish, -French, -Dutch) reading of one compiled
 *  rule, scope clause included. */
export function describeHardConstraint(c: HardConstraint, ctx: DescribeCtx): string {
  const { msg, plural, names } = ctx;
  const locale = ctx.locale ?? DEFAULT_LOCALE;

  let rule: string;
  switch (c.type) {
    case "min_rest_minutes":
      // Three readings, not one: a feeder gap is about a match waiting on the
      // match that feeds it, and a player's rest is about a person. Collapsing
      // them would tell an organiser their players get a break when nothing
      // enforces that.
      rule = msg(`board.ai.preview.rule.rest.${c.rest_scope}` as MessageKey, {
        minutes: c.minutes,
      });
      break;
    case "max_fixtures_per_day":
      rule = plural("board.ai.preview.rule.perDay", c.count, { count: c.count });
      break;
    case "fixture_on_weekday":
      rule = msg("board.ai.preview.rule.weekday", {
        what: describeSelector(c.selector, msg),
        weekday: weekdayName(c.weekday, locale),
      });
      break;
    case "fixture_on_date":
      rule = msg("board.ai.preview.rule.date", {
        what: describeSelector(c.selector, msg),
        date: dateLabel(c.date, locale),
      });
      break;
    case "not_before":
      rule = msg("board.ai.preview.rule.notBefore", { time: c.time });
      break;
    case "not_after":
      rule = msg("board.ai.preview.rule.notAfter", { time: c.time });
      break;
    default: {
      // Exhaustiveness guard — a seventh HardConstraint variant is a compile
      // error here, which is the point.
      const _never: never = c;
      return _never;
    }
  }

  const scope = constraintScopeClause(c.scope, msg, names);
  return scope ? msg("board.ai.preview.scopedRule", { rule, scope }) : rule;
}
