// W4 domain audit (#407) — person attribution + scoresheet interruptions for
// the three set-based sports. Everything here is ADDITIVE: a stream that
// carries none of the new fields must fold exactly as it did before (the
// golden corpus is the other half of that proof).
import { describe, expect, it } from "vitest";
import { foldMatch, type EventEnvelope } from "../../core/events.ts";
import type { ModuleEvent } from "../../sport/module.ts";
import { aggregatePlayerStats } from "../../stats/stats.ts";
import { resolvePositions } from "../../sport/catalog.ts";
import { defaultLineupPair, makeEnvelope } from "../../testkit/helpers.ts";
import { badminton } from "./badminton.ts";
import { SetBasedEv, type SetBasedState } from "./kernel.ts";
import { tabletennis } from "./tabletennis.ts";
import { volleyball } from "./volleyball.ts";

type Mod = typeof volleyball;

function envelopes(events: ModuleEvent[]): EventEnvelope[] {
  return events.map((event, i) => makeEnvelope(i, event));
}

function fold(mod: Mod, events: ModuleEvent[], raw: unknown = {}): SetBasedState {
  const cfg = mod.configSchema.parse(raw);
  return foldMatch(
    mod,
    cfg,
    defaultLineupPair(resolvePositions(mod, cfg)),
    envelopes([{ type: "core.start", payload: {} }, ...events]),
  ) as SetBasedState;
}

const rally = (mod: Mod, payload: Record<string, unknown>): ModuleEvent => ({
  type: `${mod.key}.rally`,
  payload,
});

// ---------------------------------------------------------------------------
// Person attribution on the rally — the FIVB point-by-point grid records the
// serving player's number; the BWF/ITTF umpire sheets record the server too.
// ---------------------------------------------------------------------------
describe("set-based rally: optional person attribution", () => {
  it("credits the scorer with a point and the server with a serve", () => {
    const state = fold(volleyball, [
      rally(volleyball, { wonBy: "H", server: "H-p1", scorer: "H-p4" }),
      rally(volleyball, { wonBy: "A", server: "H-p1", scorer: "A-p2" }),
      rally(volleyball, { wonBy: "A", server: "A-p2", scorer: "A-p2" }),
    ]);
    expect(state.persons).toEqual({
      "H-p4": { points: 1, serves: 0 },
      "H-p1": { points: 0, serves: 2 },
      "A-p2": { points: 2, serves: 1 },
    });
    // The entrant-level ledger is untouched by attribution.
    expect(state.sets[0]).toEqual({ home: 1, away: 2, closed: false });
  });

  it("leaves `persons` absent when no rally names anyone (coarse scoring stays legal)", () => {
    const state = fold(volleyball, [
      rally(volleyball, { wonBy: "H" }),
      rally(volleyball, { wonBy: "A" }),
    ]);
    expect(state.persons).toBeUndefined();
    expect(Object.keys(state)).not.toContain("persons");
  });

  it("credits the same person across all three presets", () => {
    for (const mod of [volleyball, badminton, tabletennis] as Mod[]) {
      const state = fold(mod, [rally(mod, { wonBy: "H", server: "H-p1", scorer: "H-p1" })]);
      expect(state.persons, mod.key).toEqual({ "H-p1": { points: 1, serves: 1 } });
    }
  });

  it("does not leak attribution into the summary (coarsening discards persons)", () => {
    const state = fold(volleyball, [rally(volleyball, { wonBy: "H", scorer: "H-p4" })]);
    expect(volleyball.summary(state).detail).not.toHaveProperty("persons");
  });
});

// ---------------------------------------------------------------------------
// Timeouts — FIVB records team + technical timeouts, ITTF records the single
// per-match timeout. Badminton has none (intervals only), so it refuses them.
// ---------------------------------------------------------------------------
describe("set-based timeouts", () => {
  it("counts timeouts per side and marks technical ones", () => {
    const state = fold(volleyball, [
      { type: "volleyball.timeout", payload: { by: "H" } },
      { type: "volleyball.timeout", payload: { by: "A" } },
      { type: "volleyball.timeout", payload: { by: "H", technical: true } },
    ]);
    expect(state.timeouts).toEqual({ home: 2, away: 1 });
    expect(volleyball.summary(state).detail).toMatchObject({ timeouts: { home: 2, away: 1 } });
  });

  it("table tennis records a timeout; badminton refuses one (no timeouts in BWF play)", () => {
    expect(fold(tabletennis, [{ type: "tabletennis.timeout", payload: { by: "H" } }]).timeouts)
      .toEqual({ home: 1, away: 0 });
    expect(() =>
      fold(badminton, [{ type: "badminton.timeout", payload: { by: "H" } }]),
    ).toThrowError(expect.objectContaining({ code: "INVALID_EVENT" }));
  });

  it("leaves `timeouts` absent until one is called", () => {
    expect(fold(volleyball, [rally(volleyball, { wonBy: "H" })]).timeouts).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Sanctions — FIVB warning/penalty/expulsion/disqualification; the BWF card
// ladder (yellow/red/black) and the ITTF yellow/red cards map onto the same
// four levels. The point a penalty concedes is recorded as a rally, exactly as
// the scoresheet does; the sanction row is the record of the misconduct.
// ---------------------------------------------------------------------------
describe("set-based sanctions", () => {
  it("appends sanctions in order with the person when named", () => {
    const state = fold(badminton, [
      { type: "badminton.sanction", payload: { by: "H", level: "warning", person: "H-p1" } },
      { type: "badminton.sanction", payload: { by: "A", level: "penalty" } },
    ]);
    expect(state.sanctions).toEqual([
      { by: "home", level: "warning", person: "H-p1" },
      { by: "away", level: "penalty" },
    ]);
    expect(badminton.summary(state).detail).toMatchObject({
      sanctions: [
        { by: "home", level: "warning", person: "H-p1" },
        { by: "away", level: "penalty" },
      ],
    });
  });

  it("accepts every level of the ladder", () => {
    for (const level of ["warning", "penalty", "expulsion", "disqualification"] as const) {
      const state = fold(volleyball, [
        { type: "volleyball.sanction", payload: { by: "A", level } },
      ]);
      expect(state.sanctions?.[0]?.level, level).toBe(level);
    }
  });

  it("leaves `sanctions` absent until one is issued", () => {
    expect(fold(volleyball, [rally(volleyball, { wonBy: "H" })]).sanctions).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Substitutions — indoor volleyball only. The FIVB sheet records in/out player
// numbers and the per-set count (indoor allows six a set); badminton and table
// tennis have no substitutions at all.
// ---------------------------------------------------------------------------
describe("volleyball substitutions", () => {
  // W4 review item 5 — the substitution's two person fields are `off`/`on`,
  // the names football's `football.sub` has carried since before this wave.
  // The set-based kernel shipped `out`/`in` in the same wave; the incumbent
  // wins, and `in` was a poor key besides (cricket's `out` already means a
  // DISMISSAL, so a pad reading "out" across sports meant two things).
  const sub = (payload: Record<string, unknown>): ModuleEvent => ({
    type: "volleyball.sub",
    payload,
  });

  it("logs in/out players and counts them per side and per set", () => {
    const state = fold(volleyball, [
      sub({ by: "H", on: "H-p6", off: "H-p2" }),
      sub({ by: "A", on: "A-p5", off: "A-p1" }),
      sub({ by: "H", on: "H-p2", off: "H-p6" }),
    ]);
    expect(state.subs).toEqual({
      home: 2,
      away: 1,
      thisSet: { home: 2, away: 1 },
      log: [
        { by: "home", on: "H-p6", off: "H-p2" },
        { by: "away", on: "A-p5", off: "A-p1" },
        { by: "home", on: "H-p2", off: "H-p6" },
      ],
    });
    expect(volleyball.summary(state).detail).toMatchObject({
      subs: { home: 2, away: 1, thisSet: { home: 2, away: 1 } },
    });
  });

  it("resets the per-set count when a set closes but keeps the match total", () => {
    const state = fold(volleyball, [
      sub({ by: "H", on: "H-p6", off: "H-p2" }),
      { type: "volleyball.set.summary", payload: { home: 25, away: 20 } },
      sub({ by: "H", on: "H-p5", off: "H-p3" }),
    ]);
    expect(state.subs?.home).toBe(2);
    expect(state.subs?.thisSet).toEqual({ home: 1, away: 0 });
  });

  it("is refused by badminton and table tennis", () => {
    for (const mod of [badminton, tabletennis] as Mod[]) {
      expect(() => fold(mod, [{ type: `${mod.key}.sub`, payload: { by: "H" } }]), mod.key)
        .toThrowError(expect.objectContaining({ code: "INVALID_EVENT" }));
    }
  });
});

// ---------------------------------------------------------------------------
// Union disambiguation — every branch of the widened event union must still
// parse as ITSELF and fold to its own effect (z.union takes the first branch
// that parses, so widening one branch can swallow another).
// ---------------------------------------------------------------------------
describe("set-based event union stays unambiguous", () => {
  const canonical: Array<[label: string, payload: Record<string, unknown>]> = [
    ["rally", { wonBy: "H" }],
    ["attributed rally", { wonBy: "H", server: "H-p1", scorer: "H-p4" }],
    ["positional summary", { home: 25, away: 20 }],
    ["partial positional summary", { home: 12, away: 9, partial: true }],
    ["entrant-keyed summary", { by: "H", forBy: 25, forOpp: 20 }],
    ["timeout", { by: "H", technical: true }],
    ["sanction", { by: "H", level: "warning", person: "H-p1" }],
    ["substitution", { by: "H", on: "H-p6", off: "H-p2" }],
  ];

  for (const [label, payload] of canonical) {
    it(`${label} parses against eventSchema and round-trips`, () => {
      const parsed = SetBasedEv.safeParse(payload);
      expect(parsed.success, label).toBe(true);
      expect(parsed.success && parsed.data).toEqual(payload);
    });
  }

  it("each canonical payload still folds to its own effect", () => {
    expect(fold(volleyball, [rally(volleyball, { wonBy: "H" })]).sets[0]?.home).toBe(1);
    expect(
      fold(volleyball, [{ type: "volleyball.set.summary", payload: { home: 25, away: 20 } }])
        .setsWon,
    ).toEqual({ home: 1, away: 0 });
    expect(
      fold(volleyball, [
        { type: "volleyball.set.summary", payload: { by: "H", forBy: 25, forOpp: 20 } },
      ]).setsWon,
    ).toEqual({ home: 1, away: 0 });
    expect(
      fold(volleyball, [{ type: "volleyball.timeout", payload: { by: "H" } }]).timeouts,
    ).toEqual({ home: 1, away: 0 });
    expect(
      fold(volleyball, [{ type: "volleyball.sanction", payload: { by: "H", level: "warning" } }])
        .sanctions,
    ).toHaveLength(1);
    expect(fold(volleyball, [{ type: "volleyball.sub", payload: { by: "H" } }]).subs?.home).toBe(1);
  });

  it("rejects an unknown key on any branch (branches stay strict)", () => {
    expect(SetBasedEv.safeParse({ wonBy: "H", bogus: 1 }).success).toBe(false);
    expect(SetBasedEv.safeParse({ by: "H", level: "nope" }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// playerStats — the leaderboard fold that "requires detailed scoring" blocked
// while these sports could not name a person at all (Jul3/07 §3).
// ---------------------------------------------------------------------------
describe("set-based playerStats", () => {
  it("aggregates points, serves and sanctions per person", () => {
    const events = envelopes([
      { type: "core.start", payload: {} },
      rally(volleyball, { wonBy: "H", server: "H-p1", scorer: "H-p4" }),
      rally(volleyball, { wonBy: "H", server: "H-p1", scorer: "H-p4" }),
      rally(volleyball, { wonBy: "A", server: "H-p1", scorer: "A-p2" }),
      { type: "volleyball.sanction", payload: { by: "A", level: "warning", person: "A-p2" } },
    ]);
    const rows = aggregatePlayerStats(events, volleyball.playerStats!);
    expect(rows).toEqual([
      { personId: "A-p2", stats: { points: 1, sanctions: 1 } },
      { personId: "H-p1", stats: { serves: 3 } },
      { personId: "H-p4", stats: { points: 2 } },
    ]);
  });

  it("every preset declares a stat model keyed to its own event types", () => {
    for (const mod of [volleyball, badminton, tabletennis] as Mod[]) {
      const froms = new Set(mod.playerStats!.metrics.map((m) => m.from));
      expect([...froms].every((t) => t.startsWith(`${mod.key}.`)), mod.key).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Fidelity ladder — a type absent from every tier is unreachable by the pad.
// ---------------------------------------------------------------------------
describe("set-based fidelity tiers reach the new event types", () => {
  const expected: Array<[Mod, string[]]> = [
    [volleyball, ["volleyball.timeout", "volleyball.sanction", "volleyball.sub"]],
    [badminton, ["badminton.sanction"]],
    [tabletennis, ["tabletennis.timeout", "tabletennis.sanction"]],
  ];
  for (const [mod, types] of expected) {
    it(`${mod.key}: tier 3 names ${types.join(", ")}`, () => {
      const tier3 = mod.fidelityTiers.find((t) => t.tier === 3)!;
      for (const type of types) expect(tier3.eventTypes, type).toContain(type);
      // Coarse tiers stay a bare final score.
      const tier0 = mod.fidelityTiers.find((t) => t.tier === 0)!;
      for (const type of types) expect(tier0.eventTypes).not.toContain(type);
    });
    it(`${mod.key}: refuses the extension events its scoresheet does not carry`, () => {
      const all = ["timeout", "sanction", "sub"].map((s) => `${mod.key}.${s}`);
      const tier3 = mod.fidelityTiers.find((t) => t.tier === 3)!;
      for (const type of all) {
        if (types.includes(type)) continue;
        expect(tier3.eventTypes, type).not.toContain(type);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// §9.6 — interruptions must be transparent to coarsening: a rally set with a
// timeout in the middle of it must still collapse to one set summary.
// ---------------------------------------------------------------------------
describe("coarsen is transparent to interruptions", () => {
  it("a mid-set timeout does not split the set", () => {
    const cfg = badminton.configSchema.parse({});
    const pair = defaultLineupPair(badminton.positions);
    const fine: ModuleEvent[] = [{ type: "core.start", payload: {} }];
    for (let i = 0; i < 10; i++) fine.push(rally(badminton, { wonBy: "H" }));
    fine.push({ type: "badminton.sanction", payload: { by: "A", level: "warning" } });
    for (let i = 0; i < 11; i++) fine.push(rally(badminton, { wonBy: "H" }));

    const fineEnvs = envelopes(fine);
    const fineState = foldMatch(badminton, cfg, pair, fineEnvs) as SetBasedState;
    const coarse = badminton
      .coarsen!(fineEnvs as never)
      .map((event, i) => makeEnvelope(i, event));
    const coarseState = foldMatch(badminton, cfg, pair, coarse) as SetBasedState;

    expect(fineState.setsWon).toEqual({ home: 1, away: 0 });
    expect(coarseState.setsWon).toEqual(fineState.setsWon);
    expect(badminton.summary(coarseState)).toEqual(badminton.summary(fineState));
  });
});

// W4 review item 7 — `SetBasedSub` carries `in` / `out` person ids and feeds no
// player metric, on purpose: coming on is not a performance, and the allowance
// it spends is a per-side count (`State.subs`), not a personal one. Recorded
// here so the omission is a decision a future author has to overturn
// explicitly, and stated in DOMAIN.volleyball.md.
describe("substitution persons are unscored on purpose", () => {
  it("refuses the pre-unification `in`/`out` substitution keys", () => {
    expect(() =>
      fold(volleyball, [{ type: "volleyball.sub", payload: { by: "H", in: "H-p6", out: "H-p2" } }]),
    ).toThrowError(expect.objectContaining({ code: "INVALID_EVENT" }));
  });

  it("keeps every module's sub event out of playerStats", () => {
    for (const module of [volleyball, badminton, tabletennis]) {
      const sources = new Set(module.playerStats?.metrics.map((m) => m.from) ?? []);
      expect(sources.has(`${module.key}.sub`), `${module.key}.sub now feeds a metric`).toBe(false);
      if (module.playerStats !== undefined) {
        // Guards the guard: a module with no metrics at all would pass above.
        expect(sources.size, `${module.key} declares metrics`).toBeGreaterThan(0);
      }
    }
  });
});
