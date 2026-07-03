// Football goldens + conformance — spec 04 §1, PROMPT-04 §10.
import { describe, expect, it } from "vitest";
import { foldMatch, type CoreEv, type EventEnvelope } from "../../core/events.ts";
import type { LineupPair, StageCtx } from "../../core/types.ts";
import { conformanceSuite, lineupFromCatalog, makeEnvelope } from "../../testkit/index.ts";
import { football, FOOTBALL_TIEBREAKERS, type FootballCfg, type FootballEv } from "./football.ts";

// Direct module.apply calls need the module's payload union on the envelope.
const asFootball = (event: EventEnvelope) => event as EventEnvelope<FootballEv | CoreEv>;

// Catalog-valid 11 + a two-man bench for substitution tests.
function lineupWithBench(entrantId: string): LineupPair["home"] {
  const base = lineupFromCatalog(football.positions, entrantId);
  return {
    ...base,
    slots: [
      ...base.slots,
      { personId: `${entrantId}-b1`, slot: "bench", orderNo: 12 },
      { personId: `${entrantId}-b2`, slot: "bench", orderNo: 13 },
    ],
  };
}
const lineups: LineupPair = { home: lineupWithBench("H"), away: lineupWithBench("A") };

const leagueCfg: FootballCfg = football.configSchema.parse({});
const knockoutCfg: FootballCfg = football.configSchema.parse({
  extraTime: { enabled: true, halfMinutes: 15 },
  shootout: true,
});
const league: StageCtx = { kind: "league" };
const group: StageCtx = { kind: "group" };
const knockout: StageCtx = { kind: "knockout" };

function stream(...specs: Array<[type: string, payload?: unknown]>): EventEnvelope[] {
  return specs.map(([type, payload], i) => makeEnvelope(i, { type, payload: payload ?? {} }));
}

const fold = (cfg: FootballCfg, events: EventEnvelope[]) =>
  foldMatch(football, cfg, lineups, events);

// PROMPT-04 §10 (a) — league draw 1-1 ⇒ 1 pt each + metrics.
describe("football golden (a): league draw 1-1", () => {
  const events = stream(
    ["core.start"],
    ["football.goal", { by: "H", scorer: "H-p9", minute: 12 }],
    ["football.period", { phase: "HT" }],
    ["football.goal", { by: "A", minute: 71 }],
    ["football.period", { phase: "FT" }],
  );

  it("folds to a draw with the right summary", () => {
    const state = fold(leagueCfg, events);
    expect(state.outcome).toEqual({ kind: "draw" });
    expect(football.summary(state).headline).toBe("1 — 1");
    expect(football.summary(state).detail).toMatchObject({
      periods: [
        { phase: "H1", home: 1, away: 0 },
        { phase: "H2", home: 0, away: 1 },
      ],
    });
  });

  it("pays 1 point and symmetric metrics to each side", () => {
    const state = fold(leagueCfg, events);
    const [home, away] = football.standingsDelta(state.outcome!, leagueCfg, league, state);
    expect(home).toMatchObject({
      entrantId: "H",
      drawn: 1,
      points: 1,
      metrics: { gf: 1, ga: 1, gd: 0, yellow: 0, red: 0, fair_play: 0 },
    });
    expect(away).toMatchObject({ entrantId: "A", drawn: 1, points: 1, metrics: { gd: 0 } });
  });
});

// PROMPT-04 §10 (b) — knockout 0-0 → ET 1-1 → shootout 4-3, method 'shootout'.
describe("football golden (b): knockout decided on penalties", () => {
  const kick = (by: string, scored: boolean): [string, unknown] => [
    "football.shootout.kick",
    { by, scored },
  ];
  const events = stream(
    ["core.start"],
    ["football.period", { phase: "HT" }],
    ["football.period", { phase: "FT" }], // 0-0 ⇒ ET (extraTime.enabled)
    ["football.goal", { by: "H", minute: 97 }],
    ["football.period", { phase: "ET_HT" }],
    ["football.goal", { by: "A", minute: 113 }],
    ["football.period", { phase: "ET_FT" }], // 1-1 ⇒ SHOOTOUT
    kick("H", true),
    kick("A", true),
    kick("H", true),
    kick("A", true),
    kick("H", true),
    kick("A", true),
    kick("H", false),
    kick("A", false),
    kick("H", true),
    kick("A", false), // 4-3 after 5 kicks each
  );

  it("walks the full FT → ET → shootout machine", () => {
    const state = fold(knockoutCfg, events);
    expect(state.outcome).toEqual({ kind: "win", winner: "H", loser: "A", method: "shootout" });
    expect(state.goals).toEqual({ home: 1, away: 1 }); // shootout kicks are not goals
    expect(football.summary(state).headline).toBe("1 — 1 (4–3 pens)");
  });

  it("keeps regulation points in knockout but honours the group SO split", () => {
    const state = fold(knockoutCfg, events);
    const [home, away] = football.standingsDelta(state.outcome!, knockoutCfg, knockout, state);
    expect([home.points, away.points]).toEqual([3, 0]);

    // spec 04 §1.4 — youth-cup convention SO win 2 / SO loss 1.
    const splitCfg = football.configSchema.parse({
      extraTime: { enabled: true, halfMinutes: 15 },
      shootout: true,
      points: { win: 3, draw: 1, loss: 0, shootoutWin: 2, shootoutLoss: 1 },
    });
    const splitState = foldMatch(football, splitCfg, lineups, events);
    const [h2, a2] = football.standingsDelta(splitState.outcome!, splitCfg, group, splitState);
    expect([h2.points, a2.points]).toEqual([2, 1]);
    expect(football.declaredPointsSets(splitCfg)).toContain(3);
  });

  it("enforces kick alternation and early decision arithmetic", () => {
    const early = stream(
      ["core.start"],
      ["football.period", { phase: "HT" }],
      ["football.period", { phase: "FT" }],
      ["football.goal", { by: "H" }],
      ["football.goal", { by: "A" }],
      ["football.period", { phase: "ET_HT" }],
      ["football.period", { phase: "ET_FT" }],
      kick("H", true),
      kick("A", false),
      kick("H", true),
      kick("A", false),
      kick("H", true), // 3-0 after 3v2: away max = 0+3 ⇒ not yet decided
    );
    const undecided = fold(knockoutCfg, early);
    expect(football.outcome(undecided)).toBeNull();

    const decided = fold(knockoutCfg, [
      ...early,
      makeEnvelope(early.length, { type: "football.shootout.kick", payload: { by: "A", scored: false } }),
    ]); // 3-0 after 3v3: away max = 0+2 < 3 ⇒ decided
    expect(football.outcome(decided)).toMatchObject({ kind: "win", winner: "H" });

    expect(() =>
      fold(knockoutCfg, [
        ...early,
        makeEnvelope(early.length, { type: "football.shootout.kick", payload: { by: "H", scored: true } }),
      ]),
    ).toThrowError(expect.objectContaining({ code: "INVALID_EVENT" })); // H kicked out of turn
  });
});

// PROMPT-04 §10 (c) — forfeit ⇒ award with cfg.awardScore goals.
describe("football golden (c): forfeit award 3-0", () => {
  it("awards the tie to the opponent with the configured score", () => {
    const state = fold(leagueCfg, stream(["core.start"], ["core.forfeit", { by: "A", reason: "no-show" }]));
    expect(state.outcome).toEqual({
      kind: "award",
      winner: "H",
      score: { home: 3, away: 0 },
    });
    expect(football.summary(state).headline).toBe("3 — 0");
    const [home, away] = football.standingsDelta(state.outcome!, leagueCfg, league, state);
    expect(home).toMatchObject({ won: 1, points: 3, metrics: { gf: 3, ga: 0, gd: 3 } });
    expect(away).toMatchObject({ lost: 1, points: 0, metrics: { gf: 0, ga: 3, gd: -3 } });
  });
});

// PROMPT-04 §10 (d) — own goal + red card fold to the right summary and
// FIFA fair-play points (Y −1, 2nd-Y −3, direct R −4, Y+R −5).
describe("football golden (d): own goal + cards", () => {
  const events = stream(
    ["core.start"],
    ["football.goal", { by: "H", scorer: "H-p3", ownGoal: true, minute: 23 }], // credits A
    ["football.card", { by: "H", person: "H-p5", color: "yellow", minute: 30 }],
    ["football.card", { by: "H", person: "H-p5", color: "second_yellow", minute: 44 }],
    ["football.period", { phase: "HT" }],
    ["football.card", { by: "A", person: "A-p4", color: "red", minute: 60 }],
    ["football.period", { phase: "FT" }],
  );

  it("credits the own goal to the opponent and decides the match", () => {
    const state = fold(leagueCfg, events);
    expect(state.goals).toEqual({ home: 0, away: 1 });
    expect(state.outcome).toEqual({ kind: "win", winner: "A", loser: "H", method: "regulation" });
    expect(state.squads.home.sentOff).toEqual(["H-p5"]);
  });

  it("computes card metrics on the FIFA fair-play scale", () => {
    const state = fold(leagueCfg, events);
    const [home, away] = football.standingsDelta(state.outcome!, leagueCfg, league, state);
    expect(home.metrics).toMatchObject({ gf: 0, ga: 1, gd: -1, yellow: 2, red: 1, fair_play: -3 });
    expect(away.metrics).toMatchObject({ gf: 1, ga: 0, gd: 1, yellow: 0, red: 1, fair_play: -4 });
  });

  it("scores yellow + direct red to one player as −5", () => {
    const state = fold(
      leagueCfg,
      stream(
        ["core.start"],
        ["football.card", { by: "H", person: "H-p5", color: "yellow" }],
        ["football.card", { by: "H", person: "H-p5", color: "red" }],
        ["football.goal", { by: "A" }],
        ["football.period", { phase: "HT" }],
        ["football.period", { phase: "FT" }],
      ),
    );
    const [home] = football.standingsDelta(state.outcome!, leagueCfg, league, state);
    expect(home.metrics.fair_play).toBe(-5);
  });
});

describe("football state machine guards (spec 04 §1.3)", () => {
  it("rejects a goal after FT when no extra time is configured", () => {
    const done = fold(leagueCfg, stream(["core.start"], ["football.goal", { by: "H" }], ["football.period", { phase: "HT" }], ["football.period", { phase: "FT" }]));
    expect(() =>
      football.apply(done, asFootball(makeEnvelope(9, { type: "football.goal", payload: { by: "H" } }))),
    ).toThrowError(expect.objectContaining({ code: "WRONG_PHASE" }));
  });

  it("keeps a level knockout fixture undecided at FT (ET path pending)", () => {
    const state = fold(knockoutCfg, stream(["core.start"], ["football.period", { phase: "HT" }], ["football.period", { phase: "FT" }]));
    expect(football.outcome(state)).toBeNull();
    expect(state.phase).toBe("ET_H1");
    // …and finalize is refused while undecided.
    expect(() =>
      football.apply(state, asFootball(makeEnvelope(9, { type: "core.finalize", payload: {} }))),
    ).toThrowError(expect.objectContaining({ code: "WRONG_PHASE" }));
  });

  it("goes straight to a shootout when shootout is on but ET is off", () => {
    const cfg = football.configSchema.parse({ shootout: true });
    const state = fold(cfg, stream(["core.start"], ["football.period", { phase: "HT" }], ["football.period", { phase: "FT" }]));
    expect(state.phase).toBe("SHOOTOUT");
  });

  it("rejects out-of-order period markers", () => {
    expect(() => fold(leagueCfg, stream(["core.start"], ["football.period", { phase: "FT" }]))).toThrowError(
      expect.objectContaining({ code: "WRONG_PHASE" }),
    );
  });

  it("validates substitutions against the pitch and the bench", () => {
    const base = stream(["core.start"]);
    const sub = (payload: unknown) =>
      fold(leagueCfg, [...base, makeEnvelope(1, { type: "football.sub", payload })]);
    expect(sub({ by: "H", off: "H-p1", on: "H-b1" }).squads.home.onPitch).toContain("H-b1");
    expect(() => sub({ by: "H", off: "H-b2", on: "H-b1" })).toThrowError(
      expect.objectContaining({ code: "INVALID_EVENT" }),
    );
    expect(() => sub({ by: "H", off: "H-p1", on: "A-b1" })).toThrowError(
      expect.objectContaining({ code: "INVALID_EVENT" }),
    );
    // A substituted-off player may not return.
    const twice = [
      ...base,
      makeEnvelope(1, { type: "football.sub", payload: { by: "H", off: "H-p1", on: "H-b1" } }),
      makeEnvelope(2, { type: "football.sub", payload: { by: "H", off: "H-b1", on: "H-p1" } }),
    ];
    expect(() => fold(leagueCfg, twice)).toThrowError(
      expect.objectContaining({ code: "INVALID_EVENT" }),
    );
  });

  it("flags an abandoned fixture for replay without an outcome", () => {
    const state = fold(leagueCfg, stream(["core.start"], ["football.goal", { by: "H" }], ["core.abandon", { reason: "floodlights" }]));
    expect(football.outcome(state)).toBeNull();
    expect(state.replayFlagged).toBe(true);
    expect(football.summary(state).detail).toMatchObject({ abandoned: true });
  });

  it("awards an abandoned fixture to the leader under the award policy", () => {
    const cfg = football.configSchema.parse({ abandonPolicy: "award" });
    const leader = fold(cfg, stream(["core.start"], ["football.goal", { by: "A" }], ["core.abandon", { reason: "crowd" }]));
    expect(football.outcome(leader)).toMatchObject({ kind: "award", winner: "A" });
    const level = fold(cfg, stream(["core.start"], ["core.abandon", { reason: "crowd" }]));
    expect(football.outcome(level)).toEqual({ kind: "no_result" });
  });
});

describe("football contract declarations", () => {
  it("exports both official tiebreaker presets, defaulting to fifa2026", () => {
    expect(FOOTBALL_TIEBREAKERS.fifa2026.slice(0, 4)).toEqual([
      "points",
      "h2h_points",
      "h2h_diff",
      "h2h_for",
    ]);
    expect(FOOTBALL_TIEBREAKERS.classic.slice(0, 3)).toEqual(["points", "diff", "for"]);
    expect(football.defaultTiebreakers).toEqual(FOOTBALL_TIEBREAKERS.fifa2026);
  });

  it("supports draws in league/group but never in eliminations", () => {
    expect(football.supportsDraws(leagueCfg, "league")).toBe(true);
    expect(football.supportsDraws(leagueCfg, "group")).toBe(true);
    expect(football.supportsDraws(knockoutCfg, "knockout")).toBe(false);
    expect(football.supportsDraws(knockoutCfg, "double_elim")).toBe(false);
  });

  it("declares point totals {3, 2} (+ SO split total when configured)", () => {
    expect([...football.declaredPointsSets(leagueCfg)].sort()).toEqual([2, 3]);
  });
});

// PROMPT-04 acceptance — conformance green under both configurations.
conformanceSuite(football, { cfg: {}, label: "league" });
conformanceSuite(football, {
  cfg: { extraTime: { enabled: true, halfMinutes: 15 }, shootout: true },
  label: "knockout",
  stageCtxs: [{ kind: "knockout" }, { kind: "group" }],
});
