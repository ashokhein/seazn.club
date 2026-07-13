// Nested kernel golden folds — PROMPT-48 acceptance. Every sequence here
// fails without the kernel's specific rule: deuce loops, no-ad deciding
// points, TB entry/serve rotation/receiver flip, advantage sets, fast4,
// MTB10 deciders, monotonic decision and void-of-match-point reopening.
import { describe, expect, it } from "vitest";
import { EngineError } from "../../core/errors.ts";
import { foldMatch, type EventEnvelope } from "../../core/events.ts";
import { conformanceSuite } from "../../testkit/conformance.ts";
import { defaultLineupPair, makeEnvelope } from "../../testkit/helpers.ts";
import type { ModuleEvent } from "../../sport/module.ts";
import { tennis } from "../tennis/tennis.ts";
import { gameScoreLine, type NestedState } from "./kernel.ts";

const lineups = defaultLineupPair(tennis.positions);
const H = lineups.home.entrantId;
const A = lineups.away.entrantId;

function cfgFor(variant?: string, extra?: Record<string, unknown>) {
  const preset = variant === undefined ? {} : tennis.variants[variant];
  return tennis.configSchema.parse({ ...preset, ...(extra ?? {}) });
}

function envelopes(events: ModuleEvent[]): EventEnvelope[] {
  return events.map((event, i) => makeEnvelope(i, event));
}

const start: ModuleEvent = { type: "core.start", payload: {} };
const point = (by: string): ModuleEvent => ({ type: "tennis.point", payload: { by } });
const points = (...sides: string[]): ModuleEvent[] => sides.map(point);
const summary = (home: number, away: number, tb?: { home: number; away: number }): ModuleEvent => ({
  type: "tennis.set_summary",
  payload: { home, away, ...(tb === undefined ? {} : { tb }) },
});

function fold(cfg: unknown, events: ModuleEvent[]): NestedState {
  return foldMatch(tennis, cfg, lineups, envelopes(events)) as NestedState;
}

// n straight points for one side (a clean game = 4).
const straight = (by: string, n: number): ModuleEvent[] => Array(n).fill(point(by));

describe("nested kernel — standard game", () => {
  it("wins a clean game at four straight points and flips serve", () => {
    const state = fold(cfgFor(), [start, ...straight(H, 4)]);
    expect(state.games).toEqual({ home: 1, away: 0 });
    expect(state.serving).toBe("away");
    expect(state.points).toEqual({ kind: "standard", home: 0, away: 0, advantage: null });
  });

  it("walks the deuce loop: deuce → advantage → deuce → advantage → game", () => {
    // 3-3 (deuce), H ad, A back to deuce, H ad, H game.
    const seq = [start, ...points(H, A, H, A, H, A), point(H), point(A), point(H), point(H)];
    const state = fold(cfgFor(), seq);
    expect(state.games).toEqual({ home: 1, away: 0 });
  });

  it("speaks the score: 40–40, Ad–40, 40–Ad", () => {
    const deuce = fold(cfgFor(), [start, ...points(H, A, H, A, H, A)]);
    expect(gameScoreLine(deuce.points)).toBe("40–40");
    const adHome = fold(cfgFor(), [start, ...points(H, A, H, A, H, A, H)]);
    expect(gameScoreLine(adHome.points)).toBe("Ad–40");
    const adAway = fold(cfgFor(), [start, ...points(H, A, H, A, H, A, A)]);
    expect(gameScoreLine(adAway.points)).toBe("40–Ad");
  });

  it("no-ad: the deciding point at deuce wins the game (receiver choice as meta)", () => {
    const cfg = cfgFor("fast4");
    const seq = [
      start,
      ...points(H, A, H, A, H, A),
      { type: "tennis.point", payload: { by: A, meta: { receiverSide: "ad" } } } as ModuleEvent,
    ];
    const state = fold(cfg, seq);
    expect(state.games).toEqual({ home: 0, away: 1 });
  });
});

// Rally a full game for `by` (4 straight points).
const game = (by: string): ModuleEvent[] => straight(by, 4);
const gamesFor = (by: string, n: number): ModuleEvent[] =>
  Array.from({ length: n }, () => game(by)).flat();

describe("nested kernel — sets and tie-breaks", () => {
  it("wins a 6–4 set on games and starts the next set fresh", () => {
    const seq = [start, ...gamesFor(H, 5), ...gamesFor(A, 4), ...game(H)];
    const state = fold(cfgFor(), seq);
    expect(state.sets).toEqual([{ home: 6, away: 4 }]);
    expect(state.setsWon).toEqual({ home: 1, away: 0 });
    expect(state.games).toEqual({ home: 0, away: 0 });
  });

  it("does not close a set at 6–5 (winBy 2) — plays on to 7–5", () => {
    const to65 = [start, ...gamesFor(H, 5), ...gamesFor(A, 5), ...game(H)];
    const at65 = fold(cfgFor(), to65);
    expect(at65.sets).toEqual([]);
    expect(at65.games).toEqual({ home: 6, away: 5 });
    const at75 = fold(cfgFor(), [...to65, ...game(H)]);
    expect(at75.sets).toEqual([{ home: 7, away: 5 }]);
  });

  it("enters a tie-break at 6–6, rotates serve 1-then-2-2, and flips the next-set receiver", () => {
    const to66 = [start, ...gamesFor(H, 5), ...gamesFor(A, 5), ...game(H), ...game(A)];
    const at66 = fold(cfgFor(), to66);
    expect(at66.points.kind).toBe("tiebreak");
    // 12 games played, serve alternated every game from home → home serves TB.
    expect(at66.tbFirstServer).toBe("home");
    expect(at66.serving).toBe("home");

    // Serve rotation: after point 1 the serve flips, then every 2 points.
    const p1 = fold(cfgFor(), [...to66, point(H)]);
    expect(p1.serving).toBe("away");
    const p2 = fold(cfgFor(), [...to66, ...points(H, H)]);
    expect(p2.serving).toBe("away");
    const p3 = fold(cfgFor(), [...to66, ...points(H, H, H)]);
    expect(p3.serving).toBe("home");

    // H takes the TB 7–0 → set 7–6(0); TB first server (home) receives next
    // set, so away serves set 2.
    const done = fold(cfgFor(), [...to66, ...straight(H, 7)]);
    expect(done.sets).toEqual([{ home: 7, away: 6, tb: { home: 7, away: 0 } }]);
    expect(done.serving).toBe("away");
  });

  it("advantage set (tiebreakAt null) plays past 6–6 to a two-game lead", () => {
    const cfg = cfgFor(undefined, {
      set: { gamesTo: 6, winBy: 2, tiebreakAt: null, tiebreakTo: 7 },
    });
    const to66 = [start, ...gamesFor(H, 5), ...gamesFor(A, 5), ...game(H), ...game(A)];
    const at66 = fold(cfg, to66);
    expect(at66.points.kind).toBe("standard"); // no TB — play on
    const at86 = fold(cfg, [...to66, ...gamesFor(H, 2)]);
    expect(at86.sets).toEqual([{ home: 8, away: 6 }]);
  });

  it("fast4: tie-break at 3–3 to 5, set banked 4–3", () => {
    const cfg = cfgFor("fast4");
    const to33 = [start, ...gamesFor(H, 3), ...gamesFor(A, 3)];
    const at33 = fold(cfg, to33);
    expect(at33.points.kind).toBe("tiebreak");
    const done = fold(cfg, [...to33, ...straight(A, 5)]);
    expect(done.sets).toEqual([{ home: 3, away: 4, tb: { home: 0, away: 5 } }]);
    expect(done.setsWon).toEqual({ home: 0, away: 1 });
  });
});

describe("nested kernel — deciding sets", () => {
  it("doubles-noad-mtb10: a 10-point match tie-break replaces the deciding set", () => {
    const cfg = cfgFor("doubles-noad-mtb10");
    const oneSetAll = [start, summary(6, 4), summary(4, 6)];
    const atDecider = fold(cfg, oneSetAll);
    expect(atDecider.points.kind).toBe("matchTiebreak");
    const done = fold(cfg, [...oneSetAll, ...straight(H, 10)]);
    expect(done.sets[2]).toEqual({ home: 10, away: 0, mtb: true });
    expect(done.outcome).toEqual({ kind: "win", winner: H, loser: A, method: "regulation" });
  });

  it("grand-slam: the deciding set's tie-break runs to 10", () => {
    const cfg = cfgFor("grand-slam");
    const twoSetsAll = [start, summary(6, 4), summary(4, 6), summary(6, 4), summary(4, 6)];
    const to66 = [
      ...twoSetsAll,
      ...gamesFor(H, 5),
      ...gamesFor(A, 5),
      ...game(H),
      ...game(A),
    ];
    const tb = fold(cfg, to66);
    expect(tb.points.kind).toBe("tiebreak");
    // 7 points do NOT close the deciding-set TB…
    const at7 = fold(cfg, [...to66, ...straight(H, 7)]);
    expect(at7.outcome).toBeNull();
    // …10 do.
    const done = fold(cfg, [...to66, ...straight(H, 10)]);
    expect(done.sets[4]).toEqual({ home: 7, away: 6, tb: { home: 10, away: 0 } });
    expect(done.outcome?.kind).toBe("win");
  });

  it("MTB summary at one set all is accepted as raw points", () => {
    const cfg = cfgFor("doubles-noad-mtb10");
    const done = fold(cfg, [start, summary(6, 4), summary(4, 6), summary(10, 8)]);
    expect(done.sets[2]).toEqual({ home: 10, away: 8, mtb: true });
    expect(done.outcome?.kind).toBe("win");
  });
});

describe("nested kernel — set summaries (tier 0)", () => {
  it("banks a plain 6–3 summary and a 7–6 summary with tb points", () => {
    const state = fold(cfgFor(), [start, summary(6, 3), summary(7, 6, { home: 7, away: 5 })]);
    expect(state.setsWon).toEqual({ home: 2, away: 0 });
    expect(state.outcome?.kind).toBe("win");
  });

  it("rejects unreachable summaries: 6–5, 8–2, 7–6 without tb, tb winner mismatch", () => {
    const bad = (events: ModuleEvent[]) => () => fold(cfgFor(), events);
    expect(bad([start, summary(6, 5)])).toThrowError(EngineError);
    expect(bad([start, summary(8, 2)])).toThrowError(EngineError);
    expect(bad([start, summary(7, 6)])).toThrowError(EngineError);
    expect(bad([start, summary(7, 6, { home: 3, away: 7 })])).toThrowError(EngineError);
  });

  it("rejects a summary while a set is being rallied point-by-point", () => {
    expect(() => fold(cfgFor(), [start, point(H), summary(6, 3)])).toThrowError(EngineError);
  });
});

describe("nested kernel — decision & undo", () => {
  const decided = [start, summary(6, 4), summary(6, 4)];

  it("rejects further points after match point (ALREADY_DECIDED)", () => {
    let thrown: unknown;
    try {
      fold(cfgFor(), [...decided, point(H)]);
    } catch (err) {
      thrown = err;
    }
    expect(EngineError.is(thrown)).toBe(true);
    expect((thrown as EngineError).code).toBe("ALREADY_DECIDED");
  });

  it("void of the match point reopens the fold (v3/09 regression class)", () => {
    const envs = envelopes(decided);
    const withVoid = [
      ...envs,
      makeEnvelope(envs.length, { type: "core.void", payload: {} }, "e-2"),
    ];
    const state = foldMatch(tennis, cfgFor(), lineups, withVoid) as NestedState;
    expect(state.outcome).toBeNull();
    expect(state.setsWon).toEqual({ home: 1, away: 0 });
    expect(state.phase).toBe("live");
  });

  it("headline strip: closed sets, live game, TB form", () => {
    const live = fold(cfgFor(), [start, summary(7, 6, { home: 7, away: 5 }), ...points(H, H, A)]);
    expect(live.setsWon).toEqual({ home: 1, away: 0 });
    const text = tennis.summary(live).headline;
    expect(text).toContain("7–6(5)");
    expect(text).toContain("30–15");
  });
});

// Cross-sport invariants over generated streams (spec 04 §9) — default (tour)
// and the two structurally different deciders.
conformanceSuite(tennis);
conformanceSuite(tennis, { cfg: tennis.variants["doubles-noad-mtb10"], label: "mtb10" });
conformanceSuite(tennis, { cfg: tennis.variants["fast4"], label: "fast4" });
