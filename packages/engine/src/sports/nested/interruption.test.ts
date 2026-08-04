// Tennis interruptions — W4a (#425) §5.4. Rain delay, medical timeout, toilet
// break, heat rule: play STOPS and RESUMES, and the chair charges it to
// somebody.
//
// Why a nested-owned event rather than `core.suspend`/`core.resume`: the core
// pair records that play stopped and (since W4a) when, and it is the right
// record for "the floodlights failed". It carries no side, no person and no
// kind, so it cannot express the three facts the chair's card is actually
// about — WHICH break this was, WHO it is charged to, and whether the
// per-set allowance is now spent. The two are complementary and a chair may
// record both; this suite pins the nested one and its interaction with the
// kernel's stamp guard.
//
// Why there is no `tennis.interruption.end`: a start/end pair would make the
// duration derivable from the end's `at`, and this wave's ruling is that `at`
// records only what the fold cannot derive. The single event records WHEN
// (`at`) and HOW LONG (`duration`) — two facts, neither derivable from the
// other, because tennis has no running game clock for a treatment limit to be
// measured against.
import { describe, expect, it } from "vitest";
import { EngineError } from "../../core/errors.ts";
import { foldMatch, type EventEnvelope } from "../../core/events.ts";
import type { GameTime } from "../../core/time.ts";
import { aggregatePlayerStats, type PlayerStatsModel } from "../../stats/stats.ts";
import { buildStream, defaultLineupPair, makeEnvelope } from "../../testkit/helpers.ts";
import type { ModuleEvent } from "../../sport/module.ts";
import { tennis } from "../tennis/tennis.ts";
import {
  NestedEv,
  NestedInterruption,
  NestedInterruptionKind,
  NestedPoint,
  NestedSanction,
  NestedSetSummary,
  playPhases,
  type NestedCfg,
  type NestedState,
} from "./kernel.ts";

const lineups = defaultLineupPair(tennis.positions);
const H = lineups.home.entrantId;
const A = lineups.away.entrantId;

function cfgFor(variant?: string, extra?: Record<string, unknown>): NestedCfg {
  const preset = variant === undefined ? {} : tennis.variants[variant];
  return tennis.configSchema.parse({ ...preset, ...(extra ?? {}) });
}

function envelopes(events: ModuleEvent[]): EventEnvelope[] {
  return events.map((event, i) => makeEnvelope(i, event));
}

// Pad-shaped: every event in these streams is being entered now, so the whole
// stream is strict (§3.3 seam). A read path passes nothing and is tolerant.
const STRICT_ALL = { strictFromSeq: 0 } as const;
function fold(cfg: unknown, events: ModuleEvent[]): NestedState {
  return foldMatch(tennis, cfg, lineups, envelopes(events), STRICT_ALL);
}

const start: ModuleEvent = { type: "core.start", payload: {} };
const point = (by: string): ModuleEvent => ({ type: "tennis.point", payload: { by } });
const summary = (home: number, away: number): ModuleEvent => ({
  type: "tennis.set_summary",
  payload: { home, away },
});
const sanction = (by: string): ModuleEvent => ({
  type: "tennis.sanction",
  payload: { by, level: "warning" },
});
const interruption = (payload: Record<string, unknown>): ModuleEvent => ({
  type: "tennis.interruption",
  payload,
});
const suspend = (at?: GameTime): ModuleEvent => ({
  type: "core.suspend",
  payload: { reason: "rain", ...(at === undefined ? {} : { at }) },
});
const resume = (at?: GameTime): ModuleEvent => ({
  type: "core.resume",
  payload: at === undefined ? {} : { at },
});

const S1 = (elapsed: number): GameTime => ({ period: "S1", elapsed });
const S2 = (elapsed: number): GameTime => ({ period: "S2", elapsed });

function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof EngineError) return error.code;
    return `not-an-EngineError: ${String(error)}`;
  }
  return "no-throw";
}

// The code ALONE is a vacuous assertion here: `apply`'s default branch already
// throws INVALID_EVENT for an event type it does not know, so every rejection
// test below passed before the event existed. The message is what says the
// rejection came from the rule under test.
function messageOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof EngineError) return `${error.code}: ${error.message}`;
    return `not-an-EngineError: ${String(error)}`;
  }
  return "no-throw";
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("tennis.interruption — the chair's break record", () => {
  it("folds a medical timeout charged to one player, and never moves the score", () => {
    const before = fold(cfgFor(), [start, point(H), point(H)]);
    const state = fold(cfgFor(), [
      start,
      point(H),
      point(H),
      interruption({
        kind: "medical",
        by: H,
        person: `${H}-p1`,
        duration: 180,
        at: S1(1_500),
      }),
    ]);
    // The break is recorded...
    expect(state.interruptions).toEqual([
      {
        kind: "medical",
        set: 1,
        by: "home",
        person: `${H}-p1`,
        duration: 180,
        at: { period: "S1", elapsed: 1_500 },
      },
    ]);
    // ...and nothing about the score moved. Compared field by field against
    // the same stream without the interruption, so a fold that quietly banked
    // a point or flipped serve reds here rather than passing on a spot check.
    expect(state.points).toEqual(before.points);
    expect(state.games).toEqual(before.games);
    expect(state.sets).toEqual(before.sets);
    expect(state.setsWon).toEqual(before.setsWon);
    expect(state.serving).toEqual(before.serving);
    expect(state.pointsWon).toEqual(before.pointsWon);
    expect(state.outcome).toBeNull();
  });

  it("records a rain delay charged to nobody — `by` and `person` stay absent", () => {
    const state = fold(cfgFor(), [start, point(H), interruption({ kind: "other" })]);
    const rec = state.interruptions?.[0];
    expect(rec).toEqual({ kind: "other", set: 1 });
    // Absent, not undefined-valued: the state is JSON-compared by the goldens.
    expect(Object.hasOwn(rec as object, "by")).toBe(false);
    expect(Object.hasOwn(rec as object, "person")).toBe(false);
    expect(Object.hasOwn(rec as object, "at")).toBe(false);
  });

  it("accepts every declared kind", () => {
    for (const kind of NestedInterruptionKind.options) {
      const state = fold(cfgFor(), [start, interruption({ kind, by: A })]);
      expect(state.interruptions?.[0]?.kind, kind).toBe(kind);
    }
  });

  it("refuses an interruption before the first serve and after the match is over", () => {
    expect(codeOf(() => fold(cfgFor(), [interruption({ kind: "heat" })]))).toBe("WRONG_PHASE");
    // 6–0 6–0 decides a best-of-3; the kernel refuses everything after that.
    const decided = [start, summary(6, 0), summary(6, 0)];
    expect(codeOf(() => fold(cfgFor(), [...decided, interruption({ kind: "heat" })]))).toBe(
      "ALREADY_DECIDED",
    );
  });

  it("rejects an unknown entrant on `by`", () => {
    expect(
      messageOf(() => fold(cfgFor(), [start, interruption({ kind: "medical", by: "ZZ" })])),
    ).toBe('INVALID_EVENT: unknown entrant "ZZ"');
  });

  it("refuses a named person with no side to charge it to", () => {
    // The allowance is per SIDE, and the ITF medical limit is per PLAYER — so a
    // break naming a player but no side credits `medical_timeouts` to that
    // player while the count allowance does not bite, which is precisely the
    // case the rule is about. The fold cannot derive the side: `NestedState`
    // holds the two entrant ids and no lineup, and putting the lineup in the
    // state would add an always-present key to every frozen golden.
    expect(
      messageOf(() =>
        fold(cfgFor(), [start, interruption({ kind: "medical", person: `${H}-p1` })]),
      ),
    ).toBe(
      'INVALID_EVENT: an interruption naming a person must also name the side it is charged to ("by"), because the allowance is per side',
    );
    // Both together is the normal case, and a side with no named person (a
    // doubles pair's break) stays legal.
    expect(
      codeOf(() =>
        fold(cfgFor(), [start, interruption({ kind: "medical", by: H, person: `${H}-p1` })]),
      ),
    ).toBe("no-throw");
    expect(codeOf(() => fold(cfgFor(), [start, interruption({ kind: "medical", by: H })]))).toBe(
      "no-throw",
    );
  });
});

// ---------------------------------------------------------------------------
// Union disambiguation — §8. The branches carry no discriminator.
// ---------------------------------------------------------------------------

describe("NestedEv union (§8)", () => {
  // Every branch at its NARROWEST and its WIDEST, because the shapes in between
  // are what a widened branch swallows. A hand-written list is still a sample:
  // exclusivity is asserted for these payloads, not proved for the whole
  // product of optional fields, so a branch widened in a direction none of
  // these probes is not caught here. The narrow/wide pairing is the cheapest
  // cover for that — a widening that swallows anything at all almost always
  // swallows the minimal shape of one of its neighbours.
  const shapes: [string, Record<string, unknown>][] = [
    ["point (minimal)", { by: H }],
    ["point (full)", { by: H, server: `${H}-p1`, scorer: `${H}-p1`, meta: { kind: "ace" } }],
    ["set_summary (minimal)", { home: 6, away: 4 }],
    ["set_summary (tie-break)", { home: 7, away: 6, tb: { home: 7, away: 5 } }],
    ["sanction (minimal)", { by: H, level: "warning" }],
    [
      "sanction (full)",
      { by: H, level: "point_penalty", person: `${H}-p1`, reason: "racquet abuse" },
    ],
    ["interruption (minimal)", { kind: "other" }],
    ["interruption (stamp only)", { kind: "heat", at: S1(900) }],
    ["interruption (duration only)", { kind: "toilet", duration: 180 }],
    ["interruption (side only)", { kind: "medical", by: H }],
    [
      "interruption (full)",
      { kind: "medical", by: H, person: `${H}-p1`, duration: 180, at: S1(900) },
    ],
  ];

  it.each(shapes)("%s parses against exactly ONE branch", (_name, payload) => {
    const accepting = NestedEv.options.filter((branch) => branch.safeParse(payload).success);
    // Not "it parses" — a union parse succeeds whenever ANY sibling is a
    // superset of the payload, which is how a widened branch swallows its
    // neighbours with every test still green. The claim is exclusivity.
    expect(accepting).toHaveLength(1);
    expect(NestedEv.parse(payload)).toEqual(payload);
  });

  it("keeps the interruption branch LAST", () => {
    // Appended, never reordered (§8). Structural matching is first-match-wins,
    // so branch position is behaviour: this reds the moment someone moves it.
    expect(NestedEv.options).toHaveLength(4);
    expect(NestedEv.options[NestedEv.options.length - 1]).toBe(NestedInterruption);
  });

  it("does not let the interruption branch accept a point, a summary or a sanction", () => {
    expect(NestedInterruption.safeParse({ by: H }).success).toBe(false);
    expect(NestedInterruption.safeParse({ home: 6, away: 4 }).success).toBe(false);
    expect(NestedInterruption.safeParse({ by: H, level: "warning" }).success).toBe(false);
    // ...and no sibling accepts an interruption.
    expect(NestedPoint.safeParse({ kind: "medical" }).success).toBe(false);
    expect(NestedSetSummary.safeParse({ kind: "medical" }).success).toBe(false);
    expect(NestedSanction.safeParse({ kind: "medical" }).success).toBe(false);
  });

  it("carries the GameTime schema verbatim — all four of its guards (§8)", () => {
    const bad = (at: unknown) => NestedInterruption.safeParse({ kind: "medical", at }).success;
    expect(bad({ period: "S1", elapsed: -1 })).toBe(false); // non-negative
    expect(bad({ period: "S1", elapsed: 1.5 })).toBe(false); // integer
    expect(bad({ period: "", elapsed: 1 })).toBe(false); // non-empty label
    expect(bad({ period: "S1", elapsed: 1, extra: 1 })).toBe(false); // strict
    expect(bad({ period: "S1", elapsed: 1 })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Phase order — §7, all four parts.
// ---------------------------------------------------------------------------

describe("nested phase order (§7)", () => {
  it("declares the shared function itself, not a copy of its output", () => {
    // Both typeof checks are load-bearing: while neither side existed a bare
    // toBe() was `undefined === undefined` and passed, pinning nothing.
    expect(playPhases).toBeTypeOf("function");
    expect(tennis.playPhases).toBeTypeOf("function");
    expect(tennis.playPhases).toBe(playPhases);
  });

  it("covers pre plus every set this cfg can reach, in order", () => {
    expect(playPhases(cfgFor())).toEqual(["pre", "S1", "S2", "S3"]);
    expect(playPhases(cfgFor("grand-slam"))).toEqual(["pre", "S1", "S2", "S3", "S4", "S5"]);
    for (const variant of Object.keys(tennis.variants)) {
      const cfg = cfgFor(variant);
      const phases = playPhases(cfg);
      expect(phases[0], variant).toBe("pre");
      expect(phases, variant).toHaveLength(cfg.bestOf + 1);
      expect(new Set(phases).size, variant).toBe(phases.length);
    }
  });

  it("refuses a stamp naming a period tennis does not have, and names the ones it does", () => {
    // Football's "H1" on a tennis card. Without a declared order the kernel
    // derives one from the stream and accepts this silently.
    let error: EngineError | null = null;
    try {
      fold(cfgFor(), [start, interruption({ kind: "heat", at: { period: "H1", elapsed: 60 } })]);
    } catch (caught) {
      error = caught as EngineError;
    }
    expect(error).toBeInstanceOf(EngineError);
    expect(error?.code).toBe("INVALID_EVENT");
    expect(error?.message).toContain("pre, S1, S2, S3");
  });

  it("derives the list from the cfg — S5 is a real period in a slam and not in a tour match", () => {
    const at = { period: "S5", elapsed: 60 };
    expect(codeOf(() => fold(cfgFor(), [start, suspend(at)]))).toBe("INVALID_EVENT");
    expect(codeOf(() => fold(cfgFor("grand-slam"), [start, suspend(at)]))).toBe("no-throw");
  });

  it("rejects an interruption stamped in a set the match has not reached", () => {
    // apply() orders `at.period` against the SAME exported function, so a pad
    // whose set selector ran ahead of play is caught here rather than filed
    // against the wrong set.
    expect(codeOf(() => fold(cfgFor(), [start, interruption({ kind: "heat", at: S2(60) })]))).toBe(
      "INVALID_EVENT",
    );
    // The current set is fine, and so is an earlier one (a delay before the
    // first serve, keyed in once play is under way).
    expect(codeOf(() => fold(cfgFor(), [start, interruption({ kind: "heat", at: S1(60) })]))).toBe(
      "no-throw",
    );
    expect(
      codeOf(() =>
        fold(cfgFor(), [start, interruption({ kind: "heat", at: { period: "pre", elapsed: 0 } })]),
      ),
    ).toBe("no-throw");
  });

  // `apply()` is called DIRECTLY, without the fold kernel in front of it, by
  // `testkit/conformance.ts` and `testkit/simulation.ts` — and by anything else
  // that drives a module rather than a match. The kernel's own period check
  // therefore is not a guarantee `apply` may lean on, and the period kernel
  // re-validates for exactly this reason. Whatever reaches `compareGameTime`
  // with an undeclared period gets `UNKNOWN_PHASE`, which §7 reserves for two
  // phase lists that disagree — an internal fault, nothing a scorer can fix.
  describe("apply() re-validates the stamp itself (§3.3, §7)", () => {
    const live = () => fold(cfgFor(), [start]);
    const applyDirect = (state: NestedState, payload: Record<string, unknown>) =>
      tennis.apply(state, makeEnvelope(9, interruption(payload)) as never);

    it("refuses an undeclared period as INVALID_EVENT, naming the periods it has", () => {
      const message = messageOf(() => applyDirect(live(), { kind: "heat", at: { period: "H1", elapsed: 60 } }));
      expect(message).toContain("INVALID_EVENT");
      expect(message).toContain("pre, S1, S2, S3");
    });

    it("refuses a fold that has run past the last declared set, rather than raising UNKNOWN_PHASE", () => {
      // `here` is derived from the fold's own set index and is compared against
      // the SAME list — nothing checks it belongs there. A cfg whose `bestOf`
      // no longer covers the sets already banked lands exactly here.
      const past: NestedState = {
        ...live(),
        sets: [
          { home: 6, away: 4 },
          { home: 4, away: 6 },
          { home: 6, away: 4 },
        ],
      };
      const message = messageOf(() => applyDirect(past, { kind: "heat", at: S1(60) }));
      expect(message).toContain("INVALID_EVENT");
      expect(message).not.toContain("UNKNOWN_PHASE");
    });
  });
});

// ---------------------------------------------------------------------------
// Monotonic guard (§3.3) — inherited from the kernel, exercised through tennis.
// ---------------------------------------------------------------------------

describe("stamped tennis and the monotonic guard (§3.3)", () => {
  it("accepts an equal stamp on the suspend/resume pair — the clock-stop reading", () => {
    const state = fold(cfgFor(), [start, point(H), suspend(S1(900)), resume(S1(900)), point(H)]);
    expect(state.pointsWon).toEqual({ home: 2, away: 0 });
  });

  it("rejects a resume stamped before its suspend", () => {
    expect(codeOf(() => fold(cfgFor(), [start, suspend(S1(900)), resume(S1(500))]))).toBe(
      "NON_MONOTONIC_TIME",
    );
  });

  it("rejects a second interruption stamped earlier than the first", () => {
    expect(
      codeOf(() =>
        fold(cfgFor(), [
          start,
          interruption({ kind: "medical", at: S1(900) }),
          interruption({ kind: "toilet", at: S1(600) }),
        ]),
      ),
    ).toBe("NON_MONOTONIC_TIME");
    // Equal is legal.
    expect(
      codeOf(() =>
        fold(cfgFor(), [
          start,
          interruption({ kind: "medical", at: S1(900) }),
          interruption({ kind: "toilet", at: S1(900) }),
        ]),
      ),
    ).toBe("no-throw");
  });

  it("leaves unstamped events unconstrained between stamped ones", () => {
    const state = fold(cfgFor(), [
      start,
      interruption({ kind: "medical", at: S1(900) }),
      point(H),
      sanction(A),
      interruption({ kind: "toilet", at: S1(901) }),
    ]);
    expect(state.interruptions).toHaveLength(2);
    expect(state.sanctions).toHaveLength(1);
  });

  it("survives a set boundary: the new set outranks a larger elapsed in the old one", () => {
    const state = fold(cfgFor(), [
      start,
      interruption({ kind: "heat", at: S1(3_000) }),
      summary(6, 4),
      // Set 2 has only just begun, so `elapsed` RESTARTS — lower than the S1
      // stamp above and still forward in time, because phase index is compared
      // first. A flat "seconds since the first serve" model rejects this.
      interruption({ kind: "toilet", at: S2(120) }),
    ]);
    expect(state.interruptions?.map((rec) => [rec.kind, rec.set, rec.at?.period])).toEqual([
      ["heat", 1, "S1"],
      ["toilet", 2, "S2"],
    ]);
    // The set index on the record is the FOLD's, never the payload's.
    expect(state.sets).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Allowances — §5.4. Count is rejected; duration is recorded.
// ---------------------------------------------------------------------------

describe("interruption allowances (§5.4)", () => {
  const oneMedical = { interruptions: { medical: { count: 1, seconds: 180 } } };

  it("FLAGS a break beyond the per-set count allowance instead of refusing it", () => {
    const cfg = cfgFor(undefined, oneMedical);
    const state = fold(cfg, [
      start,
      interruption({ kind: "medical", by: H }),
      interruption({ kind: "medical", by: H }),
    ]);
    // Both stand; the second carries the flag, the first does not have the key
    // at all (the goldens compare JSON.stringify(state)).
    expect(state.interruptions).toEqual([
      { kind: "medical", set: 1, by: "home" },
      { kind: "medical", set: 1, by: "home", overCount: true },
    ]);
    expect(Object.hasOwn(state.interruptions?.[0] as object, "overCount")).toBe(false);
  });

  it("keeps an already-recorded fixture readable after the count allowance is LOWERED", () => {
    // THE FIXTURE-BRICKING CASE. cfg is read live from `division.config` and the
    // whole stream replays from `init` on EVERY read — state, score page,
    // standings. A refusal computed from cfg therefore fires on replay, on
    // events already in the ledger, and there is no event to void: the fixture
    // is permanently unviewable and no scorer action recovers it. Nothing
    // derived from cfg may throw on the replay path.
    const stream = [
      start,
      interruption({ kind: "medical", by: H }),
      interruption({ kind: "medical", by: H }),
    ];
    const asRecorded = fold(cfgFor(undefined, { interruptions: { medical: { count: 2 } } }), stream);
    expect(asRecorded.interruptions).toHaveLength(2);
    expect(asRecorded.interruptions?.every((rec) => rec.overCount === undefined)).toBe(true);

    // The organiser edits the division config down to one. The SAME stream:
    const lowered = fold(cfgFor(undefined, oneMedical), stream);
    expect(lowered.interruptions).toHaveLength(2);
    expect(lowered.interruptions?.map((rec) => rec.overCount)).toEqual([undefined, true]);
  });

  it("counts the allowance per side and per set", () => {
    const cfg = cfgFor(undefined, oneMedical);
    // The opponent's break is not this player's, and a new set is a new
    // allowance — both would fail against a match-wide counter.
    const state = fold(cfg, [
      start,
      interruption({ kind: "medical", by: H }),
      interruption({ kind: "medical", by: A }),
      summary(6, 4),
      interruption({ kind: "medical", by: H }),
    ]);
    expect(state.interruptions?.map((rec) => [rec.by, rec.set])).toEqual([
      ["home", 1],
      ["away", 1],
      ["home", 2],
    ]);
  });

  it("leaves a kind with no declared allowance unlimited", () => {
    const cfg = cfgFor(undefined, oneMedical);
    const state = fold(cfg, [
      start,
      interruption({ kind: "toilet", by: H }),
      interruption({ kind: "toilet", by: H }),
      interruption({ kind: "toilet", by: H }),
    ]);
    expect(state.interruptions).toHaveLength(3);
  });

  it("records an over-long break instead of rejecting it — the umpire adjudicates", () => {
    const cfg = cfgFor(undefined, oneMedical);
    const state = fold(cfg, [start, interruption({ kind: "medical", by: H, duration: 240 })]);
    expect(state.interruptions?.[0]?.overran).toBe(true);
    // At the limit exactly is not an overrun, and `overran` stays ABSENT.
    const onTime = fold(cfg, [start, interruption({ kind: "medical", by: H, duration: 180 })]);
    expect(Object.hasOwn(onTime.interruptions?.[0] as object, "overran")).toBe(false);
  });

  it("is enforced only where the break names a side — a rain delay is charged to nobody", () => {
    const cfg = cfgFor(undefined, oneMedical);
    const state = fold(cfg, [
      start,
      interruption({ kind: "medical" }),
      interruption({ kind: "medical" }),
    ]);
    expect(state.interruptions).toHaveLength(2);
    expect(state.interruptions?.every((rec) => rec.overCount === undefined)).toBe(true);
  });

  it("re-derives both verdicts from the cfg in force AT READ TIME — they are projections, not payload facts", () => {
    // `overran` and `overCount` are computed during the fold, from a cfg read
    // live out of `division.config`. So the SAME stream, replayed after an
    // organiser edits the allowance, legitimately reports a different verdict
    // against an identical `duration` — and that is the CORRECT behaviour, not
    // a hazard: the alternative is freezing the verdict into the payload beside
    // the input it was computed from, which is the two-fields-that-can-disagree
    // bug this wave rejected everywhere else. One fold can never disagree with
    // itself, because the whole stream replays from `init` on every read.
    const stream = [
      start,
      interruption({ kind: "medical", by: H, duration: 240 }),
      interruption({ kind: "medical", by: H, duration: 240 }),
    ];
    const strict = fold(cfgFor(undefined, { interruptions: { medical: { count: 1, seconds: 180 } } }), stream);
    expect(strict.interruptions).toEqual([
      { kind: "medical", set: 1, by: "home", duration: 240, overran: true },
      { kind: "medical", set: 1, by: "home", duration: 240, overran: true, overCount: true },
    ]);
    // Same events, same durations, a laxer allowance — both verdicts flip off
    // and the recorded facts are untouched.
    const lax = fold(cfgFor(undefined, { interruptions: { medical: { count: 2, seconds: 300 } } }), stream);
    expect(lax.interruptions).toEqual([
      { kind: "medical", set: 1, by: "home", duration: 240 },
      { kind: "medical", set: 1, by: "home", duration: 240 },
    ]);
  });

  it("takes no default — the shipped variants declare no allowance at all", () => {
    for (const variant of Object.keys(tennis.variants)) {
      // cfg is serialised into the frozen golden state strings, so a default
      // here is a breaking change (§8).
      expect(Object.hasOwn(cfgFor(variant), "interruptions"), variant).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// The five coordinated edits (§5.6) — the three that fail SILENTLY.
// ---------------------------------------------------------------------------

describe("tennis.interruption is wired everywhere a new type must be (§5.6)", () => {
  it("appears in the fidelity tiers that carry attributed play", () => {
    const tiers = Object.fromEntries(
      tennis.fidelityTiers.map((tier) => [tier.tier, tier.eventTypes]),
    );
    expect(tiers[2]).toContain("tennis.interruption");
    expect(tiers[3]).toContain("tennis.interruption");
    // Tiers 0/1 are a bare set score; the chair's break record rides with
    // point scoring, exactly as the sanction does.
    expect(tiers[0]).not.toContain("tennis.interruption");
    expect(tiers[1]).not.toContain("tennis.interruption");
  });

  it("is reachable from arbitraryEvent, so a generated stream exercises it", () => {
    const cfg = cfgFor();
    const seen: string[] = [];
    for (let seed = 1; seed <= 40; seed++) {
      for (const event of buildStream(tennis, cfg, lineups, seed, 400)) {
        if (event.type === "tennis.interruption") seen.push(event.id);
      }
    }
    expect(seen.length).toBeGreaterThan(0);
  });

  it("generates only stamps the fold accepts — every generated stream folds", () => {
    const cfg = cfgFor();
    for (let seed = 1; seed <= 40; seed++) {
      const events = buildStream(tennis, cfg, lineups, seed, 400);
      // buildStream calls apply() directly; foldMatch adds the kernel's
      // monotonic guard, which is what a generated `at` can actually break.
      expect(() => foldMatch(tennis, cfg, lineups, events), `seed ${seed}`).not.toThrow();
    }
  });

  it("stamps a generated break from the START OF THE SET, so `elapsed` restarts at a set boundary", () => {
    // The dossier row says `elapsed` counts from the start of the SET. A
    // match-wide base satisfies the monotonic guard just as well and looks
    // right in the state, so no other test in this suite tells the two apart —
    // and the frozen corpus is about to be EXTENDED from generated streams,
    // which freezes whichever one ships. Restarting at a set boundary is the
    // one property that discriminates, and a random scan almost never reaches
    // it (two breaks either side of one boundary, the first of them late in
    // its set). So the generator is driven DIRECTLY, against two states that
    // differ only in which set they are in.
    //
    // The rng is scripted to walk into the interruption branch: skip the
    // sanction roll, take the interruption roll, then the side and the kind.
    // The event type is asserted rather than assumed, so a reordered draw reds
    // here instead of quietly stamping something else.
    const scriptedRng = () => {
      const draws = [0.9, 0.01, 0.3, 0.3];
      let i = 0;
      return () => draws[i++ % draws.length] as number;
    };
    const stampOf = (state: NestedState): GameTime => {
      const event = tennis.arbitraryEvent?.(state, scriptedRng());
      expect(event?.type).toBe("tennis.interruption");
      return (event?.payload as { at: GameTime }).at;
    };

    const live = fold(cfgFor(), [start]);
    // Deep into set one...
    const lateInSetOne = stampOf({ ...live, games: { home: 5, away: 4 } });
    // ...and the opening minutes of set two, one summary later.
    const earlyInSetTwo = stampOf(fold(cfgFor(), [start, summary(6, 4)]));

    expect(lateInSetOne.period).toBe("S1");
    expect(earlyInSetTwo.period).toBe("S2");
    // Nine games of set one are behind the first stamp and none of set two is
    // behind the second, so a set-relative clock RESTARTS: strictly smaller,
    // later in the match. A match-wide base makes both of these the same
    // number (no rally has been scored in either state), which is the red.
    expect(lateInSetOne.elapsed).toBeGreaterThan(0);
    expect(earlyInSetTwo.elapsed).toBeLessThan(lateInSetOne.elapsed);
  });

  it("changes summary().detail once a break is recorded, and not before", () => {
    const clean = tennis.summary(fold(cfgFor(), [start, point(H)]));
    expect(Object.hasOwn(clean.detail as object, "interruptions")).toBe(false);
    const withBreak = tennis.summary(
      fold(cfgFor(), [start, point(H), interruption({ kind: "heat", duration: 600 })]),
    );
    expect((withBreak.detail as { interruptions: unknown }).interruptions).toEqual([
      { kind: "heat", set: 1, duration: 600 },
    ]);
  });

  it("credits the named player through playerStats — MEDICAL breaks only", () => {
    // Aggregated for real, not inspected. A shape check ("a metric exists whose
    // `field` is person") is green with the `when` predicate, the `key` or the
    // `label` deleted, so it says nothing about whether the leaderboard counts
    // the right thing. The predicate is what makes "medical timeouts" mean
    // medical timeouts rather than "times this player left the court".
    const model = tennis.playerStats as PlayerStatsModel;
    const metric = model.metrics.find((m) => m.key === "medical_timeouts");
    expect(metric?.from).toBe("tennis.interruption");
    expect(metric?.field).toBe("person");
    expect(metric?.label).toBe("Medical timeouts");

    const events = [
      start,
      interruption({ kind: "medical", by: H, person: `${H}-p1`, duration: 180 }),
      interruption({ kind: "toilet", by: H, person: `${H}-p1`, duration: 90 }),
      interruption({ kind: "heat", by: H, person: `${H}-p1` }),
    ];
    // A legal stream first, so the tally is over events the fold accepts.
    expect(fold(cfgFor(), events).interruptions).toHaveLength(3);

    const rows = aggregatePlayerStats(envelopes(events), model);
    const player = rows.find((row) => row.personId === `${H}-p1`);
    expect(player?.stats.medical_timeouts).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Additive safety — §8.
// ---------------------------------------------------------------------------

describe("additive safety (§8)", () => {
  it("folds an unstamped pre-W4a stream with no new keys anywhere in the state", () => {
    // A set summary may not follow points inside the SAME set, so the summary
    // closes set one and the rally path opens set two.
    const state = fold(cfgFor(), [start, summary(6, 4), point(H), point(A), sanction(H), point(A)]);
    // `interruptions` must be ABSENT, not an empty array: the golden corpus
    // compares JSON.stringify(state), so initialising it in init() would
    // rewrite every frozen stream.
    expect(Object.hasOwn(state, "interruptions")).toBe(false);
    expect(JSON.stringify(state)).not.toContain("interruption");
    expect(JSON.stringify(state)).not.toContain('"at"');
  });

  it("still accepts a stoppage recorded with no stamp at all", () => {
    const state = fold(cfgFor(), [start, point(H), suspend(), resume(), point(H)]);
    expect(state.pointsWon).toEqual({ home: 2, away: 0 });
  });
});
