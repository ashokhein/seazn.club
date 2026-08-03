// W4 domain audit — the scorebook facts football.ts gained in this wave.
// Companion to football.test.ts (which pins the pre-W4 machine) and to
// DOMAIN.md (which is the audit itself). Every test here must fail without
// the matching fold change.
import { describe, expect, it } from "vitest";
import { foldMatch, type EventEnvelope } from "../../core/events.ts";
import type { Lineup, LineupPair } from "../../core/types.ts";
import { aggregatePlayerStats } from "../../stats/stats.ts";
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

// ---------------------------------------------------------------------------
// Law 14 — a penalty kick awarded in open play that did NOT produce a goal.
// A converted penalty is already `football.goal { penalty: true }`; a saved or
// missed one left no trace at all before W4.
// ---------------------------------------------------------------------------

describe("penalties in open play (Law 14)", () => {
  const pen = (payload: unknown): [string, unknown] => ["football.penalty", payload];

  it("records a saved penalty without moving the score", () => {
    const state = fold(
      cfgOf({}),
      stream(
        ["core.start"],
        pen({ by: "H", taker: "H-p9", keeper: "A-p1", outcome: "saved", minute: 27 }),
      ),
    );
    expect(state.goals).toEqual({ home: 0, away: 0 });
    expect(state.penalties).toEqual([
      { side: "home", outcome: "saved", taker: "H-p9", keeper: "A-p1", minute: 27 },
    ]);
  });

  // §9.6 requires summary(coarse fold) === summary(fine fold), and coarsen
  // drops every event with no score effect. So an unconverted penalty must
  // stay OUT of the summary — exactly like a card — and live in State.
  it("stays out of the summary so the coarse and fine folds still agree", () => {
    const none = fold(cfgOf({}), stream(["core.start"]));
    const some = fold(cfgOf({}), stream(["core.start"], pen({ by: "A", outcome: "missed" })));
    expect(football.summary(some)).toEqual(football.summary(none));
    expect(some.penalties).toEqual([{ side: "away", outcome: "missed" }]);
  });

  it("accepts an anonymous penalty — coarse scoring stays legal", () => {
    const state = fold(cfgOf({}), stream(["core.start"], pen({ by: "H", outcome: "post" })));
    expect(state.penalties).toEqual([{ side: "home", outcome: "post" }]);
  });

  it("refuses a taker who is not on the pitch for the awarded side", () => {
    expect(() =>
      fold(cfgOf({}), stream(["core.start"], pen({ by: "H", taker: "A-p9", outcome: "saved" }))),
    ).toThrowError(expect.objectContaining({ code: "INVALID_EVENT" }));
  });

  it("refuses a keeper who is not on the pitch for the DEFENDING side", () => {
    // H-p1 is the home keeper; a penalty awarded to H is faced by an away keeper.
    expect(() =>
      fold(cfgOf({}), stream(["core.start"], pen({ by: "H", taker: "H-p9", keeper: "H-p1", outcome: "saved" }))),
    ).toThrowError(expect.objectContaining({ code: "INVALID_EVENT" }));
  });

  it("refuses a penalty outside a period of play", () => {
    expect(() => fold(cfgOf({}), stream(pen({ by: "H", outcome: "saved" })))).toThrowError(
      expect.objectContaining({ code: "WRONG_PHASE" }),
    );
  });

  it("rejects an outcome outside the Law 14 vocabulary", () => {
    expect(() =>
      fold(cfgOf({}), stream(["core.start"], pen({ by: "H", outcome: "scored" }))),
    ).toThrowError(expect.objectContaining({ code: "INVALID_EVENT" }));
  });

  it("is reachable from the attributed fidelity tiers and never from the coarse ones", () => {
    const types = (tier: number) =>
      football.fidelityTiers.find((t) => t.tier === tier)?.eventTypes ?? [];
    expect(types(2)).toContain("football.penalty");
    expect(types(3)).toContain("football.penalty");
    expect(types(0)).not.toContain("football.penalty");
    expect(types(1)).not.toContain("football.penalty");
  });

  it("is dropped by coarsen — it never moves the score", () => {
    const events = stream(
      ["core.start"],
      pen({ by: "H", outcome: "saved" }),
      ["football.goal", { by: "H" }],
    ).map((e) => e as EventEnvelope<never>);
    const coarse = football.coarsen!(events);
    expect(coarse.map((e) => e.type)).toEqual(["core.start", "football.goal"]);
  });
});

// ---------------------------------------------------------------------------
// Law 12 addendum — temporary dismissals ("sin bins"). The FA runs them at
// every level below the National League System and throughout youth football;
// futsal and most small-sided codes use time penalties of the same shape.
// A sin-binned player leaves the pitch and comes BACK, which no existing
// branch could express: football.card's non-yellow path sends off for good.
// ---------------------------------------------------------------------------

describe("temporary dismissals / sin bins (Law 12 addendum)", () => {
  const bin = (payload: unknown): [string, unknown] => ["football.sinbin", payload];
  const started = stream(
    ["core.start"],
    bin({ by: "H", person: "H-p6", minutes: 10, reason: "dissent", minute: 21 }),
  );

  it("takes the player off the pitch without sending them off", () => {
    const state = fold(cfgOf({}), started);
    expect(state.squads.home.onPitch).not.toContain("H-p6");
    expect(state.squads.home.sentOff).toEqual([]);
    expect(state.squads.home.sinBin).toEqual([
      { person: "H-p6", minutes: 10, reason: "dissent", minute: 21 },
    ]);
  });

  it("puts the player back on the pitch on the return record", () => {
    const state = fold(cfgOf({}), [
      ...started,
      makeEnvelope(2, {
        type: "football.sinbin",
        payload: { by: "H", person: "H-p6", returned: true, minute: 31 },
      }),
    ]);
    expect(state.squads.home.onPitch).toContain("H-p6");
    expect(state.squads.home.sinBin).toEqual([]);
  });

  it("falls back to cfg.sinBinMinutes when the event omits a duration", () => {
    const state = fold(
      cfgOf({ sinBinMinutes: 8 }),
      stream(["core.start"], bin({ by: "A", person: "A-p3" })),
    );
    expect(state.squads.away.sinBin).toEqual([{ person: "A-p3", minutes: 8 }]);
  });

  it("keeps the player optional — an anonymous sin bin is recorded, pitch untouched", () => {
    const state = fold(cfgOf({}), stream(["core.start"], bin({ by: "H", minute: 12 })));
    expect(state.squads.home.onPitch).toHaveLength(11);
    expect(state.squads.home.sinBin).toEqual([{ minute: 12 }]);
  });

  it("returns the oldest anonymous entry when the return names nobody", () => {
    const state = fold(cfgOf({}), [
      ...stream(["core.start"], bin({ by: "H" })),
      makeEnvelope(2, { type: "football.sinbin", payload: { by: "H", returned: true } }),
    ]);
    expect(state.squads.home.sinBin).toEqual([]);
  });

  it("refuses to bin a player who is not on the pitch", () => {
    expect(() =>
      fold(cfgOf({}), stream(["core.start"], bin({ by: "H", person: "A-p6" }))),
    ).toThrowError(expect.objectContaining({ code: "INVALID_EVENT" }));
  });

  it("refuses to bin a player who is already in the bin", () => {
    expect(() =>
      fold(cfgOf({}), [...started, makeEnvelope(2, { type: "football.sinbin", payload: { by: "H", person: "H-p6" } })]),
    ).toThrowError(expect.objectContaining({ code: "INVALID_EVENT" }));
  });

  it("refuses to bin a player who has been sent off", () => {
    expect(() =>
      fold(
        cfgOf({}),
        stream(
          ["core.start"],
          ["football.card", { by: "H", person: "H-p7", color: "red" }],
          bin({ by: "H", person: "H-p7" }),
        ),
      ),
    ).toThrowError(expect.objectContaining({ code: "INVALID_EVENT" }));
  });

  it("refuses a return for a player who is not in the bin", () => {
    expect(() =>
      fold(
        cfgOf({}),
        stream(["core.start"], bin({ by: "H", person: "H-p6", returned: true })),
      ),
    ).toThrowError(expect.objectContaining({ code: "INVALID_EVENT" }));
  });

  it("refuses a sin bin outside a period of play", () => {
    expect(() => fold(cfgOf({}), stream(bin({ by: "H", person: "H-p6" })))).toThrowError(
      expect.objectContaining({ code: "WRONG_PHASE" }),
    );
  });

  it("lets a sin-binned player be sent off for good while off the pitch", () => {
    const state = fold(cfgOf({}), [
      ...started,
      makeEnvelope(2, { type: "football.card", payload: { by: "H", person: "H-p6", color: "red" } }),
    ]);
    expect(state.squads.home.sentOff).toEqual(["H-p6"]);
  });

  it("is reachable from the attributed fidelity tiers only", () => {
    const types = (tier: number) =>
      football.fidelityTiers.find((t) => t.tier === tier)?.eventTypes ?? [];
    expect(types(2)).toContain("football.sinbin");
    expect(types(3)).toContain("football.sinbin");
    expect(types(0)).not.toContain("football.sinbin");
  });

  it("is dropped by coarsen and stays out of the summary", () => {
    const none = fold(cfgOf({}), stream(["core.start"]));
    const some = fold(cfgOf({}), started);
    expect(football.summary(some)).toEqual(football.summary(none));
    const coarse = football.coarsen!(started as EventEnvelope<never>[]);
    expect(coarse.map((e) => e.type)).toEqual(["core.start"]);
  });
});

// ---------------------------------------------------------------------------
// Union disambiguation. `FootballEv` is a z.union of strict branches with no
// discriminator inside the payload, so z.union accepts the FIRST branch that
// parses. W4 widened two branches (card, period) and added two (penalty,
// sinbin); each one is a chance to start swallowing a sibling's payload.
// ---------------------------------------------------------------------------

describe("event union disambiguation", () => {
  const canonical: Record<string, Record<string, unknown>> = {
    "football.goal": { by: "H", scorer: "H-p9", assist: "H-p10", minute: 12, penalty: true },
    "football.card": { by: "H", person: "H-p5", color: "yellow", minute: 30, reason: "dissent" },
    "football.sub": { by: "H", off: "H-p1", on: "H-b1", minute: 60 },
    "football.period": { phase: "HT", addedMinutes: 2 },
    "football.shootout.kick": { by: "H", person: "H-p9", scored: true },
    "football.penalty": { by: "H", taker: "H-p9", keeper: "A-p1", outcome: "saved", minute: 27 },
    "football.sinbin": { by: "H", person: "H-p6", minutes: 10, reason: "dissent", minute: 21 },
  };

  it("round-trips every branch's canonical payload through the union unchanged", () => {
    for (const [type, payload] of Object.entries(canonical)) {
      const parsed = football.eventSchema.safeParse(payload);
      expect(parsed.success, `${type} must parse`).toBe(true);
      // Zod strips silently when a branch is narrower than the payload — an
      // equality round-trip is the only way to see it.
      expect(parsed.success && parsed.data, `${type} round-trip`).toEqual(payload);
    }
  });

  it("keeps every branch structurally distinct once it is fully attributed", () => {
    // A shootout kick, a sin bin and a card are all { by, person?, … } shapes,
    // so each schema must reject the others outright.
    const kick = canonical["football.shootout.kick"]!;
    const card = canonical["football.card"]!;
    const bin = canonical["football.sinbin"]!;
    const pen = canonical["football.penalty"]!;
    // Cards are extracted with FootballCard.safeParse inside discipline —
    // a kick or a sin bin leaking through there would invent suspensions.
    for (const other of [kick, bin, pen]) {
      expect(football.discipline!.extractCards([
        makeEnvelope(0, { type: "football.card", payload: other }),
      ])).toEqual([]);
    }
    expect(
      football.discipline!.extractCards([makeEnvelope(0, { type: "football.card", payload: card })]),
    ).toHaveLength(1);
  });

  it("makes the envelope type the discriminator for the ambiguous minimal shape", () => {
    // { by, minute } satisfies BOTH the goal branch and the sin-bin branch.
    // The union alone cannot tell them apart; apply() dispatches on the
    // envelope's type string, and that is what actually decides.
    const ambiguous = { by: "H", minute: 12 };
    expect(football.eventSchema.safeParse(ambiguous).success).toBe(true);

    const asGoal = fold(cfgOf({}), [
      makeEnvelope(0, { type: "core.start", payload: {} }),
      makeEnvelope(1, { type: "football.goal", payload: ambiguous }),
    ]);
    expect(asGoal.goals).toEqual({ home: 1, away: 0 });
    expect(asGoal.squads.home.sinBin).toBeUndefined();

    const asBin = fold(cfgOf({}), [
      makeEnvelope(0, { type: "core.start", payload: {} }),
      makeEnvelope(1, { type: "football.sinbin", payload: ambiguous }),
    ]);
    expect(asBin.goals).toEqual({ home: 0, away: 0 });
    expect(asBin.squads.home.sinBin).toEqual([{ minute: 12 }]);
  });

  it("folds every canonical payload through its own dispatch case", () => {
    const kick = cfgOf({ shootout: true });
    const opened = stream(["core.start"]);
    const one = (cfg: FootballCfg, before: EventEnvelope[], type: string) =>
      fold(cfg, [...before, makeEnvelope(before.length, { type, payload: canonical[type]! })]);

    expect(one(cfgOf({}), opened, "football.goal").goals).toEqual({ home: 1, away: 0 });
    expect(one(cfgOf({}), opened, "football.card").cards).toHaveLength(1);
    expect(one(cfgOf({}), opened, "football.sub").squads.home.offUsed).toEqual(["H-p1"]);
    expect(one(cfgOf({}), opened, "football.period").periods).toHaveLength(2);
    expect(one(cfgOf({}), opened, "football.penalty").penalties).toHaveLength(1);
    expect(one(cfgOf({}), opened, "football.sinbin").squads.home.sinBin).toHaveLength(1);

    const atShootout = stream(
      ["core.start"],
      ["football.period", { phase: "HT" }],
      ["football.period", { phase: "FT" }],
    );
    expect(one(kick, atShootout, "football.shootout.kick").shootout?.kicks).toEqual([
      { side: "home", scored: true },
    ]);
  });

  it("keeps every fidelity-tier event type dispatchable", () => {
    const declared = new Set(football.fidelityTiers.flatMap((t) => t.eventTypes));
    for (const type of declared) {
      expect(Object.keys(canonical), `tier type ${type} has no canonical payload`).toContain(type);
    }
    expect(declared).toEqual(new Set(Object.keys(canonical)));
  });
});

// ---------------------------------------------------------------------------
// The stat models the new branches make possible (Jul3/07 §3).
// ---------------------------------------------------------------------------

describe("player stats from the W4 branches", () => {
  const model = football.playerStats!;
  const keys = new Set(model.metrics.map((m) => m.key));

  it("counts converted penalties without double-counting them as goals", () => {
    expect(keys).toContain("penalty_goals");
    const rows = aggregatePlayerStats(
      [
        makeEnvelope(0, { type: "football.goal", payload: { by: "H", scorer: "p9", penalty: true } }),
        makeEnvelope(1, { type: "football.goal", payload: { by: "H", scorer: "p9" } }),
      ],
      model,
    );
    expect(rows).toEqual([
      { personId: "p9", stats: { goals: 2, penalty_goals: 1, points: 2 } },
    ]);
  });

  it("counts missed penalties against the taker", () => {
    const rows = aggregatePlayerStats(
      [
        makeEnvelope(0, {
          type: "football.penalty",
          payload: { by: "H", taker: "p9", keeper: "k1", outcome: "saved" },
        }),
      ],
      model,
    );
    expect(rows).toEqual([{ personId: "p9", stats: { penalties_missed: 1, points: 0 } }]);
  });

  it("counts a sin bin once — the dismissal, never the return", () => {
    const rows = aggregatePlayerStats(
      [
        makeEnvelope(0, { type: "football.sinbin", payload: { by: "H", person: "p6", minutes: 10 } }),
        makeEnvelope(1, { type: "football.sinbin", payload: { by: "H", person: "p6", returned: true } }),
      ],
      model,
    );
    expect(rows).toEqual([{ personId: "p6", stats: { sin_bins: 1, points: 0 } }]);
  });
});
