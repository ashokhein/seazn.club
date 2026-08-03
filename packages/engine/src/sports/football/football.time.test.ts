// W4a (#425) — football's core time model: `at` beside the deprecated `minute`,
// sin bins that expire by fold, and substitution WINDOWS.
//
// Companion to football.domain.test.ts (W4's scorebook facts) and to
// football.test.ts (the pre-W4 machine). Every test here must fail without the
// matching fold change.
import { describe, expect, it } from "vitest";
import { EngineError } from "../../core/errors.ts";
import { foldMatch, type EventEnvelope } from "../../core/events.ts";
import type { Lineup, LineupPair } from "../../core/types.ts";
import { lineupFromCatalog, makeEnvelope } from "../../testkit/index.ts";
import {
  FootballCard,
  FootballGoal,
  FootballPenalty,
  FootballPeriod,
  FootballShootoutKick,
  FootballSinBinEnd,
  FootballSinBinStart,
  FootballSub,
  football,
  playPhases,
  type FootballCfg,
} from "./football.ts";

// Catalog-valid XI plus a six-man bench — enough to exhaust a window allowance.
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
const at = (period: string, elapsed: number) => ({ period, elapsed });

// ---------------------------------------------------------------------------
// §7 — the phase-order obligation. One exported function, two consumers.
// ---------------------------------------------------------------------------

describe("football phase order (§7)", () => {
  it("declares the exported function itself, not a copy of its output", () => {
    // Reference identity, deliberately. An equality check on the VALUES would
    // pass for a module that built its own list that happens to match today,
    // which is exactly the two-disagreeing-orders defect the obligation exists
    // to prevent. Both typeof checks are load-bearing: `undefined === undefined`
    // satisfies a bare toBe() while neither side exists.
    expect(playPhases).toBeTypeOf("function");
    expect(football.playPhases).toBeTypeOf("function");
    expect(football.playPhases).toBe(playPhases);
  });

  it("covers every phase a stamp may name, in the order they occur", () => {
    // "pre" first: a card before the opening whistle is legal (applyCard), so a
    // stamped one must be orderable. "done"/"final"/"abandoned" are absent on
    // purpose — nothing stamped is accepted once the match is over.
    expect(playPhases(cfgOf({}))).toEqual(["pre", "H1", "H2"]);
    expect(playPhases(cfgOf({ extraTime: { enabled: true, halfMinutes: 15 } }))).toEqual([
      "pre",
      "H1",
      "H2",
      "ET_H1",
      "ET_H2",
    ]);
    // The shootout is the last thing that happens, after any extra time.
    const knockout = playPhases(
      cfgOf({ extraTime: { enabled: true, halfMinutes: 15 }, shootout: true }),
    );
    expect(knockout[knockout.length - 1]).toBe("SHOOTOUT");
    expect(knockout).toEqual(["pre", "H1", "H2", "ET_H1", "ET_H2", "SHOOTOUT"]);
    // Listed only when this cfg can actually reach it.
    expect(playPhases(cfgOf({}))).not.toContain("SHOOTOUT");
    expect(playPhases(cfgOf({ shootout: true }))).toEqual(["pre", "H1", "H2", "SHOOTOUT"]);
    for (const raw of [{}, { shootout: true }, { extraTime: { enabled: true, halfMinutes: 15 } }]) {
      const phases = playPhases(cfgOf(raw));
      // The fold refuses an empty or duplicated declaration outright.
      expect(phases.length).toBeGreaterThan(0);
      expect(new Set(phases).size).toBe(phases.length);
      expect(phases).not.toContain("done");
    }
  });

  it("refuses a stamp in a period this cfg does not have, and names the ones it does", () => {
    let caught: unknown;
    try {
      fold(
        cfgOf({}),
        stream(["core.start"], ["football.goal", { by: "H", at: at("ET_H1", 60) }]),
      );
      expect.unreachable("a period outside the declared order must be refused");
    } catch (error) {
      caught = error;
    }
    expect(EngineError.is(caught, "INVALID_EVENT")).toBe(true);
    expect((caught as EngineError).message).toContain("pre, H1, H2");
    // …and accepts it once the cfg declares extra time.
    expect(() =>
      fold(
        cfgOf({ extraTime: { enabled: true, halfMinutes: 15 } }),
        stream(["core.start"], ["football.goal", { by: "H", at: at("ET_H1", 60) }]),
      ),
    ).not.toThrow();
  });

  it("inherits the monotonic guard once it declares an order", () => {
    expect(() =>
      fold(
        cfgOf({}),
        stream(
          ["core.start"],
          ["football.goal", { by: "H", at: at("H1", 1200) }],
          ["football.card", { by: "A", color: "yellow", at: at("H1", 600) }],
        ),
      ),
    ).toThrowError(expect.objectContaining({ code: "NON_MONOTONIC_TIME" }));
  });
});

// ---------------------------------------------------------------------------
// §3.1 / §5.2 — the sin bin expires by fold, at the next stamped event.
// ---------------------------------------------------------------------------

const binCfg = cfgOf({ sinBinMinutes: 10 });
const binStart = (payload: unknown): [string, unknown] => ["football.sinbin.start", payload];

describe("sin bin expiry by fold (§3.1)", () => {
  it("derives an expiry from `at` plus cfg.sinBinMinutes", () => {
    const state = fold(
      binCfg,
      stream(
        ["core.start"],
        binStart({ by: "H", person: "H-p1", at: at("H1", 600) }),
      ),
    );
    const bin = state.squads.home.sinBin ?? [];
    expect(bin).toHaveLength(1);
    expect(bin[0]?.startedAt).toEqual(at("H1", 600));
    expect(bin[0]?.expiresAt).toEqual(at("H1", 1200)); // 600 + 10 × 60
    expect(state.squads.home.onPitch).not.toContain("H-p1");
  });

  it("sweeps the bin at the next STAMPED event at or after the expiry", () => {
    const before = fold(
      binCfg,
      stream(
        ["core.start"],
        binStart({ by: "H", person: "H-p1", at: at("H1", 600) }),
        ["football.goal", { by: "A", at: at("H1", 1199) }],
      ),
    );
    expect(before.squads.home.sinBin).toHaveLength(1);
    expect(before.squads.home.onPitch).not.toContain("H-p1");

    const after = fold(
      binCfg,
      stream(
        ["core.start"],
        binStart({ by: "H", person: "H-p1", at: at("H1", 600) }),
        ["football.goal", { by: "A", at: at("H1", 1200) }],
      ),
    );
    expect(after.squads.home.sinBin).toEqual([]);
    expect(after.squads.home.onPitch).toContain("H-p1");
  });

  it("does NOT sweep on an unstamped event", () => {
    // The pad and the fold legitimately disagree between an expiry and the next
    // stamped event (§3.1); an unstamped event carries no clock reading at all,
    // so it cannot be the moment the fold catches up.
    const state = fold(
      binCfg,
      stream(
        ["core.start"],
        binStart({ by: "H", person: "H-p1", at: at("H1", 600) }),
        ["football.goal", { by: "A", minute: 40 }],
        ["football.card", { by: "A", color: "yellow" }],
      ),
    );
    expect(state.squads.home.sinBin).toHaveLength(1);
    expect(state.squads.home.onPitch).not.toContain("H-p1");
  });

  it("never expires an anonymous bin onto the pitch — it just closes", () => {
    const state = fold(
      binCfg,
      stream(
        ["core.start"],
        binStart({ by: "H", at: at("H1", 600) }),
        ["football.goal", { by: "A", at: at("H1", 1200) }],
      ),
    );
    expect(state.squads.home.sinBin).toEqual([]);
    expect(state.squads.home.onPitch).toHaveLength(11);
  });

  it("does not expire an unstamped bin, and does not expire without cfg.sinBinMinutes", () => {
    const unstamped = fold(
      binCfg,
      stream(
        ["core.start"],
        binStart({ by: "H", person: "H-p1", minute: 10 }),
        ["football.goal", { by: "A", at: at("H1", 3000) }],
      ),
    );
    expect(unstamped.squads.home.sinBin).toHaveLength(1);

    const noLength = fold(
      cfgOf({}),
      stream(
        ["core.start"],
        binStart({ by: "H", person: "H-p1", at: at("H1", 600) }),
        ["football.goal", { by: "A", at: at("H1", 3000) }],
      ),
    );
    expect(noLength.squads.home.sinBin).toHaveLength(1);
    expect(noLength.squads.home.sinBin?.[0]?.expiresAt).toBeUndefined();
  });

  it("does NOT expire across a period boundary (§3.2)", () => {
    // addDuration stays inside the named period, and the engine has no period
    // length to roll the remainder into H2 with. So the bin simply does not
    // expire by time; the explicit end still closes it, exactly as before.
    const events = stream(
      ["core.start"],
      binStart({ by: "H", person: "H-p1", at: at("H1", 2600) }), // expires H1 3200
      ["football.period", { phase: "HT" }],
      ["football.goal", { by: "A", at: at("H2", 100) }],
    );
    const state = fold(binCfg, events);
    expect(state.squads.home.sinBin).toHaveLength(1);
    expect(state.squads.home.onPitch).not.toContain("H-p1");

    const ended = fold(binCfg, [
      ...events,
      makeEnvelope(4, {
        type: "football.sinbin.end",
        payload: { by: "H", person: "H-p1", at: at("H2", 100) },
      }),
    ]);
    expect(ended.squads.home.sinBin).toEqual([]);
    expect(ended.squads.home.onPitch).toContain("H-p1");
  });

  it("still expires inside the period when the stamp runs past the nominal length", () => {
    // §1.3 — `elapsed` may exceed the nominal half. Added time is still H1.
    const state = fold(
      binCfg,
      stream(
        ["core.start"],
        binStart({ by: "H", person: "H-p1", at: at("H1", 2600) }),
        ["football.goal", { by: "A", at: at("H1", 3200) }],
      ),
    );
    expect(state.squads.home.sinBin).toEqual([]);
    expect(state.squads.home.onPitch).toContain("H-p1");
  });

  it("refuses an explicit end for a bin the fold has already swept", () => {
    // The sweep runs BEFORE the event (§3.1), so a stamped end at or after the
    // derived expiry is a stale duplicate of a fact the fold already recorded.
    // Rejecting it is the honest reading; the pad's obligation (§6) is to render
    // the countdown from `expiresAt` and not offer the button at all.
    let caught: unknown;
    try {
      fold(
        binCfg,
        stream(
          ["core.start"],
          binStart({ by: "H", person: "H-p1", at: at("H1", 600) }),
          ["football.sinbin.end", { by: "H", person: "H-p1", at: at("H1", 1200) }],
        ),
      );
      expect.unreachable("a stale end must be refused");
    } catch (error) {
      caught = error;
    }
    expect(EngineError.is(caught, "INVALID_EVENT")).toBe(true);
    // Not `invalid football.sinbin.end payload` — that is the schema refusing
    // `at` outright, which is what this test asserted before the field existed.
    expect((caught as EngineError).message).toContain("is not serving a sin bin");
  });
});

// ---------------------------------------------------------------------------
// §5.2 — `at` and `minute` are DIFFERENT UNITS. Where both are present, `at`
// wins, and this is the test on the case where they disagree.
// ---------------------------------------------------------------------------

describe("`at` versus the deprecated `minute` (§5.2)", () => {
  it("derives the expiry from `at` (seconds), never from `minute` (minutes)", () => {
    // The two point at wildly different moments on purpose: `minute: 80` is the
    // 80th minute, `at` is 10:00 into the first half. If `minute` won — or if a
    // pad's minute box were multiplied into seconds anywhere in the fold — the
    // bin would expire at 90:00 and the stamp below would sweep nothing.
    const events = stream(
      ["core.start"],
      binStart({ by: "H", person: "H-p1", minute: 80, at: at("H1", 600) }),
      ["football.goal", { by: "A", at: at("H1", 1200) }],
    );
    const started = fold(binCfg, events.slice(0, 2));
    const record = started.squads.home.sinBin?.[0];
    expect(record?.startedAt).toEqual(at("H1", 600));
    expect(record?.expiresAt).toEqual(at("H1", 1200));
    // The recorded display integer is kept verbatim — never converted, never
    // overwritten. It is a fact the scorer wrote, and the two disagreeing is a
    // question for the match report, not for the fold.
    expect(record?.minute).toBe(80);

    const swept = fold(binCfg, events);
    expect(swept.squads.home.sinBin).toEqual([]);
    expect(swept.squads.home.onPitch).toContain("H-p1");
  });

  it("keeps both on a card record, without either touching the other", () => {
    const state = fold(
      cfgOf({}),
      stream(
        ["core.start"],
        ["football.card", { by: "H", person: "H-p1", color: "yellow", minute: 80, at: at("H1", 600) }],
      ),
    );
    expect(state.cards[0]?.minute).toBe(80);
    expect(state.cards[0]?.at).toEqual(at("H1", 600));
  });
});

// ---------------------------------------------------------------------------
// §5.2 — substitution windows. A window is the set of substitutions sharing one
// `at`: a side may make several at a single stoppage, and the Law counts the
// stoppages, not the players.
// ---------------------------------------------------------------------------

const subAt = (off: string, on: string, stamp?: unknown): [string, unknown] => [
  "football.sub",
  { by: "H", off, on, ...(stamp === undefined ? {} : { at: stamp }) },
];

describe("substitution windows (§5.2)", () => {
  it("counts substitutions sharing one `at` as a single window", () => {
    const state = fold(
      cfgOf({ subWindows: 2 }),
      stream(
        ["core.start"],
        subAt("H-p1", "H-b1", at("H1", 600)),
        subAt("H-p2", "H-b2", at("H1", 600)),
        subAt("H-p3", "H-b3", at("H1", 600)),
      ),
    );
    expect(state.squads.home.subWindows).toEqual([at("H1", 600)]);
    expect(state.squads.home.offUsed).toHaveLength(3);
  });

  it("accepts exactly N windows and refuses the N+1th", () => {
    const cfg = cfgOf({ subWindows: 2 });
    const atN = stream(
      ["core.start"],
      subAt("H-p1", "H-b1", at("H1", 600)),
      subAt("H-p2", "H-b2", at("H1", 600)), // same window
      subAt("H-p3", "H-b3", at("H1", 1200)), // second window
    );
    const state = fold(cfg, atN);
    expect(state.squads.home.subWindows).toEqual([at("H1", 600), at("H1", 1200)]);

    let caught: unknown;
    try {
      fold(cfg, [
        ...atN,
        makeEnvelope(4, {
          type: "football.sub",
          payload: { by: "H", off: "H-p4", on: "H-b4", at: at("H1", 1800) },
        }),
      ]);
      expect.unreachable("the third window must be refused");
    } catch (error) {
      caught = error;
    }
    expect(EngineError.is(caught, "SUB_WINDOW_EXCEEDED")).toBe(true);
  });

  it("counts windows per side, not per fixture", () => {
    const state = fold(
      cfgOf({ subWindows: 1 }),
      stream(
        ["core.start"],
        subAt("H-p1", "H-b1", at("H1", 600)),
        ["football.sub", { by: "A", off: "A-p1", on: "A-b1", at: at("H1", 600) }],
      ),
    );
    expect(state.squads.home.subWindows).toEqual([at("H1", 600)]);
    expect(state.squads.away.subWindows).toEqual([at("H1", 600)]);
  });

  it("never collapses UNSTAMPED substitutions into one window", () => {
    // An unstamped substitution has no `at` to share, so it cannot be in a
    // window at all — and must therefore consume none. Reading "no stamp" as
    // "one shared window" would trip a one-window allowance on the second
    // unstamped sub and make every stream recorded before this wave illegal.
    const state = fold(
      cfgOf({ subWindows: 1 }),
      stream(
        ["core.start"],
        subAt("H-p1", "H-b1"),
        subAt("H-p2", "H-b2"),
        subAt("H-p3", "H-b3"),
      ),
    );
    expect(state.squads.home.offUsed).toHaveLength(3);
    expect(state.squads.home.subWindows).toBeUndefined();
  });

  it("leaves an unstamped substitution unconstrained once the allowance is spent", () => {
    const state = fold(
      cfgOf({ subWindows: 1 }),
      stream(
        ["core.start"],
        subAt("H-p1", "H-b1", at("H1", 600)),
        subAt("H-p2", "H-b2"),
      ),
    );
    expect(state.squads.home.subWindows).toEqual([at("H1", 600)]);
    expect(state.squads.home.offUsed).toEqual(["H-p1", "H-p2"]);
  });

  it("does nothing at all when cfg.subWindows is absent", () => {
    const state = fold(
      cfgOf({}),
      stream(
        ["core.start"],
        subAt("H-p1", "H-b1", at("H1", 600)),
        subAt("H-p2", "H-b2", at("H1", 1200)),
        subAt("H-p3", "H-b3", at("H1", 1800)),
      ),
    );
    expect(state.squads.home.subWindows).toHaveLength(3);
  });

  it("still enforces cfg.maxSubs independently of the window allowance", () => {
    let caught: unknown;
    try {
      fold(
        cfgOf({ subWindows: 9, maxSubs: 1 }),
        stream(
          ["core.start"],
          subAt("H-p1", "H-b1", at("H1", 600)),
          subAt("H-p2", "H-b2", at("H1", 1200)),
        ),
      );
      expect.unreachable("the cap must still bite");
    } catch (error) {
      caught = error;
    }
    expect(EngineError.is(caught, "INVALID_EVENT")).toBe(true);
    // Not `invalid football.sub payload` — that is the schema refusing `at`
    // outright, which is what this test asserted before the field existed.
    expect((caught as EngineError).message).toContain("has used all 1 substitutions");
  });
});

// ---------------------------------------------------------------------------
// §8 — additive safety at fold level, independent of the frozen goldens.
// ---------------------------------------------------------------------------

describe("an entirely unstamped stream folds exactly as before (§8)", () => {
  const events = stream(
    ["core.start"],
    ["football.card", { by: "H", person: "H-p1", color: "yellow", minute: 10 }],
    ["football.sub", { by: "H", off: "H-p2", on: "H-b1", minute: 20 }],
    ["football.sinbin.start", { by: "A", person: "A-p1", minute: 25, reason: "dissent" }],
    ["football.sinbin.end", { by: "A", person: "A-p1", minute: 35 }],
    ["football.goal", { by: "H", scorer: "H-p3", minute: 40 }],
    ["football.period", { phase: "HT", addedMinutes: 2 }],
    ["football.penalty", { by: "A", taker: "A-p2", outcome: "saved", minute: 60 }],
    ["football.goal", { by: "A", minute: 70 }],
    ["football.period", { phase: "FT" }],
  );

  it("adds no key to the serialised state", () => {
    // The frozen goldens are the byte-level proof; this is the same proof at
    // fold level, and it holds even under a cfg that switches every new
    // behaviour ON — because nothing in the stream is stamped, nothing derives.
    const state = fold(cfgOf({ sinBinMinutes: 10, subWindows: 1 }), events);
    // `cfg` is serialised into State and DOES carry `subWindows`, so the state
    // fields are checked where they would live rather than over the whole blob.
    const withoutCfg = JSON.stringify({ ...state, cfg: null });
    for (const key of ['"at"', '"startedAt"', '"expiresAt"', '"subWindows"']) {
      expect(withoutCfg).not.toContain(key);
    }
    expect(state.goals).toEqual({ home: 1, away: 1 });
    expect(state.outcome).toEqual({ kind: "draw" });
  });
});

// ---------------------------------------------------------------------------
// §8 — union-swallow hazard. FootballEv is a z.union matched STRUCTURALLY with
// first-branch-wins, so widening a branch with an optional field can make it
// swallow a sibling. These pin which branch each shape reaches.
// ---------------------------------------------------------------------------

const BRANCHES = [
  ["FootballGoal", FootballGoal],
  ["FootballCard", FootballCard],
  ["FootballSub", FootballSub],
  ["FootballPeriod", FootballPeriod],
  ["FootballShootoutKick", FootballShootoutKick],
  ["FootballPenalty", FootballPenalty],
  ["FootballSinBinStart", FootballSinBinStart],
  ["FootballSinBinEnd", FootballSinBinEnd],
] as const;

function firstBranch(payload: unknown): string | null {
  return BRANCHES.find(([, schema]) => schema.safeParse(payload).success)?.[0] ?? null;
}

describe("FootballEv union disambiguation (§8)", () => {
  const stamp = at("H1", 600);

  it.each([
    ["stamped goal", { by: "H", scorer: "H-p1", at: stamp }, "FootballGoal"],
    ["stamped card", { by: "H", color: "yellow", at: stamp }, "FootballCard"],
    ["stamped sub", { by: "H", off: "H-p1", on: "H-b1", at: stamp }, "FootballSub"],
    ["period marker", { phase: "HT", addedMinutes: 2 }, "FootballPeriod"],
    ["shootout kick", { by: "H", scored: true }, "FootballShootoutKick"],
    ["missed penalty", { by: "H", outcome: "saved" }, "FootballPenalty"],
    ["stamped sin bin start", { by: "H", person: "H-p1", minutes: 10, at: stamp }, "FootballSinBinStart"],
  ])("%s reaches its own branch", (_, payload, expected) => {
    expect(firstBranch(payload)).toBe(expected);
  });

  it("does not let the widened goal branch swallow a stamped sibling", () => {
    // FootballGoal is branch ONE and now carries an optional `at`, which is the
    // branch most able to swallow the rest. Every sibling above stays reachable
    // because each carries a key `FootballGoal` (a strictObject) refuses.
    for (const [, payload, expected] of [
      ["", { by: "H", color: "yellow", at: stamp }, "FootballCard"],
      ["", { by: "H", off: "H-p1", on: "H-b1", at: stamp }, "FootballSub"],
      ["", { by: "H", person: "H-p1", at: stamp }, "FootballSinBinStart"],
    ] as const) {
      expect(firstBranch(payload)).not.toBe("FootballGoal");
      expect(firstBranch(payload)).toBe(expected);
    }
  });

  it("pins the two shapes that were ALREADY ambiguous before this wave", () => {
    // Neither is a regression and neither is a bug: the ENVELOPE's `type` is the
    // real discriminator, and `apply` parses the selected branch explicitly
    // (`parsePayload`). Recorded here so a future widening that changes either
    // answer has to change this test deliberately.
    // A bare `{by}` is a legal anonymous goal AND a legal anonymous sin bin.
    expect(firstBranch({ by: "H" })).toBe("FootballGoal");
    // FootballSinBinEnd's shape is a strict subset of FootballSinBinStart's, so
    // the union never reaches the last branch. It has been unreachable since
    // the pair landed in W4.
    expect(firstBranch({ by: "H", person: "H-p1", minute: 35 })).toBe("FootballSinBinStart");
  });
});
