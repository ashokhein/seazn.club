// Generic module goldens + conformance — spec 04 §8, PROMPT-03 §3/§5.
import { describe, expect, it } from "vitest";
import { foldMatch, type EventEnvelope } from "../../core/events.ts";
import type { LineupPair, StageCtx } from "../../core/types.ts";
import { conformanceSuite, makeEnvelope } from "../../testkit/index.ts";
import { generic, type GenericCfg } from "./generic.ts";

const lineups: LineupPair = {
  home: { entrantId: "H", slots: [{ personId: "h1", slot: "starting", orderNo: 1 }] },
  away: { entrantId: "A", slots: [{ personId: "a1", slot: "starting", orderNo: 1 }] },
};

const winLossCfg: GenericCfg = generic.configSchema.parse({
  resultMode: "win_loss",
  allowDraws: false,
  points: { w: 3, d: 1, l: 0 },
  progressScore: false,
});
const scoreCfg: GenericCfg = { ...winLossCfg, resultMode: "score", allowDraws: true };
const league: StageCtx = { kind: "league" };

function stream(...specs: Array<[type: string, payload?: unknown]>): EventEnvelope[] {
  return specs.map(([type, payload], i) => makeEnvelope(i, { type, payload: payload ?? {} }));
}

const fold = (cfg: GenericCfg, events: EventEnvelope[]) => foldMatch(generic, cfg, lineups, events);

describe("generic — win_loss mode (v1 parity)", () => {
  it("records a winner without requiring core.start", () => {
    const state = fold(winLossCfg, stream(["generic.result", { winnerId: "H" }]));
    expect(state.outcome).toEqual({ kind: "win", winner: "H", loser: "A", method: "regulation" });
    expect(generic.summary(state).headline).toBe("W — L");
  });

  it("rejects a draw when allowDraws is false, accepts it when true", () => {
    expect(() => fold(winLossCfg, stream(["generic.result", { isDraw: true }]))).toThrowError(
      expect.objectContaining({ code: "INVALID_EVENT" }),
    );
    const drawCfg = { ...winLossCfg, allowDraws: true };
    expect(fold(drawCfg, stream(["generic.result", { isDraw: true }])).outcome).toEqual({
      kind: "draw",
    });
  });

  it("rejects contradictory payloads", () => {
    const bad = [
      { winnerId: "H", isDraw: true },
      { winnerId: "X" },
      {},
      { winnerId: "H", p1Score: 1, p2Score: 2 }, // winner contradicts scores
      { winnerId: "H", p1Score: 2 }, // partial scores
    ];
    for (const payload of bad) {
      expect(() => fold(winLossCfg, stream(["generic.result", payload]))).toThrowError(
        expect.objectContaining({ code: "INVALID_EVENT" }),
      );
    }
  });

  it("accepts consistent optional scores and feeds them into metrics", () => {
    const state = fold(winLossCfg, stream(["generic.result", { winnerId: "H", p1Score: 5, p2Score: 2 }]));
    const [home, away] = generic.standingsDelta(state.outcome!, winLossCfg, league, state);
    expect(home).toMatchObject({ entrantId: "H", won: 1, points: 3, metrics: { for: 5, against: 2, diff: 3 } });
    expect(away).toMatchObject({ entrantId: "A", lost: 1, points: 0, metrics: { for: 2, against: 5, diff: -3 } });
  });
});

describe("generic — score mode (v1 parity)", () => {
  it("derives the winner from the scores", () => {
    const state = fold(scoreCfg, stream(["core.start"], ["generic.result", { p1Score: 1, p2Score: 3 }]));
    expect(state.outcome).toEqual({ kind: "win", winner: "A", loser: "H", method: "regulation" });
    expect(generic.summary(state)).toEqual({
      headline: "1 — 3",
      perSide: [
        { entrantId: "H", line: "1" },
        { entrantId: "A", line: "3" },
      ],
    });
  });

  it("derives a draw from level scores, rejecting it when draws are off", () => {
    expect(fold(scoreCfg, stream(["generic.result", { p1Score: 2, p2Score: 2 }])).outcome).toEqual({
      kind: "draw",
    });
    const noDraws = { ...scoreCfg, allowDraws: false };
    expect(() => fold(noDraws, stream(["generic.result", { p1Score: 2, p2Score: 2 }]))).toThrowError(
      expect.objectContaining({ code: "INVALID_EVENT" }),
    );
  });

  it("requires both scores and consistency with redundant fields", () => {
    for (const payload of [{}, { p1Score: 1 }, { p1Score: 1, p2Score: 2, winnerId: "H" }, { p1Score: 1, p2Score: 2, isDraw: true }]) {
      expect(() => fold(scoreCfg, stream(["generic.result", payload]))).toThrowError(
        expect.objectContaining({ code: "INVALID_EVENT" }),
      );
    }
  });

  it("rejects a second result and post-finalize events", () => {
    const decided = stream(["generic.result", { p1Score: 1, p2Score: 0 }]);
    expect(() =>
      fold(scoreCfg, [...decided, makeEnvelope(1, { type: "generic.result", payload: { p1Score: 2, p2Score: 0 } })]),
    ).toThrowError(expect.objectContaining({ code: "ALREADY_DECIDED" }));
    const final = fold(scoreCfg, [...decided, makeEnvelope(1, { type: "core.finalize", payload: {} })]);
    expect(final.phase).toBe("final");
  });
});

describe("generic — core event mapping (spec 03 §2 table)", () => {
  it("maps core.forfeit to an award for the other side", () => {
    const state = fold(winLossCfg, stream(["core.start"], ["core.forfeit", { by: "H", reason: "no-show" }]));
    expect(state.outcome).toEqual({ kind: "award", winner: "A" });
    const [home, away] = generic.standingsDelta(state.outcome!, winLossCfg, league, state);
    expect(home).toMatchObject({ lost: 1, points: 0 });
    expect(away).toMatchObject({ won: 1, points: 3 });
    expect(generic.summary(state).headline).toBe("L — W/O");
  });

  it("maps core.abandon to no_result with shared points and no draw counted", () => {
    const state = fold(scoreCfg, stream(["core.start"], ["core.abandon", { reason: "rain" }]));
    expect(state.outcome).toEqual({ kind: "no_result" });
    const [home, away] = generic.standingsDelta(state.outcome!, scoreCfg, league, state);
    expect(home).toMatchObject({ played: 1, won: 0, drawn: 0, lost: 0, points: 1 });
    expect(away).toMatchObject({ played: 1, won: 0, drawn: 0, lost: 0, points: 1 });
  });
});

describe("generic — contract declarations", () => {
  it("declares per-fixture point totals {w+l, 2d}", () => {
    expect([...generic.declaredPointsSets(winLossCfg)].sort()).toEqual([2, 3]);
    expect(generic.declaredPointsSets({ ...winLossCfg, points: { w: 2, d: 1, l: 0 } })).toEqual([2]);
  });

  it("supports draws only in non-elimination stages", () => {
    expect(generic.supportsDraws(scoreCfg, "league")).toBe(true);
    expect(generic.supportsDraws(scoreCfg, "group")).toBe(true);
    expect(generic.supportsDraws(scoreCfg, "knockout")).toBe(false);
    expect(generic.supportsDraws(scoreCfg, "stepladder")).toBe(false);
    expect(generic.supportsDraws(winLossCfg, "league")).toBe(false);
  });
});

// PROMPT-03 §5 — the generic module must pass the conformance kit in both
// result modes.
conformanceSuite(generic, { cfg: winLossCfg, lineups, label: "win_loss" });
conformanceSuite(generic, { cfg: scoreCfg, lineups, label: "score" });
