// Set-based goldens + property + conformance — spec 04 §3–5, PROMPT-06 §4–5.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { foldMatch, type CoreEv, type EventEnvelope } from "../../core/events.ts";
import { mulberry32 } from "../../core/rng.ts";
import type { LineupPair } from "../../core/types.ts";
import { conformanceSuite, defaultLineupPair, makeEnvelope } from "../../testkit/index.ts";
import { badminton } from "./badminton.ts";
import type { SetBasedCfg, SetBasedEv, SetBasedState } from "./kernel.ts";
import { makeSetBasedModule } from "./kernel.ts";
import { tabletennis } from "./tabletennis.ts";
import { volleyball } from "./volleyball.ts";

type Side = "home" | "away";
type Mod = ReturnType<typeof makeSetBasedModule>;

const asEv = (event: EventEnvelope) => event as EventEnvelope<SetBasedEv | CoreEv>;

function lineups(mod: Mod): LineupPair {
  return defaultLineupPair(mod.positions);
}

// Build an event stream from bare [type, payload] specs.
function stream(...specs: Array<[type: string, payload?: unknown]>): EventEnvelope[] {
  return specs.map(([type, payload], i) => makeEnvelope(i, { type, payload: payload ?? {} }));
}

// core.start + one summary per (home,away) set score.
function summaryMatch(mod: Mod, scores: Array<[number, number]>): EventEnvelope[] {
  const type = `${mod.key}.${mod.key === "volleyball" ? "set.summary" : "game.summary"}`;
  return stream(
    ["core.start"],
    ...scores.map(([home, away]) => [type, { home, away }] as [string, unknown]),
  );
}

// core.start + a rally per winner side.
function rallyMatch(mod: Mod, winners: Side[]): EventEnvelope[] {
  const ls = lineups(mod);
  const id = (s: Side) => (s === "home" ? ls.home.entrantId : ls.away.entrantId);
  return stream(
    ["core.start"],
    ...winners.map((s) => [`${mod.key}.rally`, { wonBy: id(s) }] as [string, unknown]),
  );
}

function fold(mod: Mod, cfg: SetBasedCfg, events: EventEnvelope[]): SetBasedState {
  return foldMatch(mod, cfg, lineups(mod), events) as SetBasedState;
}

// ---------------------------------------------------------------------------
// PROMPT-06 §4 (a) — volleyball 3-2 (25-20, 23-25, 25-18, 24-26, 15-13) → 2:1.
// ---------------------------------------------------------------------------
describe("volleyball golden: 3-2 → 2:1 points split", () => {
  const cfg = volleyball.configSchema.parse({});
  const events = summaryMatch(volleyball, [
    [25, 20],
    [23, 25],
    [25, 18],
    [24, 26],
    [15, 13], // deciding set to finalSetTo 15
  ]);

  it("decides for home and banks a 3-2 set score", () => {
    const state = fold(volleyball, cfg, events);
    expect(state.outcome).toEqual({ kind: "win", winner: "H", loser: "A", method: "regulation" });
    expect(state.setsWon).toEqual({ home: 3, away: 2 });
    // v3/09 §1a: the headline carries the per-set points (racquet scoreline).
    expect(volleyball.summary(state).headline).toBe("3 — 2 · 25–20, 23–25, 25–18, 24–26, 15–13");
  });

  it("pays the FIVB 3-2 split 2:1 with integer point ledgers", () => {
    const state = fold(volleyball, cfg, events);
    const [home, away] = volleyball.standingsDelta(state.outcome!, cfg, { kind: "league" }, state);
    expect(home).toMatchObject({
      entrantId: "H",
      won: 1,
      points: 2,
      metrics: { sets_won: 3, sets_lost: 2, points_won: 112, points_lost: 102 },
    });
    expect(away).toMatchObject({
      entrantId: "A",
      lost: 1,
      points: 1,
      metrics: { sets_won: 2, sets_lost: 3, points_won: 102, points_lost: 112 },
    });
    // §9.3 — a volleyball fixture always totals 3 points.
    expect(home.points + away.points).toBe(3);
    expect([...volleyball.declaredPointsSets(cfg)]).toEqual([3]);
  });
});

// ---------------------------------------------------------------------------
// PROMPT-06 §4 — a 32-30 extended (uncapped) volleyball set.
// ---------------------------------------------------------------------------
describe("volleyball golden: 32-30 extended set (uncapped win-by-two)", () => {
  const cfg = volleyball.configSchema.parse({});

  it("accepts 32-30 as a reachable set and rejects 33-30 / 25-24", () => {
    const decided = fold(volleyball, cfg, summaryMatch(volleyball, [[32, 30], [25, 12], [25, 20]]));
    expect(decided.sets[0]).toEqual({ home: 32, away: 30, closed: true });
    expect(decided.outcome).toMatchObject({ kind: "win", winner: "H" });

    // 33-30 could never occur (the set ended at 32-30) — reachability rejects it.
    expect(() => fold(volleyball, cfg, summaryMatch(volleyball, [[33, 30]]))).toThrowError(
      expect.objectContaining({ code: "INVALID_EVENT" }),
    );
    // 25-24 is not a win (margin 1, no cap).
    expect(() => fold(volleyball, cfg, summaryMatch(volleyball, [[25, 24]]))).toThrowError(
      expect.objectContaining({ code: "INVALID_EVENT" }),
    );
    // 26-24 is the minimal deuce win — accepted.
    expect(fold(volleyball, cfg, summaryMatch(volleyball, [[26, 24]])).sets[0]).toMatchObject({
      home: 26,
      away: 24,
      closed: true,
    });
  });

  it("closes an uncapped rally set only at a two-point margin", () => {
    // 30-30 then home takes two straight → 32-30.
    const winners: Side[] = [];
    for (let i = 0; i < 30; i++) winners.push("home", "away"); // 30-30
    winners.push("home", "home"); // 32-30
    const state = fold(volleyball, cfg, rallyMatch(volleyball, winners));
    expect(state.sets[0]).toEqual({ home: 32, away: 30, closed: true });
    expect(state.setsWon).toEqual({ home: 1, away: 0 });
  });
});

// ---------------------------------------------------------------------------
// PROMPT-06 §4 — badminton golden point 30-29 (hard cap 30).
// ---------------------------------------------------------------------------
describe("badminton golden: 30-29 golden point", () => {
  const cfg = badminton.configSchema.parse({});

  it("closes a rally game at the cap 30-29 and wins the match 2-0", () => {
    const winners: Side[] = [];
    for (let i = 0; i < 29; i++) winners.push("home", "away"); // 29-29
    winners.push("home"); // 30-29 golden point → game 1 to home
    for (let i = 0; i < 21; i++) winners.push("home"); // 21-0 → game 2, match over
    const state = fold(badminton, cfg, rallyMatch(badminton, winners));
    expect(state.sets[0]).toEqual({ home: 30, away: 29, closed: true });
    expect(state.outcome).toMatchObject({ kind: "win", winner: "H", method: "regulation" });
    expect(state.setsWon).toEqual({ home: 2, away: 0 });
    const [home, away] = badminton.standingsDelta(state.outcome!, cfg, { kind: "league" }, state);
    expect([home.points, away.points]).toEqual([2, 0]);
  });

  it("validates cap corners via summaries (30-29 ok · 31-30 / 22-19 / 29-29 rejected · 22-20 ok)", () => {
    const ok = (h: number, a: number) =>
      fold(badminton, cfg, summaryMatch(badminton, [[h, a]])).sets[0];
    const bad = (h: number, a: number) =>
      expect(() => fold(badminton, cfg, summaryMatch(badminton, [[h, a]]))).toThrowError(
        expect.objectContaining({ code: "INVALID_EVENT" }),
      );
    expect(ok(30, 29)).toMatchObject({ home: 30, away: 29, closed: true });
    expect(ok(22, 20)).toMatchObject({ home: 22, away: 20, closed: true });
    bad(31, 30); // beyond the cap — unreachable
    bad(22, 19); // already won at 21-19
    bad(29, 29); // not terminal
  });

  it("headline shows the open game's live points AND keeps banked game points (v3/09 §1a)", () => {
    // 3 rallies into game 1: sets 0-0, live points 2-1.
    const winners: Side[] = ["home", "away", "home"];
    const mid = fold(badminton, cfg, rallyMatch(badminton, winners));
    expect(badminton.summary(mid).headline).toBe("0 — 0 (2–1)");

    // Game 1 closes 21-1: the entered/earned points stay in the top score —
    // the intake #28a regression was the headline collapsing to just "1 — 0".
    for (let i = 0; i < 19; i++) winners.push("home");
    const closed = fold(badminton, cfg, rallyMatch(badminton, winners));
    expect(closed.setsWon).toEqual({ home: 1, away: 0 });
    expect(badminton.summary(closed).headline).toBe("1 — 0 · 21–1");

    // 1 rally into game 2: banked set points plus fresh live points.
    winners.push("away");
    const second = fold(badminton, cfg, rallyMatch(badminton, winners));
    expect(badminton.summary(second).headline).toBe("1 — 0 · 21–1 (0–1)");
  });

  it("a game entered as a summary is reflected in the headline (intake #28a)", () => {
    const one = fold(badminton, cfg, summaryMatch(badminton, [[21, 15]]));
    expect(badminton.summary(one).headline).toBe("1 — 0 · 21–15");
    const two = fold(badminton, cfg, summaryMatch(badminton, [[21, 15], [21, 18]]));
    expect(badminton.summary(two).headline).toBe("2 — 0 · 21–15, 21–18");
    expect(two.outcome).toMatchObject({ kind: "win", winner: "H" });
  });
});

// ---------------------------------------------------------------------------
// PROMPT-06 §4 — table tennis 4-3 in a best-of-7.
// ---------------------------------------------------------------------------
describe("tabletennis golden: 4-3 in best-of-7", () => {
  const cfg = tabletennis.configSchema.parse({ bestOf: 7 });

  it("goes the distance to a 7th deciding game", () => {
    const state = fold(
      tabletennis,
      cfg,
      summaryMatch(tabletennis, [
        [11, 7], // H
        [9, 11], // A
        [11, 8], // H
        [7, 11], // A
        [11, 9], // H
        [8, 11], // A
        [11, 9], // H — decider (game 7)
      ]),
    );
    expect(state.setsWon).toEqual({ home: 4, away: 3 });
    expect(state.outcome).toMatchObject({ kind: "win", winner: "H", method: "regulation" });
    const [home, away] = tabletennis.standingsDelta(state.outcome!, cfg, { kind: "league" }, state);
    expect([home.points, away.points]).toEqual([2, 0]);
  });

  it("rejects 11-10 (margin 1) and accepts 12-10 (deuce)", () => {
    expect(() => fold(tabletennis, cfg, summaryMatch(tabletennis, [[11, 10]]))).toThrowError(
      expect.objectContaining({ code: "INVALID_EVENT" }),
    );
    expect(fold(tabletennis, cfg, summaryMatch(tabletennis, [[12, 10]])).sets[0]).toMatchObject({
      home: 12,
      away: 10,
      closed: true,
    });
  });

  it("does not decide before a side reaches 4 sets", () => {
    const cfg7 = tabletennis.configSchema.parse({ bestOf: 7 });
    const state = fold(
      tabletennis,
      cfg7,
      summaryMatch(tabletennis, [[11, 0], [11, 0], [11, 0]]), // 3-0, still live
    );
    expect(tabletennis.outcome(state)).toBeNull();
    expect(state.setsWon).toEqual({ home: 3, away: 0 });
  });
});

// ---------------------------------------------------------------------------
// Forfeit / abandon / finalize.
// ---------------------------------------------------------------------------
describe("set-based match lifecycle", () => {
  const cfg = volleyball.configSchema.parse({});

  it("awards a forfeited match to the opponent with clean-sweep points", () => {
    const state = fold(
      volleyball,
      cfg,
      stream(["core.start"], [`volleyball.set.summary`, { home: 25, away: 20 }], [
        "core.forfeit",
        { by: "A", reason: "injury, no subs" },
      ]),
    );
    expect(state.outcome).toEqual({ kind: "award", winner: "H" });
    const [home, away] = volleyball.standingsDelta(state.outcome!, cfg, { kind: "league" }, state);
    expect([home.points, away.points]).toEqual([3, 0]);
    expect(home.points + away.points).toBe(3); // still inside declaredPointsSets
  });

  it("leaves an abandoned match undecided and flagged, and refuses finalize", () => {
    const state = fold(
      volleyball,
      cfg,
      stream(["core.start"], ["volleyball.rally", { wonBy: "H" }], ["core.abandon", { reason: "power cut" }]),
    );
    expect(volleyball.outcome(state)).toBeNull();
    expect(state.replayFlagged).toBe(true);
    expect(volleyball.summary(state).detail).toMatchObject({ abandoned: true });
    expect(() =>
      volleyball.apply(state, asEv(makeEnvelope(9, { type: "core.finalize", payload: {} }))),
    ).toThrowError(expect.objectContaining({ code: "WRONG_PHASE" }));
  });

  it("never supports draws in any stage", () => {
    for (const stage of ["league", "group", "swiss", "knockout"] as const) {
      expect(volleyball.supportsDraws(cfg, stage)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Dual fidelity (spec 04 §9.6) — coarsen(rally stream) ≡ summaries.
// ---------------------------------------------------------------------------

// Seeded rally match: alternate-ish random rallies until the match decides.
function simulateRallies(mod: Mod, cfg: SetBasedCfg, seed: number, maxRallies: number): EventEnvelope[] {
  const ls = lineups(mod);
  const rng = mulberry32(seed);
  const events: EventEnvelope[] = [makeEnvelope(0, { type: "core.start", payload: {} })];
  let state = mod.init(cfg, ls);
  state = mod.apply(state, asEv(events[0] as EventEnvelope));
  for (let seq = 1; seq <= maxRallies; seq++) {
    if (mod.outcome(state) !== null) break;
    const wonBy = rng() < 0.5 ? ls.home.entrantId : ls.away.entrantId;
    const ev = makeEnvelope(seq, { type: `${mod.key}.rally`, payload: { wonBy } });
    state = mod.apply(state, asEv(ev));
    events.push(ev);
  }
  return events;
}

describe("dual fidelity: coarsen(rally stream) folds identically", () => {
  const cases: Array<[string, Mod]> = [
    ["volleyball", volleyball],
    ["badminton", badminton],
    ["tabletennis", tabletennis],
  ];

  for (const [name, mod] of cases) {
    const cfg = mod.configSchema.parse({});

    it(`${name}: a decided rally match coarsens to summaries`, () => {
      const fine = simulateRallies(mod, cfg, 12345, 4000);
      const fineState = fold(mod, cfg, fine);
      expect(mod.outcome(fineState)).not.toBeNull(); // sanity: it terminated

      const coarse = mod
        .coarsen!(fine.map(asEv))
        .map((ev, i) => makeEnvelope(i, ev));
      const coarseState = fold(mod, cfg, coarse);
      expect(mod.outcome(coarseState)).toEqual(mod.outcome(fineState));
      expect(mod.summary(coarseState)).toEqual(mod.summary(fineState));
    });

    it(`${name}: a mid-set (undecided) prefix coarsens to a matching partial`, () => {
      const full = simulateRallies(mod, cfg, 99, 4000);
      // A prefix that stops part-way into some set (undecided, open set present).
      const prefix = full.slice(0, Math.min(full.length - 1, 7));
      const fineState = fold(mod, cfg, prefix);
      const coarse = mod.coarsen!(prefix.map(asEv)).map((ev, i) => makeEnvelope(i, ev));
      const coarseState = fold(mod, cfg, coarse);
      expect(mod.summary(coarseState)).toEqual(mod.summary(fineState));
      expect(mod.outcome(coarseState)).toEqual(mod.outcome(fineState));
    });
  }
});

// ---------------------------------------------------------------------------
// PROMPT-06 §5 — properties.
// ---------------------------------------------------------------------------

// Independent re-derivation of the set predicate (kept separate from the kernel
// so the property test is a genuine cross-check, not a tautology).
function targetFor(cfg: SetBasedCfg, setIndex: number): number {
  return setIndex === cfg.bestOf - 1 ? cfg.finalSetTo : cfg.setTo;
}
function isTerminal(h: number, a: number, target: number, winBy: number, cap: number | null): boolean {
  const hi = Math.max(h, a);
  const lo = Math.min(h, a);
  if (h === a) return false;
  if (cap !== null && hi >= cap) return true;
  return hi >= target && hi - lo >= winBy;
}
function isReachable(h: number, a: number, target: number, winBy: number, cap: number | null): boolean {
  if (!isTerminal(h, a, target, winBy, cap)) return false;
  const [ph, pa] = h > a ? [h - 1, a] : [h, a - 1];
  return !isTerminal(ph, pa, target, winBy, cap);
}

describe("set-based properties (PROMPT-06 §5)", () => {
  const mods: Array<[string, Mod]> = [
    ["volleyball", volleyball],
    ["badminton", badminton],
    ["tabletennis", tabletennis],
  ];

  for (const [name, mod] of mods) {
    const cfg = mod.configSchema.parse({});

    it(`${name}: every closed set is a reachable terminal score; the decision satisfies the predicate`, () => {
      fc.assert(
        fc.property(fc.nat(), fc.integer({ min: 1, max: 60 }), (seed, length) => {
          const events = buildFromGenerator(mod, cfg, seed, length);
          const state = fold(mod, cfg, events);
          state.sets.forEach((set, i) => {
            if (!set.closed) return;
            const target = targetFor(cfg, i);
            expect(isReachable(set.home, set.away, target, cfg.winBy, cfg.cap)).toBe(true);
          });
          const outcome = mod.outcome(state);
          if (outcome !== null && outcome.kind === "win") {
            const majority = Math.ceil(cfg.bestOf / 2);
            expect(Math.max(state.setsWon.home, state.setsWon.away)).toBe(majority);
          }
        }),
        { numRuns: 200 },
      );
    });

    it(`${name}: a random rally stream always terminates a set (bounded)`, () => {
      for (let seed = 0; seed < 20; seed++) {
        const events = simulateRallies(mod, cfg, seed + 1, 2000);
        const state = fold(mod, cfg, events);
        // Either the match decided, or at least one set closed within the budget.
        const closedSets = state.sets.filter((s) => s.closed).length;
        expect(closedSets).toBeGreaterThan(0);
      }
    });
  }

  it("volleyball (cap = null): a closed set never ends below the win-by margin", () => {
    const cfg = volleyball.configSchema.parse({});
    for (let seed = 0; seed < 25; seed++) {
      const state = fold(volleyball, cfg, simulateRallies(volleyball, cfg, seed * 7 + 3, 4000));
      for (const set of state.sets) {
        if (set.closed) expect(Math.abs(set.home - set.away)).toBeGreaterThanOrEqual(cfg.winBy);
      }
    }
  });
});

// Grow a valid stream by walking the module's own generator (mirrors the
// testkit's buildStream but local to keep the property self-contained).
function buildFromGenerator(mod: Mod, cfg: SetBasedCfg, seed: number, maxEvents: number): EventEnvelope[] {
  const ls = lineups(mod);
  const rng = mulberry32(seed);
  let state = mod.init(cfg, ls);
  const events: EventEnvelope[] = [];
  for (let i = 0; i < maxEvents; i++) {
    const next = mod.arbitraryEvent!(state, rng);
    if (!next) break;
    const ev = makeEnvelope(events.length, next);
    state = mod.apply(state, asEv(ev));
    events.push(ev);
  }
  return events;
}

// ---------------------------------------------------------------------------
// Conformance — spec 04 §9, green for all three presets at their default cfg.
// ---------------------------------------------------------------------------
conformanceSuite(volleyball);
conformanceSuite(badminton);
conformanceSuite(tabletennis);
