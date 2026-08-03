// W4a (#425) §5.3 — the ITTF expedite system on the set-based kernel.
//
// Law 2.15 in three parts, and each one is a test below:
//   2.15.1  expedite is introduced when a game reaches 10 minutes unfinished
//           (or earlier by agreement), unless both players have reached 9.
//           The TEN-MINUTE TRIGGER IS THE PAD'S — the engine only records that
//           it fired, as `<key>.expedite.start`.
//   2.15.2  under expedite the RECEIVER wins the point if they make 13 good
//           returns. `returns` counts the RECEIVER'S good returns, not the
//           rally's stroke count.
//   2.15.4  once introduced, expedite runs to the end of the MATCH. A new game
//           does not clear it — the single fact most implementations get wrong.
//
// Enforcement is CONDITIONAL, and deliberately so: the set-based kernel holds
// no serving state (`payload.server` is a PERSON feeding a `serves` tally), so
// the receiver can only be named when the rally itself carries `serving`.
// Where it does not, the rally is counted unenforceable and stands.
import { describe, expect, it } from "vitest";
import { foldMatch, type EventEnvelope } from "../../core/events.ts";
import { resolvePositions } from "../../sport/catalog.ts";
import type { ModuleEvent } from "../../sport/module.ts";
import { defaultLineupPair, makeEnvelope } from "../../testkit/helpers.ts";
import { badminton } from "./badminton.ts";
import { SetBasedEv, type SetBasedState } from "./kernel.ts";
import { tabletennis } from "./tabletennis.ts";
import { volleyball } from "./volleyball.ts";

type Mod = typeof tabletennis;

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

const rally = (payload: Record<string, unknown>): ModuleEvent => ({
  type: "tabletennis.rally",
  payload,
});
const EXPEDITE: ModuleEvent = { type: "tabletennis.expedite.start", payload: {} };

/** `n` rallies to `wonBy`, carrying no expedite fields. */
const points = (wonBy: string, n: number): ModuleEvent[] =>
  Array.from({ length: n }, () => rally({ wonBy }));

/** A finished game 11–0 to `wonBy`. */
const game = (wonBy: string): ModuleEvent[] => points(wonBy, 11);

// ---------------------------------------------------------------------------
// Law 2.15.2 — the receiver's thirteenth good return
// ---------------------------------------------------------------------------
describe("expedite: the receiver's 13th good return wins the point", () => {
  it("accepts a 13-return rally credited to the RECEIVER and scores it", () => {
    // H served, A received and made 13 good returns, so the point is A's.
    const state = fold(tabletennis, [EXPEDITE, rally({ wonBy: "A", serving: "H", returns: 13 })]);
    expect(state.expedite).toBe(true);
    expect(state.sets[0]).toEqual({ home: 0, away: 1, closed: false });
    // Nothing went unchecked — `serving` was there, so the rule was applied.
    expect(state.expediteUnchecked).toBeUndefined();
  });

  it("rejects a 13-return rally credited to the SERVING side", () => {
    expect(() =>
      fold(tabletennis, [EXPEDITE, rally({ wonBy: "H", serving: "H", returns: 13 })]),
    ).toThrowError(expect.objectContaining({ code: "EXPEDITE_WRONG_WINNER" }));
  });

  it("leaves a rally short of 13 returns alone, whoever won it", () => {
    const state = fold(tabletennis, [EXPEDITE, rally({ wonBy: "H", serving: "H", returns: 12 })]);
    expect(state.sets[0]).toEqual({ home: 1, away: 0, closed: false });
    expect(state.expediteUnchecked).toBeUndefined();
  });

  it("enforces beyond exactly 13 — a 14-return rally to the server is still wrong", () => {
    expect(() =>
      fold(tabletennis, [EXPEDITE, rally({ wonBy: "A", serving: "A", returns: 14 })]),
    ).toThrowError(expect.objectContaining({ code: "EXPEDITE_WRONG_WINNER" }));
  });

  it("does not enforce before expedite is introduced", () => {
    // Same rally, no `expedite.start`: 13 returns is just a long rally.
    const state = fold(tabletennis, [rally({ wonBy: "H", serving: "H", returns: 13 })]);
    expect(state.sets[0]).toEqual({ home: 1, away: 0, closed: false });
    expect(state.expedite).toBeUndefined();
    expect(state.expediteUnchecked).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Law 2.15.4 — MATCH-scoped, not game-scoped
// ---------------------------------------------------------------------------
describe("expedite is match-scoped (ITTF 2.15.4)", () => {
  it("survives a completed game and still governs the next one", () => {
    const state = fold(tabletennis, [
      EXPEDITE,
      ...game("H"), // game 1 closes 11–0
      rally({ wonBy: "A", serving: "H", returns: 13 }), // first rally of game 2
    ]);
    expect(state.setsWon).toEqual({ home: 1, away: 0 });
    expect(state.sets).toHaveLength(2);
    expect(state.expedite).toBe(true);
    // …and enforcement is still live in the NEW game.
    expect(() =>
      fold(tabletennis, [EXPEDITE, ...game("H"), rally({ wonBy: "H", serving: "H", returns: 13 })]),
    ).toThrowError(expect.objectContaining({ code: "EXPEDITE_WRONG_WINNER" }));
  });

  it("survives several games and the whole match", () => {
    const state = fold(tabletennis, [EXPEDITE, ...game("H"), ...game("A"), ...game("H")]);
    expect(state.setsWon).toEqual({ home: 2, away: 1 });
    expect(state.expedite).toBe(true);
  });

  it("refuses a second expedite.start — it carries no game number to re-scope", () => {
    expect(() => fold(tabletennis, [EXPEDITE, EXPEDITE])).toThrowError(
      expect.objectContaining({ code: "INVALID_EVENT" }),
    );
    // Even with a whole game in between: 2.15.4 means it never lapsed.
    expect(() => fold(tabletennis, [EXPEDITE, ...game("H"), EXPEDITE])).toThrowError(
      expect.objectContaining({ code: "INVALID_EVENT" }),
    );
  });

  it("refuses expedite.start outside live play", () => {
    const cfg = tabletennis.configSchema.parse({});
    const state = tabletennis.init(cfg, defaultLineupPair(resolvePositions(tabletennis, cfg)));
    expect(() =>
      tabletennis.apply(state, makeEnvelope(0, EXPEDITE) as EventEnvelope<never>),
    ).toThrowError(expect.objectContaining({ code: "WRONG_PHASE" }));
  });
});

// ---------------------------------------------------------------------------
// The honest limitation: no `serving`, no enforcement
// ---------------------------------------------------------------------------
describe("expedite enforcement is conditional on `serving`", () => {
  it("counts a 13-return rally with no `serving` as unenforceable and lets it through", () => {
    const state = fold(tabletennis, [EXPEDITE, rally({ wonBy: "H", returns: 13 })]);
    expect(state.sets[0]).toEqual({ home: 1, away: 0, closed: false });
    expect(state.expediteUnchecked).toBe(1);
  });

  it("accumulates the unenforceable count across the match", () => {
    const state = fold(tabletennis, [
      EXPEDITE,
      rally({ wonBy: "H", returns: 13 }),
      rally({ wonBy: "A", returns: 20 }),
      rally({ wonBy: "A", serving: "A", returns: 4 }), // checked, under 13
      rally({ wonBy: "H", serving: "A", returns: 13 }), // checked, legal
    ]);
    expect(state.expediteUnchecked).toBe(2);
  });

  it("never materialises the counter on a stream that carries no `returns`", () => {
    const state = fold(tabletennis, [EXPEDITE, ...points("H", 3), ...points("A", 2)]);
    expect(state.expediteUnchecked).toBeUndefined();
    expect(Object.keys(state)).not.toContain("expediteUnchecked");
  });

  it("rejects a `serving` naming an entrant that is not in the fixture", () => {
    expect(() =>
      fold(tabletennis, [EXPEDITE, rally({ wonBy: "H", serving: "Z", returns: 13 })]),
    ).toThrowError(expect.objectContaining({ code: "INVALID_EVENT" }));
  });

  it("rejects a bad `serving` on the rally that carries it, not on a later one", () => {
    // No `returns`, so the 13-return rule never looks at `serving` — the eager
    // validation in `applyRally` is the only thing that can catch this, and
    // without it a typo'd id would sit in the ledger until some much later
    // rally happened to reach thirteen returns and blame the wrong event.
    expect(() =>
      fold(tabletennis, [EXPEDITE, rally({ wonBy: "H", serving: "Z" })]),
    ).toThrowError(expect.objectContaining({ code: "INVALID_EVENT" }));
    // …and before expedite is even introduced.
    expect(() => fold(tabletennis, [rally({ wonBy: "H", serving: "Z" })])).toThrowError(
      expect.objectContaining({ code: "INVALID_EVENT" }),
    );
  });
});

// ---------------------------------------------------------------------------
// MANDATORY (spec §5.3) — `serving` is a SIDE, `server` is a PERSON. The two
// are adjacent, similarly named and differently typed: exactly the shape that
// produced the `DisciplineCard.entrantSide` bug. Without a case where they
// DISAGREE, reading the wrong one is invisible.
// ---------------------------------------------------------------------------
describe("`serving` (side) and `server` (person) are different fields", () => {
  it("accepts a doubles rally whose `server` belongs to the side that did NOT serve", () => {
    // The pair A served (serving: "A"); the pad also recorded a person from H
    // in `server`. Reading `server` would make the winner H the "receiver" and
    // wrongly ACCEPT nothing — but reading it here must not change the verdict:
    // A served and A won on the 13th return, so this is EXPEDITE_WRONG_WINNER.
    expect(() =>
      fold(tabletennis, [
        EXPEDITE,
        rally({ wonBy: "A", serving: "A", server: "H-p1", scorer: "A-p1", returns: 13 }),
      ]),
    ).toThrowError(expect.objectContaining({ code: "EXPEDITE_WRONG_WINNER" }));
  });

  it("accepts the mirror rally where the two disagree the other way", () => {
    // serving: "A" (side A served), server: "H-p1" (a PERSON on H), winner H.
    // Side A served and side H received, so H winning on 13 returns is LEGAL.
    // A kernel that resolved the serving side from `server` would see H serving
    // AND H winning and throw — this is the case that separates the two fields.
    const state = fold(tabletennis, [
      EXPEDITE,
      rally({ wonBy: "H", serving: "A", server: "H-p1", scorer: "H-p2", returns: 13 }),
    ]);
    expect(state.sets[0]).toEqual({ home: 1, away: 0, closed: false });
    expect(state.expediteUnchecked).toBeUndefined();
    // `server` still feeds the person tally it always fed, unchanged.
    expect(state.persons).toEqual({
      "H-p1": { points: 0, serves: 1 },
      "H-p2": { points: 1, serves: 0 },
    });
  });

  it("`serving` credits no person tally — it is not a person", () => {
    const state = fold(tabletennis, [
      EXPEDITE,
      rally({ wonBy: "H", serving: "A", returns: 13 }),
    ]);
    expect(state.persons).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// §8 union-swallow hazard — the new branch is APPENDED, so nothing it could
// structurally match is stolen from a sibling.
// ---------------------------------------------------------------------------
describe("SetBasedEv union disambiguation", () => {
  it("a bare rally still parses to the rally branch", () => {
    expect(SetBasedEv.parse({ wonBy: "H" })).toEqual({ wonBy: "H" });
  });

  it("an expedite-carrying rally keeps its new fields on the rally branch", () => {
    expect(SetBasedEv.parse({ wonBy: "H", serving: "A", returns: 13 })).toEqual({
      wonBy: "H",
      serving: "A",
      returns: 13,
    });
  });

  it("the empty expedite payload matches ONLY the expedite branch", () => {
    expect(SetBasedEv.parse({})).toEqual({});
    // Every pre-existing branch requires at least one key, so `{}` cannot be a
    // rally, a summary, a timeout, a sanction or a substitution.
    for (const branch of [
      { wonBy: "H" },
      { home: 11, away: 4 },
      { by: "H", forBy: 11, forOpp: 4 },
      { by: "H" },
      { by: "H", level: "warning" as const },
    ]) {
      expect(SetBasedEv.parse(branch)).toEqual(branch);
    }
  });

  it("refuses an expedite payload carrying a game number", () => {
    // 2.15.4 — match-scoped. A `game` key is a scoping mistake, not a field.
    expect(() =>
      fold(tabletennis, [{ type: "tabletennis.expedite.start", payload: { game: 3 } }]),
    ).toThrowError(expect.objectContaining({ code: "INVALID_EVENT" }));
  });
});

// ---------------------------------------------------------------------------
// Preset gating, tiers, summary, coarsen
// ---------------------------------------------------------------------------
describe("expedite is table tennis's alone", () => {
  it("volleyball and badminton refuse the event", () => {
    for (const mod of [volleyball, badminton] as Mod[]) {
      expect(() =>
        fold(mod, [{ type: `${mod.key}.expedite.start`, payload: {} }]),
      ).toThrowError(expect.objectContaining({ code: "INVALID_EVENT" }));
    }
  });

  it("tier 3 reaches tabletennis.expedite.start; tier 0 does not", () => {
    const tier3 = tabletennis.fidelityTiers.find((t) => t.tier === 3)!;
    const tier0 = tabletennis.fidelityTiers.find((t) => t.tier === 0)!;
    expect(tier3.eventTypes).toContain("tabletennis.expedite.start");
    expect(tier0.eventTypes).not.toContain("tabletennis.expedite.start");
    for (const mod of [volleyball, badminton] as Mod[]) {
      const other = mod.fidelityTiers.find((t) => t.tier === 3)!;
      expect(other.eventTypes).not.toContain(`${mod.key}.expedite.start`);
    }
  });

  it("the summary reports expedite once it is in force, and not before", () => {
    expect(tabletennis.summary(fold(tabletennis, points("H", 1))).detail).not.toHaveProperty(
      "expedite",
    );
    expect(
      tabletennis.summary(fold(tabletennis, [EXPEDITE, ...points("H", 1)])).detail,
    ).toMatchObject({ expedite: true });
  });

  it("coarsen passes expedite.start through without splitting the game", () => {
    const events = envelopes([
      { type: "core.start", payload: {} },
      ...points("H", 3),
      EXPEDITE,
      ...points("H", 8),
    ]).map((e) => ({ type: e.type, payload: e.payload }));
    const coarse = tabletennis.coarsen!(events);
    expect(coarse.map((e) => e.type)).toEqual([
      "core.start",
      "tabletennis.expedite.start",
      "tabletennis.game.summary",
    ]);
    // One game, not two — the interruption is transparent to segmentation.
    expect(coarse[2]!.payload).toEqual({ by: "H", forBy: 11, forOpp: 0 });
  });
});

// ---------------------------------------------------------------------------
// Additivity — a stream that predates this change folds byte-identically.
// (The golden corpus is the other half of this proof.)
// ---------------------------------------------------------------------------
describe("expedite is additive", () => {
  it("a stream with no expedite.start carries neither new state key", () => {
    const state = fold(tabletennis, [
      ...points("H", 11),
      { type: "tabletennis.timeout", payload: { by: "A" } },
      ...points("A", 11),
    ]);
    const keys = Object.keys(state);
    expect(keys).not.toContain("expedite");
    expect(keys).not.toContain("expediteUnchecked");
    expect(state.setsWon).toEqual({ home: 1, away: 1 });
  });
});
