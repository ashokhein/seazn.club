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
  return tennis.configSchema.parse({ ...preset, ...(extra ?? {}) }) as NestedCfg;
}

function envelopes(events: ModuleEvent[]): EventEnvelope[] {
  return events.map((event, i) => makeEnvelope(i, event));
}

function fold(cfg: unknown, events: ModuleEvent[]): NestedState {
  return foldMatch(tennis, cfg, lineups, envelopes(events)) as NestedState;
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
});

// ---------------------------------------------------------------------------
// Union disambiguation — §8. The branches carry no discriminator.
// ---------------------------------------------------------------------------

describe("NestedEv union (§8)", () => {
  const shapes: [string, Record<string, unknown>][] = [
    ["point", { by: H, server: `${H}-p1`, scorer: `${H}-p1` }],
    ["set_summary", { home: 6, away: 4 }],
    ["sanction", { by: H, level: "warning", person: `${H}-p1` }],
    ["interruption", { kind: "medical", by: H, person: `${H}-p1`, duration: 180, at: S1(900) }],
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

  it("rejects a break beyond the per-set count allowance", () => {
    const cfg = cfgFor(undefined, oneMedical);
    // On the message, not the code: `apply`'s unknown-type branch also throws
    // INVALID_EVENT, so a code-only assertion passed before the event existed.
    expect(
      messageOf(() =>
        fold(cfg, [
          start,
          interruption({ kind: "medical", by: H }),
          interruption({ kind: "medical", by: H }),
        ]),
      ),
    ).toBe(
      'INVALID_EVENT: home has already taken 1 medical break in set 1, which is all this competition allows',
    );
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

  it("changes summary().detail once a break is recorded, and not before", () => {
    const clean = tennis.summary(fold(cfgFor(), [start, point(H)]) as never);
    expect(Object.hasOwn(clean.detail as object, "interruptions")).toBe(false);
    const withBreak = tennis.summary(
      fold(cfgFor(), [start, point(H), interruption({ kind: "heat", duration: 600 })]) as never,
    );
    expect((withBreak.detail as { interruptions: unknown }).interruptions).toEqual([
      { kind: "heat", set: 1, duration: 600 },
    ]);
  });

  it("credits the named player through playerStats", () => {
    const metric = tennis.playerStats?.metrics.find((m) => m.from === "tennis.interruption");
    expect(metric).toBeDefined();
    expect(metric?.field).toBe("person");
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
