// W4 domain audit — the scorebook facts football.ts gained in this wave.
// Companion to football.test.ts (which pins the pre-W4 machine) and to
// DOMAIN.md (which is the audit itself). Every test here must fail without
// the matching fold change.
import { describe, expect, it } from "vitest";
import { foldMatch, type EventEnvelope } from "../../core/events.ts";
import type { Lineup, LineupPair } from "../../core/types.ts";
import { lineupFromCatalog, makeEnvelope } from "../../testkit/index.ts";
import { football, type FootballCfg } from "./football.ts";

// Catalog-valid XI plus a six-man bench — enough to exhaust a substitution cap.
function lineupWithBench(entrantId: string, benchSize = 6): Lineup {
  const base = lineupFromCatalog(football.positions, entrantId);
  return {
    ...base,
    slots: [
      ...base.slots,
      ...Array.from({ length: benchSize }, (_, i) => ({
        personId: `${entrantId}-b${i + 1}`,
        slot: "bench" as const,
        orderNo: 12 + i,
      })),
    ],
  };
}
const lineups: LineupPair = { home: lineupWithBench("H"), away: lineupWithBench("A") };

function stream(...specs: Array<[type: string, payload?: unknown]>): EventEnvelope[] {
  return specs.map(([type, payload], i) => makeEnvelope(i, { type, payload: payload ?? {} }));
}
const cfgOf = (raw: unknown): FootballCfg => football.configSchema.parse(raw);
const fold = (cfg: FootballCfg, events: EventEnvelope[]) =>
  foldMatch(football, cfg, lineups, events);

const sub = (off: string, on: string): [string, unknown] => [
  "football.sub",
  { by: "H", off, on },
];

// ---------------------------------------------------------------------------
// Law 3 — substitutions. 11-a-side uses return-forbidden subs under a cap;
// youth and small-sided football use repeat ("rolling"/"flying") substitutions.
// ---------------------------------------------------------------------------

describe("substitution rules per variant (Law 3)", () => {
  it("keeps return substitutions illegal by default (11-a-side)", () => {
    expect(() =>
      fold(cfgOf({}), stream(["core.start"], sub("H-p1", "H-b1"), sub("H-b1", "H-p1"))),
    ).toThrowError(expect.objectContaining({ code: "INVALID_EVENT" }));
  });

  it("lets a substituted player return when cfg.rollingSubs is on", () => {
    const state = fold(
      cfgOf({ rollingSubs: true }),
      stream(["core.start"], sub("H-p1", "H-b1"), sub("H-b1", "H-p1")),
    );
    expect(state.squads.home.onPitch).toContain("H-p1");
    expect(state.squads.home.onPitch).not.toContain("H-b1");
    // The player who came off goes back to the bench, not to offUsed.
    expect(state.squads.home.bench).toContain("H-b1");
    expect(state.squads.home.offUsed).toEqual([]);
  });

  it("refuses the substitution that would exceed cfg.maxSubs", () => {
    const cfg = cfgOf({ maxSubs: 3 });
    const three = stream(
      ["core.start"],
      sub("H-p1", "H-b1"),
      sub("H-p2", "H-b2"),
      sub("H-p3", "H-b3"),
    );
    expect(fold(cfg, three).squads.home.offUsed).toHaveLength(3);
    expect(() =>
      fold(cfg, [...three, makeEnvelope(4, { type: "football.sub", payload: { by: "H", off: "H-p4", on: "H-b4" } })]),
    ).toThrowError(expect.objectContaining({ code: "INVALID_EVENT" }));
  });

  it("counts the cap per side, not per fixture", () => {
    const cfg = cfgOf({ maxSubs: 1 });
    const state = fold(
      cfg,
      stream(
        ["core.start"],
        sub("H-p1", "H-b1"),
        ["football.sub", { by: "A", off: "A-p1", on: "A-b1" }],
      ),
    );
    expect(state.squads.home.offUsed).toEqual(["H-p1"]);
    expect(state.squads.away.offUsed).toEqual(["A-p1"]);
  });

  it("never caps a rolling-substitution match", () => {
    const cfg = cfgOf({ rollingSubs: true, maxSubs: 1 });
    const state = fold(
      cfg,
      stream(["core.start"], sub("H-p1", "H-b1"), sub("H-p2", "H-b2"), sub("H-b1", "H-p1")),
    );
    expect(state.squads.home.onPitch).toContain("H-p1");
    expect(state.squads.home.onPitch).toContain("H-b2");
  });

  it("declares rolling substitutions on the youth and small-sided variants", () => {
    expect(football.variants.youth?.rollingSubs).toBe(true);
    expect(football.variants["small-sided"]?.rollingSubs).toBe(true);
    expect(football.variants["11-a-side"]?.rollingSubs).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Law 12 — the offence a card was shown for. The referee's match record names
// it, and the suspension tariff the discipline usecase applies depends on it
// (violent conduct ≠ a second caution), so the card event has to carry it.
// ---------------------------------------------------------------------------

describe("card offence codes (Law 12)", () => {
  it("folds the offence onto the card record", () => {
    const state = fold(
      cfgOf({}),
      stream(
        ["core.start"],
        ["football.card", { by: "H", person: "H-p5", color: "red", reason: "violent_conduct", minute: 33 }],
      ),
    );
    expect(state.cards[0]).toMatchObject({
      side: "home",
      person: "H-p5",
      color: "red",
      minute: 33,
      reason: "violent_conduct",
    });
  });

  it("keeps the offence optional — an anonymous coarse card still folds", () => {
    const state = fold(cfgOf({}), stream(["core.start"], ["football.card", { by: "A", color: "yellow" }]));
    expect(state.cards[0]).toEqual({ side: "away", color: "yellow" });
  });

  it("rejects an offence outside the Law 12 vocabulary", () => {
    expect(() =>
      fold(cfgOf({}), stream(["core.start"], ["football.card", { by: "H", color: "yellow", reason: "bad_haircut" }])),
    ).toThrowError(expect.objectContaining({ code: "INVALID_EVENT" }));
  });

  it("offers both caution and sending-off offences", () => {
    const parse = (reason: string) =>
      football.eventSchema.safeParse({ by: "H", color: "yellow", reason }).success;
    expect(parse("dissent")).toBe(true);
    expect(parse("delaying_restart")).toBe(true);
    expect(parse("denying_obvious_goalscoring_opportunity")).toBe(true);
    expect(parse("second_caution")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Law 7 — allowance for time lost. A match report records "90+3", which a bare
// integer `minute` cannot distinguish from the 93rd minute of extra time.
// ---------------------------------------------------------------------------

describe("added time (Law 7)", () => {
  it("stamps added time on the period the marker closes, not the one it opens", () => {
    const state = fold(
      cfgOf({}),
      stream(
        ["core.start"],
        ["football.period", { phase: "HT", addedMinutes: 2 }],
        ["football.goal", { by: "H" }],
        ["football.period", { phase: "FT", addedMinutes: 5 }],
      ),
    );
    expect(state.periods).toEqual([
      { phase: "H1", home: 0, away: 0, addedMinutes: 2 },
      { phase: "H2", home: 1, away: 0, addedMinutes: 5 },
    ]);
  });

  it("carries added time through to the summary detail", () => {
    const state = fold(cfgOf({}), stream(["core.start"], ["football.period", { phase: "HT", addedMinutes: 4 }]));
    expect(football.summary(state).detail).toMatchObject({
      periods: [{ phase: "H1", addedMinutes: 4 }, { phase: "H2" }],
    });
  });

  it("leaves the period untouched when added time is not recorded", () => {
    const state = fold(cfgOf({}), stream(["core.start"], ["football.period", { phase: "HT" }]));
    expect(state.periods[0]).toEqual({ phase: "H1", home: 0, away: 0 });
  });

  it("still refuses an out-of-order marker that carries added time", () => {
    expect(() =>
      fold(cfgOf({}), stream(["core.start"], ["football.period", { phase: "FT", addedMinutes: 3 }])),
    ).toThrowError(expect.objectContaining({ code: "WRONG_PHASE" }));
  });

  it("records added time for both extra-time halves", () => {
    const cfg = cfgOf({ extraTime: { enabled: true, halfMinutes: 15 }, shootout: true });
    const state = fold(
      cfg,
      stream(
        ["core.start"],
        ["football.period", { phase: "HT" }],
        ["football.period", { phase: "FT" }],
        ["football.period", { phase: "ET_HT", addedMinutes: 1 }],
        ["football.goal", { by: "A" }],
        ["football.period", { phase: "ET_FT", addedMinutes: 2 }],
      ),
    );
    expect(state.periods.map((p) => p.addedMinutes)).toEqual([undefined, undefined, 1, 2]);
  });
});
