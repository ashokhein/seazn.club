// W4a (#425) — the SHARED time-kernel conformance suite.
//
// WHY THIS FILE EXISTS. Three sports were built against one design doc in
// parallel and each hand-rolled the same concept; every review found the same
// divergences, and football's found five in one sport. Copying the period
// kernel's shape into football fixes today and guarantees the next sport forks
// again, because there is nothing a new sport can RUN to find out it diverged.
//
// WHY A TEST SUITE RATHER THAN SHARED PRODUCTION CODE. The nested (tennis)
// kernel settled the extraction question: its interruptions carry `duration`
// and `overran` explicitly and have no lazy expiry at all, so it needs none of
// this machinery. That leaves exactly TWO users of the sweep — the period
// kernel and football — which is below the bar for extracting a third shared
// module and paying for the indirection everywhere. The cheaper half of the
// same benefit is this: one parameterised suite both must pass, with a small
// per-sport adapter. A sport that lands `at` adds an adapter; the six cases
// below then hold it to the same semantics without constraining how it gets
// there.
//
// WHAT IS ASSERTED — SEMANTICS, NEVER IMPLEMENTATION. Nothing here names
// `sweepExpired`, `sweepThroughPhase` or any other private helper. Each case is
// a fact a consumer can observe from a folded state, so a sport is free to
// implement it any way it likes and still be held to it:
//
//   1. An explicit end AFTER an earlier stamped event already swept is a
//      NO-OP, not a throw — and it must not return the player twice.
//   2. `apply()` re-validates `at.period` against its own phase order without
//      relying on having been called through `foldMatch`.
//   3. `asOf` is set on EVERY stamped event.
//   4. Leaving a phase sweeps whatever expired inside it, and the final
//      whistle sweeps every timed suspension still standing — so full-time
//      strength is right with NOTHING stamped after the expiry.
//   5. An unserved remainder CARRIES into the next phase whose length is
//      derivable, and stays in-period as a named fallback where it is not.
//   6. The sweep never raises `UNKNOWN_PHASE`, however stale the recorded
//      phase labels have become.
import { describe, expect, it } from "vitest";
import { EngineError } from "../core/errors.ts";
import { foldMatch, type EventEnvelope } from "../core/events.ts";
import type { GameTime } from "../core/time.ts";
import type { LineupPair } from "../core/types.ts";
import type { AnySportModule, ModuleEvent } from "../sport/module.ts";
import { defaultLineupPair, makeEnvelope } from "../testkit/helpers.ts";
import { football } from "./football/football.ts";
import { hockey } from "./hockey/hockey.ts";
import { icehockey } from "./icehockey/icehockey.ts";

// ---------------------------------------------------------------------------
// The adapter a sport implements to join the suite.
// ---------------------------------------------------------------------------

/** A running suspension / sin bin, read back through the adapter. Only the two
 *  stamps are shared vocabulary; everything else is the sport's own. */
interface RunningSuspension {
  startedAt?: GameTime;
  expiresAt?: GameTime;
}

/** A cfg plus the stream to fold under it. */
interface TimeCase {
  cfg: unknown;
  events: ModuleEvent[];
}

interface TimeKernelAdapter {
  /** The label the suite reports under. */
  name: string;
  module: AnySportModule;
  lineups: LineupPair;

  /** The on-field count for the suspended side when nobody is serving. A
   *  double return shows up here as `fullStrength + 1`, which is the trap the
   *  inverted no-op case has to have teeth against. */
  fullStrength: number;
  strength(state: unknown): number;
  running(state: unknown): readonly RunningSuspension[];
  asOf(state: unknown): GameTime | undefined;

  /** §1 — a stamped release arriving AFTER an earlier stamped event already
   *  swept the same suspension. */
  releaseAfterSweep: TimeCase;

  /** §2 — `apply()` called DIRECTLY, never through `foldMatch`, with a stamp
   *  naming a period this cfg does not declare. */
  undeclaredStamp: { cfg: unknown; open: ModuleEvent[]; event: ModuleEvent; phases: string[] };

  /** §3 — a stream whose every module event is stamped. */
  stamped: TimeCase & { lastStamp: GameTime };

  /** §4a — an expiry inside a phase, with the whistle that closes the phase
   *  carrying NO stamp. Nothing may be stamped after the expiry. */
  phaseWhistle: TimeCase;

  /** §4b — the match is decided while a TIMED suspension is still standing. */
  decidedWhileRunning: TimeCase;

  /** §4c — an expiry that carried into a phase the match never reached, so the
   *  phase whistle cannot sweep it. Absent where the cfg cannot produce one
   *  (a sport with no overtime has no phase past its last). */
  carriedPastFullTime?: TimeCase;

  /** §5a — the remainder carries into the next phase. */
  carry: TimeCase & { expiresAt: GameTime };

  /** §5b — nowhere to carry it to: the expiry stays in-period. */
  noCarry: TimeCase & { expiresAt: GameTime };

  /** §6 — a state whose recorded expiry names a phase the LIVE cfg no longer
   *  declares, which is what an admin editing `division.config` after the
   *  fixture was scored produces. */
  staleExpiry: { state: unknown; undeclared: ModuleEvent; declared: ModuleEvent };
}

// ---------------------------------------------------------------------------
// The suite.
// ---------------------------------------------------------------------------

function envelopes(events: readonly ModuleEvent[]): EventEnvelope[] {
  return events.map((event, i) => makeEnvelope(i, event));
}

function foldCase(adapter: TimeKernelAdapter, testCase: TimeCase): unknown {
  return foldMatch(adapter.module, testCase.cfg, adapter.lineups, envelopes(testCase.events));
}

function caught(run: () => unknown): unknown {
  try {
    run();
    return null;
  } catch (error) {
    return error;
  }
}

function runTimeKernelConformance(adapter: TimeKernelAdapter): void {
  describe(`${adapter.name} — shared time-kernel conformance (W4a §3)`, () => {
    it("1. an explicit end after the fold already swept is a no-op, not a throw", () => {
      // The whole premise of lazy expiry (§3.1) is that the pad and the fold
      // legitimately disagree between an expiry and the next event. A scorer
      // who records the release explicitly is being RIGHT, and refusing them
      // punishes them for the fold's own laziness.
      const error = caught(() => foldCase(adapter, adapter.releaseAfterSweep));
      expect(error).toBeNull();
      const state = foldCase(adapter, adapter.releaseAfterSweep);
      expect(adapter.running(state)).toHaveLength(0);
      // EXACTLY full strength. The no-op's trap is the double return: sweeping
      // the player back on and THEN honouring the end puts them on twice, which
      // an `is it empty` assertion on the suspension list cannot see.
      expect(adapter.strength(state)).toBe(adapter.fullStrength);
    });

    it("2. apply() re-validates the stamp's period without going through foldMatch", () => {
      // The fold kernel's guard already refuses an undeclared period, but a
      // module must not DEPEND on having been called through it: the same list,
      // the same code, and a message naming the phases so a scorer can retype.
      const { cfg, open, event, phases } = adapter.undeclaredStamp;
      let state = adapter.module.init(cfg, adapter.lineups) as unknown;
      open.forEach((step, i) => {
        state = adapter.module.apply(state, makeEnvelope(i, step) as EventEnvelope);
      });
      const before = state;
      const error = caught(() =>
        adapter.module.apply(before, makeEnvelope(open.length, event) as EventEnvelope),
      );
      expect(EngineError.is(error, "INVALID_EVENT")).toBe(true);
      // Payload validation, not an invariant breach (§3.3): the likely cause is
      // a scorer picking a period this sport does not have, so the error names
      // the ones it does. NOT `UNKNOWN_PHASE`, which is reserved for two phase
      // lists disagreeing and maps to a 500-shaped surprise for the scorer.
      expect(EngineError.is(error, "UNKNOWN_PHASE")).toBe(false);
      for (const phase of phases) {
        expect((error as EngineError).message).toContain(phase);
      }
    });

    it("3. asOf records the instant the fold is folded as of", () => {
      // §6 obligation 3. A pad drawing a countdown must be able to say what
      // instant its strength chip is true as of, or a scorer reads the gap
      // between an expiry and the next event as a bug.
      const state = foldCase(adapter, adapter.stamped);
      expect(adapter.asOf(state)).toEqual(adapter.stamped.lastStamp);
    });

    it("4a. the whistle closing a phase sweeps what expired inside it", () => {
      // Without this, an expiry late in a phase with NOTHING stamped after it
      // survives into the final state and every strength read, tally and
      // summary over the suspension list is silently wrong. The closing event
      // in this case carries no stamp, so only the phase transition can sweep.
      const state = foldCase(adapter, adapter.phaseWhistle);
      expect(adapter.running(state)).toHaveLength(0);
      expect(adapter.strength(state)).toBe(adapter.fullStrength);
    });

    it("4b. the final whistle sweeps a timed suspension still standing", () => {
      // TIMED only, and that is what keeps it additive: a suspension with no
      // derived expiry was never given a duration to run out (an unstamped
      // card, or a rest-of-match class), and those are RIGHT to keep the side
      // short to the final whistle.
      const state = foldCase(adapter, adapter.decidedWhileRunning);
      expect(adapter.running(state)).toHaveLength(0);
      expect(adapter.strength(state)).toBe(adapter.fullStrength);
    });

    const carriedPast = adapter.carriedPastFullTime;
    it.skipIf(carriedPast === undefined)(
      "4c. an expiry carried into a phase never played is swept at full time",
      () => {
        // The phase sweep alone cannot reach it: the expiry is indexed PAST the
        // phase being closed, so a suspension awarded late in the last
        // regulation period survives a full time that decides the match before
        // overtime is ever played.
        const state = foldCase(adapter, carriedPast as TimeCase);
        expect(adapter.running(state)).toHaveLength(0);
        expect(adapter.strength(state)).toBe(adapter.fullStrength);
      },
    );

    it("5a. the unserved remainder carries into the next phase", () => {
      // Leaving it in-period is not a harmless approximation, it is ACTIVELY
      // wrong under lazy expiry: an expiry past the end of its own period sorts
      // before every stamp in the next one, so the first stamped event there
      // sweeps a suspension that still has time to run — under-serving it, in
      // the offending side's favour.
      const state = foldCase(adapter, adapter.carry);
      const running = adapter.running(state);
      expect(running).toHaveLength(1);
      expect(running[0]?.expiresAt).toEqual(adapter.carry.expiresAt);
    });

    it("5b. with nowhere to carry it, the expiry stays in-period (the named fallback)", () => {
      // §3.2's fallback, named rather than assumed. Past the last phase there
      // is no more play to run into, so the remainder stays where it is and the
      // suspension ends on the explicit release or the final whistle.
      const state = foldCase(adapter, adapter.noCarry);
      const running = adapter.running(state);
      expect(running).toHaveLength(1);
      expect(running[0]?.expiresAt).toEqual(adapter.noCarry.expiresAt);
    });

    it("6. the sweep never raises UNKNOWN_PHASE against a stale phase label", () => {
      // cfg is read LIVE from `division.config` at fold time, so renaming a
      // period or dropping overtime AFTER a match was scored makes a recorded
      // phase label unrecognisable. A throwing sweep makes that fixture
      // permanently UNVIEWABLE rather than merely stale, which is the
      // catastrophic direction.
      const { state, undeclared, declared } = adapter.staleExpiry;
      const runningBefore = adapter.running(state).length;
      expect(runningBefore).toBeGreaterThan(0);

      const stale = caught(() =>
        adapter.module.apply(state, makeEnvelope(99, undeclared) as EventEnvelope),
      );
      expect(EngineError.is(stale, "UNKNOWN_PHASE")).toBe(false);

      // …and a stamp the cfg DOES declare still folds, with the unorderable
      // suspension kept rather than silently erased: one that outlives its time
      // is visible and correctable, one that vanished is neither.
      const next = adapter.module.apply(state, makeEnvelope(99, declared) as EventEnvelope);
      expect(adapter.running(next)).toHaveLength(runningBefore);
    });
  });
}

// ---------------------------------------------------------------------------
// Football adapter — sin bins, `Cfg.sinBinMinutes`, the pitch as strength.
// ---------------------------------------------------------------------------

const at = (period: string, elapsed: number): GameTime => ({ period, elapsed });

const footballLineups = defaultLineupPair(football.positions);
const fbCfg = (raw: unknown = {}): unknown => football.configSchema.parse(raw);
const BIN = { sinBinMinutes: 10 }; // 600 s
const FB_ET = { ...BIN, extraTime: { enabled: true, halfMinutes: 15 } };

const fbStart: ModuleEvent = { type: "core.start", payload: {} };
const fbBin = (stamp: GameTime): ModuleEvent => ({
  type: "football.sinbin.start",
  payload: { by: "H", person: "H-p1", at: stamp },
});
const fbEnd = (stamp: GameTime): ModuleEvent => ({
  type: "football.sinbin.end",
  payload: { by: "H", person: "H-p1", at: stamp },
});
const fbGoal = (stamp?: GameTime): ModuleEvent => ({
  type: "football.goal",
  payload: { by: "A", ...(stamp === undefined ? {} : { at: stamp }) },
});
const fbMarker = (phase: string, stamp?: GameTime): ModuleEvent => ({
  type: "football.period",
  payload: { phase, ...(stamp === undefined ? {} : { at: stamp }) },
});

// §6 — a bin stamped in extra time under a cfg that HAS extra time, then read
// back under one that does not. The competition dropped ET after the fixture
// was scored; the recorded `ET_H1` label is now unorderable.
function footballStaleExpiry(): TimeKernelAdapter["staleExpiry"] {
  const state = foldMatch(
    football,
    fbCfg(FB_ET),
    footballLineups,
    envelopes([fbStart, fbBin(at("ET_H1", 100))]),
  ) as unknown as Record<string, unknown>;
  return {
    state: { ...state, cfg: fbCfg(BIN) },
    undeclared: fbGoal(at("ET_H1", 800)),
    declared: fbGoal(at("H2", 100)),
  };
}

const footballAdapter: TimeKernelAdapter = {
  name: "football",
  module: football,
  lineups: footballLineups,
  fullStrength: 11,
  strength: (state) =>
    ((state as { squads: { home: { onPitch: string[] } } }).squads.home.onPitch ?? []).length,
  running: (state) =>
    (state as { squads: { home: { sinBin?: RunningSuspension[] } } }).squads.home.sinBin ?? [],
  asOf: (state) => (state as { asOf?: GameTime }).asOf,

  releaseAfterSweep: {
    cfg: fbCfg(BIN),
    // Bin at 10:00 runs to 20:00; the goal at 20:00 sweeps it; the scorer's own
    // release lands a minute later.
    events: [fbStart, fbBin(at("H1", 600)), fbGoal(at("H1", 1200)), fbEnd(at("H1", 1260))],
  },

  undeclaredStamp: {
    cfg: fbCfg(BIN),
    open: [fbStart],
    event: fbGoal(at("ET_H1", 60)),
    phases: ["pre", "H1", "H2"],
  },

  stamped: {
    cfg: fbCfg(BIN),
    events: [fbStart, fbGoal(at("H1", 300)), fbBin(at("H1", 600))],
    lastStamp: at("H1", 600),
  },

  phaseWhistle: {
    cfg: fbCfg(BIN),
    // Expires at H1 20:00; the half-time marker carries NO stamp, so only the
    // phase transition can end it.
    events: [fbStart, fbBin(at("H1", 600)), fbMarker("HT")],
  },

  decidedWhileRunning: {
    cfg: fbCfg(BIN),
    events: [fbStart, fbBin(at("H1", 600)), { type: "core.forfeit", payload: { by: "A", reason: "walkover" } }],
  },

  carriedPastFullTime: {
    cfg: fbCfg(FB_ET),
    // 40:00 of the second half + 10:00 runs past the nominal 45, so it carries
    // into ET_H1 — a phase this match never plays, because the home lead
    // decides it at full time.
    events: [
      fbStart,
      { type: "football.goal", payload: { by: "H", at: at("H1", 100) } },
      fbMarker("HT"),
      fbBin(at("H2", 2400)),
      fbMarker("FT"),
    ],
  },

  carry: {
    cfg: fbCfg(BIN),
    events: [fbStart, fbBin(at("H1", 2400))],
    expiresAt: at("H2", 300), // 2400 + 600 = 3000, less the 2700-second half
  },

  noCarry: {
    cfg: fbCfg(BIN),
    // The second half is the last phase this cfg has, so the remainder has
    // nowhere to run and the expiry stays in H2 past the nominal length.
    events: [fbStart, fbMarker("HT"), fbBin(at("H2", 2400))],
    expiresAt: at("H2", 3000),
  },

  staleExpiry: footballStaleExpiry(),
};

// ---------------------------------------------------------------------------
// Period-kernel adapters — ice hockey (overtime, so it has a phase past the
// last regulation one) and field hockey (four quarters, no overtime).
// ---------------------------------------------------------------------------

interface PeriodAdapterSpec {
  name: string;
  module: AnySportModule;
  /** The suspension class the scenarios use, and its length in seconds. */
  classKey: string;
  classSeconds: number;
  base: number;
  /** Phase labels: the first play phase, its length, and the last one. */
  first: string;
  firstSeconds: number;
  last: string;
  lastSeconds: number;
  /** The advance chain from `first` to `last`, exclusive of `first`. */
  toLast: string[];
  /** A cfg with a play phase AFTER `last` (overtime), where the sport has one.
   *  Absent ⇒ 4c is unreachable for this sport and the suite skips it. */
  overtime?: { raw: unknown; phase: string };
  /** §6 — a cfg declaring `phase`, and the narrower cfg that drops it again. */
  stale: { raw: unknown; phase: string; narrow: unknown };
  /** A phase label no cfg of this sport declares. */
  alien: string;
}

function periodAdapter(spec: PeriodAdapterSpec): TimeKernelAdapter {
  const { module, classKey, classSeconds, base, first, firstSeconds, last } = spec;
  const lineups = defaultLineupPair(module.positions);
  const home = lineups.home.entrantId;
  const cfg = (raw: unknown = {}): unknown => module.configSchema.parse(raw);
  const start: ModuleEvent = { type: "core.start", payload: {} };
  const card = (stamp: GameTime, cls = classKey): ModuleEvent => ({
    type: `${module.key}.suspension.start`,
    payload: { by: home, person: `${home}-p1`, class: cls, at: stamp },
  });
  const release = (stamp: GameTime): ModuleEvent => ({
    type: `${module.key}.suspension.end`,
    payload: { by: home, person: `${home}-p1`, at: stamp },
  });
  // The goal is scored BY the penalised side on purpose: release-on-goal ends
  // the CONCEDING side's suspension, so scoring at the other end would confound
  // every case below with a §3.4 release.
  const goal = (stamp?: GameTime): ModuleEvent => ({
    type: `${module.key}.goal`,
    payload: { by: home, ...(stamp === undefined ? {} : { at: stamp }) },
  });
  const advance = (to: string, stamp?: GameTime): ModuleEvent => ({
    type: `${module.key}.period.advance`,
    payload: { to, ...(stamp === undefined ? {} : { at: stamp }) },
  });
  const toLast = spec.toLast.map((phase) => advance(phase));

  const overtime = spec.overtime;
  const stale = ((): TimeKernelAdapter["staleExpiry"] => {
    const { raw, phase, narrow } = spec.stale;
    const state = foldMatch(
      module,
      cfg(raw),
      lineups,
      envelopes([start, card(at(phase, 60))]),
    ) as Record<string, unknown>;
    return {
      state: { ...state, cfg: cfg(narrow) },
      undeclared: goal(at(phase, 400)),
      declared: goal(at(first, 200)),
    };
  })();

  return {
    name: spec.name,
    module,
    lineups,
    fullStrength: base,
    strength: (state) => {
      const active = (state as { suspensions: { side: string; teamShort: boolean }[] }).suspensions;
      return base - active.filter((s) => s.side === "home" && s.teamShort).length;
    },
    running: (state) => (state as { suspensions: RunningSuspension[] }).suspensions,
    asOf: (state) => (state as { asOf?: GameTime }).asOf,

    releaseAfterSweep: {
      cfg: cfg(),
      events: [
        start,
        card(at(first, 100)),
        goal(at(first, 100 + classSeconds)),
        release(at(first, 100 + classSeconds + 60)),
      ],
    },

    undeclaredStamp: {
      cfg: cfg(),
      open: [start],
      event: goal(at(spec.alien, 60)),
      phases: ["pre", first],
    },

    stamped: {
      cfg: cfg(),
      events: [start, goal(at(first, 100)), card(at(first, 300))],
      lastStamp: at(first, 300),
    },

    phaseWhistle: {
      cfg: cfg(),
      events: [start, card(at(first, 100)), advance(spec.toLast[0] as string)],
    },

    decidedWhileRunning: {
      cfg: cfg(),
      events: [start, card(at(first, 100)), { type: "core.forfeit", payload: { by: home, reason: "walkover" } }],
    },

    ...(overtime === undefined
      ? {}
      : {
          carriedPastFullTime: {
            cfg: cfg(overtime.raw),
            events: [
              start,
              goal(at(first, 100)),
              ...toLast,
              // Late in the LAST regulation phase, so the remainder carries into
              // an overtime the home lead means is never played.
              card(at(last, spec.lastSeconds - 50)),
              advance("FT"),
            ],
          },
        }),

    carry: {
      cfg: cfg(),
      events: [start, card(at(first, firstSeconds - 50))],
      expiresAt: at(spec.toLast[0] as string, classSeconds - 50),
    },

    noCarry: {
      // Overtime and the shoot-out removed, so `last` really is the last phase
      // with any play clock at all and the remainder has nowhere to go.
      cfg: cfg({ overtime: null, shootout: null }),
      events: [start, ...toLast, card(at(last, spec.lastSeconds - 50))],
      expiresAt: at(last, spec.lastSeconds - 50 + classSeconds),
    },

    staleExpiry: stale,
  };
}

const iceAdapter = periodAdapter({
  name: "icehockey",
  module: icehockey,
  classKey: "major", // 5:00, team short, NOT releaseOnGoal
  classSeconds: 300,
  base: 5,
  first: "P1",
  firstSeconds: 1200,
  last: "P3",
  lastSeconds: 1200,
  toLast: ["P2", "P3"],
  overtime: { raw: {}, phase: "OT" }, // sudden-death OT, 5:00
  // A major stamped in overtime under the IIHF default, read back under a
  // competition that has since dropped overtime and the shoot-out.
  stale: { raw: {}, phase: "OT", narrow: { overtime: null, shootout: null } },
  alien: "Q1",
});

const fihAdapter = periodAdapter({
  name: "hockey",
  module: hockey,
  classKey: "yellow", // 5:00, team short
  classSeconds: 300,
  base: 11,
  first: "Q1",
  firstSeconds: 900,
  last: "Q4",
  lastSeconds: 900,
  toLast: ["Q2", "Q3", "Q4"],
  // No overtime in any FIH variant, and the carry deliberately refuses to spill
  // into a shoot-out (there is no match clock there at all), so no expiry can
  // ever be indexed past Q4: 4c is UNREACHABLE for this sport, which is what the
  // optional field is for.
  //
  // §6 instead uses the shoot-out itself: a card shown there is stampable under
  // the `fih-shootout` cfg and unorderable under the plain outdoor one.
  stale: { raw: { shootout: { attempts: 5, suddenDeath: true } }, phase: "SHOOTOUT", narrow: {} },
  alien: "P1",
});

for (const adapter of [footballAdapter, iceAdapter, fihAdapter]) {
  runTimeKernelConformance(adapter);
}
