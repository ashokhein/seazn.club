// Cricket goldens + properties + conformance — spec 04 §2, PROMPT-05 §8/§9.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { foldMatch, type CoreEv, type EventEnvelope } from "../../core/events.ts";
import { shuffle } from "../../core/rng.ts";
import type { LineupPair, StageCtx, StandingsDelta } from "../../core/types.ts";
import { buildStream, conformanceSuite, makeEnvelope } from "../../testkit/index.ts";
import { cricket, type CricketBallEv, type CricketCfg, type CricketEv } from "./cricket.ts";
import { dlsTarget, resources } from "./dls.ts";

// Eleven per side; batting order = orderNo (spec §2.7).
function lineup(prefix: string): LineupPair["home"] {
  return {
    entrantId: prefix,
    slots: Array.from({ length: 11 }, (_, i) => ({
      personId: `${prefix}-${i + 1}`,
      slot: "starting" as const,
      orderNo: i + 1,
      ...(i === 0 ? { roles: ["captain"] } : i === 1 ? { roles: ["wicketkeeper"] } : {}),
    })),
  };
}
const lineups: LineupPair = { home: lineup("H"), away: lineup("A") };
const league: StageCtx = { kind: "league" };

const t20: CricketCfg = cricket.configSchema.parse(
  cricket.variants.t20 as Record<string, unknown>,
);
const fold = (cfg: CricketCfg, events: EventEnvelope[]) => foldMatch(cricket, cfg, lineups, events);

function stream(...specs: Array<[type: string, payload?: unknown]>): EventEnvelope[] {
  return specs.map(([type, payload], i) => makeEnvelope(i, { type, payload: payload ?? {} }));
}

// Compact ball notation for hand-written goldens.
interface BallSpec {
  striker: string;
  nonStriker: string;
  bowler: string;
  bat?: number;
  extras?: { kind: "wide" | "noball" | "bye" | "legbye" | "penalty"; runs: number };
  wicket?: CricketBallEv["wicket"];
  boundary?: 4 | 6;
  freeHit?: boolean;
}

// Expands specs into cricket.ball payloads, deriving over/ballInOver the way
// the fold expects them (wides/no-balls repeat the ball number).
function balls(type: string, specs: BallSpec[], bpo = 6): Array<[string, CricketBallEv]> {
  let legal = 0;
  return specs.map((spec) => {
    const payload: CricketBallEv = {
      over: Math.floor(legal / bpo),
      ballInOver: (legal % bpo) + 1,
      striker: spec.striker,
      nonStriker: spec.nonStriker,
      bowler: spec.bowler,
      runs: { bat: spec.bat ?? 0, ...(spec.extras ? { extras: spec.extras } : {}) },
      ...(spec.wicket ? { wicket: spec.wicket } : {}),
      ...(spec.boundary ? { boundary: spec.boundary } : {}),
      ...(spec.freeHit ? { freeHit: true } : {}),
    };
    const isIllegal = spec.extras?.kind === "wide" || spec.extras?.kind === "noball";
    if (!isIllegal) legal++;
    return [type, payload];
  });
}

// ---------------------------------------------------------------------------
// Fine-fidelity golden — hand-scored 2-over-a-side match exercising the ball
// grammar: extras, free hit, wickets, striker rotation, bowler figures.
// ---------------------------------------------------------------------------

describe("cricket golden: ball-by-ball mini match (fine fidelity)", () => {
  const mini = cricket.configSchema.parse({
    ballsPerInnings: 12,
    maxOversPerBowler: 1,
    minOversForResult: 2,
  });
  const inningsOne = balls("cricket.ball", [
    { striker: "H-1", nonStriker: "H-2", bowler: "A-11", bat: 4, boundary: 4 },
    { striker: "H-1", nonStriker: "H-2", bowler: "A-11", bat: 1 },
    { striker: "H-2", nonStriker: "H-1", bowler: "A-11", extras: { kind: "wide", runs: 1 } },
    { striker: "H-2", nonStriker: "H-1", bowler: "A-11", bat: 6, boundary: 6 },
    {
      striker: "H-2",
      nonStriker: "H-1",
      bowler: "A-11",
      wicket: { kind: "bowled", out: "H-2", bowlerCredited: true },
    },
    { striker: "H-3", nonStriker: "H-1", bowler: "A-11", bat: 2 },
    { striker: "H-3", nonStriker: "H-1", bowler: "A-11", bat: 1 }, // over end
    { striker: "H-3", nonStriker: "H-1", bowler: "A-10", bat: 2, extras: { kind: "noball", runs: 1 } },
    {
      striker: "H-3",
      nonStriker: "H-1",
      bowler: "A-10",
      bat: 1,
      wicket: { kind: "runout", out: "H-1", bowlerCredited: false },
      freeHit: true,
    },
    { striker: "H-3", nonStriker: "H-4", bowler: "A-10", bat: 0 },
    { striker: "H-3", nonStriker: "H-4", bowler: "A-10", bat: 2 },
    { striker: "H-3", nonStriker: "H-4", bowler: "A-10", bat: 0 },
    { striker: "H-3", nonStriker: "H-4", bowler: "A-10", bat: 1 }, // odd → H-4 on strike
    { striker: "H-4", nonStriker: "H-3", bowler: "A-10", bat: 0 }, // balls exhausted → 22/2
  ]);
  const inningsTwo = balls("cricket.ball", [
    { striker: "A-1", nonStriker: "A-2", bowler: "H-11", bat: 6, boundary: 6 },
    { striker: "A-1", nonStriker: "A-2", bowler: "H-11", bat: 4, boundary: 4 },
    { striker: "A-1", nonStriker: "A-2", bowler: "H-11", bat: 0 },
    { striker: "A-1", nonStriker: "A-2", bowler: "H-11", bat: 1 },
    { striker: "A-2", nonStriker: "A-1", bowler: "H-11", extras: { kind: "legbye", runs: 2 } },
    { striker: "A-2", nonStriker: "A-1", bowler: "H-11", bat: 0 }, // over end
    { striker: "A-1", nonStriker: "A-2", bowler: "H-10", bat: 2 },
    { striker: "A-1", nonStriker: "A-2", bowler: "H-10", bat: 4, boundary: 4 },
    {
      striker: "A-1",
      nonStriker: "A-2",
      bowler: "H-10",
      wicket: { kind: "caught", out: "A-1", bowlerCredited: true },
    },
    { striker: "A-3", nonStriker: "A-2", bowler: "H-10", bat: 1 },
    { striker: "A-2", nonStriker: "A-3", bowler: "H-10", bat: 0 },
    { striker: "A-2", nonStriker: "A-3", bowler: "H-10", bat: 0 }, // 20/1 — H wins by 2
  ]);
  const events = stream(["core.start"], ...inningsOne, ...inningsTwo);

  it("folds totals, rotation and figures to the hand-scored card", () => {
    const state = fold(mini, events);
    expect(state.innings[0]).toMatchObject({ runs: 22, wickets: 2, legalBalls: 12, boundaries: 2 });
    expect(state.innings[1]).toMatchObject({ runs: 20, wickets: 1, legalBalls: 12, boundaries: 3 });
    expect(state.outcome).toMatchObject({ kind: "win", winner: "H", method: "regulation" });
    expect(state.margin).toBe("by 2 runs");
    const fine = state.innings[0]!.fine!;
    expect(fine.batterRuns).toMatchObject({ "H-1": 5, "H-2": 6, "H-3": 9, "H-4": 0 });
    expect(fine.batterBalls).toMatchObject({ "H-1": 2, "H-2": 2, "H-3": 8, "H-4": 1 });
    expect(fine.bowlerBalls).toMatchObject({ "A-11": 6, "A-10": 6 });
    expect(fine.bowlerRuns).toMatchObject({ "A-11": 15, "A-10": 7 });
    expect(fine.bowlerWickets).toMatchObject({ "A-11": 1 });
    expect(fine.extras).toBe(2);
  });

  it("summary reads only InningsTotals (spec §2.2)", () => {
    const state = fold(mini, events);
    expect(cricket.summary(state).headline).toBe("22/2 (2) — 20/1 (2)");
  });

  it("§2.2 dual fidelity: coarsen(ballEvents) folds to the identical match", () => {
    const coarse = cricket
      .coarsen!(events as EventEnvelope<CricketEv | CoreEv>[])
      .map((event, i) => makeEnvelope(i, event));
    const fineState = fold(mini, events);
    const coarseState = fold(mini, coarse);
    expect(cricket.outcome(coarseState)).toEqual(cricket.outcome(fineState));
    expect(cricket.summary(coarseState)).toEqual(cricket.summary(fineState));
  });

  it("enforces ball legality: counters, consecutive overs, quotas, wides", () => {
    const start = stream(["core.start"]);
    const bad = (payload: Partial<CricketBallEv>) =>
      fold(mini, [
        ...start,
        makeEnvelope(1, {
          type: "cricket.ball",
          payload: {
            over: 0,
            ballInOver: 1,
            striker: "H-1",
            nonStriker: "H-2",
            bowler: "A-11",
            runs: { bat: 0 },
            ...payload,
          },
        }),
      ]);
    expect(() => bad({ ballInOver: 2 })).toThrowError(
      expect.objectContaining({ code: "INVALID_EVENT" }),
    );
    expect(() => bad({ striker: "H-3" })).toThrowError(
      expect.objectContaining({ code: "INVALID_EVENT" }),
    );
    expect(() =>
      bad({ runs: { bat: 1, extras: { kind: "wide", runs: 1 } } }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_EVENT" }));
    expect(() => bad({ freeHit: true })).toThrowError(
      expect.objectContaining({ code: "INVALID_EVENT" }),
    );

    // Consecutive overs: A-11 bowled over 0, may not bowl over 1.
    const overByEleven = balls("cricket.ball", [
      { striker: "H-1", nonStriker: "H-2", bowler: "A-11" },
      { striker: "H-1", nonStriker: "H-2", bowler: "A-11" },
      { striker: "H-1", nonStriker: "H-2", bowler: "A-11" },
      { striker: "H-1", nonStriker: "H-2", bowler: "A-11" },
      { striker: "H-1", nonStriker: "H-2", bowler: "A-11" },
      { striker: "H-1", nonStriker: "H-2", bowler: "A-11" },
    ]);
    const consecutive = [
      ...stream(["core.start"], ...overByEleven),
      makeEnvelope(7, {
        type: "cricket.ball",
        payload: {
          over: 1,
          ballInOver: 1,
          striker: "H-2",
          nonStriker: "H-1",
          bowler: "A-11",
          runs: { bat: 0 },
        },
      }),
    ];
    expect(() => fold(mini, consecutive)).toThrowError(
      expect.objectContaining({ code: "INVALID_EVENT" }),
    );
    // …and the free-hit dismissal restriction (only the run-out family).
    const freeHitWicket = [
      ...stream(
        ["core.start"],
        ...balls("cricket.ball", [
          { striker: "H-1", nonStriker: "H-2", bowler: "A-11", extras: { kind: "noball", runs: 1 } },
        ]),
      ),
      makeEnvelope(2, {
        type: "cricket.ball",
        payload: {
          over: 0,
          ballInOver: 1,
          striker: "H-1",
          nonStriker: "H-2",
          bowler: "A-11",
          runs: { bat: 0 },
          wicket: { kind: "bowled", out: "H-1", bowlerCredited: true },
          freeHit: true,
        },
      }),
    ];
    expect(() => fold(mini, freeHitWicket)).toThrowError(
      expect.objectContaining({ code: "INVALID_EVENT" }),
    );
  });

  // doc 14 §1 Tier 2 — player lines validate against the fine-derived card.
  it("accepts matching player lines and rejects mismatches with a diff", () => {
    const withLine = (payload: unknown) =>
      fold(mini, [...events, makeEnvelope(events.length, { type: "cricket.player.line", payload })]);
    const ok = withLine({
      innings: 1,
      person: "H-3",
      batting: { runs: 9, balls: 8 },
    });
    expect(ok.playerLines).toHaveLength(1);
    expect(
      withLine({ innings: 1, person: "A-11", bowling: { legalBalls: 6, runs: 15, wickets: 1 } })
        .playerLines,
    ).toHaveLength(1);
    try {
      withLine({ innings: 1, person: "H-3", batting: { runs: 10, balls: 8 } });
      expect.unreachable("mismatched card must be rejected");
    } catch (err) {
      expect(err).toMatchObject({
        code: "INVALID_EVENT",
        data: { field: "batting.runs", expected: 9, got: 10 },
      });
    }
  });
});

// ---------------------------------------------------------------------------
// PROMPT-05 §8 (a)+(d) — real scorecard: 2019 Cricket World Cup final,
// Lord's (NZ 241/8; England 241 all out; Super Over 15–15; England won on
// boundary count 26–17). Sources: ESPNcricinfo match 1144530 scorecard;
// Wikipedia "2019 Cricket World Cup final". Innings entered at Tier-1
// summary fidelity; the Super Over ball-by-ball as published. Player ids:
// A-* = England (A-4 Stokes, A-6 Buttler, A-10 Archer), H-* = New Zealand
// (H-6 Neesham, H-1 Guptill, H-11 Boult).
// ---------------------------------------------------------------------------

describe("cricket golden (a): 2019 CWC final — tie, super over, boundary count", () => {
  const odiKO = cricket.configSchema.parse({
    ballsPerInnings: 300,
    maxOversPerBowler: 10,
    minOversForResult: 20,
    superOver: true,
    superOverStillTied: "boundary_count",
  });
  // England (A) batted second in the match, so bats first in the super over.
  const englandSO = balls("cricket.superover.ball", [
    { striker: "A-4", nonStriker: "A-6", bowler: "H-11", bat: 3 },
    { striker: "A-6", nonStriker: "A-4", bowler: "H-11", bat: 1 },
    { striker: "A-4", nonStriker: "A-6", bowler: "H-11", bat: 4, boundary: 4 },
    { striker: "A-4", nonStriker: "A-6", bowler: "H-11", bat: 1 },
    { striker: "A-6", nonStriker: "A-4", bowler: "H-11", bat: 2 },
    { striker: "A-6", nonStriker: "A-4", bowler: "H-11", bat: 4, boundary: 4 },
  ]);
  const newZealandSO = balls("cricket.superover.ball", [
    { striker: "H-6", nonStriker: "H-1", bowler: "A-10", extras: { kind: "wide", runs: 1 } },
    { striker: "H-6", nonStriker: "H-1", bowler: "A-10", bat: 2 },
    { striker: "H-6", nonStriker: "H-1", bowler: "A-10", bat: 6, boundary: 6 },
    { striker: "H-6", nonStriker: "H-1", bowler: "A-10", bat: 2 },
    { striker: "H-6", nonStriker: "H-1", bowler: "A-10", bat: 2 },
    { striker: "H-6", nonStriker: "H-1", bowler: "A-10", bat: 1 },
    {
      striker: "H-1",
      nonStriker: "H-6",
      bowler: "A-10",
      bat: 1,
      wicket: { kind: "runout", out: "H-1", bowlerCredited: false },
    },
  ]);
  const events = stream(
    ["cricket.toss", { wonBy: "H", elected: "bat" }],
    ["core.start"],
    ["cricket.innings.summary", { runs: 241, wickets: 8, legalBalls: 300, boundaries: 16 }],
    ["cricket.innings.summary", { runs: 241, wickets: 10, legalBalls: 300, boundaries: 24 }],
    ...englandSO,
    ...newZealandSO,
  );

  it("replays the published result: England win on boundary count", () => {
    const state = fold(odiKO, events);
    expect(state.outcome).toEqual({
      kind: "win",
      winner: "A",
      loser: "H",
      method: "boundary_count",
    });
    expect(state.margin).toBe("on boundary count");
    const so = state.superOver!;
    expect(so.innings.map((i) => ({ side: i.battingSide, runs: i.runs }))).toEqual([
      { side: "away", runs: 15 },
      { side: "home", runs: 15 },
    ]);
  });

  it("keeps the super over out of the NRR ledger (ICC convention)", () => {
    const state = fold(odiKO, events);
    const [home, away] = cricket.standingsDelta(state.outcome!, odiKO, league, state);
    // England all out ⇒ charged the full quota (equal to actual here).
    expect(away.metrics).toMatchObject({
      runs_for: 241,
      balls_faced_eff: 300,
      runs_against: 241,
      balls_bowled_eff: 300,
    });
    expect([home.points, away.points]).toEqual([0, 2]);
  });
});

// ---------------------------------------------------------------------------
// PROMPT-05 §8 (b) — all-out NRR rule (ESPNcricinfo/CricHeroes methodology:
// a side bowled out is charged its full quota of overs, not balls faced).
// ---------------------------------------------------------------------------

describe("cricket golden (b): all-out NRR ledger", () => {
  const events = stream(
    ["core.start"],
    ["cricket.innings.summary", { runs: 180, wickets: 4, legalBalls: 120 }],
    ["cricket.innings.summary", { runs: 150, wickets: 10, legalBalls: 100 }],
  );

  it("charges the bowled-out side its full 20-over quota", () => {
    const state = fold(t20, events);
    expect(state.outcome).toMatchObject({ kind: "win", winner: "H" });
    expect(state.margin).toBe("by 30 runs");
    const [home, away] = cricket.standingsDelta(state.outcome!, t20, league, state);
    expect(home.metrics).toMatchObject({
      runs_for: 180,
      balls_faced_eff: 120,
      runs_against: 150,
      balls_bowled_eff: 120, // ← not 100: all-out full-quota rule (spec §2.4)
    });
    expect(away.metrics).toMatchObject({ runs_for: 150, balls_faced_eff: 120 });
    // NRR computed from the integer ledger at rank time: 180/20 − 150/20.
    const nrr =
      home.metrics.runs_for! / (home.metrics.balls_faced_eff! / 6) -
      home.metrics.runs_against! / (home.metrics.balls_bowled_eff! / 6);
    expect(nrr).toBeCloseTo(1.5, 10);
  });

  // PROMPT-05 acceptance — permuting fixture order never changes the ledger.
  it("accumulated ledger is permutation-invariant", () => {
    const fixtures = [
      [180, 4, 120, 150, 10, 100],
      [200, 6, 120, 201, 3, 110],
      [90, 10, 80, 91, 2, 60],
    ].map(([r1, w1, b1, r2, w2, b2]) =>
      fold(
        t20,
        stream(
          ["core.start"],
          ["cricket.innings.summary", { runs: r1, wickets: w1, legalBalls: b1 }],
          ["cricket.innings.summary", { runs: r2, wickets: w2, legalBalls: b2 }],
        ),
      ),
    );
    const deltas = fixtures.map(
      (state) => cricket.standingsDelta(state.outcome!, t20, league, state)[0],
    );
    const total = (list: StandingsDelta[]) =>
      list.reduce(
        (acc, delta) => {
          for (const [key, value] of Object.entries(delta.metrics)) {
            acc[key] = (acc[key] ?? 0) + value;
          }
          return acc;
        },
        {} as Record<string, number>,
      );
    const reference = total(deltas);
    fc.assert(
      fc.property(fc.nat(), (seed) => {
        expect(total(shuffle(seed, deltas))).toEqual(reference);
      }),
      { numRuns: 50 },
    );
  });
});

// ---------------------------------------------------------------------------
// PROMPT-05 §8 (c) — DLS Standard Edition vs the published 2002 D/L table
// (© Duckworth/Lewis, ICC-hosted; engine/11-sources.md). Exact on table values.
// ---------------------------------------------------------------------------

describe("cricket golden (c): DLS Standard Edition", () => {
  const odiDls = cricket.configSchema.parse({
    ballsPerInnings: 300,
    maxOversPerBowler: 10,
    minOversForResult: 20,
    dls: { enabled: true, edition: "standard" },
  });

  it("reads the published resource table exactly", () => {
    expect(resources(50, 0)).toBe(100.0);
    expect(resources(40, 0)).toBe(89.3);
    expect(resources(25, 0)).toBe(66.5);
    expect(resources(20, 2)).toBe(52.4);
    expect(resources(10, 2)).toBe(30.8);
    expect(resources(18, 3)).toBe(45.9);
    expect(resources(4, 4)).toBe(13.2);
    expect(resources(0, 0)).toBe(0);
  });

  it("computes the reduced-target case (R2 < R1)", () => {
    // Team 1: 250 in the full 50; rain cuts the chase to 25 overs.
    // R1 = 100, R2 = 66.5 ⇒ target = ⌊250 × 0.665⌋ + 1 = 167.
    expect(dlsTarget(250, 100, 66.5)).toBe(167);
    const events = stream(
      ["core.start"],
      ["cricket.innings.summary", { runs: 250, wickets: 5, legalBalls: 300 }],
      ["cricket.revise", { oversPerSide: 25 }],
      ["cricket.innings.summary", { runs: 167, wickets: 3, legalBalls: 140 }],
    );
    const state = fold(odiDls, events);
    expect(state.revisedTarget).toBe(167);
    expect(state.targetSource).toBe("dls");
    expect(state.outcome).toMatchObject({ kind: "win", winner: "A", method: "dls" });
    expect(state.margin).toBe("by 7 wickets");
  });

  it("computes the increased-target case (R2 > R1) with G50", () => {
    // Team 1 interrupted at 120/2 after 30 of 50 overs, restarted at 40:
    // R1 = 100 − (res(20,2) − res(10,2)) = 100 − (52.4 − 30.8) = 78.4.
    // Team 2 gets 40 overs: R2 = 89.3 ⇒ target = ⌊190 + 245×10.9/100⌋ + 1 = 217.
    const events = stream(
      ["core.start"],
      ["cricket.innings.summary", { runs: 120, wickets: 2, legalBalls: 180, partial: true }],
      ["cricket.interruption", { kind: "rain" }],
      ["cricket.revise", { oversPerSide: 40 }],
      ["cricket.innings.summary", { runs: 190, wickets: 6, legalBalls: 240 }],
      ["cricket.innings.summary", { runs: 0, wickets: 0, legalBalls: 0, partial: true }],
    );
    const state = fold(odiDls, events);
    expect(state.r1).toBeCloseTo(78.4, 9);
    expect(state.r2).toBeCloseTo(89.3, 9);
    expect(state.revisedTarget).toBe(217);
  });

  it("decides an abandoned chase by the DLS par score (method 'dls')", () => {
    // Continuing the R2>R1 scenario: chase 150/3 after 22 of 40 overs, rain
    // ends play. Par = ⌊216 × (89.3 − res(18,3))/89.3⌋ = 104 ⇒ win by 46.
    const events = stream(
      ["core.start"],
      ["cricket.innings.summary", { runs: 120, wickets: 2, legalBalls: 180, partial: true }],
      ["cricket.revise", { oversPerSide: 40 }],
      ["cricket.innings.summary", { runs: 190, wickets: 6, legalBalls: 240 }],
      ["cricket.innings.summary", { runs: 150, wickets: 3, legalBalls: 132, partial: true }],
      ["core.abandon", { reason: "rain" }],
    );
    const state = fold(odiDls, events);
    expect(state.outcome).toMatchObject({ kind: "win", winner: "A", method: "dls" });
    expect(state.margin).toBe("by 46 runs");
  });

  it("no_result below the minimum overs; manual umpire target always wins", () => {
    const washout = stream(
      ["core.start"],
      ["cricket.innings.summary", { runs: 250, wickets: 5, legalBalls: 300 }],
      ["cricket.innings.summary", { runs: 40, wickets: 1, legalBalls: 60, partial: true }],
      ["core.abandon", { reason: "rain" }],
    );
    expect(fold(odiDls, washout).outcome).toEqual({ kind: "no_result" });

    const manual = stream(
      ["core.start"],
      ["cricket.innings.summary", { runs: 250, wickets: 5, legalBalls: 300 }],
      ["cricket.revise", { oversPerSide: 25, target: 200 }],
      ["cricket.revise", { oversPerSide: 20 }], // later DLS revise must not override
    );
    const state = fold(odiDls, manual);
    expect(state.revisedTarget).toBe(200);
    expect(state.targetSource).toBe("manual");
  });
});

// ---------------------------------------------------------------------------
// PROMPT-05 §8 (d) — tied T20 → super over → still-tied policies.
// ---------------------------------------------------------------------------

describe("cricket golden (d): tied T20 super over policies", () => {
  const tiedMain = (policy: "repeat" | "boundary_count" | "shared") =>
    ({
      cfg: cricket.configSchema.parse({ superOver: true, superOverStillTied: policy }),
      events: stream(
        ["core.start"],
        ["cricket.innings.summary", { runs: 150, wickets: 5, legalBalls: 120, boundaries: 10 }],
        ["cricket.innings.summary", { runs: 150, wickets: 7, legalBalls: 120, boundaries: 12 }],
      ),
    }) as const;

  // Away batted second ⇒ bats first in the super over (ICC).
  it("boundary_count: more boundaries across match + super over wins", () => {
    const { cfg, events } = tiedMain("boundary_count");
    // Both super-over innings score 10 — still tied ⇒ boundaries 13 v 10.
    const awaySO = balls("cricket.superover.ball", [
      { striker: "A-1", nonStriker: "A-2", bowler: "H-11", bat: 4, boundary: 4 },
      { striker: "A-1", nonStriker: "A-2", bowler: "H-11", bat: 1 },
      { striker: "A-2", nonStriker: "A-1", bowler: "H-11", bat: 1 },
      { striker: "A-1", nonStriker: "A-2", bowler: "H-11", bat: 2 },
      { striker: "A-1", nonStriker: "A-2", bowler: "H-11", bat: 1 },
      { striker: "A-2", nonStriker: "A-1", bowler: "H-11", bat: 1 },
    ]);
    const homeSO = balls("cricket.superover.ball", [
      { striker: "H-1", nonStriker: "H-2", bowler: "A-11", bat: 2 },
      { striker: "H-1", nonStriker: "H-2", bowler: "A-11", bat: 2 },
      { striker: "H-1", nonStriker: "H-2", bowler: "A-11", bat: 2 },
      { striker: "H-1", nonStriker: "H-2", bowler: "A-11", bat: 2 },
      { striker: "H-1", nonStriker: "H-2", bowler: "A-11", bat: 1 },
      { striker: "H-2", nonStriker: "H-1", bowler: "A-11", bat: 1 },
    ]);
    const state = fold(cfg, [...events, ...streamFrom(events.length, [...awaySO, ...homeSO])]);
    expect(state.outcome).toMatchObject({ kind: "win", winner: "A", method: "boundary_count" });
  });

  it("repeat: a second super over decides (batting order flips)", () => {
    const { cfg, events } = tiedMain("repeat");
    const so1 = [
      ...balls("cricket.superover.ball", [
        { striker: "A-1", nonStriker: "A-2", bowler: "H-11", bat: 2 },
        { striker: "A-1", nonStriker: "A-2", bowler: "H-11", bat: 2 },
        { striker: "A-1", nonStriker: "A-2", bowler: "H-11", bat: 2 },
        { striker: "A-1", nonStriker: "A-2", bowler: "H-11", bat: 2 },
        { striker: "A-1", nonStriker: "A-2", bowler: "H-11", bat: 2 },
        { striker: "A-1", nonStriker: "A-2", bowler: "H-11", bat: 2 }, // 12
      ]),
      ...balls("cricket.superover.ball", [
        { striker: "H-1", nonStriker: "H-2", bowler: "A-11", bat: 2 },
        { striker: "H-1", nonStriker: "H-2", bowler: "A-11", bat: 2 },
        { striker: "H-1", nonStriker: "H-2", bowler: "A-11", bat: 2 },
        { striker: "H-1", nonStriker: "H-2", bowler: "A-11", bat: 2 },
        { striker: "H-1", nonStriker: "H-2", bowler: "A-11", bat: 2 },
        { striker: "H-1", nonStriker: "H-2", bowler: "A-11", bat: 2 }, // 12 — tied again
      ]),
    ];
    // Second super over: home bats first now; away chases 7 and wins.
    const so2 = [
      ...balls("cricket.superover.ball", [
        { striker: "H-3", nonStriker: "H-4", bowler: "A-10", bat: 2 },
        { striker: "H-3", nonStriker: "H-4", bowler: "A-10", bat: 2 },
        { striker: "H-3", nonStriker: "H-4", bowler: "A-10", bat: 2 },
        { striker: "H-3", nonStriker: "H-4", bowler: "A-10", bat: 0 },
        { striker: "H-3", nonStriker: "H-4", bowler: "A-10", bat: 0 },
        { striker: "H-3", nonStriker: "H-4", bowler: "A-10", bat: 0 }, // 6
      ]),
      ...balls("cricket.superover.ball", [
        { striker: "A-3", nonStriker: "A-4", bowler: "H-10", bat: 6, boundary: 6 },
        { striker: "A-3", nonStriker: "A-4", bowler: "H-10", bat: 1 }, // 7 ≥ 7 → away wins
      ]),
    ];
    const state = fold(cfg, [...events, ...streamFrom(events.length, [...so1, ...so2])]);
    expect(state.outcome).toMatchObject({ kind: "win", winner: "A", method: "super_over" });
    expect(state.superOver!.innings).toHaveLength(4);
  });

  it("shared: the tie stands and pays tie points", () => {
    const { cfg, events } = tiedMain("shared");
    const so = [
      ...balls("cricket.superover.ball", [
        { striker: "A-1", nonStriker: "A-2", bowler: "H-11", bat: 2 },
        { striker: "A-1", nonStriker: "A-2", bowler: "H-11", bat: 2 },
        { striker: "A-1", nonStriker: "A-2", bowler: "H-11", bat: 2 },
        { striker: "A-1", nonStriker: "A-2", bowler: "H-11", bat: 0 },
        { striker: "A-1", nonStriker: "A-2", bowler: "H-11", bat: 0 },
        { striker: "A-1", nonStriker: "A-2", bowler: "H-11", bat: 0 },
      ]),
      ...balls("cricket.superover.ball", [
        { striker: "H-1", nonStriker: "H-2", bowler: "A-11", bat: 2 },
        { striker: "H-1", nonStriker: "H-2", bowler: "A-11", bat: 2 },
        { striker: "H-1", nonStriker: "H-2", bowler: "A-11", bat: 2 },
        { striker: "H-1", nonStriker: "H-2", bowler: "A-11", bat: 0 },
        { striker: "H-1", nonStriker: "H-2", bowler: "A-11", bat: 0 },
        { striker: "H-1", nonStriker: "H-2", bowler: "A-11", bat: 0 },
      ]),
    ];
    const state = fold(cfg, [...events, ...streamFrom(events.length, so)]);
    expect(state.outcome).toEqual({ kind: "tie" });
    const [home, away] = cricket.standingsDelta(state.outcome!, cfg, league, state);
    expect([home.points, away.points]).toEqual([1, 1]);
    expect(home.metrics.ties).toBe(1);
  });

  it("league tie without a super over stands as a tie (≠ no_result)", () => {
    const { events } = tiedMain("repeat");
    const state = fold(t20, events); // superOver: false
    expect(state.outcome).toEqual({ kind: "tie" });
  });
});

// ---------------------------------------------------------------------------
// PROMPT-05 §8 (e) — two-innings (test) rules: draw, innings victory,
// follow-on enforcement, 4th-innings chase.
// ---------------------------------------------------------------------------

describe("cricket golden (e): two-innings matches", () => {
  const test = cricket.configSchema.parse(cricket.variants.test as Record<string, unknown>);

  it("draws on time expiry with draw points", () => {
    const events = stream(
      ["core.start"],
      ["cricket.innings.summary", { runs: 400, wickets: 6, legalBalls: 540, declared: true }],
      ["cricket.innings.summary", { runs: 250, wickets: 10, legalBalls: 480 }],
      ["cricket.innings.summary", { runs: 200, wickets: 2, legalBalls: 180, declared: true }],
      ["cricket.match.close"],
    );
    const state = fold(test, events);
    expect(state.outcome).toEqual({ kind: "draw" });
    expect(cricket.supportsDraws(test, "league")).toBe(true);
    expect(cricket.supportsDraws(t20, "league")).toBe(false);
    const [home, away] = cricket.standingsDelta(state.outcome!, test, league, state);
    expect([home.points, away.points]).toEqual([1, 1]);
    expect([home.drawn, away.drawn]).toEqual([1, 1]);
  });

  it("enforces the follow-on and scores an innings victory", () => {
    const events = stream(
      ["core.start"],
      ["cricket.innings.summary", { runs: 500, wickets: 3, legalBalls: 540, declared: true }],
      ["cricket.innings.summary", { runs: 200, wickets: 10, legalBalls: 300 }],
      ["cricket.followon"],
      ["cricket.innings.summary", { runs: 250, wickets: 10, legalBalls: 350 }],
    );
    const state = fold(test, events);
    expect(state.outcome).toMatchObject({ kind: "win", winner: "H", method: "innings" });
    expect(state.margin).toBe("by an innings and 50 runs");
  });

  it("rejects a follow-on below the configured lead", () => {
    const events = stream(
      ["core.start"],
      ["cricket.innings.summary", { runs: 300, wickets: 10, legalBalls: 400 }],
      ["cricket.innings.summary", { runs: 200, wickets: 10, legalBalls: 350 }],
      ["cricket.followon"],
    );
    expect(() => fold(test, events)).toThrowError(
      expect.objectContaining({ code: "INVALID_EVENT" }),
    );
  });

  it("resolves a fourth-innings chase by wickets", () => {
    const events = stream(
      ["core.start"],
      ["cricket.innings.summary", { runs: 300, wickets: 10, legalBalls: 400 }],
      ["cricket.innings.summary", { runs: 250, wickets: 10, legalBalls: 380 }],
      ["cricket.innings.summary", { runs: 150, wickets: 10, legalBalls: 200 }],
      ["cricket.innings.summary", { runs: 201, wickets: 5, legalBalls: 240 }],
    );
    const state = fold(test, events);
    expect(state.outcome).toMatchObject({ kind: "win", winner: "A", method: "regulation" });
    expect(state.margin).toBe("by 5 wickets");
    expect(cricket.summary(state).perSide).toEqual([
      { entrantId: "H", line: "300 & 150" },
      { entrantId: "A", line: "250 & 201/5" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// PROMPT-05 acceptance — bowler-legality property over generated streams.
// ---------------------------------------------------------------------------

describe("cricket property: generated streams respect bowling legality", () => {
  it("never violates consecutive-over or quota rules", () => {
    fc.assert(
      fc.property(fc.nat(), fc.integer({ min: 20, max: 300 }), (seed, length) => {
        const events = buildStream(cricket, t20, lineups, seed, length);
        // Segment fine deliveries into innings on over-counter resets.
        const segments: CricketBallEv[][] = [];
        let current: CricketBallEv[] = [];
        let prevKey = -1;
        for (const event of events) {
          if (event.type !== "cricket.ball") continue;
          const ball = event.payload as CricketBallEv;
          const key = ball.over * 100 + ball.ballInOver;
          if (key < prevKey && ball.over === 0 && ball.ballInOver === 1) {
            if (current.length > 0) segments.push(current);
            current = [];
          }
          prevKey = key;
          current.push(ball);
        }
        if (current.length > 0) segments.push(current);
        for (const segment of segments) {
          const overBowler = new Map<number, string>();
          for (const ball of segment) {
            const existing = overBowler.get(ball.over);
            expect(existing ?? ball.bowler).toBe(ball.bowler); // one bowler per over
            overBowler.set(ball.over, ball.bowler);
          }
          const overs = [...overBowler.entries()].sort((a, b) => a[0] - b[0]);
          const perBowler = new Map<string, number>();
          for (const [overNo, bowler] of overs) {
            const prev = overs.find(([n]) => n === overNo - 1);
            if (prev !== undefined) expect(prev[1]).not.toBe(bowler); // no consecutive overs
            perBowler.set(bowler, (perBowler.get(bowler) ?? 0) + 1);
          }
          for (const count of perBowler.values()) {
            expect(count).toBeLessThanOrEqual(t20.maxOversPerBowler as number); // quota
          }
        }
      }),
      { numRuns: 60 },
    );
  });
});

// Helper: envelope a pre-built [type, payload] list continuing a stream.
function streamFrom(
  offset: number,
  specs: Array<[type: string, payload?: unknown]>,
): EventEnvelope[] {
  return specs.map(([type, payload], i) =>
    makeEnvelope(offset + i, { type, payload: payload ?? {} }),
  );
}

// PROMPT-05 acceptance — conformance green across the fidelity/format matrix.
conformanceSuite(cricket, { cfg: {}, lineups, label: "t20", numRuns: 120, maxEvents: 60 });
conformanceSuite(cricket, {
  cfg: { superOver: true, superOverStillTied: "boundary_count" },
  lineups,
  label: "t20 knockout",
  stageCtxs: [{ kind: "knockout" }, { kind: "group" }],
  numRuns: 120,
  maxEvents: 60,
});
conformanceSuite(cricket, {
  cfg: {
    inningsPerSide: 2,
    ballsPerInnings: null,
    points: { win: 2, tie: 1, noResult: 1, loss: 0, draw: 1 },
    followOn: { enabled: true, lead: 200 },
    minOversForResult: 0,
  },
  lineups,
  label: "test",
  numRuns: 120,
  maxEvents: 60,
});
