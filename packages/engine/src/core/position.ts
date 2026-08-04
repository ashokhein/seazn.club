// Match position — W4a (#425) T6b. ONE cross-sport axis answering "where in
// the match are we": set 2, game 4, 30–15 · over 12.3 · move 31 · P2 12:41.
//
// ---------------------------------------------------------------------------
// WHY THIS IS A READ-SIDE PROJECTION AND NOT AN EVENT PAYLOAD
// ---------------------------------------------------------------------------
//
// A `MatchPosition` payload union — every stamped event carrying the set/game/
// over it happened in — was considered this wave and REJECTED. The governing
// rule is the one `at` is built on: **record only what the fold cannot derive.**
//
// Elapsed game time qualifies. The engine never reads a clock inside a fold
// (`core/time.ts` header, property 1), so an unstamped elapsed is lost forever
// and `at` has to be recorded.
//
// Position does NOT qualify. "Set 2, game 4, 30–15" and "move 31" are functions
// of state the fold already computes. Recording them would invite eight of the
// eleven sports to denormalise their own fold onto the event, producing a
// recorded value and a derived value OF THE SAME TYPE that can silently
// disagree — the exact shape of a bug this codebase already shipped once
// (`DisciplineCard.entrantSide` carried the side whose score moved rather than
// the offender's, and stayed invisible until someone wrote the case where the
// two differ, `core/types.ts:38`).
//
// The asymmetry that settles it: a wrong recorded value is in the hash-chained
// ledger forever, and there is no scorer action that repairs it. A wrong
// projection is one deploy away from fixed.
//
// ---------------------------------------------------------------------------
// THE RETURN SHAPE: ORDERED SEGMENTS, NOT A DISPLAY STRING
// ---------------------------------------------------------------------------
//
// W8 renders ONE position chip across eleven sports without knowing which sport
// it holds. A plain string ("Set 2, Game 4, 30–15") would be the cheap answer
// and is lossy in three ways that all bite:
//
//  1. **It cannot be dropped.** A 375px scorebug shows "P2 · 12:41"; a match
//     report shows the full line. Segments can be truncated from the left; a
//     concatenated string cannot be un-concatenated.
//  2. **It cannot be localised.** Engine labels are English by construction
//     (`MetricSpec.label`, `PositionCatalog.groups[].name`). `key` is the
//     stable token W8 looks a dictionary up by; `label` is the fallback.
//  3. **It cannot be ordered.** W5/W6 need to sort two positions in one match.
//
// The opposite failure — a per-sport typed union (`{ kind: "tennis"; set; game }
// | { kind: "cricket"; innings; over }`) — is worse than a string: it forces the
// universal renderer to grow eleven branches, which is precisely "the renderer
// knows which sport it holds".
//
// So: an ordered list of `{ key, label?, value, ordinal? }`. `ScoreSummary` set
// the precedent (structured `perSide` a UI renders without knowing the sport);
// this drops that shape's denormalised `headline` for the reason above.
//
// NOTHING DERIVABLE IS MATERIALISED. There is no `line` field and no `ord`
// tuple: `formatPosition` and `comparePosition` are those, as functions, so
// there is exactly one source of truth per fact. Applying the axis's own rule
// to the axis.
import { z } from "zod";
import { EngineError } from "./errors.ts";
import { formatElapsed, type GameTime } from "./time.ts";

/**
 * One ordered component of a position.
 *
 * `key` — stable machine token, shared across sports where the concept is
 * shared (`set` means the same thing in tennis and volleyball). W8 renders
 * `scoring.position.<key>` from a dictionary; the engine writes no locale copy.
 *
 * `label` — English fallback, and ONLY where the value needs a noun to read.
 * `"2"` needs "Set"; `"P2"`, `"12:41"` and `"30–15"` name themselves, and
 * labelling them renders "Period P2". Optional for exactly that reason.
 *
 * `value` — display-ready, already in the sport's own notation ("12.3" overs,
 * "TB 5–3"). The renderer prints it verbatim.
 *
 * `ordinal` — the rank of this value WITHIN this segment, present only where
 * the state gives an exact monotone one. Absent is a claim: "two positions that
 * agree this far are indistinguishable to me", which `comparePosition` honours
 * by stopping. Tennis's point score is deliberately unranked — a deuce loop's
 * point count is not derivable from `GamePoints` — and inventing a rank there
 * would be a wrong sort nothing detects.
 *
 * Strict: a sport that wants to smuggle its own payload through the axis is the
 * denormalisation this file exists to refuse.
 */
export const PositionSegment = z.strictObject({
  key: z.string().min(1),
  label: z.string().min(1).optional(),
  value: z.string().min(1),
  ordinal: z.number().int().optional(),
});
export type PositionSegment = z.infer<typeof PositionSegment>;

/**
 * Where in the match we are, coarsest segment first.
 *
 * At least one segment: "no position" is `null` from `matchPositionOf`, never
 * an empty list, which renders as a blank chip that reads like a bug.
 */
export const MatchPosition = z.strictObject({
  segments: z.array(PositionSegment).min(1),
});
export type MatchPosition = z.infer<typeof MatchPosition>;

/** What `formatPosition` joins segments with. Not a separator a caller picks —
 *  W8 renders from segments and this is the plain-text path only. */
export const POSITION_SEPARATOR = " · ";

// ---------------------------------------------------------------------------
// Segment builders — the shared derivations, handed out BY REFERENCE.
//
// The phase-order contract (§7) is the precedent: `playPhases` was fixed three
// times because each fix left the next sport free to hand-roll its own copy, and
// it is now one exported function asserted by IDENTITY. Same lesson here — a
// sport builds its segments from these, never by hand, so "Set" is spelled one
// way and a clock is formatted one way across all eleven.
// ---------------------------------------------------------------------------

/**
 * A named value whose display notation is not its rank: cricket's over prints
 * "12.3" and ranks by 75 legal balls.
 */
export function labelledSegment(
  key: string,
  label: string,
  value: string,
  ordinal?: number,
): PositionSegment {
  return ordinal === undefined ? { key, label, value } : { key, label, value, ordinal };
}

/**
 * A numbered unit: set 2, game 4, innings 1, board 3.
 *
 * The number is both the display value and the rank, so the two cannot drift —
 * which is why this is not merely `labelledSegment` with the caller stringifying.
 */
export function unitSegment(key: string, label: string, n: number): PositionSegment {
  return labelledSegment(key, label, String(n), n);
}

/**
 * The named phase of a period sport, ranked by its index in the phase order the
 * module declares (`playPhases` — the SAME list the fold's monotonic guard and
 * every `compareGameTime` call use, §7 obligation 3).
 *
 * A phase absent from the order gets NO ordinal. Ranking it -1 would sort an
 * unrecognised phase before the opening whistle, which is the arbitrary sort
 * `compareGameTime` throws rather than perform.
 */
export function phaseSegment(phase: string, phaseOrder: readonly string[]): PositionSegment {
  const index = phaseOrder.indexOf(phase);
  return index === -1
    ? { key: "period", value: phase }
    : { key: "period", value: phase, ordinal: index };
}

/**
 * Elapsed seconds within the current phase, as the scoresheet prints them.
 *
 * Seconds are the rank, `formatElapsed` is the display — one function, so the
 * chip and the sort can never disagree about which of two stamps is later.
 */
export function clockSegment(elapsed: number): PositionSegment {
  return { key: "clock", value: formatElapsed(elapsed), ordinal: elapsed };
}

/**
 * A within-unit score line: "30–15", "21–19", "TB 5–3".
 *
 * `ordinal` is optional and means "points played". Supply it only where the
 * state gives it exactly (a rally-scored set: home + away). Omit it where it is
 * not derivable (tennis past deuce) rather than approximating.
 */
export function scoreSegment(key: string, line: string, ordinal?: number): PositionSegment {
  return ordinal === undefined ? { key, value: line } : { key, value: line, ordinal };
}

/**
 * THE rule for "which set / game / innings / board are we in", given how many
 * are COMPLETE and whether the match is still live.
 *
 * One function because the naive form is wrong in one specific way that every
 * sport would rediscover: `completed + 1` on a DECIDED match names a unit
 * nobody played. A best-of-three won 2–0 reads "Set 3"; a carrom match won on
 * board 5 reads "Board 6". The last position of a finished match has to be the
 * last position that actually happened, because that is the one every match
 * report prints.
 *
 * A match decided before anything completed still happened in unit 1 — a
 * walkover is not "set 0".
 */
export function currentUnit(completed: number, live: boolean): number {
  return live ? completed + 1 : Math.max(1, completed);
}

/**
 * `currentUnit` widened by the OTHER thing the state can prove: how many units
 * have STARTED. The rule for every sport that counts sets, games or innings.
 *
 * `live` alone is not enough, and the case that proves it is not a hand-written
 * one — the conformance suite's monotonicity property found it. A carrom match
 * ABANDONED during game 3 has two games complete and three started, so
 * `currentUnit` reports "Game 2": the position travels BACKWARDS at the final
 * event, and W6 sorts a timeline by exactly this.
 *
 * `started` alone is not enough either, in the opposite direction. These kernels
 * open a unit LAZILY — set-based on the first rally, cricket on the first ball —
 * so between units nothing is open, and `started` under-counts by one for a
 * match that is still running and certain to play the next one.
 *
 * The max of the two is right in both directions, and monotone: neither input
 * ever decreases. It never invents a unit for a match already decided, because
 * `currentUnit` stops at `completed` there and a decided match starts nothing.
 */
export function unitNumber(args: { started: number; completed: number; live: boolean }): number {
  return Math.max(args.started, currentUnit(args.completed, args.live));
}

/**
 * THE position derivation for a period sport — football and the period kernel
 * (hockey, ice hockey), which have different state types and so cannot share a
 * module member. They share this instead, and the conformance suite holds the
 * two to producing the same shape, because W8 draws ONE chip for both.
 *
 * `evidence` is every phase this state attests to, in any order and with holes:
 * the phase the fold is in, the phase the newest stamp names, the last phase
 * entered, and "SHOOTOUT" where one was reached. The LATEST by `phaseOrder`
 * wins.
 *
 * A MAX rather than "trust `state.phase`" for two reasons. It is monotone by
 * construction — position cannot travel backwards as a match folds, whatever
 * order the fields update in. And `state.phase` goes terminal ("done", "final",
 * "abandoned") at the final whistle, and those are markers rather than places:
 * they are absent from `playPhases` for that reason, so reporting one would
 * hand W6 an unorderable position for every finished fixture, when the honest
 * answer — the last phase actually played — is right there in the evidence.
 *
 * THE CLOCK IS ATTACHED ONLY WHEN THE STAMP NAMES THE PHASE THIS RESOLVED TO.
 * A period advances on an unstamped whistle and `asOf` then still names the one
 * before it; printing 44:59 beside "H2" asserts something false about where
 * play is. `state.phase` and `asOf.period` are both plain strings, so a producer
 * that reached for the wrong one compiles, folds and looks right — the
 * `DisciplineCard.entrantSide` shape, and the reason the conformance suite pins
 * the case where the two differ.
 */
export function periodClockPosition(args: {
  phaseOrder: readonly string[];
  evidence: readonly (string | undefined)[];
  asOf?: GameTime;
}): MatchPosition {
  const { phaseOrder, evidence, asOf } = args;
  let best = 0; // phaseOrder[0] — "pre" for every sport that declares one
  for (const candidate of evidence) {
    if (candidate === undefined) continue;
    const index = phaseOrder.indexOf(candidate);
    if (index > best) best = index;
  }
  const phase = phaseOrder[best] as string;
  const segments = [phaseSegment(phase, phaseOrder)];
  if (asOf !== undefined && asOf.period === phase) segments.push(clockSegment(asOf.elapsed));
  return { segments };
}

// ---------------------------------------------------------------------------
// Consumers
// ---------------------------------------------------------------------------

/**
 * Plain-text rendering — exports, api-v1 text, scoresheets. NOT the UI path:
 * W8 renders from `segments` so it can localise `key` and drop segments that do
 * not fit. This exists so the non-localised paths all print one format.
 */
export function formatPosition(position: MatchPosition): string {
  return position.segments
    .map((segment) => (segment.label === undefined ? segment.value : `${segment.label} ${segment.value}`))
    .join(POSITION_SEPARATOR);
}

/**
 * Order two positions from the SAME match. `-1 | 0 | 1`.
 *
 * Walks the common prefix. The first segment whose ordinals differ decides.
 *
 * `0` is returned, and is honest, in three cases: genuinely the same position;
 * one side runs out of segments (a period sport before its first stamped event
 * has a phase and no clock — less resolved, not earlier); and either side
 * cannot rank the segment they agree on so far.
 *
 * THROWS `INVALID_EVENT` when the two disagree about the SHAPE — comparing a
 * set against an innings. This follows `compareGameTime`, which throws
 * `UNKNOWN_PHASE` rather than sorting an unrecognised period: a silently
 * arbitrary order is a wrong answer that nothing downstream detects. It cannot
 * arise inside one match under one module; it arises when a caller mixes two
 * fixtures, and that caller wants to know.
 */
export function comparePosition(a: MatchPosition, b: MatchPosition): -1 | 0 | 1 {
  const depth = Math.min(a.segments.length, b.segments.length);
  for (let index = 0; index < depth; index += 1) {
    const left = a.segments[index] as PositionSegment;
    const right = b.segments[index] as PositionSegment;
    if (left.key !== right.key) {
      throw new EngineError(
        "INVALID_EVENT",
        `position segment ${index} is "${left.key}" on one side and "${right.key}" on the other — ` +
          `these positions are not from the same match`,
        { index, a: left.key, b: right.key },
      );
    }
    if (left.ordinal === undefined || right.ordinal === undefined) return 0;
    if (left.ordinal !== right.ordinal) return left.ordinal < right.ordinal ? -1 : 1;
  }
  return 0;
}

/**
 * The read-side half of the module contract, structurally — core learns no
 * `SportModule` (that type lives in `sport/module.ts` and imports core, so
 * naming it here would be a cycle).
 */
export interface PositionProjecting<State> {
  position?(state: State): MatchPosition;
}

/**
 * Project the position of a folded state, or `null` if this sport has none.
 *
 * **`null` means: fall back to `seq`.** That fallback lives HERE, at the one
 * call site, and not in eleven modules — the phase-order contract's lesson.
 * Eleven copies of one rule is eleven chances to diverge, and a module that
 * fabricates a position to fill the table (boardgame returning "Move 1" when
 * the move index lives on `BoardgameResult.moves`) is exactly the denormalised
 * second source of truth this axis refuses.
 *
 * The engine cannot build the fallback itself: `seq` is an envelope field and
 * nothing reaches a folded state, so the caller owns the substitution. What the
 * engine owes is that the "no position" answer is produced in one place and is
 * unambiguous.
 */
export function matchPositionOf<State>(
  module: PositionProjecting<State>,
  state: State,
): MatchPosition | null {
  return module.position === undefined ? null : module.position(state);
}
