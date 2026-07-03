// Board-game goldens + conformance — spec 04 §6, PROMPT-07.
import { describe, expect, it } from "vitest";
import { foldMatch, type CoreEv, type EventEnvelope } from "../../core/events.ts";
import type { LineupPair, StageCtx } from "../../core/types.ts";
import { conformanceSuite, defaultLineupPair, makeEnvelope } from "../../testkit/index.ts";
import { boardgame, BOARDGAME_TIEBREAKERS, type BoardgameState } from "./boardgame.ts";

const lineups: LineupPair = defaultLineupPair(boardgame.positions); // entrants H / A
const cfg = boardgame.configSchema.parse({});
const league: StageCtx = { kind: "league" };

function stream(...specs: Array<[type: string, payload?: unknown]>): EventEnvelope[] {
  return specs.map(([type, payload], i) => makeEnvelope(i, { type, payload: payload ?? {} }));
}
function fold(events: EventEnvelope[], config = cfg): BoardgameState {
  return foldMatch(boardgame, config, lineups, events) as BoardgameState;
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

// PROMPT-07 acceptance — conformance green.
conformanceSuite(boardgame);
