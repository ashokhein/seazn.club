// Period kernel golden folds — PROMPT-49 acceptance: phase progression for
// 3 periods and 4 quarters, sudden-death OT, shootout early-out and sudden-
// death pairs, suspension strength math (5v3, misconduct 5v5, FIH 10v11),
// PIM totals, OT-aware 3-2-1-0 points through StandingsDelta, FIH draws, and
// the IIHF §220 H2H-first cascade on a hand-computed 3-team tie.
import { describe, expect, it } from "vitest";
import { EngineError } from "../../core/errors.ts";
import { foldMatch, type EventEnvelope } from "../../core/events.ts";
import { rankStandings, validateCascade } from "../../competition/tiebreakers.ts";
import type { FixtureResult, StandingsRow } from "../../competition/standings.ts";
import { conformanceSuite } from "../../testkit/conformance.ts";
import { defaultLineupPair, makeEnvelope } from "../../testkit/helpers.ts";
import type { ModuleEvent } from "../../sport/module.ts";
import { aggregatePlayerStats } from "../../stats/stats.ts";
import { icehockey } from "../icehockey/icehockey.ts";
import { hockey } from "../hockey/hockey.ts";
import { expectedAdvance, type PeriodState } from "./kernel.ts";
import { shootoutDecision } from "./shootout.ts";

const iceLineups = defaultLineupPair(icehockey.positions);
const fihLineups = defaultLineupPair(hockey.positions);
const IH = iceLineups.home.entrantId;
const IA = iceLineups.away.entrantId;
const FH = fihLineups.home.entrantId;
const FA = fihLineups.away.entrantId;

const start: ModuleEvent = { type: "core.start", payload: {} };

function envelopes(events: ModuleEvent[]): EventEnvelope[] {
  return events.map((event, i) => makeEnvelope(i, event));
}

function foldIce(events: ModuleEvent[], variant?: string): PeriodState {
  const cfg = icehockey.configSchema.parse(
    variant === undefined ? {} : icehockey.variants[variant],
  );
  return foldMatch(icehockey, cfg, iceLineups, envelopes(events)) as PeriodState;
}

function foldFih(events: ModuleEvent[], variant?: string): PeriodState {
  const cfg = hockey.configSchema.parse(variant === undefined ? {} : hockey.variants[variant]);
  return foldMatch(hockey, cfg, fihLineups, envelopes(events)) as PeriodState;
}

const iceGoal = (by: string, extra?: Record<string, unknown>): ModuleEvent => ({
  type: "icehockey.goal",
  payload: { by, ...(extra ?? {}) },
});
const iceAdvance = (to: string): ModuleEvent => ({
  type: "icehockey.period.advance",
  payload: { to },
});
const fihGoal = (by: string, extra?: Record<string, unknown>): ModuleEvent => ({
  type: "hockey.goal",
  payload: { by, ...(extra ?? {}) },
});
const fihAdvance = (to: string): ModuleEvent => ({
  type: "hockey.period.advance",
  payload: { to },
});

// Full regulation with the given goals scattered in P1.
const iceRegulation = (goals: ModuleEvent[]): ModuleEvent[] => [
  start,
  ...goals,
  iceAdvance("P2"),
  iceAdvance("P3"),
  iceAdvance("FT"),
];
const fihRegulation = (goals: ModuleEvent[]): ModuleEvent[] => [
  start,
  ...goals,
  fihAdvance("Q2"),
  fihAdvance("Q3"),
  fihAdvance("Q4"),
  fihAdvance("FT"),
];

describe("period kernel — phase machine", () => {
  it("walks P1→P2→P3→FT and decides a regulation win", () => {
    const state = foldIce(iceRegulation([iceGoal(IH), iceGoal(IH), iceGoal(IA)]));
    expect(state.outcome).toEqual({ kind: "win", winner: IH, loser: IA, method: "regulation" });
    expect(state.periods.map((p) => p.phase)).toEqual(["P1", "P2", "P3"]);
  });

  it("walks Q1..Q4 for quarters and finalizes a FIH draw", () => {
    const state = foldFih(fihRegulation([fihGoal(FH), fihGoal(FA)]));
    expect(state.outcome).toEqual({ kind: "draw" });
    expect(state.periods.map((p) => p.phase)).toEqual(["Q1", "Q2", "Q3", "Q4"]);
  });

  it("rejects an out-of-order advance with the expected target", () => {
    expect(() => foldIce([start, iceAdvance("P3")])).toThrowError(EngineError);
    const fresh = foldIce([start]);
    expect(expectedAdvance(fresh)).toBe("P2");
  });

  it("level after 60' enters sudden-death OT; the first goal ends it", () => {
    const toOt = iceRegulation([iceGoal(IH), iceGoal(IA)]);
    const atOt = foldIce(toOt);
    expect(atOt.phase).toBe("OT");
    const done = foldIce([...toOt, iceGoal(IA)]);
    expect(done.outcome).toEqual({ kind: "win", winner: IA, loser: IH, method: "extra_time" });
  });

  it("scoreless OT rolls into the GWS; attempts alternate and early-out", () => {
    const toSo = [...iceRegulation([]), iceAdvance("FT")];
    const atSo = foldIce(toSo);
    expect(atSo.phase).toBe("SHOOTOUT");
    // H scores 3, A misses 3 → decided after A's third miss (3 > 0 + 2 left).
    const attempts: ModuleEvent[] = [];
    for (let i = 0; i < 3; i++) {
      attempts.push({ type: "icehockey.shootout.attempt", payload: { by: IH, scored: true } });
      attempts.push({ type: "icehockey.shootout.attempt", payload: { by: IA, scored: false } });
    }
    const done = foldIce([...toSo, ...attempts]);
    expect(done.outcome).toEqual({ kind: "win", winner: IH, loser: IA, method: "shootout" });
    // A fourth attempt is rejected — already decided.
    expect(() =>
      foldIce([
        ...toSo,
        ...attempts,
        { type: "icehockey.shootout.attempt", payload: { by: IH, scored: true } },
      ]),
    ).toThrowError(EngineError);
  });

  it("sudden-death pairs after five: decision only once the pair completes", () => {
    // 5 scored each → 5-5 after regulation attempts; SD pair: H scores, A misses.
    const kicks = [] as { side: "home" | "away"; scored: boolean }[];
    for (let i = 0; i < 5; i++) {
      kicks.push({ side: "home", scored: true }, { side: "away", scored: true });
    }
    expect(shootoutDecision(kicks, 5)).toBeNull();
    kicks.push({ side: "home", scored: true });
    expect(shootoutDecision(kicks, 5)).toBeNull(); // pair incomplete
    kicks.push({ side: "away", scored: false });
    expect(shootoutDecision(kicks, 5)).toBe("home");
  });
});

const minor = (by: string, person?: string): ModuleEvent => ({
  type: "icehockey.suspension.start",
  payload: { by, class: "minor", ...(person === undefined ? {} : { person }) },
});
const release = (by: string, cls: string): ModuleEvent => ({
  type: "icehockey.suspension.end",
  payload: { by, class: cls },
});

describe("period kernel — suspensions & strength", () => {
  it("two minors → 5v3; release restores 5v4 then 5v5", () => {
    const twoMinors = [start, minor(IA), minor(IA)];
    const at53 = foldIce(twoMinors);
    expect((icehockey.summary(at53).detail as { strength: string }).strength).toBe("5v3");
    const at54 = foldIce([...twoMinors, release(IA, "minor")]);
    expect((icehockey.summary(at54).detail as { strength: string }).strength).toBe("5v4");
    const at55 = foldIce([...twoMinors, release(IA, "minor"), release(IA, "minor")]);
    expect((icehockey.summary(at55).detail as { strength: string | null }).strength).toBeNull();
  });

  it("misconduct keeps 5v5 but records 10 PIM", () => {
    const state = foldIce(
      iceRegulation([
        iceGoal(IH),
        { type: "icehockey.suspension.start", payload: { by: IA, class: "misconduct" } },
      ]),
    );
    const summary = icehockey.summary(state).detail as { strength: string | null };
    const outcome = state.outcome;
    expect(outcome?.kind).toBe("win");
    const [, awayDelta] = icehockey.standingsDelta(outcome!, state.cfg, { kind: "league" }, state);
    expect(awayDelta.metrics.pim).toBe(10);
    expect(summary.strength).toBeNull(); // never went short
  });

  it("FIH yellow → 10v11 team-short chip; green then another green flags escalation", () => {
    const p1 = fihLineups.away.slots[0]!.personId;
    const carded = [
      start,
      { type: "hockey.suspension.start", payload: { by: FA, person: p1, class: "green" } },
    ] as ModuleEvent[];
    const detail = hockey.summary(foldFih(carded)).detail as {
      strength: string;
      escalate: string[];
    };
    expect(detail.strength).toBe("11v10");
    expect(detail.escalate).toEqual([p1]);
    const yellow = foldFih([
      ...carded,
      { type: "hockey.suspension.end", payload: { by: FA, class: "green" } },
      { type: "hockey.suspension.start", payload: { by: FA, class: "yellow" } },
    ]);
    expect((hockey.summary(yellow).detail as { strength: string }).strength).toBe("11v10");
  });

  it("a red card cannot be released", () => {
    const red = [
      start,
      { type: "hockey.suspension.start", payload: { by: FA, class: "red" } },
    ] as ModuleEvent[];
    expect(() =>
      foldFih([...red, { type: "hockey.suspension.end", payload: { by: FA, class: "red" } }]),
    ).toThrowError(EngineError);
  });

  it("team PIM totals: minor + double minor + match = 2 + 4 + 25 = 31", () => {
    const state = foldIce(
      iceRegulation([
        iceGoal(IH),
        minor(IA),
        { type: "icehockey.suspension.start", payload: { by: IA, class: "double_minor" } },
        { type: "icehockey.suspension.start", payload: { by: IA, class: "match" } },
      ]),
    );
    const [, awayDelta] = icehockey.standingsDelta(
      state.outcome!,
      state.cfg,
      { kind: "league" },
      state,
    );
    expect(awayDelta.metrics.pim).toBe(31);
  });
});

describe("period kernel — OT-aware points (Event Code §219)", () => {
  const deltasFor = (events: ModuleEvent[]): [number, number] => {
    const state = foldIce(events);
    const [h, a] = icehockey.standingsDelta(state.outcome!, state.cfg, { kind: "league" }, state);
    return [h.points, a.points];
  };

  it("regulation win 3/0 · OT win 2/1 · GWS win 2/1", () => {
    expect(deltasFor(iceRegulation([iceGoal(IH)]))).toEqual([3, 0]);
    expect(deltasFor([...iceRegulation([iceGoal(IH), iceGoal(IA)]), iceGoal(IH)])).toEqual([2, 1]);
    const gws = [
      ...iceRegulation([]),
      iceAdvance("FT"),
      { type: "icehockey.shootout.attempt", payload: { by: IA, scored: true } },
      { type: "icehockey.shootout.attempt", payload: { by: IH, scored: false } },
      { type: "icehockey.shootout.attempt", payload: { by: IA, scored: true } },
      { type: "icehockey.shootout.attempt", payload: { by: IH, scored: false } },
      { type: "icehockey.shootout.attempt", payload: { by: IA, scored: true } },
      { type: "icehockey.shootout.attempt", payload: { by: IH, scored: false } },
    ] as ModuleEvent[];
    expect(deltasFor(gws)).toEqual([1, 2]);
  });

  it("FIH draw yields 1/1 with a drawn row each", () => {
    const state = foldFih(fihRegulation([fihGoal(FH), fihGoal(FA)]));
    const [h, a] = hockey.standingsDelta(state.outcome!, state.cfg, { kind: "league" }, state);
    expect([h.points, a.points]).toEqual([1, 1]);
    expect([h.drawn, a.drawn]).toEqual([1, 1]);
  });

  it("fih-shootout: SO win pays the bonus point split 2/1", () => {
    const so = [
      ...fihRegulation([fihGoal(FH), fihGoal(FA)]).slice(0, -1),
      fihAdvance("FT"),
    ] as ModuleEvent[];
    // fih-shootout config resolves the level Q4 end into a shootout.
    const atSo = foldFih(so, "fih-shootout");
    expect(atSo.phase).toBe("SHOOTOUT");
    const done = foldFih(
      [
        ...so,
        { type: "hockey.shootout.attempt", payload: { by: FH, scored: true, meta: { clockSeconds: 8 } } },
        { type: "hockey.shootout.attempt", payload: { by: FA, scored: false } },
        { type: "hockey.shootout.attempt", payload: { by: FH, scored: true } },
        { type: "hockey.shootout.attempt", payload: { by: FA, scored: false } },
        { type: "hockey.shootout.attempt", payload: { by: FH, scored: true } },
        { type: "hockey.shootout.attempt", payload: { by: FA, scored: false } },
      ],
      "fih-shootout",
    );
    const [h, a] = hockey.standingsDelta(done.outcome!, done.cfg, { kind: "league" }, done);
    expect([h.points, a.points]).toEqual([2, 1]);
  });
});

describe("period kernel — goals, assists, kinds", () => {
  it("PP goal with an assist feeds kind counts and player stats (array field)", () => {
    const scorer = iceLineups.home.slots[1]!.personId;
    const helper1 = iceLineups.home.slots[2]!.personId;
    const helper2 = iceLineups.home.slots[3]!.personId;
    const events = iceRegulation([
      iceGoal(IH, { person: scorer, assists: [helper1, helper2], kind: "pp" }),
    ]);
    const state = foldIce(events);
    const [homeDelta] = icehockey.standingsDelta(
      state.outcome!,
      state.cfg,
      { kind: "league" },
      state,
    );
    expect(homeDelta.metrics.goals_pp).toBe(1);
    const rows = aggregatePlayerStats(envelopes(events), icehockey.playerStats!);
    expect(rows.find((r) => r.personId === scorer)?.stats.goals).toBe(1);
    expect(rows.find((r) => r.personId === helper1)?.stats.assists).toBe(1);
    expect(rows.find((r) => r.personId === helper2)?.stats.assists).toBe(1);
    expect(rows.find((r) => r.personId === helper1)?.stats.points).toBe(1);
  });

  it("rejects a FIH goal kind on ice and an own goal with assists", () => {
    expect(() => foldIce([start, iceGoal(IH, { kind: "pc" })])).toThrowError(EngineError);
    expect(() =>
      foldIce([start, iceGoal(IH, { kind: "og", assists: ["x"] })]),
    ).toThrowError(EngineError);
  });

  it("FIH penalty-corner goal counts toward goals_pc", () => {
    const state = foldFih(fihRegulation([fihGoal(FH, { kind: "pc" }), fihGoal(FH)]));
    const [h] = hockey.standingsDelta(state.outcome!, state.cfg, { kind: "league" }, state);
    expect(h.metrics.goals_pc).toBe(1);
    expect(h.metrics.gf).toBe(2);
  });
});

describe("period kernel — headline grammar (v6/00 §5)", () => {
  it("ice: '2 — 1 · P3', OT '(OT)', GWS '(GWS 2–1)'", () => {
    const p3 = foldIce([start, iceGoal(IH), iceGoal(IH), iceGoal(IA), iceAdvance("P2"), iceAdvance("P3")]);
    expect(icehockey.summary(p3).headline).toBe("2 — 1 · P3");
    const ot = foldIce([...iceRegulation([iceGoal(IH), iceGoal(IA)]), iceGoal(IH)]);
    expect(icehockey.summary(ot).headline).toBe("2 — 1 (OT)");
    const gws = foldIce([
      ...iceRegulation([]),
      iceAdvance("FT"),
      { type: "icehockey.shootout.attempt", payload: { by: IH, scored: true } },
      { type: "icehockey.shootout.attempt", payload: { by: IA, scored: false } },
    ]);
    expect(icehockey.summary(gws).headline).toBe("0 — 0 (GWS 1–0)");
  });

  it("FIH: '1 — 1 · Q4' and '(SO 3–2)' suffix", () => {
    const q4 = foldFih([
      start,
      fihGoal(FH),
      fihGoal(FA),
      fihAdvance("Q2"),
      fihAdvance("Q3"),
      fihAdvance("Q4"),
    ]);
    expect(hockey.summary(q4).headline).toBe("1 — 1 · Q4");
  });
});

describe("icehockey cascade — IIHF §220 hand-computed 3-team tie", () => {
  it("validates and orders the sub-group by H2H points, then H2H diff", () => {
    validateCascade(icehockey.defaultTiebreakers, { metrics: icehockey.metrics });
    // Three teams on 6 points. Head-to-head mini-table (each played each
    // once): A beat B 5–0, B beat C 3–2, C beat A 2–1 → all 3 H2H points;
    // H2H diff: A +4, B −2, C −2; H2H for: B 3, C 4 → order A, C, B.
    const rows: StandingsRow[] = [
      { entrantId: "A", played: 5, won: 2, drawn: 0, lost: 3, points: 6, metrics: { gf: 10, ga: 8, gd: 2 } },
      { entrantId: "B", played: 5, won: 2, drawn: 0, lost: 3, points: 6, metrics: { gf: 9, ga: 7, gd: 2 } },
      { entrantId: "C", played: 5, won: 2, drawn: 0, lost: 3, points: 6, metrics: { gf: 8, ga: 6, gd: 2 } },
    ];
    const h2h = [
      [
        { entrantId: "A", played: 1, won: 1, drawn: 0, lost: 0, points: 3, metrics: { gf: 5, ga: 0, gd: 5 } },
        { entrantId: "B", played: 1, won: 0, drawn: 0, lost: 1, points: 0, metrics: { gf: 0, ga: 5, gd: -5 } },
      ],
      [
        { entrantId: "B", played: 1, won: 1, drawn: 0, lost: 0, points: 3, metrics: { gf: 3, ga: 2, gd: 1 } },
        { entrantId: "C", played: 1, won: 0, drawn: 0, lost: 1, points: 0, metrics: { gf: 2, ga: 3, gd: -1 } },
      ],
      [
        { entrantId: "C", played: 1, won: 1, drawn: 0, lost: 0, points: 3, metrics: { gf: 2, ga: 1, gd: 1 } },
        { entrantId: "A", played: 1, won: 0, drawn: 0, lost: 1, points: 0, metrics: { gf: 1, ga: 2, gd: -1 } },
      ],
    ] as FixtureResult[];
    const ranked = rankStandings(rows, { cascade: icehockey.defaultTiebreakers, results: h2h });
    expect(ranked.rows.map((r) => r.entrantId)).toEqual(["A", "C", "B"]);
  });
});

// Cross-sport invariants over generated streams — both hockeys, plus the
// structurally different variants (rec ice = draws; FIH shootout).
conformanceSuite(icehockey);
conformanceSuite(icehockey, { cfg: icehockey.variants["recreational"], label: "recreational" });
conformanceSuite(hockey);
conformanceSuite(hockey, { cfg: hockey.variants["fih-shootout"], label: "fih-shootout" });
