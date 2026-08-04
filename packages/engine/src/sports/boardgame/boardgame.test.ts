// Board-game goldens + conformance — spec 04 §6, PROMPT-07.
import { describe, expect, it } from "vitest";
import { foldMatch, type CoreEv, type EventEnvelope } from "../../core/events.ts";
import type { LineupPair, StageCtx } from "../../core/types.ts";
import { aggregatePlayerStats } from "../../stats/stats.ts";
import { conformanceSuite, defaultLineupPair, makeEnvelope } from "../../testkit/index.ts";
import { boardgame, BOARDGAME_TIEBREAKERS, type BoardgameState } from "./boardgame.ts";

// W4a (#425) §3.3 — every fold below is PAD-SHAPED: it is building a stream
// event by event, which is the write path. `strictFromSeq: 0` marks the whole
// stream new and is therefore exactly the pre-seam behaviour. Only a real READ
// path (apps/web fold.ts) and the cfg-replay property pass no options.
const STRICT_ALL = { strictFromSeq: 0 } as const;

const lineups: LineupPair = defaultLineupPair(boardgame.positions); // entrants H / A
const cfg = boardgame.configSchema.parse({});
const league: StageCtx = { kind: "league" };

function stream(...specs: Array<[type: string, payload?: unknown]>): EventEnvelope[] {
  return specs.map(([type, payload], i) => makeEnvelope(i, { type, payload: payload ?? {} }));
}
function fold(events: EventEnvelope[], config = cfg): BoardgameState {
  return foldMatch(boardgame, config, lineups, events, STRICT_ALL) as BoardgameState;
}
const asEv = (event: EventEnvelope) => event as EventEnvelope<CoreEv>;

describe("boardgame golden: decisive game (White wins)", () => {
  const state = fold(stream(["core.start"], ["boardgame.result", { winner: "H", method: "checkmate" }]));

  it("decides for the winner and displays points, not half-points", () => {
    expect(state.outcome).toEqual({ kind: "win", winner: "H", loser: "A", method: "checkmate" });
    expect(boardgame.summary(state).headline).toBe("1 — 0");
    expect(boardgame.summary(state).detail).toMatchObject({ method: "checkmate", colorOfHome: "W" });
  });

  it("pays win/loss as integer half-points with colour + win metrics", () => {
    const [home, away] = boardgame.standingsDelta(state.outcome!, cfg, league, state);
    expect(home).toMatchObject({ won: 1, points: 2, metrics: { wins: 1, white: 1, black: 0 } });
    expect(away).toMatchObject({ lost: 1, points: 0, metrics: { wins: 0, white: 0, black: 1 } });
    // Half-point integers only — never a 0.5 float (PROMPT-07 acceptance).
    expect(Number.isInteger(home.points)).toBe(true);
    expect(Number.isInteger(away.points)).toBe(true);
  });
});

describe("boardgame golden: draw (½-½)", () => {
  const state = fold(stream(["core.start"], ["boardgame.result", { winner: null, method: "agreement" }]));

  it("splits a half-point (stored as 1) to each side", () => {
    expect(state.outcome).toEqual({ kind: "draw" });
    expect(boardgame.summary(state).headline).toBe("½ — ½");
    const [home, away] = boardgame.standingsDelta(state.outcome!, cfg, league, state);
    expect([home.points, away.points]).toEqual([1, 1]);
    expect(home).toMatchObject({ drawn: 1, metrics: { wins: 0, white: 1, black: 0 } });
    expect(away).toMatchObject({ drawn: 1, metrics: { wins: 0, white: 0, black: 1 } });
    expect(home.points + away.points).toBe(2);
  });
});

describe("boardgame golden: forfeit + double forfeit", () => {
  it("scores a forfeit like a win but excludes it from colour history", () => {
    const state = fold(stream(["core.start"], ["core.forfeit", { by: "A", reason: "no-show" }]));
    expect(state.outcome).toMatchObject({ kind: "win", winner: "H", method: "forfeit" });
    const [home, away] = boardgame.standingsDelta(state.outcome!, cfg, league, state);
    expect(home).toMatchObject({ won: 1, points: 2, metrics: { wins: 1, white: 0, black: 0 } });
    expect(away.metrics).toMatchObject({ white: 0, black: 0 }); // colour excluded
  });

  it("maps a double forfeit to a 0-0 no-result", () => {
    const state = fold(
      stream(["core.start"], ["boardgame.result", { winner: null, method: "double_forfeit" }]),
    );
    expect(state.outcome).toEqual({ kind: "no_result" });
    const [home, away] = boardgame.standingsDelta(state.outcome!, cfg, league, state);
    expect([home.points, away.points]).toEqual([0, 0]);
    expect(home.points + away.points).toBe(0); // inside declaredPointsSets
  });
});

describe("boardgame contract declarations", () => {
  it("always allows draws, even in knockout (KO ties resolve via mini-matches)", () => {
    for (const stage of ["league", "group", "swiss", "knockout", "double_elim"] as const) {
      expect(boardgame.supportsDraws(cfg, stage)).toBe(true);
    }
  });

  it("declares the FIDE cascade and {2, 0} point totals", () => {
    expect(boardgame.defaultTiebreakers).toEqual(BOARDGAME_TIEBREAKERS);
    expect(boardgame.defaultTiebreakers.slice(0, 4)).toEqual([
      "points",
      "buchholz_cut1",
      "buchholz",
      "sberger",
    ]);
    expect([...boardgame.declaredPointsSets(cfg)].sort((a, b) => a - b)).toEqual([0, 2]);
  });

  it("disables colour metadata when colours are off (go / generic 1-v-1)", () => {
    const noColor = boardgame.configSchema.parse({ colors: false });
    const state = fold(
      stream(["core.start"], ["boardgame.result", { winner: "H", method: "resign" }]),
      noColor,
    );
    expect(state.colorOfHome).toBeNull();
    const [home] = boardgame.standingsDelta(state.outcome!, noColor, league, state);
    expect(home.metrics).toMatchObject({ white: 0, black: 0 });
  });

  it("rejects a result before kickoff and finalize while undecided", () => {
    expect(() =>
      boardgame.apply(
        boardgame.init(cfg, lineups),
        makeEnvelope(0, { type: "boardgame.result", payload: { winner: "H" } }) as EventEnvelope<never>,
      ),
    ).toThrowError(expect.objectContaining({ code: "WRONG_PHASE" }));
    const live = fold(stream(["core.start"]));
    expect(() =>
      boardgame.apply(live, asEv(makeEnvelope(9, { type: "core.finalize", payload: {} }))),
    ).toThrowError(expect.objectContaining({ code: "WRONG_PHASE" }));
  });
});

// ---------------------------------------------------------------------------
// W4 domain audit — FIDE Laws of Chess (2023) Articles 5, 7, 8, 9.
// ---------------------------------------------------------------------------

describe("boardgame: how the game ended (FIDE Art. 5 + 9)", () => {
  // Art. 9.2/9.3/9.6 — the drawing methods a scoresheet distinguishes.
  const drawn = ["repetition", "fifty_move", "dead_position"] as const;
  for (const method of drawn) {
    it(`records a draw by ${method}`, () => {
      const state = fold(stream(["core.start"], ["boardgame.result", { winner: null, method }]));
      expect(state.method).toBe(method);
      expect(state.outcome).toEqual({ kind: "draw" });
      expect(boardgame.summary(state).detail).toMatchObject({ method });
    });
  }

  // Art. 7.5.5 — the loss an arbiter records for a repeated illegal move.
  it("records a loss by illegal move", () => {
    const state = fold(
      stream(["core.start"], ["boardgame.result", { winner: "H", method: "illegal_move" }]),
    );
    expect(state.outcome).toMatchObject({ kind: "win", winner: "H", method: "illegal_move" });
  });
});

describe("boardgame: the arbiter's pairing card", () => {
  const pairing = ["boardgame.pairing", { white: "A", homePerson: "H-p1", awayPerson: "A-p1", board: 3 }] as const;

  it("assigns White to the entrant the pairing names, not always the home side", () => {
    const state = fold(
      stream(["core.start"], [...pairing], ["boardgame.result", { winner: "H", method: "resign" }]),
    );
    expect(state.colorOfHome).toBe("B");
    const [home, away] = boardgame.standingsDelta(state.outcome!, cfg, league, state);
    expect(home.metrics).toMatchObject({ white: 0, black: 1 });
    expect(away.metrics).toMatchObject({ white: 1, black: 0 });
  });

  it("records who sat at the board and which board it was", () => {
    const state = fold(stream(["core.start"], [...pairing]));
    expect(state.players).toEqual({ home: "H-p1", away: "A-p1" });
    expect(state.board).toBe(3);
    expect(boardgame.summary(state).detail).toMatchObject({
      players: { home: "H-p1", away: "A-p1" },
      board: 3,
    });
  });

  it("rejects a colour assignment when the division plays without colours", () => {
    const noColor = boardgame.configSchema.parse({ colors: false });
    expect(() =>
      fold(stream(["core.start"], ["boardgame.pairing", { white: "A" }]), noColor),
    ).toThrowError(expect.objectContaining({ code: "INVALID_EVENT" }));
    // …but the players may still be recorded.
    const state = fold(
      stream(["core.start"], ["boardgame.pairing", { homePerson: "H-p1" }]),
      noColor,
    );
    expect(state.players).toEqual({ home: "H-p1" });
    expect(state.colorOfHome).toBeNull();
  });

  // W4 review item 6 — the house pattern for "which side did this" is `by` +
  // `person`, and the pairing card uses `homePerson`/`awayPerson` instead.
  // Deliberate, and this is the reason: the card is ONE arbiter record of a
  // MEETING, and `white` and `board` are properties of the pairing, not of a
  // side. Splitting it into two `by`+`person` events would either orphan those
  // two facts or duplicate them onto both halves — and two copies of "who had
  // White" can disagree, which is a contradiction the current shape cannot
  // express. See DOMAIN.md.
  it("holds both seats, the colour and the board number in ONE atomic record", () => {
    const state = fold(stream(["core.start"], [...pairing]));
    expect(state.players).toEqual({ home: "H-p1", away: "A-p1" });
    expect(state.colorOfHome).toBe("B"); // `white: "A"` — a fact about the PAIR
    expect(state.board).toBe(3);
  });

  it("has no per-side pairing branch — `by` + `person` is not accepted here", () => {
    // If this ever starts parsing, the atomic card has grown a second, partial
    // form and the two can disagree about White.
    expect(() =>
      fold(stream(["core.start"], ["boardgame.pairing", { by: "H", person: "H-p1" }])),
    ).toThrowError(expect.objectContaining({ code: "INVALID_EVENT" }));
  });

  it("rejects an empty pairing card and one after the game is over", () => {
    expect(() => fold(stream(["core.start"], ["boardgame.pairing", {}]))).toThrowError(
      expect.objectContaining({ code: "INVALID_EVENT" }),
    );
    const decided = fold(stream(["core.start"], ["boardgame.result", { winner: "H" }]));
    expect(() =>
      boardgame.apply(
        decided,
        makeEnvelope(9, { type: "boardgame.pairing", payload: { board: 1 } }) as EventEnvelope<never>,
      ),
    ).toThrowError(expect.objectContaining({ code: "WRONG_PHASE" }));
  });
});

describe("boardgame: game length and the winning player", () => {
  it("records the move count the scoresheet finished on (Art. 8.1)", () => {
    const state = fold(
      stream(["core.start"], ["boardgame.result", { winner: "H", method: "checkmate", moves: 41 }]),
    );
    expect(state.moves).toBe(41);
    expect(boardgame.summary(state).detail).toMatchObject({ moves: 41 });
  });

  it("credits the player who won the board in a team match", () => {
    const state = fold(
      stream(["core.start"], ["boardgame.result", { winner: "H", winnerPerson: "H-p1" }]),
    );
    expect(state.winnerPerson).toBe("H-p1");
    expect(boardgame.summary(state).detail).toMatchObject({ winnerPerson: "H-p1" });
  });

  it("rejects a winning player on a drawn game", () => {
    expect(() =>
      fold(stream(["core.start"], ["boardgame.result", { winner: null, winnerPerson: "H-p1" }])),
    ).toThrowError(expect.objectContaining({ code: "INVALID_EVENT" }));
  });

  it("folds person credit into a games/wins leaderboard", () => {
    const events = stream(
      ["core.start"],
      ["boardgame.pairing", { homePerson: "H-p1", awayPerson: "A-p1" }],
      ["boardgame.result", { winner: "H", method: "checkmate", winnerPerson: "H-p1" }],
    );
    expect(aggregatePlayerStats(events, boardgame.playerStats!)).toEqual([
      { personId: "A-p1", stats: { games: 1 } },
      { personId: "H-p1", stats: { games: 1, wins: 1 } },
    ]);
  });
});

describe("boardgame: event union stays unambiguous", () => {
  it("parses each branch as itself and rejects an empty payload", () => {
    expect(boardgame.eventSchema.parse({ winner: null, method: "agreement" })).toEqual({
      winner: null,
      method: "agreement",
    });
    expect(boardgame.eventSchema.parse({ white: "A" })).toEqual({ white: "A" });
    expect(boardgame.eventSchema.safeParse({}).success).toBe(false);
  });

  it("folds a pairing payload as a pairing and a result payload as a result", () => {
    const paired = fold(stream(["core.start"], ["boardgame.pairing", { white: "A" }]));
    expect(paired.phase).toBe("live");
    expect(paired.outcome).toBeNull();
    const decided = fold(stream(["core.start"], ["boardgame.result", { winner: null }]));
    expect(decided.outcome).toEqual({ kind: "draw" });
    expect(decided.colorOfHome).toBe("W");
  });
});

// W4a §5.5 — the time control is metadata, but INCREMENT and DELAY are two
// different clocks and a pad that conflates them counts down wrongly:
// increment BANKS unused time, delay does not. They are independent knobs, so
// each of the four combinations has to survive a parse.
describe("boardgame: increment and delay are independent clock facts", () => {
  const clockOf = (clock: unknown) => boardgame.configSchema.parse({ clock }).clock;

  it("round-trips a delay, and does not silently drop it", () => {
    // z.object STRIPS unknown keys, so an unmodelled `delay` parses "fine" and
    // vanishes — the assertion has to be on the round-tripped value.
    expect(clockOf({ base: 900, increment: 10, delay: 5 })).toEqual({
      base: 900,
      increment: 10,
      delay: 5,
    });
  });

  it("accepts a delay-only control (US delay: nothing is banked)", () => {
    const clock = clockOf({ base: 300, delay: 3 });
    expect(clock).toEqual({ base: 300, delay: 3 });
    expect(clock?.increment).toBeUndefined();
  });

  // Green in both states — `{base, increment}` parsed before the widening too.
  // Kept as the symmetry guard opposite the delay-only case above.
  it("accepts an increment-only control (Fischer: unused time is banked)", () => {
    const clock = clockOf({ base: 180, increment: 2 });
    expect(clock).toEqual({ base: 180, increment: 2 });
    expect(clock?.delay).toBeUndefined();
  });

  it("accepts a control with neither (sudden death)", () => {
    expect(clockOf({ base: 5400 })).toEqual({ base: 5400 });
  });

  it("refuses a negative or fractional delay", () => {
    // `increment` is supplied so the ONLY thing that can reject these is the
    // delay itself — otherwise a stripped `delay` plus a missing `increment`
    // fails the parse and the test passes without modelling anything.
    const bad = (delay: number) =>
      boardgame.configSchema.safeParse({ clock: { base: 300, increment: 0, delay } }).success;
    expect(bad(-1)).toBe(false);
    expect(bad(1.5)).toBe(false);
  });

  // The additive proof at cfg level (§8): cfg is serialised into the frozen
  // golden state strings, so a DEFAULT on any clock field would re-baseline
  // all eleven goldens. This passed before the change and must keep passing.
  it("leaves a cfg with no clock byte-identical", () => {
    const parsed = boardgame.configSchema.parse({});
    expect(Object.keys(parsed).sort()).toEqual(["byeScore", "colors", "scoring", "variant"]);
    expect(JSON.stringify(parsed)).toBe(
      JSON.stringify({
        scoring: { win: 2, draw: 1, loss: 0 },
        colors: true,
        byeScore: 2,
        variant: "classical",
      }),
    );
  });
});

// PROMPT-07 acceptance — conformance green.
conformanceSuite(boardgame);
