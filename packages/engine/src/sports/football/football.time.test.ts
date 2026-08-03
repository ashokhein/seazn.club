// W4a (#425) — football's core time model: `at` beside the deprecated `minute`,
// sin bins that expire by fold, and substitution WINDOWS.
//
// Companion to football.domain.test.ts (W4's scorebook facts) and to
// football.test.ts (the pre-W4 machine). Every test here must fail without the
// matching fold change.
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { EngineError } from "../../core/errors.ts";
import { foldMatch, type EventEnvelope } from "../../core/events.ts";
import { compareGameTime, gameTimeOf } from "../../core/time.ts";
import type { Lineup, LineupPair } from "../../core/types.ts";
import { buildStream, defaultLineupPair, lineupFromCatalog, makeEnvelope } from "../../testkit/index.ts";
import {
  FootballCard,
  FootballEv,
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

  it("carries the unserved remainder into the next half, and the explicit end still closes it", () => {
    // §3.2 AS AMENDED (2026-08-04). This used to assert the opposite, on the
    // reasoning that the engine held no period length. Both halves were wrong:
    // IFAB's temporary-dismissal protocol carries the unserved remainder into
    // the next half exactly as IIHF carries a penalty, and `Cfg.halfMinutes` is
    // a REQUIRED positive integer, so the length was never missing.
    //
    // 43:20 + 10:00 runs 500 s past the nominal 45-minute half, so the bin has
    // 500 s still to serve in H2 and a stamp at H2 1:40 must NOT sweep it. The
    // old reading under-served the player, silently and in the offending side's
    // favour, which is worse than not modelling expiry at all.
    const events = stream(
      ["core.start"],
      binStart({ by: "H", person: "H-p1", at: at("H1", 2600) }), // carries to H2 500
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

  it("sweeps against a stamp in added time, which is still the same half (§1.3)", () => {
    // `elapsed` MAY exceed the nominal half — 90+3 is `{H2, 2880}` against a
    // nominal 2700 — and the fold never rejects it. So a bin that expires
    // comfortably inside the half is swept by a stamp taken in added time.
    //
    // The carry counts against the NOMINAL length, not the length the half
    // actually ran, because the nominal is the only figure cfg holds. That is
    // the same approximation the period kernel makes and it is stated rather
    // than hidden: a bin opened at 43:20 carries into H2 even if six minutes of
    // stoppage time were played.
    const state = fold(
      binCfg,
      stream(
        ["core.start"],
        binStart({ by: "H", person: "H-p1", at: at("H1", 2000) }), // expires H1 2600
        ["football.goal", { by: "A", at: at("H1", 3200) }],
      ),
    );
    expect(state.squads.home.sinBin).toEqual([]);
    expect(state.squads.home.onPitch).toContain("H-p1");
  });

  it("accepts an explicit end the fold has already swept, and returns the player ONCE", () => {
    // INVERTED in the W4a review pass, and the reasoning is the whole premise
    // of this design rather than a preference: lazy expiry means the pad and
    // the fold legitimately disagree between an expiry and the next event
    // (§3.1), so a scorer who records the release explicitly is being RIGHT,
    // and refusing them punishes them for the fold's own laziness. It is a
    // no-op, not an error.
    //
    // The goal at 20:00 sweeps the bin; the scorer's release lands a minute
    // later, against a bin `state.squads` no longer holds.
    const state = fold(
      binCfg,
      stream(
        ["core.start"],
        binStart({ by: "H", person: "H-p1", at: at("H1", 600) }),
        ["football.goal", { by: "A", at: at("H1", 1200) }],
        ["football.sinbin.end", { by: "H", person: "H-p1", at: at("H1", 1260) }],
      ),
    );
    expect(state.squads.home.sinBin).toEqual([]);
    // EXACTLY once. The trap the no-op has to have teeth against is the double
    // return: sweeping the player back on and then honouring the end as well
    // puts them on the pitch twice, which an "is the bin empty" assertion
    // cannot see and which no golden covers.
    expect(state.squads.home.onPitch.filter((id) => id === "H-p1")).toEqual(["H-p1"]);
    expect(state.squads.home.onPitch).toHaveLength(11);
  });

  it("still refuses a release the fold did NOT already run out", () => {
    // Narrow on purpose. A no-op only where the bin log shows the named
    // dismissal had in fact expired by this stamp. A release of something that
    // never existed, and one for a bin still running, are contradictory
    // records — not a scorer the fold got ahead of.
    const never = () =>
      fold(
        binCfg,
        stream(["core.start"], ["football.sinbin.end", { by: "H", person: "H-p1", at: at("H1", 60) }]),
      );
    expect(never).toThrowError(expect.objectContaining({ code: "INVALID_EVENT" }));
    expect(never).toThrowError(/is not serving a sin bin/);

    // Still running: 10:00 + 10:00 is 20:00, and this release is a minute early.
    const early = () =>
      fold(
        binCfg,
        stream(
          ["core.start"],
          binStart({ by: "H", person: "H-p1", at: at("H1", 600) }),
          ["football.goal", { by: "A", at: at("H1", 700) }],
          ["football.sinbin.end", { by: "H", person: "H-p1", at: at("H1", 1140) }],
        ),
      );
    // …and it is accepted, because the bin is still THERE to be released. The
    // early release is the scorer's call (a permanent dismissal, a squad
    // change); what the log guards is only the case where nothing matches.
    expect(early().squads.home.onPitch).toContain("H-p1");
  });

  it("refuses a release for a player the fold sent off, expired bin or not", () => {
    // A red card drops the bin entry (`removeFromPitch`), so the player cannot
    // "return". The log still carries the dismissal and its derived expiry, so
    // without this guard the no-op path would put a sent-off player back on the
    // pitch — the exact silent wrong the log was added to prevent.
    const off = () =>
      fold(
        binCfg,
        stream(
          ["core.start"],
          binStart({ by: "H", person: "H-p1", at: at("H1", 600) }),
          ["football.card", { by: "H", person: "H-p1", color: "red", at: at("H1", 700) }],
          ["football.goal", { by: "A", at: at("H1", 1200) }],
          ["football.sinbin.end", { by: "H", person: "H-p1", at: at("H1", 1260) }],
        ),
      );
    expect(off).toThrowError(expect.objectContaining({ code: "INVALID_EVENT" }));
    expect(off).toThrowError(/is not serving a sin bin/);
  });
});

// ---------------------------------------------------------------------------
// §3.2 as amended — where the length of a half comes from, and what
// `Cfg.periodSeconds` is allowed to override.
// ---------------------------------------------------------------------------

describe("the carry counts against cfg's own lengths (§3.2)", () => {
  const binOf = (state: ReturnType<typeof fold>) => state.squads.home.sinBin?.[0];

  it("derives the half length from Cfg.halfMinutes, with no new required config", () => {
    // The scalar is REQUIRED (default 45) and fixes both halves, so the carry
    // needed no new authority. A shorter competition format shortens it.
    const senior = fold(
      binCfg,
      stream(["core.start"], binStart({ by: "H", person: "H-p1", at: at("H1", 2400) })),
    );
    expect(binOf(senior)?.expiresAt).toEqual(at("H2", 300)); // 3000 − 2700

    const youth = fold(
      cfgOf({ sinBinMinutes: 10, halfMinutes: 30 }),
      stream(["core.start"], binStart({ by: "H", person: "H-p1", at: at("H1", 1500) })),
    );
    expect(youth.squads.home.sinBin?.[0]?.expiresAt).toEqual(at("H2", 300)); // 2100 − 1800
  });

  it("derives an extra-time half from Cfg.extraTime.halfMinutes", () => {
    const cfg = cfgOf({ sinBinMinutes: 10, extraTime: { enabled: true, halfMinutes: 15 } });
    const state = fold(
      cfg,
      stream(
        ["core.start"],
        ["football.period", { phase: "HT" }],
        ["football.period", { phase: "FT" }], // 0–0 ⇒ extra time
        binStart({ by: "H", person: "H-p1", at: at("ET_H1", 600) }),
      ),
    );
    // 600 + 600 = 1200 against a 900-second ET half ⇒ 300 into ET_H2.
    expect(state.squads.home.sinBin?.[0]?.expiresAt).toEqual(at("ET_H2", 300));
  });

  it("lets periodSeconds override ONLY what cfg cannot express — unequal halves", () => {
    // `halfMinutes` is a single scalar for both halves, so a competition
    // playing a long first half and a short second cannot say so any other way.
    // This is the whole remaining job of the override.
    const state = fold(
      cfgOf({ sinBinMinutes: 10, periodSeconds: { H1: 3000, H2: 2400 } }),
      stream(["core.start"], binStart({ by: "H", person: "H-p1", at: at("H1", 2700) })),
    );
    // 3300 against a 3000-second first half ⇒ 300 into H2, not the 600 the
    // nominal 45 would have given.
    expect(state.squads.home.sinBin?.[0]?.expiresAt).toEqual(at("H2", 300));
  });

  it("IGNORES a periodSeconds map that merely contradicts halfMinutes, and never refuses it", () => {
    // A map giving every half in a group the SAME value states nothing the
    // required scalar does not — it is duplicated authority, not a refinement —
    // so the scalar wins.
    //
    // Ignored rather than refused, and that is a correctness requirement, not
    // leniency: cfg is read LIVE from `division.config` on every fold, so a
    // CONFIG_INVALID here would let one later admin edit make every
    // already-scored fixture in the division permanently unviewable.
    const cfg = cfgOf({ sinBinMinutes: 10, periodSeconds: { H1: 60, H2: 60 } });
    expect(cfg.periodSeconds).toEqual({ H1: 60, H2: 60 }); // recorded, not stripped
    const state = fold(
      cfg,
      stream(["core.start"], binStart({ by: "H", person: "H-p1", at: at("H1", 2400) })),
    );
    // The 60-second map would have carried this to H2 with 40 minutes still to
    // run. The required 45-minute scalar wins instead.
    expect(state.squads.home.sinBin?.[0]?.expiresAt).toEqual(at("H2", 300));
  });

  it("keeps a TIMED bin short past the whistle, and an untimed one short to the end", () => {
    // The boundary sweep is TIMED-ONLY, and that is what keeps it additive: a
    // bin with no derivable expiry — unstamped, or stamped in a competition
    // that declared no sin-bin length — was never given a duration to run out,
    // so it is RIGHT that it survives every whistle. Every one of the eleven
    // frozen goldens is made entirely of those.
    const untimed = fold(
      cfgOf({}), // no sinBinMinutes ⇒ no expiry can be derived
      stream(
        ["core.start"],
        binStart({ by: "H", person: "H-p1", at: at("H1", 600) }),
        ["football.period", { phase: "HT" }],
        ["football.period", { phase: "FT" }],
      ),
    );
    expect(untimed.squads.home.sinBin).toHaveLength(1);
    expect(untimed.squads.home.onPitch).not.toContain("H-p1");
    expect(untimed.phase).toBe("done");
  });
});

// ---------------------------------------------------------------------------
// §6 obligation 3 — `asOf`: as of when is everything in this state true?
// ---------------------------------------------------------------------------

describe("State.asOf (§6 obligation 3)", () => {
  it("is absent until the first stamped event, then tracks the newest stamp", () => {
    // Absent until something populates it, matching the `penalties` / `sinBin`
    // precedent, so a pre-W4a state serialises exactly as it did.
    const unstamped = fold(cfgOf({}), stream(["core.start"], ["football.goal", { by: "H", minute: 10 }]));
    expect(unstamped.asOf).toBeUndefined();

    const stamped = fold(
      cfgOf({}),
      stream(
        ["core.start"],
        ["football.goal", { by: "H", at: at("H1", 300) }],
        ["football.card", { by: "A", color: "yellow", at: at("H1", 900) }],
      ),
    );
    expect(stamped.asOf).toEqual(at("H1", 900));
  });

  it("is NOT moved backwards by a later unstamped event", () => {
    // An unstamped event carries no clock reading, so it cannot be the moment
    // the fold is folded as of; the pad must keep rendering against the last
    // real stamp rather than losing it.
    const state = fold(
      cfgOf({}),
      stream(
        ["core.start"],
        ["football.goal", { by: "H", at: at("H1", 300) }],
        ["football.card", { by: "A", color: "yellow", minute: 20 }],
      ),
    );
    expect(state.asOf).toEqual(at("H1", 300));
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

  it("reads the DURATION from `minutes`, never from the adjacent `minute`", () => {
    // `FootballSinBinStart` carries `minutes` (the length of the dismissal,
    // which drives `expiresAt`) and `minute` (the display clock) — same type,
    // adjacent in the schema, one letter apart. That is the exact shape that
    // produced the `DisciplineCard.entrantSide` bug, and the only stream in the
    // suite carrying both used `minutes: 10, minute: 21`, which folds
    // identically whichever one a reader picks up.
    //
    // So both cases below use the SAME number, 10, and the cfg fallback is a
    // DIFFERENT number. A fold reading `minute` as the duration cannot be told
    // apart from one reading `minutes` by the value; it can only be told apart
    // by which field is present.
    const cfg = cfgOf({ sinBinMinutes: 5 });
    const fromMinutes = fold(
      cfg,
      stream(["core.start"], binStart({ by: "H", person: "H-p1", minutes: 10, at: at("H1", 600) })),
    );
    expect(fromMinutes.squads.home.sinBin?.[0]?.expiresAt).toEqual(at("H1", 1200)); // 600 + 10×60

    const fromMinute = fold(
      cfg,
      stream(["core.start"], binStart({ by: "H", person: "H-p1", minute: 10, at: at("H1", 600) })),
    );
    // The cfg fallback, 5 minutes — NOT 10. A fold that mistook `minute` for
    // the awarded duration would land on 1200 here as well.
    expect(fromMinute.squads.home.sinBin?.[0]?.expiresAt).toEqual(at("H1", 900));
    expect(fromMinute.squads.home.sinBin?.[0]?.minutes).toBe(5);
    expect(fromMinute.squads.home.sinBin?.[0]?.minute).toBe(10);
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
// §5.2 / §8 — the three payloads that were left UNSTAMPABLE. A `strictObject`
// with no `at` does not merely lack a field: it REJECTS the key, so a stamped
// event of that kind cannot be recorded at all.
// ---------------------------------------------------------------------------

describe("every timed football payload can carry a stamp", () => {
  it("records a stamped open-play penalty, and keeps the stamp on the record", () => {
    const state = fold(
      cfgOf({}),
      stream(
        ["core.start"],
        ["football.penalty", { by: "H", taker: "H-p1", outcome: "saved", minute: 30, at: at("H1", 1800) }],
      ),
    );
    expect(state.penalties?.[0]?.at).toEqual(at("H1", 1800));
    // The legacy display integer rides alongside, untouched, as everywhere else.
    expect(state.penalties?.[0]?.minute).toBe(30);
  });

  it("makes a stamped penalty advance the guard's high-water mark", () => {
    // The consequence of `strictObject` rejecting `at` was not only that the
    // penalty went unrecorded: an unstampable event can never move the fold's
    // clock, so a card recorded BEFORE it would have been accepted.
    expect(() =>
      fold(
        cfgOf({}),
        stream(
          ["core.start"],
          ["football.penalty", { by: "H", outcome: "saved", at: at("H1", 1800) }],
          ["football.card", { by: "A", color: "yellow", at: at("H1", 600) }],
        ),
      ),
    ).toThrowError(expect.objectContaining({ code: "NON_MONOTONIC_TIME" }));
  });

  it("records a stamped shoot-out kick — the phase was stampable, the payload was not", () => {
    // `playPhases` lists SHOOTOUT, so a card there was already stampable while
    // no shoot-out payload could carry a stamp: `State.asOf` froze at the last
    // stamped card for the whole decider.
    const state = fold(
      cfgOf({ shootout: true }),
      stream(
        ["core.start"],
        ["football.period", { phase: "HT" }],
        ["football.period", { phase: "FT" }], // 0–0 ⇒ kicks from the penalty mark
        ["football.shootout.kick", { by: "H", scored: true, at: at("SHOOTOUT", 30) }],
      ),
    );
    expect(state.shootout?.kicks).toHaveLength(1);
    expect(state.asOf).toEqual(at("SHOOTOUT", 30));
  });

  it("records the whistle itself — the natural stamp, and the boundary sweep's trigger", () => {
    const state = fold(
      binCfg,
      stream(
        ["core.start"],
        binStart({ by: "H", person: "H-p1", at: at("H1", 600) }),
        ["football.period", { phase: "HT", addedMinutes: 2, at: at("H1", 2820) }],
      ),
    );
    expect(state.asOf).toEqual(at("H1", 2820));
    expect(state.periods[0]?.addedMinutes).toBe(2);
    expect(state.squads.home.sinBin).toEqual([]);
    expect(state.squads.home.onPitch).toContain("H-p1");
  });
});

// ---------------------------------------------------------------------------
// §9.6 — the generator stamps what it emits, so the property runs exercise the
// wave rather than routing around it.
// ---------------------------------------------------------------------------

describe("arbitraryEvent emits `at`", () => {
  // Without it the whole W4a path had ZERO generated coverage: conformance's
  // coarse-equals-fine, the chaos and undo-sweep runs and every stream a future
  // EXTEND_GOLDEN appends all stayed on the pre-wave path, so "the goldens are
  // byte-identical" was guaranteed by the generator's blind spot rather than by
  // the change being additive.
  //
  // The stated reason for the omission — that an extra rng draw would shift
  // every generated stream — does not hold: `testkit/golden.ts` records the
  // corpus as actual `{type, payload}` objects and replays THOSE
  // (`recomputeStream` never calls `arbitraryEvent`), and `extendCorpus` copies
  // existing streams through untouched and only appends.
  const genCfg = football.configSchema.parse({ sinBinMinutes: 10 });
  const genLineups = defaultLineupPair(football.positions);

  it("stamps every module payload it emits", () => {
    // Scanned across seeds rather than pinned to one: a stream can end on its
    // second event (a generated forfeit), and one unlucky seed would make this
    // assert nothing.
    const events = Array.from({ length: 12 }, (_, i) =>
      buildStream(football, genCfg, genLineups, i + 1, 60),
    ).flat();
    expect(events.length).toBeGreaterThan(20);
    expect(events.filter((e) => gameTimeOf(e.payload) !== null).length).toBeGreaterThan(10);
    for (const event of events) {
      if (event.type.startsWith("core.")) continue;
      expect(gameTimeOf(event.payload), `${event.type} must carry a stamp`).not.toBeNull();
    }
  });

  it("stamps them MONOTONICALLY, derived from state rather than drawn", () => {
    // A drawn stamp would red the conformance run with NON_MONOTONIC_TIME for
    // entirely the wrong reason. Derived from `state.asOf` it costs no rng draw
    // at all and is monotonic by construction, the phase index carrying the
    // ordering across each boundary.
    for (let seed = 1; seed <= 12; seed++) {
      const events = buildStream(football, genCfg, genLineups, seed, 60);
      const order = playPhases(genCfg);
      let high: ReturnType<typeof gameTimeOf> = null;
      for (const event of events) {
        const stamp = gameTimeOf(event.payload);
        if (stamp === null) continue;
        if (high !== null) {
          expect(
            compareGameTime(stamp, high, order),
            `seed ${seed}: ${event.type} travels backwards`,
          ).toBeGreaterThanOrEqual(0);
        }
        high = stamp;
      }
    }
  });

  it("and those streams reach a DERIVED EXPIRY, not merely a stamped payload", () => {
    // A stream that stamps but never expires anything leaves the sweep and the
    // carry exactly as uncovered as before.
    let sawExpiry = false;
    for (let seed = 1; seed <= 40 && !sawExpiry; seed++) {
      const events = buildStream(football, genCfg, genLineups, seed, 60);
      const state = foldMatch(football, genCfg, genLineups, events);
      sawExpiry = (state.squads.home.sinBinLog ?? [])
        .concat(state.squads.away.sinBinLog ?? [])
        .some((entry) => entry.expiresAt !== undefined);
    }
    expect(sawExpiry).toBe(true);
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

// DERIVED FROM THE REAL UNION, not hand-ordered. The previous local copy
// listed the branches in the order they happen to appear in `football.ts`, so
// reordering the actual `z.union` — the thing that decides which branch wins —
// red nothing at all. `FootballEv.options` IS the order zod matches in.
const BRANCH_NAMES = new Map<unknown, string>([
  [FootballGoal, "FootballGoal"],
  [FootballCard, "FootballCard"],
  [FootballSub, "FootballSub"],
  [FootballPeriod, "FootballPeriod"],
  [FootballShootoutKick, "FootballShootoutKick"],
  [FootballPenalty, "FootballPenalty"],
  [FootballSinBinStart, "FootballSinBinStart"],
  [FootballSinBinEnd, "FootballSinBinEnd"],
]);
const BRANCHES: [string, z.ZodType][] = FootballEv.options.map((schema) => [
  BRANCH_NAMES.get(schema) ?? "UNNAMED",
  schema as z.ZodType,
]);

function firstBranch(payload: unknown): string | null {
  return BRANCHES.find(([, schema]) => schema.safeParse(payload).success)?.[0] ?? null;
}

describe("FootballEv union disambiguation (§8)", () => {
  const stamp = at("H1", 600);

  it("reads its branch order off the real union", () => {
    // A new branch that nobody names here shows up as UNNAMED rather than
    // silently escaping every disambiguation case below.
    expect(BRANCHES.length).toBe(BRANCH_NAMES.size);
    expect(BRANCHES.map(([name]) => name)).not.toContain("UNNAMED");
  });

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
