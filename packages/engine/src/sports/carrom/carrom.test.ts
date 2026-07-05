// Carrom goldens + conformance — engine/sports/carrom.md, PROMPT-16.
// ICF law citations (Laws 49, 52–57) refer to the ICF "Laws of Carrom";
// carrom.md §1–7 carries the verified text.
import { describe, expect, it } from "vitest";
import { EngineError } from "../../core/errors.ts";
import { foldMatch, type EventEnvelope } from "../../core/events.ts";
import type { LineupPair, StageCtx } from "../../core/types.ts";
import { conformanceSuite, defaultLineupPair, makeEnvelope } from "../../testkit/index.ts";
import { carrom, CARROM_TIEBREAKERS, type CarromState } from "./carrom.ts";

const lineups: LineupPair = defaultLineupPair(carrom.positions); // entrants H / A
const cfg = carrom.configSchema.parse({});
const league: StageCtx = { kind: "league" };

function stream(...specs: Array<[type: string, payload?: unknown]>): EventEnvelope[] {
  return specs.map(([type, payload], i) => makeEnvelope(i, { type, payload: payload ?? {} }));
}
function fold(events: EventEnvelope[], config = cfg): CarromState {
  return foldMatch(carrom, config, lineups, events) as CarromState;
}

// One board-summary spec: [winner, opponentCoinsLeft, queenTo].
type BoardSpec = [winner: string, coins: number, queenTo?: string | null];
function boards(...specs: BoardSpec[]): Array<[string, unknown]> {
  return specs.map(([winner, opponentCoinsLeft, queenTo]) => [
    "carrom.board.summary",
    { winner, opponentCoinsLeft, queenTo: queenTo ?? null },
  ]);
}

// ---------------------------------------------------------------------------
// Golden (a) — game won exactly at 25 via the queen bonus (Laws 52–54, 56a).
// ---------------------------------------------------------------------------
describe("carrom golden: game won exactly at 25 via queen bonus", () => {
  const state = fold(
    stream(["core.start"], ...boards(["H", 9], ["H", 9], ["H", 2], ["H", 2, "H"])),
  );

  it("banks 20 + 2 coins + queen 3 = 25 and closes the game", () => {
    const game = state.games[0]!;
    expect(game.score).toEqual({ home: 25, away: 0 });
    expect(game.winner).toBe("home");
    expect(game.boards[3]).toMatchObject({ points: 5, queenScored: true });
    expect(state.gamesWon).toEqual({ home: 1, away: 0 });
    expect(state.outcome).toBeNull(); // best-of-3: match still live
    expect(carrom.summary(state).headline).toBe("1 — 0");
  });
});

// ---------------------------------------------------------------------------
// Golden (b) — the queenCapAt boundary (Law 52(b)(i): 3 points up to and
// including 21; Law 54: no queen benefit once 22 is reached). The bonus is
// checked against the PRE-board score.
// ---------------------------------------------------------------------------
describe("carrom golden: queen cap boundary", () => {
  it("21 → queen still counts (21 + 1 coin + 3 = 25, game won)", () => {
    const state = fold(
      stream(["core.start"], ...boards(["H", 9], ["H", 9], ["H", 3], ["H", 1, "H"])),
    );
    const game = state.games[0]!;
    expect(game.score.home).toBe(25);
    expect(game.winner).toBe("home");
    expect(game.boards[3]).toMatchObject({ points: 4, queenScored: true });
  });

  it("22 → queen scores 0, coins only — the game continues", () => {
    const state = fold(
      stream(["core.start"], ...boards(["H", 9], ["H", 9], ["H", 4], ["H", 1, "H"])),
    );
    const game = state.games[0]!;
    expect(game.score.home).toBe(23); // 22 + 1 coin, no queen
    expect(game.winner).toBeNull();
    expect(game.boards[3]).toMatchObject({ points: 1, queenScored: false });
    expect(state.outcome).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Law 53(b)/(c) — a loser-covered queen scores for nobody under ICF; the
// queenFollowsBoard house rule credits the board winner instead.
// ---------------------------------------------------------------------------
describe("carrom: loser-covered queen (Law 53)", () => {
  const events = stream(["core.start"], ...boards(["H", 5, "A"]));

  it("ICF default: winner gets coins only", () => {
    const state = fold(events);
    expect(state.games[0]!.score.home).toBe(5);
    expect(state.games[0]!.boards[0]).toMatchObject({ points: 5, queenScored: false });
  });

  it("queenFollowsBoard: true credits the queen to the board winner", () => {
    const state = fold(events, carrom.configSchema.parse({ queenFollowsBoard: true }));
    expect(state.games[0]!.score.home).toBe(8);
    expect(state.games[0]!.boards[0]).toMatchObject({ points: 8, queenScored: true });
  });
});

// ---------------------------------------------------------------------------
// Golden (c) — 8-board game decided on points (Law 56a: leader after the
// eighth board wins).
// ---------------------------------------------------------------------------
describe("carrom golden: 8-board game decided on points", () => {
  const eight: BoardSpec[] = [
    ["H", 3], ["A", 2], ["H", 3], ["A", 2],
    ["H", 3], ["A", 2], ["H", 3], ["A", 2],
  ];
  const state = fold(stream(["core.start"], ...boards(...eight)));

  it("closes the game for the leader 12–8 after board 8", () => {
    const game = state.games[0]!;
    expect(game.boards).toHaveLength(8);
    expect(game.score).toEqual({ home: 12, away: 8 });
    expect(game.winner).toBe("home");
    expect(state.gamesWon).toEqual({ home: 1, away: 0 });
  });
});

// ---------------------------------------------------------------------------
// Golden (d) — best-of-3 with a tie-board. ICF (Law 56b): an extra sudden-
// death board; house rule 'draw': the game is drawn and a drawn match is
// possible.
// ---------------------------------------------------------------------------
describe("carrom golden: best-of-3 with a tie-board", () => {
  const tiedEight: BoardSpec[] = [
    ["H", 3], ["A", 3], ["H", 3], ["A", 3],
    ["H", 3], ["A", 3], ["H", 3], ["A", 3],
  ];

  it("ICF 'extra': 12–12 after 8 boards → a ninth board decides (Law 56b)", () => {
    const open = fold(stream(["core.start"], ...boards(...tiedEight)));
    expect(open.games[0]!.winner).toBeNull(); // still open past maxBoards
    const state = fold(stream(["core.start"], ...boards(...tiedEight, ["A", 2])));
    const game = state.games[0]!;
    expect(game.boards).toHaveLength(9);
    expect(game.winner).toBe("away");
    expect(game.score).toEqual({ home: 12, away: 14 });
  });

  it("'draw' policy: the game is drawn; 1-1 plus a drawn game → drawn match", () => {
    const drawCfg = carrom.configSchema.parse({ tieBoard: "draw" });
    const game2: BoardSpec[] = [["H", 9], ["H", 9], ["H", 9]]; // 27 ≥ 25
    const game3: BoardSpec[] = [["A", 9], ["A", 9], ["A", 9]];
    const state = fold(
      stream(["core.start"], ...boards(...tiedEight, ...game2, ...game3)),
      drawCfg,
    );
    expect(state.games[0]!.winner).toBe("draw");
    expect(state.gamesDrawn).toBe(1);
    expect(state.gamesWon).toEqual({ home: 1, away: 1 });
    expect(state.outcome).toEqual({ kind: "draw" });
    const [home, away] = carrom.standingsDelta(state.outcome!, drawCfg, league, state);
    expect([home.points, away.points]).toEqual([1, 1]);
    expect(home).toMatchObject({ drawn: 1, metrics: { sets_won: 1, sets_lost: 1 } });
  });
});

// ---------------------------------------------------------------------------
// Golden (e) — walkover: award outcome, completed games stand in the ledger.
// ---------------------------------------------------------------------------
describe("carrom golden: walkover", () => {
  const state = fold(
    stream(["core.start"], ...boards(["H", 5, "H"]), [
      "core.forfeit",
      { by: "A", reason: "no-show" },
    ]),
  );

  it("awards the match to the opponent", () => {
    expect(state.outcome).toEqual({ kind: "award", winner: "H" });
  });

  it("pays win/loss points; the ledger keeps only what was played", () => {
    const [home, away] = carrom.standingsDelta(state.outcome!, cfg, league, state);
    expect(home).toMatchObject({ won: 1, points: 2 });
    expect(away).toMatchObject({ lost: 1, points: 0 });
    expect(home.metrics).toMatchObject({ boards_won: 1, points_won: 8, sets_won: 0 });
    expect(home.points + away.points).toBe(2); // inside declaredPointsSets
  });
});

// ---------------------------------------------------------------------------
// Abandonment — PROMPT-16 §4: no_result, completed games recorded.
// ---------------------------------------------------------------------------
describe("carrom: abandonment → no_result", () => {
  const game1: BoardSpec[] = [["H", 9], ["H", 9], ["H", 9]]; // H takes game 1
  const state = fold(
    stream(["core.start"], ...boards(...game1, ["A", 4]), [
      "core.abandon",
      { reason: "venue flooded" },
    ]),
  );

  it("records no_result with the completed game in the ledger", () => {
    expect(state.outcome).toEqual({ kind: "no_result" });
    expect(state.gamesWon).toEqual({ home: 1, away: 0 });
    const [home, away] = carrom.standingsDelta(state.outcome!, cfg, league, state);
    expect([home.points, away.points]).toEqual([1, 1]); // shared draw points
    expect(home.metrics).toMatchObject({ sets_won: 1, boards_won: 3, boards_lost: 1 });
    expect(away.metrics).toMatchObject({ sets_won: 0, boards_won: 1 });
  });
});

// ---------------------------------------------------------------------------
// Break alternation — Law 49(a): alternates each board; each game's first
// break alternates between the players; the toss sets game 1.
// ---------------------------------------------------------------------------
describe("carrom: break alternation (Law 49)", () => {
  it("toss winner breaks board 1; alternation runs across boards and games", () => {
    const game1: BoardSpec[] = [["A", 9], ["A", 9], ["A", 9]]; // A takes game 1
    const state = fold(
      stream(
        ["carrom.toss", { firstBreak: "A" }],
        ["core.start"],
        ...boards(...game1, ["H", 2]),
      ),
    );
    const breakers = state.games[0]!.boards.map((board) => board.breaker);
    expect(breakers).toEqual(["away", "home", "away"]); // game 1 alternates from A
    expect(state.games[1]!.boards[0]!.breaker).toBe("home"); // game 2 opens with H
  });

  it("rejects a toss after core.start or a second toss", () => {
    expect(() =>
      fold(stream(["core.start"], ["carrom.toss", { firstBreak: "A" }])),
    ).toThrow(EngineError);
    expect(() =>
      fold(
        stream(["carrom.toss", { firstBreak: "A" }], ["carrom.toss", { firstBreak: "H" }]),
      ),
    ).toThrow(EngineError);
  });
});

// ---------------------------------------------------------------------------
// Umpire adjustments + reserved strike fidelity.
// ---------------------------------------------------------------------------
describe("carrom: game.adjust and reserved strike events", () => {
  it("applies a penalty delta and can decide the game", () => {
    const state = fold(
      stream(["core.start"], ...boards(["H", 9], ["H", 9], ["H", 6]), [
        "carrom.game.adjust",
        { entrantId: "H", delta: 1, reason: "opponent foul" },
      ]),
    );
    expect(state.games[0]!.score.home).toBe(25);
    expect(state.games[0]!.winner).toBe("home");
  });

  it("rejects an adjustment below zero and a zero delta", () => {
    expect(() =>
      fold(
        stream(["core.start"], [
          "carrom.game.adjust",
          { entrantId: "H", delta: -1, reason: "foul" },
        ]),
      ),
    ).toThrow(EngineError);
    expect(() =>
      fold(
        stream(["core.start"], [
          "carrom.game.adjust",
          { entrantId: "H", delta: 0, reason: "foul" },
        ]),
      ),
    ).toThrow(EngineError);
  });

  it("rejects the reserved carrom.strike event", () => {
    expect(() =>
      fold(stream(["core.start"], ["carrom.strike", { striker: "H", pocketed: ["white"] }])),
    ).toThrow(/reserved/);
  });
});

// ---------------------------------------------------------------------------
// Validation edges.
// ---------------------------------------------------------------------------
describe("carrom: board validation", () => {
  it("rejects opponentCoinsLeft outside 0..9 and unknown entrants", () => {
    expect(() => fold(stream(["core.start"], ...boards(["H", 10])))).toThrow(EngineError);
    expect(() => fold(stream(["core.start"], ...boards(["X", 5])))).toThrow(EngineError);
    expect(() =>
      fold(stream(["core.start"], [
        "carrom.board.summary",
        { winner: "H", opponentCoinsLeft: 5, queenTo: "X" },
      ])),
    ).toThrow(EngineError);
  });

  it("declares the house-standard cascade (carrom.md §4)", () => {
    expect(carrom.defaultTiebreakers).toEqual(CARROM_TIEBREAKERS);
    expect(CARROM_TIEBREAKERS).toEqual([
      "points",
      "wins",
      "set_ratio",
      "board_ratio",
      "point_ratio",
      "h2h_points",
      "lots",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Conformance — spec 04 §9 (PROMPT-03 kit) at the ICF default and under the
// tie-board 'draw' house rule (drawn matches reachable).
// ---------------------------------------------------------------------------
conformanceSuite(carrom);
conformanceSuite(carrom, { cfg: { tieBoard: "draw" }, label: "tie-board draw" });
conformanceSuite(carrom, {
  cfg: { gameTo: 29, queenPoints: 5, queenCapAt: 24 },
  label: "club-29",
});
